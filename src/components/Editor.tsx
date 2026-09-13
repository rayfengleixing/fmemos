import { memo, useEffect, useMemo, useRef, useState } from "react";
import TagInput from "./TagInput";
import MemoImage from "./MemoImage";
import { renderMarkdown } from "../lib/md";
import { insertAtCaret, useImagePaste } from "../lib/useImagePaste";

interface Props {
  onCreate: (content: string) => Promise<void>;
  /** quick-open 事件计数：变化时聚焦输入框（全局快捷键呼出窗口用） */
  focusSignal: number;
  /** 全部标签路径（按热度排序），供 # 自动补全 */
  allTags: string[];
  /** 图片上传失败等提示（走 App 的错误横幅） */
  onError?: (message: string) => void;
}

/** 未发送的草稿存 localStorage，重启 / 误关窗口后不丢 */
const DRAFT_KEY = "memos.editor-draft";
/** 实时预览开关的记忆键 */
const PREVIEW_KEY = "memos.editor-preview";

function loadDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function loadPreviewPref(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) === "1";
  } catch {
    return false;
  }
}

function Editor({ onCreate, focusSignal, allTags, onError }: Props) {
  const [content, setContent] = useState(loadDraft);
  const [sending, setSending] = useState(false);
  const [previewOn, setPreviewOn] = useState(loadPreviewPref);
  const ref = useRef<HTMLDivElement>(null);

  // 粘贴 / 拖入图片：入库后在光标处插入 image:// 引用
  const { uploading } = useImagePaste(
    ref,
    (token) => insertAtCaret(ref.current, content, setContent, token),
    onError,
  );

  // 草稿随输入即时保存；发送成功清空后移除
  useEffect(() => {
    try {
      if (content) localStorage.setItem(DRAFT_KEY, content);
      else localStorage.removeItem(DRAFT_KEY);
    } catch {
      // localStorage 不可用时静默跳过
    }
  }, [content]);

  useEffect(() => {
    if (focusSignal > 0) {
      ref.current?.querySelector("textarea")?.focus();
    }
  }, [focusSignal]);

  // 预览渲染结果按内容记忆化：与卡片正文同一套渲染器（含图片、标签、TODO）
  const preview = useMemo(
    () =>
      renderMarkdown(content, {
        renderImage: (id, alt) => <MemoImage id={id} alt={alt} />,
      }),
    [content],
  );

  const togglePreview = () => {
    setPreviewOn((v) => {
      const next = !v;
      try {
        localStorage.setItem(PREVIEW_KEY, next ? "1" : "0");
      } catch {
        // localStorage 不可用时本次会话内仍然生效
      }
      return next;
    });
  };

  const send = async () => {
    const text = content.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onCreate(text);
      setContent("");
      ref.current?.querySelector("textarea")?.focus();
    } catch {
      // 错误横幅已由 App 展示，保留输入内容
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="editor" ref={ref}>
      <TagInput
        value={content}
        onChange={setContent}
        allTags={allTags}
        placeholder="现在，记录点什么..."
        rows={4}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {previewOn && content.trim() ? (
        <div className="editor-preview md">{preview}</div>
      ) : null}
      <div className="editor-footer">
        <span className="editor-hint">
          {uploading
            ? "图片上传中…"
            : "Ctrl + Enter 发送 · # 打标签 · 可直接粘贴图片"}
        </span>
        <button
          className={"editor-toggle" + (previewOn ? " active" : "")}
          title="实时预览 Markdown 渲染效果"
          onClick={togglePreview}
        >
          预览
        </button>
        <button
          className="btn-primary"
          disabled={!content.trim() || sending}
          onClick={() => void send()}
        >
          {sending ? "记录中..." : "记录"}
        </button>
      </div>
    </div>
  );
}

// 按 props 浅比较跳过重渲染：搜索输入时编辑器子树不跟随重渲染
export default memo(Editor);
