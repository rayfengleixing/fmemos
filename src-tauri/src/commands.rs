use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::backup::Backup;
use rusqlite::{params, params_from_iter, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::{self, Db};
use crate::import;
use crate::tags;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memo {
    pub id: i64,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
    /// 置顶时间；null = 未置顶
    pub pinned_at: Option<String>,
}

fn row_to_memo(row: &Row) -> rusqlite::Result<Memo> {
    Ok(Memo {
        id: row.get("id")?,
        content: row.get("content")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        pinned_at: row.get("pinned_at")?,
    })
}

const MEMO_COLS: &str = "id, content, created_at, updated_at, pinned_at";

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
/// - pinned：None = 不筛；Some(true) = 只列置顶；Some(false) = 只列未置顶（卡片流主列表用）；
/// - limit + beforeCreatedAt/beforeId：keyset 分页（游标为 (created_at, id)）。
///
/// 置顶项**不参与分页**：主列表用 pinned=Some(false) 查，置顶区另用 pinned=Some(true) 一次查完
/// （置顶数量有限，不需要翻页）。这样游标始终单调，现有 keyset 分页逻辑一行都不用改。
#[tauri::command]
pub fn list_memos(
    db: State<Db>,
    tag: Option<String>,
    query: Option<String>,
    untagged: Option<bool>,
    date: Option<String>,
    trash: Option<bool>,
    pinned: Option<bool>,
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
        pinned,
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
    list_memos_page(conn, tag, query, untagged, date, false, None, None, None)
}

#[allow(clippy::too_many_arguments)]
pub fn list_memos_page(
    conn: &Connection,
    tag: Option<String>,
    query: Option<String>,
    untagged: bool,
    date: Option<String>,
    trash: bool,
    pinned: Option<bool>,
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

    match pinned {
        Some(true) => sql.push_str(" AND memos.pinned_at IS NOT NULL"),
        Some(false) => sql.push_str(" AND memos.pinned_at IS NULL"),
        None => {}
    }

    if let Some((before_at, before_id)) = before {
        sql.push_str(" AND ");
        sql.push_str("(memos.created_at < ? OR (memos.created_at = ? AND memos.id < ?))");
        args.push(before_at.clone());
        args.push(before_at);
        args.push(before_id.to_string());
    }

    // 置顶区按「最近置顶在前」；主列表仍按创建时间倒序（keyset 游标语义完全不变）
    sql.push_str(if pinned == Some(true) {
        " ORDER BY pinned_at DESC, id DESC"
    } else {
        " ORDER BY created_at DESC, id DESC"
    });
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

/// 全库（含回收站）的 (id, content)。标签治理要连回收站一起改，
/// 否则恢复出来的笔记会带着已经改掉的旧标签。
/// 设置 / 取消置顶：pinned = true 打上当前时间（最近置顶的排在前面），false 清空。
/// 返回更新后的 memo，前端可以直接替换这一条而不用整表重拉。
pub fn set_pin_impl(conn: &Connection, id: i64, pinned: bool) -> Result<Memo, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let changed = tx
        .execute(
            "UPDATE memos SET pinned_at = CASE WHEN ?2 THEN datetime('now','localtime') ELSE NULL END \
             WHERE id = ?1",
            params![id, pinned],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("这条笔记不存在（可能已被彻底删除）".into());
    }
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

fn all_memo_contents(conn: &Connection) -> Result<Vec<(i64, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT id, content FROM memos")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 改写正文并同步 updated_at；FTS 索引由 memos_fts_au 触发器自动跟随，
/// 标签关联需要手动重建（走 sync_tags 先删后插）。
fn write_content(conn: &Connection, id: i64, content: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE memos SET content = ?1, updated_at = datetime('now', 'localtime') WHERE id = ?2",
        params![content, id],
    )
    .map_err(|e| e.to_string())?;
    tags::sync_tags(conn, id, content).map_err(|e| e.to_string())?;
    Ok(())
}

/// 重命名（或合并到另一个）标签：改写所有正文里的 `#from`（含 `from/` 子孙），
/// 返回受影响的笔记数。合并到已有标签就是把 to 传成那个标签。
pub fn rename_tag_impl(conn: &Connection, from: &str, to: &str) -> Result<usize, String> {
    let from = from.trim();
    let to = to.trim();
    if from.is_empty() || to.is_empty() {
        return Err("标签名不能为空".into());
    }
    if from == to {
        return Err("新标签名和原标签一样".into());
    }
    // 挡掉自嵌套：读书 → 读书/心理，或反过来把子标签改成父标签
    if tags::tag_has_prefix(to, from) || tags::tag_has_prefix(from, to) {
        return Err("新标签名不能是原标签的上级或下级".into());
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let rows = all_memo_contents(&tx)?;
    let mut affected = 0usize;
    for (id, content) in rows {
        let Some(next) = tags::rename_tag_in_content(&content, from, to) else {
            continue;
        };
        write_content(&tx, id, &next)?;
        affected += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(affected)
}

/// 删除标签：从所有正文里移除 `#tag`（含 `tag/` 子孙），返回受影响的笔记数。
/// 删完正文会变空的那条跳过——宁可标签留着，也不留下一张空卡片。
pub fn delete_tag_impl(conn: &Connection, tag: &str) -> Result<usize, String> {
    let tag = tag.trim();
    if tag.is_empty() {
        return Err("标签名不能为空".into());
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let rows = all_memo_contents(&tx)?;
    let mut affected = 0usize;
    let mut skipped = 0usize;
    for (id, content) in rows {
        let Some(next) = tags::remove_tag_in_content(&content, tag) else {
            continue;
        };
        let next = next.trim();
        if next.is_empty() {
            skipped += 1;
            continue;
        }
        write_content(&tx, id, next)?;
        affected += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    if skipped > 0 {
        eprintln!("delete_tag: {skipped} 条笔记正文只有该标签，已跳过");
    }
    Ok(affected)
}

#[tauri::command]
pub fn rename_tag(db: State<Db>, from: String, to: String) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    rename_tag_impl(&conn, &from, &to)
}

#[tauri::command]
pub fn delete_tag(db: State<Db>, tag: String) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    delete_tag_impl(&conn, &tag)
}

/// 备份目录：与 exe 同级的 backup/（便携模式，跟着程序走）
pub fn backup_dir() -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("无法定位程序所在目录")?
        .to_path_buf();
    Ok(exe_dir.join("backup"))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub path: String,
    /// 备份日期 "YYYY-MM-DD"（取自文件名）
    pub date: String,
    pub size_bytes: u64,
}

/// 备份文件名里的 YYYYMMDD → "YYYY-MM-DD"；格式不符返回 None
fn fmt_backup_date(digits: &str) -> Option<String> {
    if digits.len() != 8 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(format!(
        "{}-{}-{}",
        &digits[0..4],
        &digits[4..6],
        &digits[6..8]
    ))
}

/// 列出 backup/ 里的自动备份，最新的在前。恢复前的安全副本（before-restore-*）不算备份。
#[tauri::command]
pub fn list_backups() -> Result<Vec<BackupInfo>, String> {
    let dir = backup_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<BackupInfo> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let Some(digits) = name
            .strip_prefix("fmemos-backup-")
            .and_then(|s| s.strip_suffix(".db"))
        else {
            continue;
        };
        out.push(BackupInfo {
            date: fmt_backup_date(digits).unwrap_or_else(|| digits.to_string()),
            size_bytes: entry.metadata().map(|m| m.len()).unwrap_or(0),
            path: path.to_string_lossy().to_string(),
            name,
        });
    }
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

/// 恢复前安全副本只保留最近 3 份
fn prune_guards(dir: &Path) {
    const KEEP: usize = 3;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut guards: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("before-restore-"))
        })
        .collect();
    guards.sort();
    while guards.len() > KEEP {
        let _ = std::fs::remove_file(guards.remove(0));
    }
}

