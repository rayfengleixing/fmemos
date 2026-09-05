use rusqlite::{params, Connection};

/// 标签截止字符集，与前端 src/lib/tags.ts 的 TAG_BODY 保持一致
/// （前端字符类里的 `;;`、`!!`、`??` 是重复项，这里取去重后的集合）。
fn is_tag_break(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '#' | ','
                | '，'
                | '。'
                | '.'
                | ';'
                | ':'
                | '!'
                | '?'
                | '、'
                | '\''
                | '"'
                | '“'
                | '”'
                | '‘'
                | '’'
                | '('
                | '（'
                | ')'
                | '）'
                | '【'
                | '】'
                | '《'
                | '》'
                | '<'
                | '>'
                | '@'
                | '*'
                | '…'
                | '—'
        )
}

/// 提取正文里的全部标签（去掉 #、去重，保持出现顺序）。
/// 语义与前端 extractTags 一致：# 后连续非空白字符，遇空白/标点结束，支持 / 分层。
pub fn extract_tags(content: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let bytes = content.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'#' {
            i += 1;
            continue;
        }
        let start = i + 1;
        let mut end = start;
        for (j, c) in content[start..].char_indices() {
            if is_tag_break(c) {
                break;
            }
            end = start + j + c.len_utf8();
        }
        let tag = &content[start..end];
        if !tag.is_empty() && !tags.iter().any(|t| t == tag) {
            tags.push(tag.to_string());
        }
        i = end;
    }
    tags
}

/// 全量重建一条 memo 的标签关联（先删后插）。
pub fn sync_tags(conn: &Connection, memo_id: i64, content: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM memo_tags WHERE memo_id = ?1", params![memo_id])?;
    for tag in extract_tags(content) {
        conn.execute(
            "INSERT INTO memo_tags (memo_id, tag) VALUES (?1, ?2)",
            params![memo_id, tag],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_and_dedup() {
        assert_eq!(extract_tags(" #读书 #读书 ok"), vec!["读书"]);
    }

    #[test]
    fn hierarchy_and_punct_boundary() {
        assert_eq!(
            extract_tags("#读书/心理学，#工作。结束"),
            vec!["读书/心理学", "工作"]
        );
    }

    #[test]
    fn stops_at_hash() {
        assert_eq!(extract_tags("##a#b"), vec!["a", "b"]);
    }

    #[test]
    fn trailing_and_empty() {
        assert_eq!(extract_tags("#"), Vec::<String>::new());
        assert_eq!(extract_tags("#a"), vec!["a"]);
        assert_eq!(extract_tags("no tags"), Vec::<String>::new());
    }

    #[test]
    fn unicode_tag_body_kept() {
        assert_eq!(extract_tags("#旅行✈️ok"), vec!["旅行✈️ok"]);
    }
}
