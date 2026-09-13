use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::tags;

/// 共享的数据库连接，注册进 Tauri 的 managed state。
/// 第二个字段是加密密钥（hex）：开「第二个连接」（自动备份 / 恢复）的地方要用同一个密钥。
pub struct Db(pub Mutex<rusqlite::Connection>, pub Option<String>);

/// 密钥文件名：与 exe 同目录。**丢了它数据就解不开了**——README 里写清楚了。
const KEY_FILE: &str = "fmemos.key";

/// 读取密钥文件；不存在则生成 32 字节随机密钥写入。返回（hex 密钥, 是否新建）。
/// 新建 = true 时说明可能存在一份明文老库等着迁移。
fn load_or_create_key(exe_dir: &Path) -> Result<(String, bool), String> {
    let path = exe_dir.join(KEY_FILE);
    if path.is_file() {
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("读不了密钥文件：{e}"))?;
        let hex = raw.trim();
        if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!(
                "{KEY_FILE} 内容不对（应为 64 位十六进制字符），拒绝打开数据库"
            ));
        }
        return Ok((hex.to_ascii_lowercase(), false));
    }
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(|e| format!("生成密钥失败：{e}"))?;
    let hex: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    std::fs::write(&path, format!("{hex}\n")).map_err(|e| {
        format!(
            "写不了密钥文件 {}：{e}（程序目录可能没有写权限）",
            path.display()
        )
    })?;
    Ok((hex, true))
}

/// 打开（必要时创建）数据库文件并执行迁移，随后做当日自动备份。
/// 便携模式：数据库与 exe 同目录，直接跟着程序走，方便备份和用同步盘同步。
/// 注意：若程序装进 Program Files 等受保护目录，写入会因权限不足失败。
///
/// 加密流程（SQLCipher）：
/// - 首次启动生成 `fmemos.key`；库里已有明文数据时自动迁移成加密库，
///   明文原件改名 `fmemos.db.plain-backup` 留底（迁移成功后可手动删除）；
/// - 之后每次启动都带密钥打开，密钥对不上（文件被拷给别人 / 密钥被改）立即报错，不碰数据。
/// 返回（连接, hex 密钥）：密钥要放进 Db state，供自动备份 / 恢复开第二个连接用。
pub fn init() -> Result<(rusqlite::Connection, String), Box<dyn std::error::Error>> {
    let exe_dir = std::env::current_exe()?
        .parent()
        .ok_or("无法定位程序所在目录")?
        .to_path_buf();
    let (key_hex, created) = load_or_create_key(&exe_dir)?;
    let conn = open_conn_auto(&exe_dir.join("fmemos.db"), &key_hex)?;
    if created {
        eprintln!("generated new key file; database is now SQLCipher-encrypted");
    }
    auto_backup(&conn, &exe_dir, Some(&key_hex));
    auto_export_markdown(&conn);
    // 孤儿图片清理：只清「无引用且超过 24h」的——24h 是给还没保存的草稿图留的缓冲。
    if let Err(e) = crate::commands::cleanup_unused_images(&conn, 24) {
        eprintln!("image cleanup failed: {e}");
    }
    Ok((conn, key_hex))
}

/// SQLite 文件的魔数（前 16 字节）。加密后的库开头是密文，不会是这个。
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// 是否是未加密的 SQLite 库（0 字节 / 文件不存在都按不是处理）。
fn is_plaintext_sqlite(path: &Path) -> Result<bool, String> {
    if !path.is_file() {
        return Ok(false);
    }
    let mut head = [0u8; 16];
    use std::io::Read;
    let n = std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut head))
        .map_err(|e| format!("读不了数据库文件头：{e}"))?;
    Ok(n == 16 && &head == SQLITE_MAGIC)
}

/// 打开数据库：明文老库自动迁移成 SQLCipher 加密库，否则直接带密钥打开；
/// 之后照旧切 WAL、跑迁移。加密迁移只认「SQLite 魔数」这一个信号，幂等安全。
pub fn open_conn_auto(db_path: &Path, key_hex: &str) -> Result<rusqlite::Connection, String> {
    let migrated;
    if is_plaintext_sqlite(db_path)? {
        eprintln!("plaintext database detected, migrating to SQLCipher...");
        encrypt_plaintext_db(db_path, key_hex)?;
        migrated = true;
    } else {
        migrated = false;
    }
    let conn = open_keyed(db_path, Some(key_hex))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("切 WAL 失败：{e}"))?;
    migrate(&conn).map_err(|e| format!("迁移失败：{e}"))?;
    if migrated {
        eprintln!("database encrypted; plaintext original kept as *.plain-backup");
    }
    Ok(conn)
}

