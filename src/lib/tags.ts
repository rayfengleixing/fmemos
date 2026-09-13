import type { Memo, TagNode } from "./types";

/**
 * flomo 的 #tag 语法：# 后连续的非空白字符，遇到空白或常见标点即结束；
 * 支持 / 分层，如 #读书/心理学。
 */
const TAG_BODY_CLASS = String.raw`[^\s#,，。.;:;!!??、'"“”‘’()（）【】《》<>@*…—]`;
const TAG_BODY = TAG_BODY_CLASS + "+";

/** 匹配内容中的所有标签，捕获组为去掉 # 的标签路径 */
export const TAG_RE = new RegExp(`#(${TAG_BODY})`, "gu");

/** 整段恰好是一个 #tag（渲染时判定 split 片段是否为标签，避免 "C#" 之类误判） */
export const TAG_FULL_RE = new RegExp(`^#${TAG_BODY}$`, "u");

/** 光标前文本末尾的半个标签（#自动补全用）：# 后跟 0 个或多个标签字符直到行尾 */
export const TAG_PARTIAL_RE = new RegExp(`#(${TAG_BODY_CLASS}*)$`, "u");

/** 用于 split 的版本，捕获组保留 #tag 整体，方便渲染时高亮 */
export const TAG_SPLIT_RE = new RegExp(`(#(?:${TAG_BODY}))`, "gu");

export function extractTags(content: string): string[] {
  return [...new Set([...content.matchAll(TAG_RE)].map((m) => m[1]))];
}

/**
 * 标签前缀语义：精确等于 prefix，或是它的子孙（prefix/xxx）。
 * 与后端 tags.rs 的 tag_has_prefix 保持一致——所以重命名/删除父标签会连带整个子分支。
 */
export function tagMatchesPrefix(tag: string, prefix: string): boolean {
  return tag === prefix || tag.startsWith(`${prefix}/`);
}

/** 会被某个标签操作（重命名 / 删除）影响的笔记数，含子孙标签 */
export function countMemosWithTag(memos: Memo[], tag: string): number {
  return memos.filter((m) => extractTags(m.content).some((t) => tagMatchesPrefix(t, tag)))
    .length;
}

/** 逐个扫描正文里的 #标签，回调 (标签前 # 的下标, 标签结束下标, 标签文本) */
function forEachTag(
  content: string,
  cb: (hashIndex: number, endIndex: number, tag: string) => void,
): void {
  const re = new RegExp(`#(${TAG_BODY})`, "gu");
  let m: RegExpExecArray | null;
  // TAG_BODY 至少一个字符，不会出现空匹配死循环
  while ((m = re.exec(content)) !== null) {
    cb(m.index, m.index + m[0].length, m[1]);
  }
}

/** 按 (起, 止, 替换文本) 重写正文；无改动返回 null */
function applyEdits(content: string, edits: [number, number, string][]): string | null {
  if (edits.length === 0) return null;
  let out = "";
  let cursor = 0;
  for (const [start, end, repl] of edits) {
    out += content.slice(cursor, start) + repl;
    cursor = end;
  }
  return out + content.slice(cursor);
}

/**
 * 把正文里的 `#from` 改写为 `#to`，子孙标签一并改写前缀。
 * 语义与后端 tags::rename_tag_in_content 一致（仅供浏览器 mock 使用，正式路径走后端）。
 */
export function renameTagInContent(content: string, from: string, to: string): string | null {
  const edits: [number, number, string][] = [];
  forEachTag(content, (hash, end, tag) => {
    if (tagMatchesPrefix(tag, from)) {
      edits.push([hash, end, `#${to}${tag.slice(from.length)}`]);
    }
  });
  return applyEdits(content, edits);
}

/**
 * 删除正文里的 `#from`（子孙标签一并删除），并吃掉相邻的一个空格。
 * 语义与后端 tags::remove_tag_in_content 一致（仅供浏览器 mock 使用）。
 */
export function removeTagInContent(content: string, from: string): string | null {
  const edits: [number, number, string][] = [];
  forEachTag(content, (hash, end, tag) => {
    if (!tagMatchesPrefix(tag, from)) return;
    const atLineStart = hash === 0 || content[hash - 1] === "\n";
    const spaceAfter = content[end] === " ";
    const spaceBefore = hash > 0 && content[hash - 1] === " ";
    let start = hash;
    let stop = end;
    if (atLineStart && spaceAfter) stop = end + 1;
    else if (spaceBefore) start = hash - 1;
    else if (spaceAfter) stop = end + 1;
    edits.push([start, stop, ""]);
  });
  return applyEdits(content, edits);
}

/** 把笔记里的标签路径（#读书/心理学 → "读书/心理学"）构建成标签树，父级计数含所有子孙 */
export function buildTagTree(memos: Memo[]): TagNode[] {
  const root: TagNode = { name: "", path: "", count: 0, children: [] };
  for (const memo of memos) {
    for (const full of extractTags(memo.content)) {
      let node = root;
      for (const part of full.split("/")) {
        let child = node.children.find((c) => c.name === part);
        if (!child) {
          child = {
            name: part,
            path: node.path ? `${node.path}/${part}` : part,
            count: 0,
            children: [],
          };
          node.children.push(child);
        }
        child.count++;
        node = child;
      }
    }
  }
  sortTree(root.children);
  return root.children;
}

function sortTree(nodes: TagNode[]) {
  nodes.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  for (const node of nodes) sortTree(node.children);
}
