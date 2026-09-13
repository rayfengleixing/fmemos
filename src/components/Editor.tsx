import { memo, useEffect, useRef, useState } from "react";
import type { Editor as TipTapEditor } from "@tiptap/react";
import RichEditor, { insertImageRef } from "./RichEditor";
import { useImagePaste } from "../lib/useImagePaste";

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

function loadDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function Editor({ onCreate, focusSignal, allTags, onError }: Props) {
  const [content, setContent] = useState(loadDraft);
  const [sending, setSending] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<TipTapEditor | null>(null);

  // 粘贴 / 拖入图片：入库后在光标处插入图片节点
  const { uploading } = useImagePaste(wrapRef, (token) => {
    const m = /^!\[([^\]]*)\]\(image:\/\/(\d+)\)$/.exec(token);
    if (m) insertImageRef(editorRef.current, Number(m[2]), m[1] || "图片");
  }, onError);

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
      editorRef.current?.commands.focus("end");
    }
  }, [focusSignal]);

  const send = async () => {
    const text = content.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onCreate(text);
      setContent("");
      editorRef.current?.commands.focus("end");
    } catch {
      // 错误横幅已由 App 展示，保留输入内容
    } finally {
      setSending(false);
    }
  };

  /** 原生 KeyboardEvent（ProseMirror handleKeyDown 透传），非 React 合成事件 */
  const handleKeyDown = (e: globalThis.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
      return true;
    }
    return false;
  };

  return (
    <div className="editor" ref={wrapRef}>
      <RichEditor
        value={content}
        onChange={setContent}
        allTags={allTags}
        placeholder="现在，记录点什么..."
        autoFocus
        onKeyDown={handleKeyDown}
        editorRef={editorRef}
      />
      <div className="editor-footer">
        <span className="editor-hint">
          {uploading
            ? "图片上传中…"
            : "Ctrl + Enter 发送 · # 打标签 · 可直接粘贴图片"}
        </span>
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
