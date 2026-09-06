use rusqlite::{params, params_from_iter, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::tags;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memo {
    pub id: i64,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_memo(row: &Row) -> rusqlite::Result<Memo> {
    Ok(Memo {
        id: row.get("id")?,
        content: row.get("content")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const MEMO_COLS: &str = "id, content, created_at, updated_at";

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

/// 新建一条 memo。写入与标签关联在同一事务内，避免中途失败留下不一致。
pub fn create_memo_impl(conn: &Connection, content: &str) -> Result<Memo, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("内容不能为空".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO memos (content) VALUES (?1)", params![content])
        .map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();
    tags::sync_tags(&tx, id, content).map_err(|e| e.to_string())?;
    let memo = tx
        .query_row(
            &format!("SELECT {MEMO_COLS} FROM memos WHERE id = ?1"),
            params![id],
            row_to_memo,
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(memo)
}

/// 列出 memo，按创建时间倒序。可叠加过滤：
/// - tag：标签精确匹配，父标签连带子孙（#读书 命中 #读书/心理学），走 memo_tags 表；
/// - query：全文搜索，空格分隔多关键词 AND；全部 ≥3 字符走 FTS5 trigram，任一较短回退 LIKE；
/// - untagged：只看没有标签的记录；
/// - date：按创建日期 "YYYY-MM-DD" 过滤；
/// - trash：true 时只列出回收站中的 memo；
/// - limit + beforeCreatedAt/beforeId：keyset 分页（游标为 (created_at, id)）。
#[tauri::command]
pub fn list_memos(
    db: State<Db>,
    tag: Option<String>,
    query: Option<String>,
    untagged: Option<bool>,
    date: Option<String>,
    trash: Option<bool>,
    limit: Option<i64>,
    before_created_at: Option<String>,
    before_id: Option<i64>,
) -> Result<Vec<Memo>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let before = match (before_created_at, before_id) {
        (Some(at), Some(id)) => Some((at, id)),
        _ => None,
    };
    list_memos_page(
        &conn,
        tag,
        query,
        untagged.unwrap_or(false),
        date,
        trash.unwrap_or(false),
        limit,
        before,
    )
}

/// 不分页入口，仅供测试使用（正式命令 list_memos 走 list_memos_page）。
#[cfg(test)]
pub fn list_memos_impl(
    conn: &Connection,
    tag: Option<String>,
    query: Option<String>,
    untagged: bool,
    date: Option<String>,
) -> Result<Vec<Memo>, String> {
    list_memos_page(conn, tag, query, untagged, date, false, None, None)
}

#[allow(clippy::too_many_arguments)]
pub fn list_memos_page(
    conn: &Connection,
    tag: Option<String>,
    query: Option<String>,
    untagged: bool,
    date: Option<String>,
    trash: bool,
    limit: Option<i64>,
    before: Option<(String, i64)>,
) -> Result<Vec<Memo>, String> {
    // 基础条件：回收站开关（正常列表只看未删除，trash 只看已删除）
    let mut sql = format!(
        "SELECT {MEMO_COLS} FROM memos WHERE deleted_at IS {}",
        if trash { "NOT NULL" } else { "NULL" }
    );
    // 基础条件之后全部用 AND 连接
    let mut args: Vec<String> = Vec::new();

    if let Some(tag) = non_empty(tag.as_deref()) {
        sql.push_str(" AND ");
        sql.push_str(
            "EXISTS (SELECT 1 FROM memo_tags mt WHERE mt.memo_id = memos.id \
             AND (mt.tag = ? OR mt.tag LIKE ? || '/%'))",
        );
        args.push(tag.to_string());
        args.push(tag.to_string());
    }

    if let Some(query) = non_empty(query.as_deref()) {
        sql.push_str(" AND ");
        // 多关键词 AND：按空白拆分，全部命中才算命中。
        // 全部关键词 ≥3 字符走 FTS 短语 AND；任一较短则整组回退 LIKE（trigram 对短词无索引）
        let terms: Vec<&str> = query.split_whitespace().collect();
        if terms.iter().all(|t| t.chars().count() >= 3) {
            let match_expr: String = terms
                .iter()
                .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" AND ");
            sql.push_str("memos.id IN (SELECT rowid FROM memos_fts WHERE memos_fts MATCH ?)");
            args.push(match_expr);
        } else {
            let likes: Vec<String> = terms
                .iter()
                .map(|t| {
                    // LIKE 通配符转义：% _ \ 视为字面字符，避免搜索 "100%" 之类误匹配
                    format!(
                        "%{}%",
                        t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
                    )
                })
                .collect();
            sql.push_str(
                &likes
                    .iter()
                    .map(|_| "content LIKE ? ESCAPE '\\'")
                    .collect::<Vec<_>>()
                    .join(" AND "),
            );
            args.extend(likes);
        }
    }

    if untagged {
        sql.push_str(" AND ");
        sql.push_str("NOT EXISTS (SELECT 1 FROM memo_tags mt WHERE mt.memo_id = memos.id)");
    }

    if let Some(date) = non_empty(date.as_deref()) {
        sql.push_str(" AND ");
        sql.push_str("created_at LIKE ?");
        args.push(format!("{date}%"));
    }

    if let Some((before_at, before_id)) = before {
        sql.push_str(" AND ");
        sql.push_str("(memos.created_at < ? OR (memos.created_at = ? AND memos.id < ?))");
        args.push(before_at.clone());
        args.push(before_at);
        args.push(before_id.to_string());
    }

    sql.push_str(" ORDER BY created_at DESC, id DESC");
    if let Some(limit) = limit {
        // 钳制后是可信整数，直接拼入 SQL
        sql.push_str(&format!(" LIMIT {}", limit.clamp(1, 500)));
    }

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(args.iter()), row_to_memo)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 更新一条 memo 的内容。id 不存在时返回明确错误而非查询空结果的底层报错。
pub fn update_memo_impl(conn: &Connection, id: i64, content: &str) -> Result<Memo, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("内容不能为空".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let changed = tx
        .execute(
            "UPDATE memos SET content = ?1, updated_at = datetime('now', 'localtime') WHERE id = ?2",
            params![content, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("memo #{id} 不存在"));
    }
    tags::sync_tags(&tx, id, content).map_err(|e| e.to_string())?;
    let memo = tx
        .query_row(
            &format!("SELECT {MEMO_COLS} FROM memos WHERE id = ?1"),
            params![id],
            row_to_memo,
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(memo)
}

/// 删除一条 memo：软删除进回收站（restore_memo 可撤销，purge_memo 彻底清除）。
pub fn delete_memo_impl(conn: &Connection, id: i64) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE memos SET deleted_at = datetime('now', 'localtime') \
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("memo #{id} 不存在"));
    }
    Ok(())
}

/// 从回收站恢复一条 memo。
pub fn restore_memo_impl(conn: &Connection, id: i64) -> Result<(), String> {
    let n = conn
        .execute("UPDATE memos SET deleted_at = NULL WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("回收站中没有 memo #{id}"));
    }
    Ok(())
}

/// 彻底删除回收站中的一条 memo（正文、FTS 索引、标签关联一并清除）。
pub fn purge_memo_impl(conn: &Connection, id: i64) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM memos WHERE id = ?1 AND deleted_at IS NOT NULL",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM memo_tags WHERE memo_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 清空回收站，返回清除的条数。
pub fn empty_trash_impl(conn: &Connection) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let n = tx
        .execute("DELETE FROM memos WHERE deleted_at IS NOT NULL", [])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM memo_tags WHERE memo_id NOT IN (SELECT id FROM memos)",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

/// 构建全量 Markdown 导出内容，返回（内容, 条数）。
pub fn build_export_markdown(conn: &Connection) -> Result<(String, usize), String> {
    let memos = list_memos_page(conn, None, None, false, None, false, None, None)?;
    let now: String = conn
        .query_row("SELECT datetime('now', 'localtime')", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut out = format!(
        "# FMemos 导出\n\n> 导出时间：{now} · 共 {} 条\n\n",
        memos.len()
    );
    for m in &memos {
        out.push_str(&format!("## {}\n\n{}\n\n---\n\n", m.created_at, m.content));
    }
    Ok((out, memos.len()))
}

/// 导出全部笔记为 Markdown 文本（浏览器模式用 Blob 下载）。
#[tauri::command]
pub fn export_markdown(db: State<Db>) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    build_export_markdown(&conn).map(|(s, _)| s)
}

/// 导出全部笔记到系统另存为对话框选定的路径，返回导出条数。
#[tauri::command]
pub fn export_to(db: State<Db>, path: String) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let (content, count) = build_export_markdown(&conn)?;
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(count)
}

/// 打开自动备份目录。
#[tauri::command]
pub fn open_backup_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let exe_dir = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("无法定位程序所在目录")?
        .to_path_buf();
    let dir = exe_dir.join("backup");
    if !dir.exists() {
        return Err("备份目录还不存在（首次启动完成备份后自动创建）".into());
    }
    app.opener()
        .open_path(dir.to_string_lossy(), None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_memo(db: State<Db>, content: String) -> Result<Memo, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    create_memo_impl(&conn, &content)
}

#[tauri::command]
pub fn update_memo(db: State<Db>, id: i64, content: String) -> Result<Memo, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    update_memo_impl(&conn, id, &content)
}

