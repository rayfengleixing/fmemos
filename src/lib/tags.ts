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