/// 恢复实现：校验备份 → 给当前数据留安全副本 → 在线备份反向写回 → 重建派生数据。
/// 返回恢复后的笔记条数。独立成函数便于测试（测试传临时目录当 guard_dir）。
pub fn restore_backup_impl(
    conn: &mut Connection,
    src_path: &Path,
    guard_dir: &Path,
) -> Result<usize, String> {
    let src = Connection::open(src_path).map_err(|e| format!("打不开备份文件：{e}"))?;
    // 损坏的备份直接拒绝，绝不动现有数据
    let check: String = src
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| format!("备份文件无法读取：{e}"))?;
    if check != "ok" {
        return Err(format!("备份文件已损坏，已取消恢复（{check}）"));
    }
    let is_memo_db: i64 = src
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'memos'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if is_memo_db == 0 {
        return Err("这个文件不是 FMemos 的备份".into());
    }

    // 覆盖前先把当前数据另存一份，恢复错了还有退路
    std::fs::create_dir_all(guard_dir).map_err(|e| e.to_string())?;
    let ts: String = conn
        .query_row("SELECT strftime('%Y%m%d-%H%M%S','now','localtime')", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    {
        let mut dst = Connection::open(guard_dir.join(format!("before-restore-{ts}.db")))
            .map_err(|e| e.to_string())?;
        Backup::new(conn, &mut dst)
            .map_err(|e| e.to_string())?
            .run_to_completion(64, std::time::Duration::from_millis(2), None)
            .map_err(|e| e.to_string())?;
    }
    prune_guards(guard_dir);

    // 反向在线备份：把备份内容写回当前连接，所以不用退出应用、也不用替换文件
    // （Windows 上数据库文件被本进程占用，直接覆盖文件是做不到的）
    Backup::new(&src, conn)
        .map_err(|e| format!("恢复失败：{e}"))?
        .run_to_completion(64, std::time::Duration::from_millis(2), None)
        .map_err(|e| format!("恢复失败：{e}"))?;
    // 老备份可能缺列或派生数据版本不一致，切回 WAL、补齐结构并强制重建索引与标签关联
    db::sync_after_restore(conn).map_err(|e| e.to_string())?;

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM memos WHERE deleted_at IS NULL", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    Ok(count as usize)
}

/// 从备份恢复。只接受 backup/ 目录内的文件路径。
#[tauri::command]
pub fn restore_backup(db: State<Db>, path: String) -> Result<usize, String> {
    let dir = backup_dir()?;
    let canonical_dir = dir.canonicalize().map_err(|e| format!("备份目录不可用：{e}"))?;
    let src = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("找不到备份文件：{e}"))?;
    if !src.starts_with(&canonical_dir) {
        return Err("只能恢复备份文件夹里的文件".into());
    }
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    restore_backup_impl(&mut conn, &src, &canonical_dir)
}

/// 导出筛选条件：与 list_memos 的前几个过滤参数同源，全为空 = 导出全部。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFilter {
    pub tag: Option<String>,
    pub query: Option<String>,
    #[serde(default)]
    pub untagged: bool,
    pub date: Option<String>,
}

impl ExportFilter {
    /// 是否没有任何筛选（等价于导出全部）
    pub fn is_all(&self) -> bool {
        non_empty(self.tag.as_deref()).is_none()
            && non_empty(self.query.as_deref()).is_none()
            && non_empty(self.date.as_deref()).is_none()
            && !self.untagged
    }

