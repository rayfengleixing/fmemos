use std::path::Path;
use std::sync::Mutex;

use crate::tags;

/// 共享的数据库连接，注册进 Tauri 的 managed state。
pub struct Db(pub Mutex<rusqlite::Connection>);

/// 打开（必要时创建）数据库文件并执行迁移。
/// 便携模式：数据库与 exe 同目录，直接跟着程序走，方便备份和用同步盘同步。
/// 注意：若程序装进 Program Files 等受保护目录，写入会因权限不足失败。
pub fn init() -> Result<rusqlite::Connection, Box<dyn std::error::Error>> {
    let exe_dir = std::env::current_exe()?
        .parent()
        .ok_or("无法定位程序所在目录")?
        .to_path_buf();
    open_conn(&exe_dir.join("fmemos.db"))
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
        CREATE INDEX IF NOT EXISTS idx_memo_tags_tag  ON memo_tags(tag);",
    )?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < DERIVED_VERSION {
        rebuild_derived(conn)?;
        conn.pragma_update(None, "user_version", DERIVED_VERSION)?;
    }
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