/// 打开连接并按需应用 SQLCipher 密钥。设完密钥立刻读一次 sqlite_master：
/// 密钥不对会在这一步以「文件不是数据库」暴露，而不是等第一条业务 SQL 才炸。
/// pub 是给「恢复备份」「自动备份」这类要开第二个连接的地方用的——第二个连接必须同密钥。
pub fn open_keyed(path: &Path, key: Option<&str>) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(path).map_err(|e| format!("打不开数据库：{e}"))?;
    if let Some(hex) = key {
        // hex 只含 [0-9a-f]，直接拼进 PRAGMA 没有注入面；PRAGMA key 不支持参数绑定
        conn.execute_batch(&format!("PRAGMA key = \"x'{hex}'\";"))
            .map_err(|e| format!("应用密钥失败：{e}"))?;
        conn.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
            .map_err(|_| {
                format!(
                    "数据库密钥不匹配：{KEY_FILE} 与这个库对不上。\
                     如果是拷贝来的数据库，需要连同 {KEY_FILE} 一起拷贝。"
                )
            })?;
    }
    Ok(conn)
}

/// SQL 字符串字面量转义（路径里可能有单引号）
fn sql_quote(s: &str) -> String {
    s.replace('\'', "''")
}

/// 把明文库整体迁成加密库：ATTACH 一个空库带密钥 → `sqlcipher_export` 原样倒过去 →
/// 明文原件改名留底、加密库顶替原名。中途任何一步失败，原文件都还完好（重命名在最后）。
fn encrypt_plaintext_db(db_path: &Path, key_hex: &str) -> Result<(), String> {
    let enc_path = db_path.with_extension("db.enc");
    let _ = std::fs::remove_file(&enc_path); // 清掉上次失败可能留下的半成品
    let plain = rusqlite::Connection::open(db_path)
        .map_err(|e| format!("打不开明文库：{e}"))?;
    plain
        .execute_batch(&format!(
            "ATTACH DATABASE '{}' AS enc KEY \"x'{key_hex}'\";
             SELECT sqlcipher_export('enc');
             DETACH DATABASE enc;",
            sql_quote(&enc_path.display().to_string())
        ))
        .map_err(|e| format!("加密迁移失败（原文件未动）：{e}"))?;
    drop(plain); // 正常关闭，WAL 落盘并被 checkpoint，明文库的 -wal/-shm 随之清空

    let backup_path = db_path.with_extension("db.plain-backup");
    let _ = std::fs::remove_file(&backup_path);
    std::fs::rename(db_path, &backup_path).map_err(|e| format!("留底明文库失败：{e}"))?;
    // 明文库的 WAL 残留必须清掉，否则会被张冠李戴到加密库上
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(db_path.with_extension(format!("db{suffix}")));
    }
    std::fs::rename(&enc_path, db_path).map_err(|e| format!("启用加密库失败：{e}"))?;
    Ok(())
}