    /// 人类可读的筛选描述，写进导出文件的抬头，免得事后分不清导的是哪一批
    pub fn describe(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if let Some(t) = non_empty(self.tag.as_deref()) {
            parts.push(format!("#{t}"));
        }
        if let Some(q) = non_empty(self.query.as_deref()) {
            parts.push(format!("搜索「{q}」"));
        }
        if let Some(d) = non_empty(self.date.as_deref()) {
            parts.push(d.to_string());
        }
        if self.untagged {
            parts.push("无标签".into());
        }
        parts.join(" · ")
    }
}

/// 取导出用的笔记列表。pinned 传 None —— 置顶项也必须导出，不能漏。
fn export_memos(conn: &Connection, filter: &ExportFilter) -> Result<Vec<Memo>, String> {
    list_memos_page(
        conn,
        filter.tag.clone(),
        filter.query.clone(),
        filter.untagged,
        filter.date.clone(),
        false,
        None,
        None,
        None,
    )
}

/// 构建 Markdown 导出内容，返回（内容, 条数）。
/// 注意：Markdown 会丢时间戳精度与置顶状态，结构化备份请走 build_export_json。
pub fn build_export_markdown(
    conn: &Connection,
    filter: &ExportFilter,
) -> Result<(String, usize), String> {
    let memos = export_memos(conn, filter)?;
    let now: String = conn
        .query_row("SELECT datetime('now', 'localtime')", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let scope = if filter.is_all() {
        String::new()
    } else {
        format!(" · 筛选：{}", filter.describe())
    };
    let mut out = format!(
        "# FMemos 导出\n\n> 导出时间：{now} · 共 {} 条{scope}\n\n",
        memos.len()
    );
    for m in &memos {
        out.push_str(&format!("## {}\n\n{}\n\n---\n\n", m.created_at, m.content));
    }
    Ok((out, memos.len()))
}

/// JSON 导出里的一条笔记：比界面上的 Memo 多带标签数组，方便外部工具直接消费。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMemo {
    pub id: i64,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
    /// 置顶时间；null = 未置顶
    pub pinned_at: Option<String>,
    /// 正文里解析出的标签（含层级）
    pub tags: Vec<String>,
}

/// 批量取这些笔记的标签：一条 SQL 查完再在内存里聚合，避免逐条查询。
fn load_tags(
    conn: &Connection,
    ids: &[i64],
) -> Result<std::collections::HashMap<i64, Vec<String>>, String> {
    let mut out: std::collections::HashMap<i64, Vec<String>> = std::collections::HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT memo_id, tag FROM memo_tags WHERE memo_id IN ({placeholders}) \
             ORDER BY memo_id, tag"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(ids.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, tag) = row.map_err(|e| e.to_string())?;
        out.entry(id).or_default().push(tag);
    }
    Ok(out)
}

/// 构建 JSON 结构化导出，返回（内容, 条数）。
/// 相对 Markdown 多保住精确时间戳、置顶状态与标签数组——所以它才是能回灌的结构化备份。
pub fn build_export_json(
    conn: &Connection,
    filter: &ExportFilter,
) -> Result<(String, usize), String> {
    let memos = export_memos(conn, filter)?;
    let ids: Vec<i64> = memos.iter().map(|m| m.id).collect();
    let mut tags_by_memo = load_tags(conn, &ids)?;
    let now: String = conn
        .query_row("SELECT datetime('now', 'localtime')", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let items: Vec<ExportMemo> = memos
        .iter()
        .map(|m| ExportMemo {
            id: m.id,
            content: m.content.clone(),
            created_at: m.created_at.clone(),
            updated_at: m.updated_at.clone(),
            pinned_at: m.pinned_at.clone(),
            tags: tags_by_memo.remove(&m.id).unwrap_or_default(),
        })
        .collect();

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Doc<'a> {
        app: &'a str,
        version: &'a str,
        exported_at: &'a str,
        count: usize,
        /// 导出时应用的筛选条件（全 null/false = 导出全部）
        filter: &'a ExportFilter,
        memos: &'a [ExportMemo],
    }

    let doc = Doc {
        app: "FMemos",
        version: env!("CARGO_PKG_VERSION"),
        exported_at: &now,
        count: items.len(),
        filter,
        memos: &items,
    };
    let json = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    Ok((json, items.len()))
}

/// 取导出文本（浏览器模式用 Blob 下载）：format = "json" 走结构化导出，其余按 Markdown。
#[tauri::command]
pub fn export_text(
    db: State<Db>,
    format: Option<String>,
    filter: Option<ExportFilter>,
) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let filter = filter.unwrap_or_default();
    let (content, _) = if format.as_deref() == Some("json") {
        build_export_json(&conn, &filter)?
    } else {
        build_export_markdown(&conn, &filter)?
    };
    Ok(content)
}

/// 导出到系统另存为对话框选定的路径，返回导出条数。
#[tauri::command]
pub fn export_to(
    db: State<Db>,
    path: String,
    format: Option<String>,
    filter: Option<ExportFilter>,
) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let filter = filter.unwrap_or_default();
    let (mut content, count) = if format.as_deref() == Some("json") {
        build_export_json(&conn, &filter)?
    } else {
        build_export_markdown(&conn, &filter)?
    };
    // 正文引用了图片：写到 <文件名>.assets/ 目录并把 image://<id> 改写成相对链接，
    // 导出的 Markdown 拿到任何机器上图片都还能看
    if content.contains(IMAGE_REF_PREFIX) {
        let path_p = Path::new(&path);
        let stem = path_p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "export".into());
        let assets = path_p
            .parent()
            .unwrap_or(Path::new("."))
            .join(format!("{stem}.assets"));
        content = write_export_assets(&conn, &content, &assets, &format!("{stem}.assets"))?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(count)
}

// ===== 图片附件（BLOB 进库） =====

/// 单张图片的元信息（不含字节）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub id: i64,
    pub mime: String,
    pub size_bytes: i64,
}

/// 读取图片：字节以 base64 返回，前端拼 data URL 渲染
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    pub id: i64,
    pub mime: String,
    pub data: String,
}

