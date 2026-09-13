import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type Editor,
  type ReactNodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Placeholder } from "@tiptap/extensions";
import { Extension, Mark, Node, markInputRule, markPasteRule, mergeAttributes } from "@tiptap/core";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import MemoImage from "./MemoImage";
import { docToMd, mdToDoc } from "../lib/tiptap-md";

/**
 * TipTap 所见即所得编辑器（0.12.0 起，替代 TagTextarea）：
 * - 打字即时渲染：**加粗**、`行内代码`、任务复选框、列表、图片节点全部实时成型
 * - 存储仍是纯 Markdown：加载走 mdToDoc（复用卡片渲染器同一套 parseBlocks），
 *   保存走 docToMd，「打开→不动→保存」字节级无损（tiptap-md.test.ts 兜底）
 * - # 标签自动补全用 @tiptap/suggestion 重做，交互与旧 TagInput 一致
 */

interface Props {
  /** 受控的 Markdown 源文本 */
  value: string;
  onChange: (md: string) => void;
  /** 全部标签路径（按热度排序），供 # 自动补全 */
  allTags: string[];
  placeholder?: string;
  autoFocus?: boolean;
  /**
   * 补全弹层未消费的按键透传（Ctrl/Cmd+Enter 发送、Esc 取消编辑等）。
   * 返回 true 表示已处理（调用方负责 preventDefault），TipTap 不再接管。
   */
  onKeyDown?: (e: KeyboardEvent) => boolean;
  /** 编辑器实例外泄：父组件用它聚焦 / 插入图片 */
  editorRef?: RefObject<Editor | null>;
}

/* ---------------- 自定义扩展 ---------------- */

/**
 * v3 的 bold 输入/粘贴规则要求 `**` 前是行首或空白（防英文单词内误触发），
 * 但这废掉了中文最常见的「这是**加粗**文字」写法。这里补一条无前缀约束的规则；
 * 内容首尾不能是空格，避免 "2 ** 3 ** 5" 这类文本被误转。
 */
const CjkBoldRule = Extension.create({
  name: "cjkBoldRule",
  addInputRules() {
    return [
      markInputRule({
        find: /\*\*(\S(?:[^*]*\S)?)\*\*$/,
        type: this.editor.schema.marks.bold,
      }),
    ];
  },
  addPasteRules() {
    return [
      markPasteRule({
        find: /\*\*(\S(?:[^*]*\S)?)\*\*/g,
        type: this.editor.schema.marks.bold,
      }),
    ];
  },
});

/** #标签 mark：文本自带 # 号，仅负责高亮样式（存储层无特殊处理） */
const TagMark = Mark.create({
  name: "tag",
  inclusive: false,
  addAttributes() {
    return { tag: { default: "" } };
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "tag" }), 0];
  },
});

