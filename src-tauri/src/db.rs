use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::tags;

/// 共享的数据库连接，注册进 Tauri 的 managed state。
pub struct Db(pub Mutex<rusqlite::Connection>);

/// 打开（必要时创建）数据库文件并执行迁移，随后做当日自动备份。
/// 便携模式：数据库与 exe 同目录，直接跟着程序走，方便备份和用同步盘同步。
/// 注意：若程序装进 Program Files 等受保护目录，写入会因权限不足失败。
pub fn init() -> Result<rusqlite::Connection, Box<dyn std::error::Error>> {
    let exe_dir = std::env::current_exe()?
        .parent()
        .ok_or("无法定位程序所在目录")?
        .to_path_buf();
    let conn = open_conn(&exe_dir.join("fmemos.db"))?;
    auto_backup(&conn, &exe_dir);
    auto_export_markdown(&conn);
    // 孤儿图片清理：只清「无引用且超过 24h」的——24h 是给还没保存的草稿图留的缓冲。
    if let Err(e) = crate::commands::cleanup_unused_images(&conn, 24) {
        eprintln!("image cleanup failed: {e}");
    }
    Ok(conn)
}

/// 打开数据库连接并执行迁移；测试直接用 `Connection::open_in_memory` + `migrate`。
pub fn open_conn(path: &Path) -> Result<rusqlite::Connection, Box<dyn std::error::Error>> {
    let conn = rusqlite::Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    migrate(&conn)?;
    Ok(conn)
}

/// 派生数据版本：改动影响 FTS 索引或标签关联的逻辑（如标签解析规则）时 +1，
/// 下次启动会做一次全量重建。原本每次启动都重建（可自愈数据漂移），
/// 笔记多后拖慢启动，改为按版本触发；需要手动自愈时清库或提升版本号即可。
const DERIVED_VERSION: i64 = 1;

/// 建表与迁移，幂等。派生数据（FTS 索引、标签关联）按 DERIVED_VERSION 触发全量重建。
pub fn migrate(conn: &rusqlite::Connection) -> Result<(), Box<dyn std::error::Error>> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memos (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            content    TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        CREATE INDEX IF NOT EXISTS idx_memos_created_at ON memos(created_at DESC);

        -- trigram 分词：支持 CJK 任意 >=3 字符子串匹配（unicode61 对中文整串分词不可用）
        CREATE VIRTUAL TABLE IF NOT EXISTS memos_fts USING fts5(
            content,
            content='memos',
            content_rowid='id',
            tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS memos_fts_ai AFTER INSERT ON memos BEGIN
            INSERT INTO memos_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memos_fts_ad AFTER DELETE ON memos BEGIN
            INSERT INTO memos_fts(memos_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memos_fts_au AFTER UPDATE OF content ON memos BEGIN
            INSERT INTO memos_fts(memos_fts, rowid, content) VALUES ('delete', old.id, old.content);
            INSERT INTO memos_fts(rowid, content) VALUES (new.id, new.content);
        END;

        CREATE TABLE IF NOT EXISTS memo_tags (
            memo_id INTEGER NOT NULL,
            tag     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memo_tags_memo ON memo_tags(memo_id);
        CREATE INDEX IF NOT EXISTS idx_memo_tags_tag  ON memo_tags(tag);

        -- 通用键值设置：目前放每日 Markdown 导出的目标目录等
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- 图片附件：字节直接进库（BLOB），备份/恢复/同步天然覆盖。
        -- sha256 唯一：同一张图重复粘贴只存一份。正文用 ![图片](image://<id>) 引用。
        CREATE TABLE IF NOT EXISTS images (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            sha256     TEXT NOT NULL UNIQUE,
            mime       TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            data       BLOB NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );",
    )?;
    // 软删除列（回收站）：NULL = 正常，非 NULL = 删除时间。老库补列。
    let has_deleted_at: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('memos') WHERE name = 'deleted_at'",
        [],
        |r| r.get(0),
    )?;
    if !has_deleted_at {
        conn.execute("ALTER TABLE memos ADD COLUMN deleted_at TEXT", [])?;
    }
    // 置顶列：NULL = 未置顶，非 NULL = 置顶时间。老库补列。
    let has_pinned_at: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('memos') WHERE name = 'pinned_at'",
        [],
        |r| r.get(0),
    )?;
    if !has_pinned_at {
        conn.execute("ALTER TABLE memos ADD COLUMN pinned_at TEXT", [])?;
    }
    // 部分索引：只索引置顶项（数量少）。必须放在补列之后，否则老库建索引时列还不存在。
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memos_pinned ON memos(pinned_at) WHERE pinned_at IS NOT NULL",
        [],
    )?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < DERIVED_VERSION {
        rebuild_derived(conn)?;
        conn.pragma_update(None, "user_version", DERIVED_VERSION)?;
    }
    Ok(())
}