/// 正文里图片引用的前缀，完整引用形如 `![图片](image://<id>)`
pub const IMAGE_REF_PREFIX: &str = "image://";

/// 单图大小上限：10 MB。截图一般 100KB～2MB，足够覆盖日常粘贴场景
const IMAGE_MAX_BYTES: usize = 10 * 1024 * 1024;

/// 纯函数：从文本里按出现顺序抽出全部 image://<id> 的 id（不去重）
fn extract_image_refs(text: &str) -> Vec<i64> {
    let mut ids = Vec::new();
    let mut rest = text;
    while let Some(pos) = rest.find(IMAGE_REF_PREFIX) {
        let after = &rest[pos + IMAGE_REF_PREFIX.len()..];
        let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(id) = digits.parse::<i64>() {
            ids.push(id);
        }
        rest = &after[digits.len()..];
    }
    ids
}

/// 全库被引用的图片 id（memos 表含回收站，回收站里的也算引用）
fn referenced_image_ids(conn: &Connection) -> Result<Vec<i64>, String> {
    let contents: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT content FROM memos")
            .map_err(|e| e.to_string())?;
        let collected = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        collected
    };
    Ok(contents.iter().flat_map(|c| extract_image_refs(c)).collect())
}

/// mime → 导出文件扩展名
fn image_ext(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        _ => "bin",
    }
}

/// 存一张图片：base64 进 → sha256 去重（相同字节秒传）→ BLOB 入库
pub fn add_image_impl(conn: &Connection, data_base64: &str, mime: &str) -> Result<ImageInfo, String> {
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("图片数据不是有效的 base64：{e}"))?;
    if data.is_empty() {
        return Err("图片内容为空".into());
    }
    if data.len() > IMAGE_MAX_BYTES {
        return Err(format!(
            "图片超过 {} MB 上限，请压缩后再粘贴",
            IMAGE_MAX_BYTES / 1024 / 1024
        ));
    }
    let mime = if mime.starts_with("image/") {
        mime.to_string()
    } else {
        "image/png".to_string()
    };
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(&data);
    let hash: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if let Ok(id) = conn.query_row("SELECT id FROM images WHERE sha256 = ?1", [&hash], |r| r.get::<_, i64>(0)) {
        let size_bytes: i64 = conn
            .query_row("SELECT size_bytes FROM images WHERE id = ?1", [id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        return Ok(ImageInfo { id, mime, size_bytes });
    }
    conn.execute(
        "INSERT INTO images (sha256, mime, size_bytes, data) VALUES (?1, ?2, ?3, ?4)",
        params![hash, mime, data.len() as i64, data],
    )
    .map_err(|e| e.to_string())?;
    Ok(ImageInfo {
        id: conn.last_insert_rowid(),
        mime,
        size_bytes: data.len() as i64,
    })
}

/// 读一张图片
pub fn get_image_impl(conn: &Connection, id: i64) -> Result<ImageData, String> {
    use base64::Engine as _;
    let row: Option<(String, Vec<u8>)> = conn
        .query_row(
            "SELECT mime, data FROM images WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map(Some)
        .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })
        .map_err(|_| format!("图片 #{id} 不存在"))?;
    let Some((mime, bytes)) = row else {
        return Err(format!("图片 #{id} 不存在"));
    };
    Ok(ImageData {
        id,
        mime,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// 清理孤儿图片：删除「无任何笔记引用 且 早于 older_than_hours 小时入库」的图。
/// 留 24h 缓冲是保护还没保存的草稿图——粘贴后图片立刻入库，正文却还在编辑器里。
pub fn cleanup_unused_images(conn: &Connection, older_than_hours: i64) -> Result<usize, String> {
    let referenced: HashSet<i64> = referenced_image_ids(conn)?.into_iter().collect();
    let cutoff: String = conn
        .query_row(
            "SELECT datetime('now','localtime', ?1)",
            [format!("-{older_than_hours} hours")],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, created_at FROM images")
            .map_err(|e| e.to_string())?;
        let collected = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        collected
    };
    let mut deleted = 0usize;
    for (id, created_at) in rows {
        // "YYYY-MM-DD HH:MM:SS" 字典序即时间序；太新的不动
        if referenced.contains(&id) || created_at.as_str() >= cutoff.as_str() {
            continue;
        }
        conn.execute("DELETE FROM images WHERE id = ?1", [id])
            .map_err(|e| e.to_string())?;
        deleted += 1;
    }
    Ok(deleted)
}

/// 导出联动：把正文引用的图片写到 assets_dir（img-<id>.<ext>），
/// 并把 image://<id> 改写成 <url_prefix>/img-<id>.<ext>，返回改写后的正文。
/// 单张图缺失只保留原引用，不阻塞整个导出。
pub fn write_export_assets(
    conn: &Connection,
    content: &str,
    assets_dir: &Path,
    url_prefix: &str,
) -> Result<String, String> {
    std::fs::create_dir_all(assets_dir).map_err(|e| e.to_string())?;
    let mut out = content.to_string();
    for id in extract_image_refs(content) {
        let row: Option<(String, Vec<u8>)> = conn
            .query_row(
                "SELECT mime, data FROM images WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map(Some)
            .or_else(|e| {
                if e == rusqlite::Error::QueryReturnedNoRows {
                    Ok(None)
                } else {
                    Err(e)
                }
            })
            .map_err(|e| e.to_string())?;
        let Some((mime, bytes)) = row else { continue };
        let name = format!("img-{id}.{}", image_ext(&mime));
        let path = assets_dir.join(&name);
        if !path.exists() {
            std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        }
        out = out.replace(&format!("{IMAGE_REF_PREFIX}{id}"), &format!("{url_prefix}/{name}"));
    }
    Ok(out)
}

/// 存一张图片（前端把剪贴板/拖入的图片文件读成 base64 传进来）
#[tauri::command]
pub fn add_image(db: State<Db>, data: String, mime: Option<String>) -> Result<ImageInfo, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    add_image_impl(&conn, &data, mime.as_deref().unwrap_or("image/png"))
}

/// 读一张图片（字节 base64）
#[tauri::command]
pub fn get_image(db: State<Db>, id: i64) -> Result<ImageData, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    get_image_impl(&conn, id)
}

/// 导入报告：dry_run 时 added 表示「将新增」的条数
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// 识别到的笔记条数（含重复与空内容）
    pub total: usize,
    /// 实际写入 / 将要写入的条数
    pub added: usize,
    /// 因正文与已有笔记重复而跳过的条数
    pub skipped: usize,
    /// 因正文为空而跳过的条数
    pub empty: usize,
    /// 扫过的文件数
    pub files: usize,
    /// 前几条的正文摘要，供前端确认时预览
    pub samples: Vec<String>,
}

/// 文件修改时间的本地时间字符串（借 SQLite 做时区换算，省得自己实现一套时间库）
fn file_mtime_local(conn: &Connection, path: &Path) -> Option<String> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let secs = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    conn.query_row(
        "SELECT strftime('%Y-%m-%d %H:%M:%S', ?1, 'unixepoch', 'localtime')",
        params![secs],
        |r| r.get(0),
    )
    .ok()
}