/// 打开数据库连接并执行迁移；仅测试用（不加密）。正式路径一律走 `open_conn_auto`。
#[cfg(test)]
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
/// key 为主库的加密密钥：备份文件与主库同密钥，None = 不加密（测试场景）。
fn auto_backup(conn: &rusqlite::Connection, exe_dir: &Path, key: Option<&str>) {
    let run = || -> Result<(), Box<dyn std::error::Error>> {
        let dir: PathBuf = exe_dir.join("backup");
        std::fs::create_dir_all(&dir)?;
        let day: String = conn.query_row("SELECT strftime('%Y%m%d','now','localtime')", [], |r| r.get(0))?;
        let path = dir.join(format!("fmemos-backup-{day}.db"));
        if !path.exists() {
            // 备份文件与主库同密钥：主库是加密的，第二个连接必须也带上密钥才写得进去
            let mut dst = open_keyed(&path, key)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::tests_support::temp_dir;

    const KEY_A: &str = "a3f1c0d9b2e4f56897a0b1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60";
    const KEY_B: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// 建一个带一条数据的明文库（老版 FMemos 的样子）
    fn make_plaintext_db(path: &Path) {
        let conn = open_conn(path).unwrap();
        conn.execute("INSERT INTO memos (content) VALUES ('迁移前的一条 #读书')", [])
            .unwrap();
    }

    fn header_is_sqlite_magic(path: &Path) -> bool {
        let mut head = [0u8; 16];
        use std::io::Read;
        std::fs::File::open(path)
            .unwrap()
            .read_exact(&mut head)
            .is_ok()
            && &head == SQLITE_MAGIC
    }

    #[test]
    fn key_file_created_and_reloaded() {
        let dir = temp_dir("enc-keyfile");
        let (k1, created) = load_or_create_key(&dir).unwrap();
        assert!(created);
        assert_eq!(k1.len(), 64);
        // 第二次读回同一个密钥，不再是「新建」
        let (k2, created2) = load_or_create_key(&dir).unwrap();
        assert!(!created2);
        assert_eq!(k1, k2);
        // 内容被篡改要被拒绝
        std::fs::write(dir.join(KEY_FILE), "not-a-key").unwrap();
        assert!(load_or_create_key(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fresh_db_is_encrypted_from_the_start() {
        let dir = temp_dir("enc-fresh");
        let db_path = dir.join("fmemos.db");
        let conn = open_conn_auto(&db_path, KEY_A).unwrap();
        conn.execute("INSERT INTO memos (content) VALUES ('x')", []).unwrap();
        drop(conn);
        // 文件头不是 SQLite 魔数 = 确实落了密文
        assert!(!header_is_sqlite_magic(&db_path));
        // 不带密钥读不出 schema
        let raw = rusqlite::Connection::open(&db_path).unwrap();
        assert!(raw.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plaintext_db_migrates_and_keeps_backup() {
        let dir = temp_dir("enc-migrate");
        let db_path = dir.join("fmemos.db");
        make_plaintext_db(&db_path);
        assert!(header_is_sqlite_magic(&db_path));

        let conn = open_conn_auto(&db_path, KEY_A).unwrap();
        // 数据活着回来了，标签也重新解析过
        let content: String = conn
            .query_row("SELECT content FROM memos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(content, "迁移前的一条 #读书");
        let tags: i64 = conn
            .query_row("SELECT COUNT(*) FROM memo_tags WHERE tag = '读书'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tags, 1);
        drop(conn);

        // 现在是密文；明文原件留了底
        assert!(!header_is_sqlite_magic(&db_path));
        let backup = db_path.with_extension("db.plain-backup");
        assert!(backup.is_file());
        assert!(header_is_sqlite_magic(&backup));

        // 再开一次：已是密文，不会误判成需要迁移，数据照常
        let conn = open_conn_auto(&db_path, KEY_A).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM memos", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_key_is_rejected() {
        let dir = temp_dir("enc-wrongkey");
        let db_path = dir.join("fmemos.db");
        open_conn_auto(&db_path, KEY_A).unwrap();
        let err = open_conn_auto(&db_path, KEY_B).unwrap_err();
        assert!(err.contains("密钥不匹配"), "实际错误：{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn auto_backup_writes_keyed_file_when_key_given() {
        let dir = temp_dir("enc-backup");
        let db_path = dir.join("fmemos.db");
        let conn = open_conn_auto(&db_path, KEY_A).unwrap();
        conn.execute("INSERT INTO memos (content) VALUES ('要备份的一条')", []).unwrap();
        auto_backup(&conn, &dir, Some(KEY_A));

        let today: String = conn
            .query_row("SELECT strftime('%Y%m%d','now','localtime')", [], |r| r.get(0))
            .unwrap();
        let backup_path = dir.join("backup").join(format!("fmemos-backup-{today}.db"));
        assert!(backup_path.is_file());
        // 备份文件是同密钥加密库，能带密钥打开且数据完整
        let src = open_keyed(&backup_path, Some(KEY_A)).unwrap();
        let content: String = src
            .query_row("SELECT content FROM memos LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(content, "要备份的一条");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
