//! 数据导入：把 flomo 导出的 HTML、Markdown / 纯文本文件（或整个文件夹）解析成待入库的笔记。
//!
//! 导入是最容易埋雷的功能，这里把几条规矩摆在明面上：
//! - 本模块只解析、不碰库，全是纯函数（写库与去重见 `commands::import_path_impl`），因此可单测；
//! - 去重键是「归一化正文」（行尾统一成 LF + 去掉首尾空白），所以重复导入同一个文件不会翻倍；
//! - 时间戳一律校验并规范成 SQLite 的 `"YYYY-MM-DD HH:MM:SS"`，格式不对就退回文件修改时间；
//! - 解析不出来宁可少导入也不乱导入：空正文直接丢掉，不计入条目。

use std::path::{Path, PathBuf};

/// 解析出来的一条待导入笔记
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedMemo {
    /// 已校验的时间戳 "YYYY-MM-DD HH:MM:SS"；None = 由调用方给兜底时间
    pub created_at: Option<String>,
    pub content: String,
}

/// 去重键：行尾统一成 LF，去掉首尾空白。
/// Windows 下导出的 CRLF 文本和库里的 LF 文本会得到同一个键，重复导入不会翻倍。
pub fn dedup_key(content: &str) -> String {
    normalize_newlines(content).trim().to_string()
}

