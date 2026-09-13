import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatTime } from "../lib/format";
import { renderMarkdown, toggleTodo as toggleTodoInContent } from "../lib/md";
import { insertAtCaret, useImagePaste } from "../lib/useImagePaste";
import MemoImage from "./MemoImage";
import TagInput from "./TagInput";
import type { Memo } from "../lib/types";

interface Props {
  memo: Memo;
  allTags: string[];
  /** 搜索结果高亮关键词 */
  highlight?: string[];
  /** 受控编辑态：App 用 editingId 统一管理（回顾弹窗也能发起编辑） */
  editing: boolean;
  onSetEditing: (id: number | null) => void;
  /** 回收站模式：展示 恢复 / 彻底删除 而非 编辑 / 删除 */
  trash?: boolean;
  onRestore?: (id: number) => void;
  onPurge?: (id: number) => void;
  onTagClick: (tag: string) => void;
  onUpdate: (id: number, content: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /** 置顶 / 取消置顶；pinned 为目标状态 */
  onTogglePin: (id: number, pinned: boolean) => void;
}

function MemoCard({
  memo,
  allTags,
  highlight,
  editing,
  onSetEditing,
  trash,
  onRestore,
  onPurge,
  onTagClick,
  onUpdate,
  onDelete,
  onTogglePin,
}: Props) {
  const [draft, setDraft] = useState(memo.content);
  const [overflowing, setOverflowing] = useState(false); // 内容是否超过两行
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 根节点 ref：编辑态下粘贴/拖入图片用（非编辑态图片走渲染）
  const cardRef = useRef<HTMLDivElement>(null);

  // 编辑态的图片粘贴：入库后在编辑框光标处插入引用
  const { uploading } = useImagePaste(
    cardRef,
    (token) => insertAtCaret(cardRef.current, draft, setDraft, token),
  );

  useEffect(() => {
    setExpanded(false);
    const el = bodyRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [memo.content]);

  // 进入编辑（含回顾弹窗发起）时，以最新正文为草稿
  useEffect(() => {
    if (editing) setDraft(memo.content);
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = () => {
    setDraft(memo.content);
    onSetEditing(null);
  };

  const save = async () => {
    const text = draft.trim();
    if (!text) return;
    try {
      await onUpdate(memo.id, text);
      onSetEditing(null);
    } catch {
      // 错误横幅已由 App 展示，保留编辑状态
    }
  };

  const handleToggleTodo = useCallback(
    (todoIndex: number) => {
      // 失败时错误横幅已由 App 展示，这里吞掉异常避免 unhandled rejection
      onUpdate(memo.id, toggleTodoInContent(memo.content, todoIndex)).catch(() => {});
    },
    [onUpdate, memo.id, memo.content],
  );

  // Markdown 渲染结果按内容记忆化：父级重渲染而正文未变时不再重新解析
  const body = useMemo(
    () =>
      renderMarkdown(memo.content, {
        onTagClick,
        onToggleTodo: handleToggleTodo,
        highlight,
        renderImage: (id, alt) => <MemoImage id={id} alt={alt} />,
      }),
    [memo.content, onTagClick, handleToggleTodo, highlight],
  );

  return (
    <div
      className={"memo-card" + (memo.pinnedAt ? " pinned" : "")}
      data-memo-id={memo.id}
      ref={cardRef}
    >
      {!editing && overflowing && (
        <button
          className="memo-expand"
          title={expanded ? "收起" : "展开全文"}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "▴" : "▾"}
        </button>
      )}
      {editing ? (
        <div className="memo-editing">
          <TagInput
            value={draft}
            allTags={allTags}
            rows={4}
            autoFocus
            onChange={setDraft}
            onKeyDown={(e) => {
              if (e.key === "Escape") cancel();
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              }
            }}
          />
          <div className="memo-actions">
            {uploading && <span className="memo-img-loading">图片上传中…</span>}
            <button className="btn-ghost" onClick={cancel}>
              取消
            </button>
            <button className="btn-primary" onClick={() => void save()}>
              保存
            </button>
          </div>
        </div>
      ) : (
        <>
          <div ref={bodyRef} className={"memo-body md" + (expanded ? "" : " clamped")}>
            {body}
          </div>
          <div className="memo-meta">
            <span title={memo.createdAt}>{formatTime(memo.createdAt)}</span>
            <span className="memo-ops">
              {trash ? (
                <>
                  <button onClick={() => onRestore?.(memo.id)}>恢复</button>
                  <button
                    className="danger"
                    onClick={() => {
                      if (confirm("彻底删除这条 memo？不可恢复！")) {
                        onPurge?.(memo.id);
                      }
                    }}
                  >
                    彻底删除
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => onTogglePin(memo.id, memo.pinnedAt === null)}>
                    {memo.pinnedAt ? "取消置顶" : "置顶"}
                  </button>
                  <button onClick={() => onSetEditing(memo.id)}>编辑</button>
                  <button
                    className="danger"
                    onClick={() => {
                      if (confirm("删除这条 memo？")) {
                        // 失败时错误横幅已由 App 展示
                        void onDelete(memo.id).catch(() => {});
                      }
                    }}
                  >
                    删除
                  </button>
                </>
              )}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// 按 props 浅比较跳过重渲染：配合 App 侧稳定的回调，搜索输入时卡片流不再整体重渲染
export default memo(MemoCard);