/** image:// 图片节点：inline atom，React 节点视图复用 MemoImage（懒加载 + 点击放大） */
const MemoImageNode = Node.create({
  name: "memoImage",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes() {
    return {
      id: { default: 0 },
      alt: { default: "图片" },
    };
  },
  renderHTML() {
    return ["span", { "data-memo-image": "true" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MemoImageView);
  },
});

const MemoImageView = ({ node }: ReactNodeViewProps) => (
  <NodeViewWrapper as="span" className="memo-img-wrap">
    <MemoImage id={node.attrs.id as number} alt={(node.attrs.alt as string) ?? "图片"} />
  </NodeViewWrapper>
);

const MAX_SUGGESTIONS = 6;

interface SuggestState {
  items: string[];
  active: number;
  /** 弹层锚点：# 字符在视口中的矩形（每次渲染回调刷新） */
  rect: DOMRect | null;
}

/**
 * # 标签自动补全：@tiptap/suggestion 插件 + 自绘弹层（定位在编辑器容器内，不引 tippy）。
 * ↑↓ 选择、Enter/Tab 确认（补成 "#标签 "）、Esc 关闭（下一条输入会重新唤起）。
 */
function createTagSuggestion(
  allTagsRef: RefObject<string[]>,
  onState: (s: SuggestState | null) => void,
) {
  return Extension.create({
    name: "tagSuggestion",
    addProseMirrorPlugins() {
      const editor = this.editor;
      let active = 0;
      const applyState = (props: SuggestionProps | null) => {
        if (!props) {
          onState(null);
          return;
        }
        const items = props.items as string[];
        if (active >= items.length) active = 0;
        onState(items.length ? { items, active, rect: props.clientRect?.() ?? null } : null);
      };
      return [
        Suggestion({
          editor,
          char: "#",
          allowSpaces: false,
          items: ({ query }) =>
            allTagsRef.current
              .filter((t) => t.toLowerCase().includes(query.toLowerCase()))
              .slice(0, MAX_SUGGESTIONS),
          command: ({ editor: ed, range, props: tag }) => {
            ed.chain().focus().deleteRange(range).insertContent(`#${tag} `).run();
          },
          // 行内代码与代码块里不触发补全
          allow: ({ state, range }) => {
            const $from = state.doc.resolve(range.from);
            if ($from.parent.type.name === "codeBlock") return false;
            return !$from.marks().some((m) => m.type.name === "code");
          },
          render: () => {
            // 键盘事件回调里要用到最新 suggestion 上下文（v3 的 keydown props 不带它），闭包暂存
            let current: SuggestionProps | null = null;
            return {
              onStart: (props) => {
                current = props;
                active = 0;
                applyState(props);
              },
              onUpdate: (props) => {
                current = props;
                applyState(props);
              },
              onExit: () => {
                current = null;
                applyState(null);
              },
              onKeyDown: ({ event }) => {
                if (!current) return false;
                const items = current.items as string[];
                if (!items.length) return false;
                if (event.key === "ArrowDown") {
                  active = (active + 1) % items.length;
                  applyState(current);
                  return true;
                }
                if (event.key === "ArrowUp") {
                  active = (active - 1 + items.length) % items.length;
                  applyState(current);
                  return true;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  // Ctrl/Cmd+Enter（发送）不拦截，透传给编辑器的 handleKeyDown
                  if (event.ctrlKey || event.metaKey) return false;
                  current.command(items[active]);
                  return true;
                }
                if (event.key === "Escape") {
                  onState(null);
                  return true;
                }
                return false;
              },
            };
          },
        }),
      ];
    },
  });
}

/* ---------------- 组件 ---------------- */

export default function RichEditor({
  value,
  onChange,
  allTags,
  placeholder,
  autoFocus,
  onKeyDown,
  editorRef,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [suggest, setSuggest] = useState<SuggestState | null>(null);
  // 回调进 ref，扩展/编辑器只创建一次
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;
  const allTagsRef = useRef(allTags);
  allTagsRef.current = allTags;
  const suggestRef = useRef<SuggestState | null>(null);
  suggestRef.current = suggest;

  const extensions = [
    // 渲染器不支持的结构全部禁用，从源头杜绝「存了但渲染不出来」
    StarterKit.configure({
      heading: false,
      blockquote: false,
      italic: false,
      strike: false,
      underline: false,
      horizontalRule: false,
      link: { autolink: true, openOnClick: false },
    }),
    TaskList,
    TaskItem.configure({ nested: false }),
    Placeholder.configure({ placeholder: placeholder ?? "" }),
    TagMark,
    MemoImageNode,
    CjkBoldRule,
    createTagSuggestion(allTagsRef, setSuggest),
  ];

  const editor = useEditor({
    extensions,
    content: mdToDoc(value),
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: { class: "md rich-content" },
      handleKeyDown: (_view, event) => onKeyDownRef.current?.(event) ?? false,
    },
    onUpdate: ({ editor: ed }) => onChangeRef.current(docToMd(ed.getJSON())),
  });

  useEffect(() => {
    if (editorRef) editorRef.current = editor;
    return () => {
      if (editorRef) editorRef.current = null;
    };
  }, [editor, editorRef]);

  // 外部 value 变化（草稿恢复 / 清空 / 取消编辑）且与当前内容不同时才重置文档，避免光标跳动
  useEffect(() => {
    if (!editor) return;
    if (value !== docToMd(editor.getJSON())) {
      editor.commands.setContent(mdToDoc(value), { emitUpdate: false });
    }
  }, [value, editor]);

  return (
    <div className="rich-editor" ref={wrapRef}>
      <EditorContent editor={editor} />
      {suggest && editor && (
        <SuggestPopup
          state={suggest}
          wrapRef={wrapRef}
          onPick={(tag) => {
            applySuggest(editor, tag);
            setSuggest(null);
          }}
          onHover={(i) => setSuggest({ ...suggest, active: i })}
        />
      )}
    </div>
  );
}

/** 鼠标点选补全项：把 #query 替换成完整标签（与键盘 Enter 同一条路径） */
function applySuggest(editor: Editor, tag: string) {
  const { state } = editor;
  const { from } = state.selection;
  const before = state.doc.textBetween(Math.max(0, from - 40), from, "\n");
  const m = /#([^\s#,，。.;:;!!??、'"“”‘’()（）【】《》<>@*…—]*)$/.exec(before);
  if (!m) return;
  const start = from - m[0].length;
  editor
    .chain()
    .focus()
    .deleteRange({ from: start, to: from })
    .insertContent(`#${tag} `)
    .run();
}

function SuggestPopup({
  state,
  wrapRef,
  onPick,
  onHover,
}: {
  state: SuggestState;
  wrapRef: RefObject<HTMLDivElement | null>;
  onPick: (tag: string) => void;
  onHover: (index: number) => void;
}) {
  // 锚点矩形换算成容器内坐标（补全层 position: absolute）
  let style: CSSProperties | undefined;
  const wrapRect = wrapRef.current?.getBoundingClientRect();
  if (state.rect && wrapRect) {
    style = {
      left: Math.max(0, state.rect.left - wrapRect.left),
      top: state.rect.bottom - wrapRect.top + 4,
    };
  }
  return (
    <div className="tag-suggest" style={style}>
      {state.items.map((t, i) => (
        <button
          key={t}
          type="button"
          className={"tag-suggest-item" + (i === state.active ? " hl" : "")}
          // mousedown 防止抢焦点导致编辑器失焦
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(t);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="tag-hash">#</span>
          {t}
        </button>
      ))}
    </div>
  );
}

/** 在光标处插入图片节点：空段落就地插，有文字时另起一段（图片独占一行） */
export function insertImageRef(editor: Editor | null, id: number, alt = "图片") {
  if (!editor) return;
  const { $from } = editor.state.selection;
  const attrs = { id, alt };
  if ($from.parent.content.size === 0) {
    editor.chain().focus().insertContent({ type: "memoImage", attrs }).run();
  } else {
    editor
      .chain()
      .focus()
      .insertContentAt(editor.state.selection, {
        type: "paragraph",
        content: [{ type: "memoImage", attrs }],
      })
      .run();
  }
}