/// 行尾归一：CRLF / CR → LF（导入的是外部文件，行尾不可控）
pub fn normalize_newlines(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// 时间戳规范化：接受 `YYYY-MM-DD`、`YYYY-MM-DD HH:MM`、`YYYY-MM-DD HH:MM:SS`，
/// 一律补成 `"YYYY-MM-DD HH:MM:SS"`（时分秒缺省补 0）；其余返回 None。
/// 多余的时区后缀（如 `+0800`）忽略——导出里的时间通常已经是本地时间。
pub fn normalize_timestamp(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let (date, time) = match raw.split_once(char::is_whitespace) {
        Some((d, t)) => (d, t.split_whitespace().next().unwrap_or("")),
        None => (raw, ""),
    };
    let d: Vec<&str> = date.split('-').collect();
    if d.len() != 3 {
        return None;
    }
    let (y, mo, da) = (num(d[0], 4)?, num(d[1], 2)?, num(d[2], 2)?);
    if y < 1900 || !(1..=12).contains(&mo) || !(1..=31).contains(&da) {
        return None;
    }
    let (h, mi, s) = if time.is_empty() {
        (0, 0, 0)
    } else {
        let p: Vec<&str> = time.split(':').collect();
        if p.len() > 3 {
            return None;
        }
        let h = num(p[0], 2)?;
        let mi = match p.get(1) {
            Some(v) => num(v, 2)?,
            None => 0,
        };
        let s = match p.get(2) {
            Some(v) => num(v, 2)?,
            None => 0,
        };
        (h, mi, s)
    };
    if h > 23 || mi > 59 || s > 59 {
        return None;
    }
    Some(format!("{y:04}-{mo:02}-{da:02} {h:02}:{mi:02}:{s:02}"))
}

/// 定长纯数字解析："9" -> 9，"09" -> 9；含非数字或超长返回 None
fn num(s: &str, max_len: usize) -> Option<u32> {
    if s.is_empty() || s.len() > max_len || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// 分节小标题：`## 2021-04-05 09:43:21`（flomo 的 Markdown 导出就是这个格式），
/// `###` 之类不当分节标题，避免把正文里的小标题也切开。
pub fn section_timestamp(line: &str) -> Option<String> {
    let t = line.trim();
    let rest = t.strip_prefix("## ").or_else(|| t.strip_prefix("##\t"))?;
    normalize_timestamp(rest)
}

/// 把 Markdown 正文按 `## 时间` 分节。
/// 文档里没有这种小标题时整段算一条（时间用 fallback）；
/// 有分节时，分节之前的前言（如导出文件的标题）会被丢弃。
pub fn split_markdown_sections(text: &str, fallback: Option<&str>) -> Vec<ImportedMemo> {
    let text = normalize_newlines(text);
    let lines: Vec<&str> = text.lines().collect();
    let mut sections: Vec<(String, Vec<&str>)> = Vec::new();
    for line in &lines {
        match section_timestamp(line) {
            Some(ts) => sections.push((ts, Vec::new())),
            None => {
                if let Some(last) = sections.last_mut() {
                    last.1.push(line);
                }
            }
        }
    }
    if sections.is_empty() {
        let body = text.trim().to_string();
        if body.is_empty() {
            return Vec::new();
        }
        return vec![ImportedMemo {
            created_at: fallback.and_then(normalize_timestamp),
            content: body,
        }];
    }
    sections
        .into_iter()
        .map(|(ts, body)| ImportedMemo {
            created_at: Some(ts),
            content: trim_section_body(&body),
        })
        .filter(|m| !m.content.is_empty())
        .collect()
}

/// 分节正文收尾：去掉首尾空行与导出时的 `---` 分隔线
fn trim_section_body(lines: &[&str]) -> String {
    let mut lines: Vec<&str> = lines.iter().map(|l| l.trim_end()).collect();
    while lines.first().is_some_and(|l| l.trim().is_empty()) {
        lines.remove(0);
    }
    while lines
        .last()
        .is_some_and(|l| l.trim().is_empty() || l.trim() == "---")
    {
        lines.pop();
    }
    lines.join("\n").trim().to_string()
}

/// 读文件为文本。非法 UTF-8 字节按替换字符处理，保证不崩。
pub fn read_text(path: &Path) -> Result<String, String> {
    let raw = std::fs::read(path).map_err(|e| format!("读不了 {}：{e}", path.display()))?;
    Ok(String::from_utf8_lossy(&raw).to_string())
}

/// 小写扩展名（不含点）
pub fn extension_of(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// 按扩展名解析文本内容：`.html` / `.htm` 走 flomo 导出解析，其余按 Markdown 分节。
/// fallback 为时间兜底（通常是文件修改时间）。
pub fn parse_text(text: &str, ext: &str, fallback: Option<&str>) -> Vec<ImportedMemo> {
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    let mut memos = if ext == "html" || ext == "htm" {
        parse_flomo_html(text)
    } else {
        split_markdown_sections(text, fallback)
    };
    if let Some(fb) = fallback.and_then(normalize_timestamp) {
        for m in &mut memos {
            if m.created_at.is_none() {
                m.created_at = Some(fb.clone());
            }
        }
    }
    memos
}

/// 递归收集可导入的文本文件（.md / .markdown / .txt / .html / .htm），按路径排序保证顺序稳定。
/// 传单个文件时直接返回它。
pub fn collect_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    if root.is_file() {
        return Ok(vec![root.to_path_buf()]);
    }
    if !root.is_dir() {
        return Err("找不到这个路径".into());
    }
    let mut out: Vec<PathBuf> = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败：{e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if is_importable(&path) {
                out.push(path);
            }
        }
    }
    out.sort();
    Ok(out)
}

fn is_importable(path: &Path) -> bool {
    matches!(
        extension_of(path).as_str(),
        "md" | "markdown" | "txt" | "html" | "htm"
    )
}

/// 解析 flomo「导出全部（HTML）」：每条笔记一个 `<div class="memo">`，
/// 内含 `<div class="time">时间</div>` 和 `<div class="content">正文</div>`。
/// 属性顺序、单双引号、额外 class 都不影响识别。
pub fn parse_flomo_html(html: &str) -> Vec<ImportedMemo> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some((start, end)) = find_div_block(rest, "memo") {
        let block = &rest[start..end];
        let created_at =
            find_div_block(block, "time").and_then(|(s, e)| normalize_timestamp(&html_to_text(&block[s..e])));
        let content = find_div_block(block, "content")
            .map(|(s, e)| html_to_text(&block[s..e]))
            .unwrap_or_default();
        let content = content.trim().to_string();
        if !content.is_empty() {
            out.push(ImportedMemo {
                created_at,
                content,
            });
        }
        rest = &rest[end..];
    }
    if out.is_empty() {
        // 兜底：没有 memo 包裹层时，按「时间块 + 紧随其后的正文块」配对
        out = pair_time_and_content(html);
    }
    out
}