/// 正文摘要：第一行非空内容，最多 40 字
fn sample_line(content: &str) -> String {
    let first = content
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let mut s: String = first.chars().take(40).collect();
    if first.chars().count() > 40 {
        s.push('…');
    }
    s
}

/// 导入实现：解析路径下（文件夹则递归）所有文本文件 → 与库内正文去重 → 非 dry_run 时整批写入。
/// 去重键是归一化正文，所以重复导入同一个文件不会翻倍；整批写入在一个事务里，中途失败不会留半截数据。
pub fn import_path_impl(
    conn: &Connection,
    root: &Path,
    dry_run: bool,
) -> Result<ImportReport, String> {
    let files = import::collect_files(root)?;
    if files.is_empty() {
        return Err("没有找到可导入的文件（支持 .md / .markdown / .txt / .html）".into());
    }

    // 已有正文的归一化集合：既做去重，也顺带挡住同一批里的重复内容
    let mut seen: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT content FROM memos").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut set = HashSet::new();
        for c in rows {
            set.insert(import::dedup_key(&c.map_err(|e| e.to_string())?));
        }
        set
    };

    let mut total = 0usize;
    let mut empty = 0usize;
    let mut skipped = 0usize;
    let mut samples: Vec<String> = Vec::new();
    let mut pending: Vec<(Option<String>, String)> = Vec::new();

    for path in &files {
        let fallback = file_mtime_local(conn, path);
        let text = import::read_text(path)?;
        let ext = import::extension_of(path);
        for memo in import::parse_text(&text, &ext, fallback.as_deref()) {
            total += 1;
            let content = memo.content.trim().to_string();
            let key = import::dedup_key(&content);
            if key.is_empty() {
                empty += 1;
                continue;
            }
            if seen.contains(&key) {
                skipped += 1;
                continue;
            }
            seen.insert(key);
            if samples.len() < 5 {
                samples.push(sample_line(&content));
            }
            pending.push((memo.created_at, content));
        }
    }

    let added = pending.len();
    if !dry_run && added > 0 {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for (created_at, content) in &pending {
            let done = match created_at {
                // 导入的时间戳是导出文件里的原始时间，要原样保留（不能用默认的 now）
                Some(ts) => tx.execute(
                    "INSERT INTO memos (content, created_at, updated_at) VALUES (?1, ?2, ?2)",
                    params![content, ts],
                ),
                None => tx.execute("INSERT INTO memos (content) VALUES (?1)", params![content]),
            };
            done.map_err(|e| e.to_string())?;
            let id = tx.last_insert_rowid();
            tags::sync_tags(&tx, id, content).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    Ok(ImportReport {
        total,
        added,
        skipped,
        empty,
        files: files.len(),
        samples,
    })
}

/// 从文件或文件夹导入笔记。dry_run = true 时只解析统计（供前端确认），不写库。
#[tauri::command]
pub fn import_path(db: State<Db>, path: String, dry_run: bool) -> Result<ImportReport, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    import_path_impl(&conn, Path::new(&path), dry_run)
}

/// 打开自动备份目录。
/// 读一个设置项；键不存在返回 None。
#[tauri::command]
pub fn get_setting(db: State<Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::read_setting(&conn, &key).map_err(|e| e.to_string())
}

