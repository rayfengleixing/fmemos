import { Fragment, type ReactNode } from "react";
import { TAG_FULL_RE, TAG_SPLIT_RE } from "./tags";

export type TagClick = (tag: string) => void;

/** 点击第 N 个 TODO 复选框（N 为全篇顺序号） */
export type TodoToggle = (todoIndex: number) => void;

export type Block =
  | { type: "p"; lines: string[] }
  | { type: "ul"; lines: string[] }
  | { type: "ol"; lines: string[] }
  | { type: "todo"; items: { text: string; done: boolean }[] }
  | { type: "image"; id: number; alt: string }
  | { type: "code"; lines: string[] };

const FENCE_RE = /^```/;
const UL_RE = /^-\s+/;
const OL_RE = /^\d+\.\s+/;
/** GFM 风格任务项：`- [ ] 文字` / `- [x] 文字`，`]` 后必须跟空格或行尾 */
const TODO_RE = /^- \[( |x|X)\](?: (.*))?$/;

/** 图片引用：`![alt](image://<id>)`。image:// 是 FMemos 自定义 scheme，指向 images 表 */
export const IMAGE_RE = /!\[([^\]]*)\]\(image:\/\/(\d+)\)/g;
/** 独占一行的图片引用自成图片块 */
const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(image:\/\/(\d+)\)$/;

export type ImageRender = (id: number, alt: string) => ReactNode;

export interface ImagePart {
  kind: "text" | "image";
  value: string;
  /** kind = "image" 时有效 */
  id?: number;
  alt?: string;
}

/** 纯函数：把文本按图片引用切分，供渲染与测试（语法不完整时按普通文本处理） */
export function splitImages(text: string): ImagePart[] {
  const parts: ImagePart[] = [];
  let last = 0;
  for (const m of text.matchAll(IMAGE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push({ kind: "text", value: text.slice(last, idx) });
    parts.push({ kind: "image", value: m[0], id: Number(m[2]), alt: m[1] });
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  return parts;
}

export type ListEnterAction =
  | { type: "exit"; markerLen: number }
  | { type: "continue"; marker: string };

/**
 * 回车落在列表行上时的行为（输入框自动延续标记用）：
 * - 空标记项（只有 `- `、`- [ ]`、`3. ` 这类标记）→ 退出列表，删除本行标记；
 * - 有内容的列表行 → 生成下一行的标记（任务列表新行始终未完成）；
 * - 非列表行、或光标还在标记内部 → null（走默认换行）。
 * caretOffset 为光标在行内的下标（0 = 行首）。
 */
export function listEnterAction(line: string, caretOffset: number): ListEnterAction | null {
  // 任务列表也以 "- " 开头，先判 TODO，避免被无序规则抢先
  const todo = /^- \[( |x|X)\]( ?)/.exec(line);
  const ul = todo ? null : /^- /.exec(line);
  const ol = todo || ul ? null : /^(\d+)\. /.exec(line);
  const marker = todo ?? ul ?? ol;
  if (!marker) return null;

  const markerLen = marker[0].length;
  const contentEmpty = line.slice(markerLen).trim() === "";
  if (contentEmpty && caretOffset >= markerLen) {
    return { type: "exit", markerLen };
  }
  if (caretOffset < markerLen) return null;
  const next = todo ? "- [ ] " : ul ? "- " : `${parseInt(ol![1], 10) + 1}. `;
  return { type: "continue", marker: next };
}
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const BOLD_RE = /\*\*(.+?)\*\*/g;
// URL 只吃 ASCII 及拉丁区字符：遇到空白或 CJK/全角区（U+2000 起）即终止，
// 避免中文标点与后续文字被吞进链接
const URL_RE = /https?:\/\/[^\s\u2000-\u{10FFFF}]+/gu;

/** 去掉 URL 尾部粘连的中英文标点，避免把句读当成链接的一部分 */
export function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?)\]}>、。，；：！？）】》"'“”‘’…—]+$/u, "");
}

export interface LinkPart {
  kind: "text" | "link";
  value: string;
}

/** 纯函数：把文本按 URL 切分（尾随标点并入下一段文本），供渲染与测试 */
export function splitLinks(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let pending = "";
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0;
    pending += text.slice(last, idx);
    const url = trimUrl(m[0]);
    if (pending) parts.push({ kind: "text", value: pending });
    parts.push({ kind: "link", value: url });
    pending = m[0].slice(url.length);
    last = idx + m[0].length;
  }
  pending += text.slice(last);
  if (pending) parts.push({ kind: "text", value: pending });
  return parts;
}

