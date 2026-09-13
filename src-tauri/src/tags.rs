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

/// 扫描正文里的每个 `#标签`，回调 (标签前 `#` 的字节下标, 标签结束字节下标, 标签文本)。
/// `#` 后面直接是分隔符或结尾（空标签）时不回调。
/// 所有需要按标签改写正文的操作都走这里，保证边界判定与 extract_tags 完全一致。
fn for_each_tag<'a, F: FnMut(usize, usize, &'a str)>(content: &'a str, mut cb: F) {
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
        if end > start {
            cb(i, end, &content[start..end]);
        }
        // 空标签（"##a"）时 end == start == i + 1，只前进一个字节
        i = end;
    }
}

/// 提取正文里的全部标签（去掉 #、去重，保持出现顺序）。
/// 语义与前端 extractTags 一致：# 后连续非空白字符，遇空白/标点结束，支持 / 分层。
pub fn extract_tags(content: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for_each_tag(content, |_, _, tag| {
        if !tags.iter().any(|t| t == tag) {
            tags.push(tag.to_string());
        }
    });
    tags
}

/// 标签的前缀语义：精确等于 prefix，或是它的子孙（prefix/xxx）。
/// 与 list_memos 里 `mt.tag = ? OR mt.tag LIKE ? || '/%'` 的筛选语义一致，
/// 因此「重命名 / 删除父标签」会连带整个子标签分支。
pub fn tag_has_prefix(tag: &str, prefix: &str) -> bool {
    if tag == prefix {
        return true;
    }
    tag.strip_prefix(prefix)
        .is_some_and(|rest| rest.starts_with('/'))
}

/// 按 (起, 止, 替换文本) 改写正文；无改动返回 None。
/// 区间由 for_each_tag 顺序产出，天然有序且不重叠。
fn apply_edits(content: &str, edits: Vec<(usize, usize, String)>) -> Option<String> {
    if edits.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(content.len());
    let mut cursor = 0;
    for (start, end, repl) in edits {
        out.push_str(&content[cursor..start]);
        out.push_str(&repl);
        cursor = end;
    }
    out.push_str(&content[cursor..]);
    Some(out)
}

/// 把正文里的 `#from` 改写为 `#to`，子孙标签一并改写前缀：
/// `#读书/心理学` → `#阅读/心理学`。注意只改标签边界内的内容，
/// 重命名 `读书` 不会误伤 `#读书笔记`。无改动返回 None。
pub fn rename_tag_in_content(content: &str, from: &str, to: &str) -> Option<String> {
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for_each_tag(content, |hash, end, tag| {
        if tag_has_prefix(tag, from) {
            // from 是 tag 的前缀，from.len() 必落在字符边界上
            edits.push((hash, end, format!("#{to}{}", &tag[from.len()..])));
        }
    });
    apply_edits(content, edits)
}

/// 删除正文里的 `#from`（子孙标签一并删除）。顺手吃掉相邻的一个空格
/// （行首标签吃后面、行尾标签吃前面、其余吃前面），避免留下行首缩进或双空格。
/// 无改动返回 None。
pub fn remove_tag_in_content(content: &str, from: &str) -> Option<String> {
    let bytes = content.as_bytes();
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for_each_tag(content, |hash, end, tag| {
        if !tag_has_prefix(tag, from) {
            return;
        }
        let at_line_start = hash == 0 || bytes[hash - 1] == b'\n';
        let space_after = end < bytes.len() && bytes[end] == b' ';
        let space_before = hash > 0 && bytes[hash - 1] == b' ';
        let (start, stop) = if at_line_start && space_after {
            (hash, end + 1)
        } else if space_before {
            (hash - 1, end)
        } else if space_after {
            (hash, end + 1)
        } else {
            (hash, end)
        };
        edits.push((start, stop, String::new()));
    });
    apply_edits(content, edits)
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

    #[test]
    fn prefix_semantics() {
        assert!(tag_has_prefix("读书", "读书"));
        assert!(tag_has_prefix("读书/心理学", "读书"));
        assert!(!tag_has_prefix("读书笔记", "读书"));
        assert!(!tag_has_prefix("读书", "读书/心理学"));
    }

    #[test]
    fn rename_tag_only_touches_boundaries() {
        // 前缀子串不误伤：改「读书」不动「读书笔记」
        assert_eq!(rename_tag_in_content("#读书笔记 很好", "读书", "阅读"), None);
        // 精确命中
        assert_eq!(
            rename_tag_in_content("#读书 打卡", "读书", "阅读").unwrap(),
            "#阅读 打卡"
        );
        // 子孙标签连带改写前缀
        assert_eq!(
            rename_tag_in_content("今天看了 #读书/心理学 和 #读书/经济", "读书", "阅读").unwrap(),
            "今天看了 #阅读/心理学 和 #阅读/经济"
        );
        // 一行里父与子同时出现，都改
        assert_eq!(
            rename_tag_in_content("#读书 #读书/心理学", "读书", "阅读").unwrap(),
            "#阅读 #阅读/心理学"
        );
        // 无命中
        assert_eq!(rename_tag_in_content("no tags #运动", "读书", "阅读"), None);
        // 空标签不参与
        assert_eq!(rename_tag_in_content("# 空", "读书", "阅读"), None);
    }

    #[test]
    fn remove_tag_cleans_adjacent_space() {
        // 行首标签吃掉后面的空格
        assert_eq!(remove_tag_in_content("#运动 晨跑 5km", "运动").unwrap(), "晨跑 5km");
        // 行尾标签吃掉前面的空格
        assert_eq!(remove_tag_in_content("晨跑 5km #运动", "运动").unwrap(), "晨跑 5km");
        // 行中间标签：吃掉前一个空格，不留双空格
        assert_eq!(remove_tag_in_content("晨跑 #运动 5km", "运动").unwrap(), "晨跑 5km");
        // 独占一行：整行被删掉（含换行），前后文合并前由调用方 trim
        assert_eq!(
            remove_tag_in_content("#运动\n正文", "运动").unwrap(),
            "\n正文"
        );
        // 子孙标签一并删除
        assert_eq!(
            remove_tag_in_content("#读书/心理学 书评", "读书").unwrap(),
            "书评"
        );
        // 不误伤前缀子串
        assert_eq!(remove_tag_in_content("#读书笔记 ok", "读书"), None);
        // 同一条里多个命中一起删
        assert_eq!(
            remove_tag_in_content("#a x #a/子 y", "a").unwrap(),
            "x y"
        );
    }
}