/// 兜底配对：逐个找 `class="time"`，再吃紧跟在它后面的 `class="content"`
fn pair_time_and_content(html: &str) -> Vec<ImportedMemo> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some((ts, te)) = find_div_block(rest, "time") {
        let created_at = normalize_timestamp(&html_to_text(&rest[ts..te]));
        let after = &rest[te..];
        let Some((cs, ce)) = find_div_block(after, "content") else {
            rest = after;
            continue;
        };
        let content = html_to_text(&after[cs..ce]).trim().to_string();
        if !content.is_empty() {
            out.push(ImportedMemo {
                created_at,
                content,
            });
        }
        rest = &after[ce..];
    }
    out
}

/// 找 class 里含 `class` 的 `<div ...>`，返回（内容起点, 内容终点）；找不到返回 None。
/// 内容终点按标签配对计算，所以正文里嵌 `<div>` 也不会截断。
fn find_div_block(hay: &str, class: &str) -> Option<(usize, usize)> {
    let bytes = hay.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let tail = &bytes[i..];
        if tail.len() >= 5
            && tail[..4].eq_ignore_ascii_case(b"<div")
            && (tail[4] == b'>' || tail[4].is_ascii_whitespace())
        {
            if let Some(tag_end) = hay[i..].find('>') {
                if has_class_token(&hay[i + 4..i + tag_end], class) {
                    let start = i + tag_end + 1;
                    return Some((start, matching_div_end(hay, start)));
                }
            }
        }
        i += 1;
    }
    None
}

/// 从 div 内容起点开始找配对的 `</div>` 下标；找不到就返回末尾
fn matching_div_end(hay: &str, from: usize) -> usize {
    let bytes = hay.as_bytes();
    let mut depth = 1usize;
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let tail = &bytes[i..];
        if tail.len() >= 5 && tail[..5].eq_ignore_ascii_case(b"</div") {
            let next = tail.get(5).copied();
            if matches!(next, Some(b'>')) || next.is_some_and(|b| b.is_ascii_whitespace()) {
                depth -= 1;
                if depth == 0 {
                    return i;
                }
            }
        } else if tail.len() >= 5
            && tail[..4].eq_ignore_ascii_case(b"<div")
            && (tail[4] == b'>' || tail[4].is_ascii_whitespace())
        {
            depth += 1;
        }
        i += 1;
    }
    hay.len()
}