async function openExternal(url: string): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * 纯函数：列出正文里的全部 TODO（含代码块之外的每一行，顺序与 toggleTodo 的下标一致）。
 * 供待办聚合视图使用；跳过 ``` 围栏内的内容，与 parseBlocks / toggleTodo 保持同一套计数。
 */
export function listTodos(content: string): { text: string; done: boolean }[] {
  const out: { text: string; done: boolean }[] = [];
  let inFence = false;
  for (const line of content.split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = TODO_RE.exec(line);
    if (m) out.push({ text: m[2] ?? "", done: m[1] !== " " });
  }
  return out;
}

/** 纯函数：把正文第 todoIndex 个 TODO（与 parseBlocks 的计数一致，跳过代码块）切换完成态 */
export function toggleTodo(content: string, todoIndex: number): string {
  const lines = content.split("\n");
  let inFence = false;
  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = TODO_RE.exec(lines[i]);
    if (!m) continue;
    if (count === todoIndex) {
      // "- [x]" 结构固定：下标 3 是勾选标记
      const mark = m[1] === " " ? "x" : " ";
      lines[i] = lines[i].slice(0, 3) + mark + lines[i].slice(4);
      break;
    }
    count += 1;
  }
  return lines.join("\n");
}

/** 纯函数：把正文切成段落/列表/TODO 列表/代码块，供渲染与测试 */
export function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏（缺失则到 EOF 为止）
      blocks.push({ type: "code", lines: codeLines });
      continue;
    }
    // 独占一行的图片引用自成图片块
    const img = IMAGE_LINE_RE.exec(line.trim());
    if (img) {
      blocks.push({ type: "image", id: Number(img[2]), alt: img[1] });
      i += 1;
      continue;
    }
    if (TODO_RE.test(line)) {
      const items: { text: string; done: boolean }[] = [];
      while (i < lines.length) {
        const m = TODO_RE.exec(lines[i]);
        if (!m) break;
        items.push({ text: m[2] ?? "", done: m[1] !== " " });
        i += 1;
      }
      blocks.push({ type: "todo", items });
      continue;
    }
    if (UL_RE.test(line)) {
      const items: string[] = [];
      // TODO 行也是 "- " 开头，需在此断开自成一组
      while (i < lines.length && UL_RE.test(lines[i]) && !TODO_RE.test(lines[i])) {
        items.push(lines[i].replace(UL_RE, ""));
        i += 1;
      }
      blocks.push({ type: "ul", lines: items });
      continue;
    }
    if (OL_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL_RE.test(lines[i])) {
        items.push(lines[i].replace(OL_RE, ""));
        i += 1;
      }
      blocks.push({ type: "ol", lines: items });
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const pLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE_RE.test(lines[i]) &&
      !TODO_RE.test(lines[i]) &&
      !IMAGE_LINE_RE.test(lines[i].trim()) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i])
    ) {
      pLines.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "p", lines: pLines });
  }
  return blocks;
}

/** 纯函数：把文本按高亮关键词切成段（hit 标记是否命中），不区分大小写 */
export function splitHighlight(
  text: string,
  terms: string[],
): { text: string; hit: boolean }[] {
  const valid = terms.filter((t) => t);
  if (valid.length === 0) return [{ text, hit: false }];
  const escaped = valid.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const lowered = valid.map((t) => t.toLowerCase());
  return text
    .split(re)
    .filter((p) => p !== "")
    .map((p) => ({ text: p, hit: lowered.includes(p.toLowerCase()) }));
}

/** 高亮拆分渲染：命中片段包 <mark>，其余原样 */
function renderHighlight(text: string, highlight?: string[]): ReactNode[] {
  if (!highlight?.length) return [text];
  return splitHighlight(text, highlight).map((seg, i) =>
    seg.hit ? <mark key={i}>{seg.text}</mark> : <Fragment key={i}>{seg.text}</Fragment>,
  );
}

/** **加粗** + 高亮解析（在标签切分之后、不含代码段与链接的文本上执行） */
function renderBold(text: string, highlight?: string[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(BOLD_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) {
      nodes.push(
        <Fragment key={`t${idx}`}>{renderHighlight(text.slice(last, idx), highlight)}</Fragment>,
      );
    }
    nodes.push(<strong key={idx}>{renderHighlight(m[1], highlight)}</strong>);
    last = idx + m[0].length;
  }
  if (last < text.length) {
    nodes.push(
      <Fragment key={`t${last}`}>{renderHighlight(text.slice(last), highlight)}</Fragment>,
    );
  }
  return nodes;
}

/** URL 切分 + **加粗**：链接优先，链接之间的文本再解析加粗（均在标签切分之后执行） */
function renderLinks(text: string, highlight?: string[]): ReactNode[] {
  return splitLinks(text).map((part, i) =>
    part.kind === "link" ? (
      <a
        key={`l${i}`}
        className="link"
        href={part.value}
        onClick={(e) => {
          e.preventDefault();
          void openExternal(part.value);
        }}
      >
        {part.value}
      </a>
    ) : (
      <Fragment key={`t${i}`}>{renderBold(part.value, highlight)}</Fragment>
    ),
  );
}

/** #标签 切分 + 链接/加粗；行内代码段在更外层处理，内部保持字面 */
function renderText(text: string, onTagClick?: TagClick, highlight?: string[]): ReactNode[] {
  return text.split(TAG_SPLIT_RE).map((part, i) => {
    if (TAG_FULL_RE.test(part)) {
      return (
        <span key={i} className="tag" onClick={() => onTagClick?.(part.slice(1))}>
          {part}
        </span>
      );
    }
    return <Fragment key={i}>{renderLinks(part, highlight)}</Fragment>;
  });
}

/** 单行渲染（不含图片引用的文本部分）：先按 `行内代码` 切分，代码保持字面，其余文本做标签+加粗解析 */
function renderLineBase(line: string, onTagClick?: TagClick, highlight?: string[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(INLINE_CODE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) {
      nodes.push(
        <Fragment key={`t${idx}`}>
          {renderText(line.slice(last, idx), onTagClick, highlight)}
        </Fragment>,
      );
    }
    nodes.push(<code key={`c${idx}`}>{m[1]}</code>);
    last = idx + m[0].length;
  }
  if (last < line.length) {
    nodes.push(
      <Fragment key={`t${last}`}>{renderText(line.slice(last), onTagClick, highlight)}</Fragment>,
    );
  }
  return nodes;
}

/** 单行渲染：先切出图片引用（交给 renderImage），其余文本走标签/加粗/行内代码解析 */
function renderLine(
  line: string,
  onTagClick?: TagClick,
  highlight?: string[],
  renderImage?: ImageRender,
): ReactNode[] {
  const parts = splitImages(line);
  if (parts.every((p) => p.kind === "text")) {
    return renderLineBase(line, onTagClick, highlight);
  }
  return parts.map((part, i) =>
    part.kind === "image" ? (
      <Fragment key={`img${i}`}>
        {renderImage ? renderImage(part.id!, part.alt ?? "") : `【${part.alt || "图片"}】`}
      </Fragment>
    ) : (
      <Fragment key={`t${i}`}>{renderLineBase(part.value, onTagClick, highlight)}</Fragment>
    ),
  );
}

export function renderBlocks(
  blocks: Block[],
  onTagClick?: TagClick,
  onToggleTodo?: TodoToggle,
  highlight?: string[],
  renderImage?: ImageRender,
): ReactNode {
  // 全篇 TODO 顺序号：供勾选回写正文时定位（与 toggleTodo 计数一致）
  let todoOffset = 0;
  return blocks.map((block, i) => {
    const todoStart = todoOffset;
    if (block.type === "todo") todoOffset += block.items.length;
    switch (block.type) {
      case "p":
        return (
          <p key={i}>
            {block.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {renderLine(line, onTagClick, highlight, renderImage)}
              </Fragment>
            ))}
          </p>
        );
      case "ul":
        return (
          <ul key={i}>
            {block.lines.map((item, j) => (
              <li key={j}>{renderLine(item, onTagClick, highlight, renderImage)}</li>
            ))}
          </ul>
        );
      case "ol":
        return (
          <ol key={i}>
            {block.lines.map((item, j) => (
              <li key={j}>{renderLine(item, onTagClick, highlight, renderImage)}</li>
            ))}
          </ol>
        );
      case "todo":
        return (
          <ul key={i} className="todo-list">
            {block.items.map((item, j) => (
              <li key={j} className={item.done ? "todo-done" : undefined}>
                <span
                  className="todo-check"
                  role="checkbox"
                  aria-checked={item.done}
                  aria-label={`待办：${item.text || "空"}`}
                  onClick={onToggleTodo ? () => onToggleTodo(todoStart + j) : undefined}
                >
                  {item.done ? "✓" : ""}
                </span>
                <span className="todo-text">
                  {renderLine(item.text, onTagClick, highlight, renderImage)}
                </span>
              </li>
            ))}
          </ul>
        );
      case "image":
        // 独占一行的图片块；没传 renderImage 的只读场景退化为文字占位
        return (
          <div key={i} className="md-image">
            {renderImage ? (
              renderImage(block.id, block.alt)
            ) : (
              <span className="memo-img-fallback">【{block.alt || "图片"}】</span>
            )}
          </div>
        );
      case "code":
        return (
          <pre key={i}>
            <code>{block.lines.join("\n")}</code>
          </pre>
        );
    }
  });
}

export interface RenderOptions {
  onTagClick?: TagClick;
  /** 传入后卡片内 TODO 复选框可点击切换；回顾弹窗等只读场景省略 */
  onToggleTodo?: TodoToggle;
  /** 搜索结果高亮：这些关键词（不区分大小写）用 <mark> 标出；代码与链接内不高亮 */
  highlight?: string[];
  /** 图片引用渲染：传入后 image:// 引用显示为真实图片；省略时退化为【图片】占位 */
  renderImage?: ImageRender;
}

export function renderMarkdown(content: string, opts: RenderOptions = {}): ReactNode {
  return renderBlocks(
    parseBlocks(content),
    opts.onTagClick,
    opts.onToggleTodo,
    opts.highlight,
    opts.renderImage,
  );
}

/**
 * 单行内联渲染（不含 <p> / <ul> 等块级包裹）：#标签 可点、**加粗**、链接、`行内代码`、图片引用。
 * 供待办清单等需要把正文片段放进行内元素（<span>）的场景复用。
 */
export function renderInline(line: string, opts: RenderOptions = {}): ReactNode[] {
  return renderLine(line, opts.onTagClick, opts.highlight, opts.renderImage);
}