#[tauri::command]
pub fn delete_memo(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    delete_memo_impl(&conn, id)
}

#[tauri::command]
pub fn restore_memo(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    restore_memo_impl(&conn, id)
}

#[tauri::command]
pub fn purge_memo(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    purge_memo_impl(&conn, id)
}

#[tauri::command]
pub fn empty_trash(db: State<Db>) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    empty_trash_impl(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn tag_exact_match_with_descendants() {
        let conn = setup();
        create_memo_impl(&conn, "读书笔记 #读书/心理学 hello").unwrap();
        create_memo_impl(&conn, "跑步 5km #运动").unwrap();
        create_memo_impl(&conn, "plain text no tags").unwrap();

        // 父标签连带子孙
        assert_eq!(
            list_memos_impl(&conn, Some("读书".into()), None, false, None)
                .unwrap()
                .len(),
            1
        );
        // 精确匹配子标签
        assert_eq!(
            list_memos_impl(&conn, Some("读书/心理学".into()), None, false, None)
                .unwrap()
                .len(),
            1
        );
        // 前缀子串不再误命中（LIKE 子串匹配的旧问题）
        assert!(list_memos_impl(&conn, Some("读".into()), None, false, None)
            .unwrap()
            .is_empty());
        // 无标签
        assert_eq!(
            list_memos_impl(&conn, None, None, true, None).unwrap().len(),
            1
        );
    }

    #[test]
    fn fts_search_and_short_query_fallback() {
        let conn = setup();
        create_memo_impl(&conn, "The quick brown fox").unwrap();
        create_memo_impl(&conn, "今天开始读书笔记").unwrap();

        assert_eq!(
            list_memos_impl(&conn, None, Some("brown".into()), false, None)
                .unwrap()
                .len(),
            1
        );
        // trigram 默认大小写不敏感
        assert_eq!(
            list_memos_impl(&conn, None, Some("QUICK".into()), false, None)
                .unwrap()
                .len(),
            1
        );
        // 2 字符：LIKE 回退
        assert_eq!(
            list_memos_impl(&conn, None, Some("读书".into()), false, None)
                .unwrap()
                .len(),
            1
        );
        // 3 字符：FTS trigram 子串
        assert_eq!(
            list_memos_impl(&conn, None, Some("书笔记".into()), false, None)
                .unwrap()
                .len(),
            1
        );
        // 引号转义后正常返回（不 panic 不 500）
        assert!(list_memos_impl(&conn, None, Some("q\"x".into()), false, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn like_fallback_escapes_wildcards() {
        let conn = setup();
        create_memo_impl(&conn, "a_b first").unwrap();
        create_memo_impl(&conn, "axb second").unwrap();
        create_memo_impl(&conn, "50% off third").unwrap();

        // 2 字符走 LIKE：_ 按字面匹配，不再当任意单字符通配符
        assert_eq!(
            list_memos_impl(&conn, None, Some("_b".into()), false, None)
                .unwrap()
                .len(),
            1
        );
        // % 按字面匹配
        assert_eq!(
            list_memos_impl(&conn, None, Some("%".into()), false, None)
                .unwrap()
                .len(),
            1
        );
        // 4 字符走 FTS，含 % 也能正常返回
        assert_eq!(
            list_memos_impl(&conn, None, Some("50%".into()), false, None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn trash_flow() {
        let conn = setup();
        let m1 = create_memo_impl(&conn, "one").unwrap();
        let m2 = create_memo_impl(&conn, "two").unwrap();

        // 删除 = 软删除进回收站
        delete_memo_impl(&conn, m1.id).unwrap();
        assert!(
            list_memos_impl(&conn, None, None, false, None)
                .unwrap()
                .iter()
                .all(|m| m.id != m1.id)
        );
        let trash = list_memos_page(&conn, None, None, false, None, true, None, None).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, m1.id);

        // 恢复
        restore_memo_impl(&conn, m1.id).unwrap();
        assert_eq!(list_memos_impl(&conn, None, None, false, None).unwrap().len(), 2);
        assert!(list_memos_page(&conn, None, None, false, None, true, None, None)
            .unwrap()
            .is_empty());

        // 彻底删除：正文、FTS、标签关联全部清除
        delete_memo_impl(&conn, m2.id).unwrap();
        purge_memo_impl(&conn, m2.id).unwrap();
        assert_eq!(list_memos_impl(&conn, None, None, false, None).unwrap().len(), 1);
        assert!(list_memos_page(&conn, None, None, false, None, true, None, None)
            .unwrap()
            .is_empty());
        // FTS 里也查不到了
        assert!(list_memos_impl(&conn, None, Some("two".into()), false, None)
            .unwrap()
            .is_empty());

        // 导出只含未删除内容（此时仅剩 one）
        let (content, count) = build_export_markdown(&conn).unwrap();
        assert_eq!(count, 1);
        assert!(content.contains("one") && !content.contains("two"));

        // 软删除后清空回收站
        delete_memo_impl(&conn, m1.id).unwrap();
        let n = empty_trash_impl(&conn).unwrap();
        assert_eq!(n, 1);
        assert!(list_memos_page(&conn, None, None, false, None, true, None, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn multi_term_search() {
        let conn = setup();
        create_memo_impl(&conn, "马拉松训练完成后写周报").unwrap();
        create_memo_impl(&conn, "明天开会讨论").unwrap();
        create_memo_impl(&conn, "晨跑 5km").unwrap();

        // 两个 ≥3 字符关键词 AND（FTS 路径）
        assert_eq!(
            list_memos_impl(&conn, None, Some("马拉松训练 周报".into()), false, None)
                .unwrap()
                .len(),
            1
        );
        // 同时含两个词才命中
        assert!(list_memos_impl(&conn, None, Some("周报 开会".into()), false, None)
            .unwrap()
            .is_empty());
        // 任一关键词 <3 字符整组走 LIKE AND
        assert_eq!(
            list_memos_impl(&conn, None, Some("晨跑 5km".into()), false, None)
                .unwrap()
                .len(),
            1
        );
        assert!(list_memos_impl(&conn, None, Some("晨跑 6km".into()), false, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn pagination_cursor() {
        let conn = setup();
        for i in 1..=5 {
            create_memo_impl(&conn, &format!("memo {i:02}")).unwrap();
        }
        let all: Vec<i64> = list_memos_impl(&conn, None, None, false, None)
            .unwrap()
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(all.len(), 5);

        let page1 = list_memos_page(&conn, None, None, false, None, false, Some(2), None).unwrap();
        assert_eq!(page1.len(), 2);
        // 同秒创建的记录 created_at 相同，游标靠 (created_at, id) 复合键不重不漏
        let last1 = page1.last().unwrap();
        let page2 = list_memos_page(
            &conn,
            None,
            None,
            false,
            None,
            false,
            Some(2),
            Some((last1.created_at.clone(), last1.id)),
        )
        .unwrap();
        assert_eq!(page2.len(), 2);
        let got: Vec<i64> = page1.iter().chain(page2.iter()).map(|m| m.id).collect();
        assert_eq!(got, all[..4]);

        let last2 = page2.last().unwrap();
        let page3 = list_memos_page(
            &conn,
            None,
            None,
            false,
            None,
            false,
            Some(2),
            Some((last2.created_at.clone(), last2.id)),
        )
        .unwrap();
        assert_eq!(page3.len(), 1);
        assert_eq!(page3[0].id, all[4]);
    }

    #[test]
    fn update_retags_and_delete_cleans() {
        let conn = setup();
        let m = create_memo_impl(&conn, "#a x").unwrap();
        update_memo_impl(&conn, m.id, "#b y").unwrap();

        assert!(list_memos_impl(&conn, Some("a".into()), None, false, None)
            .unwrap()
            .is_empty());
        assert_eq!(
            list_memos_impl(&conn, Some("b".into()), None, false, None)
                .unwrap()
                .len(),
            1
        );

        delete_memo_impl(&conn, m.id).unwrap();
        assert!(list_memos_impl(&conn, None, None, true, None).unwrap().is_empty());
    }

    #[test]
    fn date_filter() {
        let conn = setup();
        create_memo_impl(&conn, "one").unwrap();
        let today: String = conn
            .query_row("SELECT date('now','localtime')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            list_memos_impl(&conn, None, None, false, Some(today))
                .unwrap()
                .len(),
            1
        );
        assert!(list_memos_impl(&conn, None, None, false, Some("2000-01-01".into()))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn combined_tag_and_query() {
        let conn = setup();
        create_memo_impl(&conn, "#工作 今天写周报").unwrap();
        create_memo_impl(&conn, "#工作 明天开会").unwrap();
        create_memo_impl(&conn, "#生活 买菜做饭").unwrap();
        let got = list_memos_impl(
            &conn,
            Some("工作".into()),
            Some("周报".into()),
            false,
            None,
        )
        .unwrap();
        assert_eq!(got.len(), 1);
    }
}