/// 属性串里是否有 `class="..."` 且其中含指定 class token（class 名不区分大小写）。
/// 前面必须是空白，避免匹配到 `data-class` / `myclass` 之类。
fn has_class_token(attrs: &str, class: &str) -> bool {
    let lower = attrs.to_ascii_lowercase();
    let want = class.to_ascii_lowercase();
    let mut from = 0;
    while let Some(rel) = lower[from..].find("class") {
        let at = from + rel;
        from = at + 5;
        if at > 0 && !attrs.as_bytes()[at - 1].is_ascii_whitespace() {
            continue;
        }
        let rest = lower[at + 5..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start();
        match rest.chars().next() {
            Some(q @ ('"' | '\'')) => {
                let Some(end) = rest[1..].find(q) else {
                    continue;
                };
                if rest[1..1 + end].split_whitespace().any(|t| t == want) {
                    return true;
                }
            }
            _ => {
                // 无引号值：取到空白为止
                if rest
                    .split_whitespace()
                    .next()
                    .is_some_and(|v| v.split_whitespace().any(|t| t == want))
                {
                    return true;
                }
            }
        }
    }
    false
}

/// HTML 片段转纯文本：`<br>` 与块级结束标签转换行，其余标签去掉，常见实体解码。
/// 文本里的连续空白按 HTML 规则折成一个空格（源文件里的缩进与换行不会漏进正文），
/// 最后压缩空行——导入后就是一条卡片的正文。
pub fn html_to_text(html: &str) -> String {
    let mut s = String::with_capacity(html.len());
    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let Some(rel) = html[i..].find('>') else {
                break;
            };
            let tag = &html[i + 1..i + rel];
            let name: String = tag
                .trim_start_matches('/')
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_ascii_lowercase();
            match name.as_str() {
                "br" => s.push('\n'),
                // 只在结束标签处换行：`<p>a</p><p>b</p>` 得到 a、b 两行，
                // 而不是被空行隔开的两段
                "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote"
                | "section" | "article" => {
                    if tag.starts_with('/') {
                        s.push('\n');
                    }
                }
                _ => {}
            }
            i += rel + 1;
            continue;
        }
        let ch = html[i..].chars().next().unwrap();
        i += ch.len_utf8();
        if ch.is_whitespace() {
            if !s.ends_with(' ') && !s.ends_with('\n') {
                s.push(' ');
            }
            continue;
        }
        s.push(ch);
    }
    tidy_lines(&decode_entities(&s))
}

