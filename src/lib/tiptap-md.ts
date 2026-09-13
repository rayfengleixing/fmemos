import {
  BOLD_RE,
  INLINE_CODE_RE,
  IMAGE_RE,
  parseBlocks,
  splitImages,
  splitLinks,
} from "./md";
import { TAG_FULL_RE, TAG_SPLIT_RE } from "./tags";

/**
 * Markdown ↔ ProseMirror 文档 JSON 的双向转换（纯函数，无 DOM 依赖，vitest 可直接测）。
 *
 * 为什么不走 HTML：TipTap 官方 markdown 方案要经 HTML 解析器中转，
 * 对 `#标签`、`image://`、`- [ ]` 这类自定义语法的保真不可控；这里直接
 * 复用卡片渲染器同一套 parseBlocks / 正则规则，打开 = 渲染口径，保存 =
 * 字节级还原。「打开→不动→保存」必须无损，由 tiptap-md.test.ts 兜底。
 */

/** ProseMirror 文档节点的最小结构描述（与 TipTap 的 JSONContent 结构兼容） */
export interface PMMark {
  type: "bold" | "code" | "tag" | "link";
  attrs?: Record<string, unknown>;
}

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: PMMark[];
  text?: string;
}

/* ---------------- md → doc ---------------- */

/** 行内叶子：一段文本带至多一个标记（与渲染器的标记互斥性一致），或一个图片节点 */
interface Leaf {
  text?: string;
  mark?: PMMark;
  image?: { id: number; alt: string };
}

/** 顺序严格镜像渲染器：图片 → 行内代码(字面) → #标签 → URL → **加粗**，标记互斥不嵌套 */
function parseInline(line: string): Leaf[] {
  const out: Leaf[] = [];
  for (const part of splitImages(line)) {
    if (part.kind === "image") {
      out.push({ image: { id: part.id!, alt: part.alt ?? "" } });
    } else {
      parseCodeSegment(part.value, out);
    }
  }
  return mergeLeaves(out);
}

function parseCodeSegment(s: string, out: Leaf[]): void {
  let last = 0;
  for (const m of s.matchAll(INLINE_CODE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) parseTagSegment(s.slice(last, idx), out);
    out.push({ text: m[1], mark: { type: "code" } });
    last = idx + m[0].length;
  }
  if (last < s.length) parseTagSegment(s.slice(last), out);
}

function parseTagSegment(s: string, out: Leaf[]): void {
  for (const part of s.split(TAG_SPLIT_RE)) {
    if (!part) continue;
    if (TAG_FULL_RE.test(part)) {
      out.push({ text: part, mark: { type: "tag", attrs: { tag: part.slice(1) } } });
    } else {
      parseLinkSegment(part, out);
    }
  }
}

function parseLinkSegment(s: string, out: Leaf[]): void {
  for (const part of splitLinks(s)) {
    if (part.kind === "link") {
      out.push({ text: part.value, mark: { type: "link", attrs: { href: part.value } } });
    } else {
      parseBoldSegment(part.value, out);
    }
  }
}

function parseBoldSegment(s: string, out: Leaf[]): void {
  let last = 0;
  for (const m of s.matchAll(BOLD_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: s.slice(last, idx) });
    out.push({ text: m[1], mark: { type: "bold" } });
    last = idx + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
}

/** 相邻同标记的文本叶合并，避免文档碎片化；空文本叶丢弃 */
function mergeLeaves(leaves: Leaf[]): Leaf[] {
  const out: Leaf[] = [];
  const key = (l: Leaf) => JSON.stringify(l.mark ?? null);
  for (const l of leaves) {
    const prev = out[out.length - 1];
    if (
      l.text !== undefined &&
      l.text !== "" &&
      prev?.text !== undefined &&
      key(l) === key(prev)
    ) {
      prev.text += l.text;
    } else if (l.text === "" && l.image === undefined) {
      continue;
    } else {
      out.push({ ...l });
    }
  }
  return out;
}

function inlineNodes(line: string): PMNode[] {
  const nodes: PMNode[] = [];
  for (const leaf of parseInline(line)) {
    if (leaf.image) {
      nodes.push({ type: "memoImage", attrs: { id: leaf.image.id, alt: leaf.image.alt } });
    } else {
      nodes.push({
        type: "text",
        text: leaf.text,
        marks: leaf.mark ? [leaf.mark] : undefined,
      });
    }
  }
  return nodes;
}

function listItem(inline: PMNode[]): PMNode {
  return {
    type: "listItem",
    content: [{ type: "paragraph", content: inline.length ? inline : undefined }],
  };
}

function taskItem(done: boolean, inline: PMNode[]): PMNode {
  return {
    type: "taskItem",
    attrs: { checked: done },
    content: [{ type: "paragraph", content: inline.length ? inline : undefined }],
  };
}