/// 写一个设置项；值为空串等同删除该项。
#[tauri::command]
pub fn set_setting(db: State<Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::write_setting(&conn, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_backup_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = backup_dir()?;
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

/// 置顶 / 取消置顶
#[tauri::command]
pub fn set_pin(db: State<Db>, id: i64, pinned: bool) -> Result<Memo, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    set_pin_impl(&conn, id, pinned)
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
        let trash = list_memos_page(&conn, None, None, false, None, true, None, None, None).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, m1.id);

        // 恢复
        restore_memo_impl(&conn, m1.id).unwrap();
        assert_eq!(list_memos_impl(&conn, None, None, false, None).unwrap().len(), 2);
        assert!(list_memos_page(&conn, None, None, false, None, true, None, None, None)
            .unwrap()
            .is_empty());

        // 彻底删除：正文、FTS、标签关联全部清除
        delete_memo_impl(&conn, m2.id).unwrap();
        purge_memo_impl(&conn, m2.id).unwrap();
        assert_eq!(list_memos_impl(&conn, None, None, false, None).unwrap().len(), 1);
        assert!(list_memos_page(&conn, None, None, false, None, true, None, None, None)
            .unwrap()
            .is_empty());
        // FTS 里也查不到了
        assert!(list_memos_impl(&conn, None, Some("two".into()), false, None)
            .unwrap()
            .is_empty());

        // 导出只含未删除内容（此时仅剩 one）
        let (content, count) = build_export_markdown(&conn, &Default::default()).unwrap();
        assert_eq!(count, 1);
        assert!(content.contains("one") && !content.contains("two"));

        // 软删除后清空回收站
        delete_memo_impl(&conn, m1.id).unwrap();
        let n = empty_trash_impl(&conn).unwrap();
        assert_eq!(n, 1);
        assert!(list_memos_page(&conn, None, None, false, None, true, None, None, None)
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

        let page1 = list_memos_page(&conn, None, None, false, None, false, None, Some(2), None).unwrap();
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
            None,
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
            None,
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

    #[test]
    fn rename_tag_rewrites_content_and_index() {
        let conn = setup();
        create_memo_impl(&conn, "#读书 打卡").unwrap();
        create_memo_impl(&conn, "#读书/心理学 锚定效应").unwrap();
        create_memo_impl(&conn, "#读书笔记 别动我").unwrap();

        let n = rename_tag_impl(&conn, "读书", "阅读").unwrap();
        assert_eq!(n, 2);

        // 父标签连带子孙一起改了：旧路径查不到，新路径两条都命中
        assert!(list_memos_impl(&conn, Some("读书".into()), None, false, None)
            .unwrap()
            .is_empty());
        assert_eq!(
            list_memos_impl(&conn, Some("阅读".into()), None, false, None)
                .unwrap()
                .len(),
            2
        );
        let sub = list_memos_impl(&conn, Some("阅读/心理学".into()), None, false, None).unwrap();
        assert_eq!(sub.len(), 1);
        assert!(sub[0].content.contains("#阅读/心理学"));
        // 前缀子串不误伤
        assert_eq!(
            list_memos_impl(&conn, Some("读书笔记".into()), None, false, None)
                .unwrap()
                .len(),
            1
        );
        // FTS 索引跟着更新：按新标签全文搜得到
        assert_eq!(
            list_memos_impl(&conn, None, Some("阅读/心理学".into()), false, None)
                .unwrap()
                .len(),
            1
        );

        // 自嵌套与空名挡掉
        assert!(rename_tag_impl(&conn, "阅读", "阅读/子").is_err());
        assert!(rename_tag_impl(&conn, "阅读", "阅读").is_err());
        assert!(rename_tag_impl(&conn, "", "x").is_err());
    }

    #[test]
    fn delete_tag_skips_memos_that_would_become_empty() {
        let conn = setup();
        create_memo_impl(&conn, "#读书 打卡").unwrap();
        create_memo_impl(&conn, "#读书").unwrap();
        create_memo_impl(&conn, "#读书/心理学 书评").unwrap();

        let n = delete_tag_impl(&conn, "读书").unwrap();
        assert_eq!(n, 2);
        // 正文只有该标签的那条被跳过，所以「读书」还剩 1 条命中
        assert_eq!(
            list_memos_impl(&conn, Some("读书".into()), None, false, None)
                .unwrap()
                .len(),
            1
        );

        // 正文只有标签的那条原样留着，不会变成空卡片
        let all = list_memos_impl(&conn, None, None, false, None).unwrap();
        assert_eq!(all.len(), 3);
        assert!(all.iter().any(|m| m.content == "#读书"));
        // 另外两条变成无标签
        assert_eq!(
            list_memos_impl(&conn, None, None, true, None).unwrap().len(),
            2
        );
    }

    #[test]
    fn restore_backup_roundtrip() {
        let dir = std::env::temp_dir().join(format!("fmemos-test-restore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let backup_path = dir.join("fmemos-backup-20250101.db");

        // 造一份「备份」：两条旧笔记
        {
            let src = Connection::open(&backup_path).unwrap();
            db::migrate(&src).unwrap();
            create_memo_impl(&src, "旧笔记一 #归档").unwrap();
            create_memo_impl(&src, "旧笔记二").unwrap();
        }

        // 当前库：一条笔记，口径与备份不同
        let mut conn = db::open_conn(&dir.join("main.db")).unwrap();
        create_memo_impl(&conn, "现在这条会被覆盖").unwrap();

        let guard = dir.join("guard");
        let n = restore_backup_impl(&mut conn, &backup_path, &guard).unwrap();
        assert_eq!(n, 2);

        let all = list_memos_impl(&conn, None, None, false, None).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|m| m.content.starts_with("旧笔记")));
        // 派生数据重建后标签关联可用
        assert_eq!(
            list_memos_impl(&conn, Some("归档".into()), None, false, None)
                .unwrap()
                .len(),
            1
        );
        // 恢复前留了安全副本
        assert!(std::fs::read_dir(&guard).unwrap().count() >= 1);
        // 恢复后回到 WAL，能继续写
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        create_memo_impl(&conn, "恢复后新增的一条").unwrap();

        // 损坏的备份被拒绝，现有数据不动
        let broken = dir.join("broken.db");
        std::fs::write(&broken, b"not a database").unwrap();
        assert!(restore_backup_impl(&mut conn, &broken, &guard).is_err());
        assert_eq!(
            list_memos_impl(&conn, None, None, false, None).unwrap().len(),
            3
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_path_writes_memos_and_dedupes() {
        let conn = setup();
        create_memo_impl(&conn, "库里已有的一条").unwrap();

        let dir = tests_support::temp_dir("import");
        // flomo 的 Markdown 导出：按 "## 时间" 分节，条目之间用 --- 分隔
        std::fs::write(
            dir.join("flomo.md"),
            "## 2021-04-05 09:43:21\n\n第一条 #读书\n\n---\n\n\
             ## 2021-04-06 10:00:00\n\n第二条\n- [ ] 待办\n\n---\n",
        )
        .unwrap();
        // 散装文本文件：整段一条，兜底用文件修改时间
        std::fs::write(dir.join("note.txt"), "散的文本文件\r\n第二行").unwrap();
        // 与库里已有内容重复
        std::fs::write(dir.join("已有.md"), "库里已有的一条\n").unwrap();

        // 预览：只解析统计，不写库
        let preview = import_path_impl(&conn, &dir, true).unwrap();
        assert_eq!(preview.files, 3);
        assert_eq!(preview.total, 4);
        assert_eq!(preview.added, 3);
        assert_eq!(preview.skipped, 1);
        assert_eq!(preview.samples.len(), 3);
        assert_eq!(
            list_memos_impl(&conn, None, None, false, None).unwrap().len(),
            1
        );

        let report = import_path_impl(&conn, &dir, false).unwrap();
        assert_eq!(report.added, 3);
        let all = list_memos_impl(&conn, None, None, false, None).unwrap();
        assert_eq!(all.len(), 4);

        // 导出里的原始时间戳要原样保留，标签同步进 memo_tags
        let old = all
            .iter()
            .find(|m| m.content.starts_with("第一条"))
            .unwrap();
        assert_eq!(old.created_at, "2021-04-05 09:43:21");
        assert_eq!(
            list_memos_impl(&conn, Some("读书".into()), None, false, None)
                .unwrap()
                .len(),
            1
        );
        // 文本文件的行尾归一成 LF，时间是文件修改时间
        let txt = all
            .iter()
            .find(|m| m.content.starts_with("散的文本"))
            .unwrap();
        assert_eq!(txt.content, "散的文本文件\n第二行");
        assert!(txt.created_at.starts_with("20"));

        // 再导入一次：全部命中重复，库里条数不变
        let again = import_path_impl(&conn, &dir, false).unwrap();
        assert_eq!(again.added, 0);
        assert_eq!(again.skipped, 4);
        assert_eq!(
            list_memos_impl(&conn, None, None, false, None).unwrap().len(),
            4
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_path_rejects_directory_without_importable_files() {
        let conn = setup();
        let dir = tests_support::temp_dir("import-empty");
        assert!(import_path_impl(&conn, &dir, true).is_err());
        std::fs::write(dir.join("pic.png"), "x").unwrap();
        assert!(import_path_impl(&conn, &dir, true).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pin_filter_three_states() {
        let conn = setup();
        let a = create_memo_impl(&conn, "a").unwrap();
        create_memo_impl(&conn, "b").unwrap();
        create_memo_impl(&conn, "c").unwrap();
        let pinned = set_pin_impl(&conn, a.id, true).unwrap();
        assert!(pinned.pinned_at.is_some());

        // None = 不筛（导出走这条路，置顶项不能漏）
        let all = list_memos_page(&conn, None, None, false, None, false, None, None, None).unwrap();
        assert_eq!(all.len(), 3);
        // Some(false) = 卡片流主列表，排除置顶项
        let plain =
            list_memos_page(&conn, None, None, false, None, false, Some(false), None, None).unwrap();
        assert_eq!(plain.len(), 2);
        assert!(plain.iter().all(|m| m.pinned_at.is_none()));
        // Some(true) = 置顶区
        let pins =
            list_memos_page(&conn, None, None, false, None, false, Some(true), None, None).unwrap();
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].id, a.id);

        // 取消置顶后回到普通列表
        assert!(set_pin_impl(&conn, a.id, false).unwrap().pinned_at.is_none());
        let plain =
            list_memos_page(&conn, None, None, false, None, false, Some(false), None, None).unwrap();
        assert_eq!(plain.len(), 3);
    }

    #[test]
    fn pin_survives_content_update_and_reorders() {
        let conn = setup();
        let a = create_memo_impl(&conn, "a").unwrap();
        let b = create_memo_impl(&conn, "b").unwrap();

        // 改正文不应清掉置顶（UPDATE 只动 content / updated_at）
        set_pin_impl(&conn, a.id, true).unwrap();
        assert!(update_memo_impl(&conn, a.id, "a 改过了").unwrap().pinned_at.is_some());

        // 最近置顶的排在前面
        set_pin_impl(&conn, b.id, true).unwrap();
        let pins =
            list_memos_page(&conn, None, None, false, None, false, Some(true), None, None).unwrap();
        assert_eq!(pins.iter().map(|m| m.id).collect::<Vec<_>>(), vec![b.id, a.id]);

        // 置顶一条不存在的笔记要报错，而不是静默成功
        assert!(set_pin_impl(&conn, 9999, true).is_err());
    }

    #[test]
    fn export_scopes_by_filter_and_json_keeps_pin_and_tags() {
        let conn = setup();
        let a = create_memo_impl(&conn, "#工作 周报").unwrap();
        create_memo_impl(&conn, "#生活 买菜").unwrap();
        set_pin_impl(&conn, a.id, true).unwrap();

        let all = ExportFilter::default();
        let (md, n) = build_export_markdown(&conn, &all).unwrap();
        assert_eq!(n, 2);
        // 置顶项也必须出现在导出里（回归保护：主列表排除置顶，导出不能跟着排）
        assert!(md.contains("周报") && md.contains("买菜"));

        // 按标签筛选导出，并在抬头写明筛的是什么
        let only_work = ExportFilter {
            tag: Some("工作".into()),
            ..Default::default()
        };
        let (md, n) = build_export_markdown(&conn, &only_work).unwrap();
        assert_eq!(n, 1);
        assert!(md.contains("周报") && !md.contains("买菜"));
        assert!(md.contains("筛选：#工作"));

        // JSON：保住置顶状态、标签数组与完整时间戳
        let (json, n) = build_export_json(&conn, &all).unwrap();
        assert_eq!(n, 2);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["count"], 2);
        let items = v["memos"].as_array().unwrap();
        let work = items
            .iter()
            .find(|m| m["content"].as_str().unwrap().contains("周报"))
            .unwrap();
        assert!(work["pinnedAt"].is_string());
        assert_eq!(work["tags"][0], "工作");
        assert_eq!(work["createdAt"].as_str().unwrap().len(), 19);
    }

    #[test]
    fn settings_roundtrip_and_delete_on_empty() {
        let conn = setup();
        assert!(db::read_setting(&conn, "md_export_dir").unwrap().is_none());

        db::write_setting(&conn, "md_export_dir", "D:/sync").unwrap();
        assert_eq!(
            db::read_setting(&conn, "md_export_dir").unwrap().as_deref(),
            Some("D:/sync")
        );
        // 覆盖写
        db::write_setting(&conn, "md_export_dir", "D:/other").unwrap();
        assert_eq!(
            db::read_setting(&conn, "md_export_dir").unwrap().as_deref(),
            Some("D:/other")
        );
        // 空串等同删除该项
        db::write_setting(&conn, "md_export_dir", "").unwrap();
        assert!(db::read_setting(&conn, "md_export_dir").unwrap().is_none());
    }

    fn b64(bytes: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn image_add_dedups_and_roundtrips() {
        let conn = setup();
        let data = b64(b"\x89PNG-fake-bytes");
        let a = add_image_impl(&conn, &data, "image/png").unwrap();
        let b = add_image_impl(&conn, &data, "image/png").unwrap();
        // 相同字节去重（秒传）：同一个 id
        assert_eq!(a.id, b.id);
        assert_eq!(a.size_bytes, 15); // 原文字节数，不是 base64 长度

        let got = get_image_impl(&conn, a.id).unwrap();
        assert_eq!(got.mime, "image/png");
        assert_eq!(got.data, data);
        assert!(get_image_impl(&conn, 999).is_err());

        // 非 image/ 开头的 mime 归一成 png；坏 base64 报错
        let odd = add_image_impl(&conn, &b64(b"odd"), "application/octet-stream").unwrap();
        assert_eq!(odd.mime, "image/png");
        assert!(add_image_impl(&conn, "!!!not-base64!!!", "image/png").is_err());
        assert!(add_image_impl(&conn, "", "image/png").is_err());
    }

    #[test]
    fn image_cleanup_keeps_referenced_and_fresh() {
        let conn = setup();
        // 三张图：被引用的、无引用但很新的、无引用且过期的
        let referenced = add_image_impl(&conn, &b64(b"img-1"), "image/png").unwrap();
        let fresh = add_image_impl(&conn, &b64(b"img-2"), "image/png").unwrap();
        let stale = add_image_impl(&conn, &b64(b"img-3"), "image/png").unwrap();
        conn.execute(
            "INSERT INTO memos (content, created_at, updated_at) VALUES (?1, datetime('now','localtime'), datetime('now','localtime'))",
            [format!("看图 ![图片]({IMAGE_REF_PREFIX}{}) 呢", referenced.id)],
        )
        .unwrap();
        conn.execute(
            "UPDATE images SET created_at = datetime('now','localtime','-48 hours') WHERE id = ?1",
            [stale.id],
        )
        .unwrap();

        let deleted = cleanup_unused_images(&conn, 24).unwrap();
        assert_eq!(deleted, 1);
        assert!(get_image_impl(&conn, referenced.id).is_ok());
        assert!(get_image_impl(&conn, fresh.id).is_ok());
        assert!(get_image_impl(&conn, stale.id).is_err());
    }

    #[test]
    fn export_assets_rewrite_refs_and_write_files() {
        let conn = setup();
        let img = add_image_impl(&conn, &b64(b"png-bytes"), "image/png").unwrap();
        let content = format!("开头 ![图片]({IMAGE_REF_PREFIX}{}) 结尾", img.id);
        let dir = tests_support::temp_dir("export-assets");
        let assets = dir.join("x.assets");
        let out = write_export_assets(&conn, &content, &assets, "x.assets").unwrap();
        assert_eq!(out, format!("开头 ![图片](x.assets/img-{}.png) 结尾", img.id));
        assert!(assets.join(format!("img-{}.png", img.id)).exists());
        // 再次导出不重复写文件；引用不存在的图保留原样
        let missing = format!("![x]({IMAGE_REF_PREFIX}424242)");
        assert_eq!(
            write_export_assets(&conn, &missing, &assets, "x.assets").unwrap(),
            missing
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn daily_markdown_export_writes_once_per_day() {
        let conn = setup();
        create_memo_impl(&conn, "每日导出内容").unwrap();
        let dir = tests_support::temp_dir("md-export");
        db::write_setting(&conn, "md_export_dir", dir.to_str().unwrap()).unwrap();

        db::auto_export_markdown(&conn);
        let day: String = conn
            .query_row("SELECT strftime('%Y%m%d','now','localtime')", [], |r| r.get(0))
            .unwrap();
        let file = dir.join(format!("fmemos-{day}.md"));
        assert!(file.exists());
        assert!(std::fs::read_to_string(&file).unwrap().contains("每日导出内容"));

        // 同一天再跑不会覆盖已有文件
        std::fs::write(&file, "已存在就不覆盖").unwrap();
        db::auto_export_markdown(&conn);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "已存在就不覆盖");

        // 目录不存在时静默跳过（换盘 / 被删），不 panic
        db::write_setting(&conn, "md_export_dir", "D:/不存在的目录-xyz").unwrap();
        db::auto_export_markdown(&conn);

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 测试共用的临时目录工具（import / 备份等测试用）。目录名进程内唯一，避免并行测试互相踩。
#[cfg(test)]
pub mod tests_support {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    pub fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fmemos-test-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