/// 解码常见 HTML 实体（含 `&#123;` / `&#x1f;` 数字实体）
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find('&') {
        out.push_str(&rest[..idx]);
        let tail = &rest[idx..];
        match tail.find(';').filter(|semi| *semi <= 12) {
            Some(semi) => match decode_entity(&tail[1..semi]) {
                Some(c) => {
                    out.push(c);
                    rest = &tail[semi + 1..];
                }
                None => {
                    out.push('&');
                    rest = &tail[1..];
                }
            },
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn decode_entity(ent: &str) -> Option<char> {
    match ent {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" | "ensp" | "emsp" | "thinsp" => Some(' '),
        "mdash" => Some('—'),
        "ndash" => Some('–'),
        "hellip" => Some('…'),
        "copy" => Some('©'),
        _ => {
            let digits = ent.strip_prefix('#')?;
            let code = match digits.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => digits.parse().ok()?,
            };
            char::from_u32(code)
        }
    }
}

/// 逐行去掉首尾空白、压缩连续空行、去掉首尾空行
fn tidy_lines(s: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for line in s.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            if out.is_empty() || out.last().copied() == Some("") {
                continue;
            }
            out.push("");
        } else {
            out.push(line);
        }
    }
    while out.last().copied() == Some("") {
        out.pop();
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_normalized_and_rejected() {
        assert_eq!(
            normalize_timestamp("2021-04-05 09:43:21"),
            Some("2021-04-05 09:43:21".into())
        );
        // 缺秒、缺时分都补齐
        assert_eq!(
            normalize_timestamp("2021-04-05 09:43"),
            Some("2021-04-05 09:43:00".into())
        );
        assert_eq!(
            normalize_timestamp("2021-4-5"),
            Some("2021-04-05 00:00:00".into())
        );
        // 带时区后缀：忽略后缀，保留本地时间
        assert_eq!(
            normalize_timestamp("2021-04-05 09:43:21 +0800"),
            Some("2021-04-05 09:43:21".into())
        );
        for bad in ["", "昨天", "2021/04/05", "2021-13-05", "2021-04-05 25:00:00"] {
            assert_eq!(normalize_timestamp(bad), None, "{bad} 不该被当成合法时间");
        }
    }

    #[test]
    fn dedup_key_ignores_crlf_and_padding() {
        assert_eq!(dedup_key("a\r\nb\r\n"), dedup_key("  a\nb  "));
    }

    #[test]
    fn markdown_sections_split_and_drop_prelude() {
        let text = "# FMemos 导出\n\n> 导出时间：2026-01-01 · 共 2 条\n\n\
                    ## 2021-04-05 09:43:21\n\n第一条\n\n---\n\n\
                    ## 2021-04-06 10:00:00\n\n第二条\n- [ ] 待办\n\n---\n";
        let memos = split_markdown_sections(text, None);
        assert_eq!(memos.len(), 2);
        assert_eq!(memos[0].created_at.as_deref(), Some("2021-04-05 09:43:21"));
        assert_eq!(memos[0].content, "第一条");
        assert_eq!(memos[1].content, "第二条\n- [ ] 待办");
    }

    #[test]
    fn markdown_without_sections_is_one_memo() {
        let memos = split_markdown_sections("随手写的一行\r\n第二行", Some("2026-01-02 03:04:05"));
        assert_eq!(memos.len(), 1);
        assert_eq!(memos[0].content, "随手写的一行\n第二行");
        assert_eq!(memos[0].created_at.as_deref(), Some("2026-01-02 03:04:05"));
        // 空文件不产生条目
        assert!(split_markdown_sections("   \n\n", None).is_empty());
    }

    #[test]
    fn flomo_html_parsed_with_entities_and_nesting() {
        let html = r#"<html><body>
<div class="memo">
  <div class="time">2021-04-05 09:43:21</div>
  <div class="content"><p>第一条 &amp; 有点意思</p><div><p>第二段 &lt;标签&gt;</p></div></div>
</div>
<div class='memo'>
  <div class='time'>2021-04-06 10:00:00</div>
  <div class='content'><p>第二条<br>换行</p></div>
</div>
</body></html>"#;
        let memos = parse_flomo_html(html);
        assert_eq!(memos.len(), 2);
        assert_eq!(memos[0].created_at.as_deref(), Some("2021-04-05 09:43:21"));
        assert_eq!(memos[0].content, "第一条 & 有点意思\n第二段 <标签>");
        assert_eq!(memos[1].content, "第二条\n换行");
    }

    #[test]
    fn flomo_html_without_memo_wrapper_falls_back_to_pairing() {
        let html = r#"<div class="time">2021-04-05 09:43:21</div><div class="content"><p>裸结构</p></div>"#;
        let memos = parse_flomo_html(html);
        assert_eq!(memos.len(), 1);
        assert_eq!(memos[0].content, "裸结构");
    }

    #[test]
    fn html_to_text_ignores_scripts_and_decodes_numbers() {
        assert_eq!(html_to_text("<p>a</p><p>b</p>"), "a\nb");
        assert_eq!(html_to_text("&#65;&#x42;"), "AB");
        assert_eq!(html_to_text("<p>&nbsp;空格</p>"), "空格");
        // 源文件里的缩进与换行不能漏进正文（HTML 会把连续空白折成一个空格）
        assert_eq!(html_to_text("\n    <p>a</p>\n    <p>b</p>\n  "), "a\nb");
    }

    #[test]
    fn parse_text_dispatches_by_extension() {
        let html = r#"<div class="memo"><div class="time">2021-04-05 09:43:21</div><div class="content">x</div></div>"#;
        assert_eq!(parse_text(html, "html", None)[0].content, "x");
        // 扩展名大小写、带点都能认
        assert_eq!(parse_text(html, ".HTML", None)[0].content, "x");
        assert_eq!(parse_text("纯文本", "md", None)[0].content, "纯文本");
    }

    #[test]
    fn collect_files_walks_directories_and_filters_extensions() {
        let dir = crate::commands::tests_support::temp_dir("import-collect");
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("a.md"), "x").unwrap();
        std::fs::write(dir.join("b.txt"), "x").unwrap();
        std::fs::write(dir.join("c.html"), "x").unwrap();
        std::fs::write(dir.join("skip.png"), "x").unwrap();
        std::fs::write(dir.join("nested/d.markdown"), "x").unwrap();

        let files = collect_files(&dir).unwrap();
        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["a.md", "b.txt", "c.html", "d.markdown"]);
        // 传单个文件时原样返回
        assert_eq!(collect_files(&dir.join("a.md")).unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