/// 启动时自动备份：每天一份完整快照到 exe 旁 backup/，保留最近 5 份。
/// 用 SQLite 在线备份 API，WAL 模式下也能拿到一致快照；任何失败只记日志，不阻塞启动。
fn auto_backup(conn: &rusqlite::Connection, exe_dir: &Path) {
    let run = || -> Result<(), Box<dyn std::error::Error>> {
        let dir: PathBuf = exe_dir.join("backup");
        std::fs::create_dir_all(&dir)?;
        let day: String = conn.query_row("SELECT strftime('%Y%m%d','now','localtime')", [], |r| r.get(0))?;
        let path = dir.join(format!("fmemos-backup-{day}.db"));
        if !path.exists() {
            let mut dst = rusqlite::Connection::open(&path)?;
            use rusqlite::backup::Backup;
            Backup::new(conn, &mut dst)?.run_to_completion(64, std::time::Duration::from_millis(2), None)?;
        }
        // 只保留最近 BACKUP_KEEP 份
        const BACKUP_KEEP: usize = 5;
        let mut backups: Vec<PathBuf> = std::fs::read_dir(&dir)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .map_or(false, |n| n.to_string_lossy().starts_with("fmemos-backup-"))
            })
            .collect();
        backups.sort();
        while backups.len() > BACKUP_KEEP {
            let _ = std::fs::remove_file(backups.remove(0));
        }
        Ok(())
    };
    if let Err(e) = run() {
        eprintln!("auto backup failed: {e}");
    }
}

/// 从备份恢复之后调用：把库切回 WAL、补齐可能缺失的表结构、强制重建派生数据。
/// 备份文件默认是 delete 日志模式，在线备份 API 会把它一并带过来，所以要手动切回；
/// 老备份还可能缺 deleted_at 列、或派生数据版本与当前代码不一致，一并在这里抹平。
pub fn sync_after_restore(conn: &rusqlite::Connection) -> Result<(), Box<dyn std::error::Error>> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    migrate(conn)?;
    rebuild_derived(conn)?;
    conn.pragma_update(None, "user_version", DERIVED_VERSION)?;
    Ok(())
}

/// 全量重建派生数据：FTS 索引 + 标签关联。整体在一个事务内，避免中途失败留下半重建状态。
pub fn rebuild_derived(conn: &rusqlite::Connection) -> Result<(), Box<dyn std::error::Error>> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("INSERT INTO memos_fts(memos_fts) VALUES ('rebuild')", [])?;
    tx.execute("DELETE FROM memo_tags", [])?;
    let rows: Vec<(i64, String)> = {
        let mut stmt = tx.prepare("SELECT id, content FROM memos")?;
        let collected = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        collected
    };
    for (id, content) in rows {
        tags::sync_tags(&tx, id, &content)?;
    }
    tx.commit()?;
    Ok(())
}

/// 读一个设置项；键不存在返回 None。
pub fn read_setting(
    conn: &rusqlite::Connection,
    key: &str,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query([key])?;
    Ok(match rows.next()? {
        Some(row) => Some(row.get(0)?),
        None => None,
    })
}

/// 写一个设置项（不存在则插入，存在则覆盖）；值为空串等同于删除该项。
pub fn write_setting(
    conn: &rusqlite::Connection,
    key: &str,
    value: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if value.trim().is_empty() {
        conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
        return Ok(());
    }
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

/// 每日 Markdown 导出：设置里配了目标目录时，每天首次启动顺带写一份可读的 Markdown。
/// 面向「丢进同步盘 / 网盘」的场景——WAL 下的 db 快照直接同步并不友好，Markdown 没有这个问题。
/// 任何失败只记日志，绝不阻塞启动。
pub(crate) fn auto_export_markdown(conn: &rusqlite::Connection) {
    let run = || -> Result<(), Box<dyn std::error::Error>> {
        let Some(dir) = read_setting(conn, "md_export_dir")? else {
            return Ok(());
        };
        let dir = PathBuf::from(dir);
        if !dir.is_dir() {
            // 目录被删/换盘了，静默跳过，等用户重新设置
            return Ok(());
        }
        let day: String =
            conn.query_row("SELECT strftime('%Y%m%d','now','localtime')", [], |r| r.get(0))?;
        let path = dir.join(format!("fmemos-{day}.md"));
        if path.exists() {
            return Ok(());
        }
        let (content, _) = crate::commands::build_export_markdown(conn, &Default::default())?;
        // 正文引用了图片时，把图片写到 fmemos-images/ 并改写链接，导出的 Markdown 才是自包含的
        let content = if content.contains("image://") {
            let assets = dir.join("fmemos-images");
            crate::commands::write_export_assets(conn, &content, &assets, "fmemos-images")?
        } else {
            content
        };
        std::fs::write(&path, content)?;
        Ok(())
    };
    if let Err(e) = run() {
        eprintln!("daily markdown export failed: {e}");
    }
}