/** Markdown 正文 → TipTap 文档 JSON。空正文返回只有一个空段落的文档。 */
export function mdToDoc(content: string): PMNode {
  const children: PMNode[] = [];
  for (const block of parseBlocks(content)) {
    switch (block.type) {
      case "p": {
        const inline: PMNode[] = [];
        block.lines.forEach((line, i) => {
          if (i > 0) inline.push({ type: "hardBreak" });
          inline.push(...inlineNodes(line));
        });
        children.push({ type: "paragraph", content: inline.length ? inline : undefined });
        break;
      }
      case "ul":
        children.push({
          type: "bulletList",
          content: block.lines.map((l) => listItem(inlineNodes(l))),
        });
        break;
      case "ol":
        children.push({
          type: "orderedList",
          content: block.lines.map((l) => listItem(inlineNodes(l))),
        });
        break;
      case "todo":
        children.push({
          type: "taskList",
          content: block.items.map((it) => taskItem(it.done, inlineNodes(it.text))),
        });
        break;
      case "image":
        // 独占一行的图片 = 只含一个图片节点的段落（序列化时原样回到独占一行）
        children.push({
          type: "paragraph",
          content: [{ type: "memoImage", attrs: { id: block.id, alt: block.alt } }],
        });
        break;
      case "code":
        children.push({
          type: "codeBlock",
          content: [{ type: "text", text: block.lines.join("\n") }],
        });
        break;
    }
  }
  return { type: "doc", content: children.length ? children : [{ type: "paragraph" }] };
}

/* ---------------- doc → md ---------------- */

function codeBlockText(node: PMNode): string {
  return (node.content ?? []).map((c) => c.text ?? "").join("");
}

/** 代码标记内的文本保持字面；加粗补回星号；#标签 / URL 直接输出原文（重解析口径一致） */
function serializeText(node: PMNode): string {
  const marks = node.marks ?? [];
  const t = node.text ?? "";
  if (marks.some((m) => m.type === "code")) return `\`${t}\``;
  if (marks.some((m) => m.type === "bold")) return `**${t}**`;
  return t;
}

function serializeInline(children: PMNode[] | undefined): string {
  let s = "";
  for (const n of children ?? []) {
    if (n.type === "hardBreak") s += "\n";
    else if (n.type === "memoImage") s += `![${n.attrs?.alt ?? "图片"}](image://${n.attrs?.id})`;
    else if (n.type === "text") s += serializeText(n);
  }
  return s;
}

/** 列表项拍平序列化：段落给标记行，嵌套列表（不支持的结构）降级为后续行 */
function serializeListItem(item: PMNode): string[] {
  const lines: string[] = [];
  for (const child of item.content ?? []) {
    if (child.type === "paragraph") {
      const s = serializeInline(child.content);
      if (s !== "") lines.push(...s.split("\n"));
    } else {
      lines.push(...serializeList(child));
    }
  }
  return lines;
}

function serializeList(node: PMNode): string[] {
  const out: string[] = [];
  let index = 1;
  for (const item of node.content ?? []) {
    const body = serializeListItem(item);
    let marker: string;
    if (node.type === "bulletList") marker = "- ";
    else if (node.type === "orderedList") marker = `${index}. `;
    else marker = item.attrs?.checked ? "- [x] " : "- [ ] ";
    out.push(body.length ? marker + body[0] : marker.trimEnd());
    out.push(...body.slice(1));
    index += 1;
  }
  return out;
}

/** TipTap 文档 JSON → Markdown 正文。未知节点类型静默跳过，防脏数据炸掉保存。 */
export function docToMd(doc: PMNode): string {
  const lines: string[] = [];
  // 上一个输出的顶层块是否为「文本段落」：两个相邻文本段落之间必须补空行，
  // 否则「两个段落」会重解析成「一个段落里的软换行」，结构就变了。
  // 图片块段落与正文相邻时保持紧凑（与历史数据的存储习惯一致，解析语义不变）。
  let prevWasTextParagraph = false;
  for (const node of doc.content ?? []) {
    switch (node.type) {
      case "paragraph": {
        const children = node.content ?? [];
        // 只含一个图片节点的段落 = 图片块，独占一行
        if (children.length === 1 && children[0].type === "memoImage") {
          if (prevWasTextParagraph) prevWasTextParagraph = false;
          lines.push(serializeInline(children));
          break;
        }
        const s = serializeInline(children);
        if (s !== "") {
          if (prevWasTextParagraph) lines.push("");
          prevWasTextParagraph = true;
          lines.push(...s.split("\n").filter((l) => l !== ""));
        }
        break;
      }
      case "bulletList":
      case "orderedList":
      case "taskList":
        prevWasTextParagraph = false;
        lines.push(...serializeList(node));
        break;
      case "codeBlock":
        prevWasTextParagraph = false;
        lines.push("```", ...codeBlockText(node).split("\n"), "```");
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
}

/** 图片引用 token（`![图片](image://3)`）→ 图片节点；解析失败返回 null */
export function imageTokenToNode(token: string): PMNode | null {
  const m = new RegExp(`^${IMAGE_RE.source}$`).exec(token.trim());
  if (!m) return null;
  return { type: "memoImage", attrs: { id: Number(m[2]), alt: m[1] } };
}
