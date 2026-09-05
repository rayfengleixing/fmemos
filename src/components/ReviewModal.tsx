import { useEffect } from "react";
import { renderMarkdown } from "../lib/md";
import type { Memo } from "../lib/types";

interface Props {
  mode: "random" | "daily";
  memo: Memo;
  onClose: () => void;
  onAnother: () => void;
  onTagClick: (tag: string) => void;
}

export default function ReviewModal({ mode, memo, onClose, onAnother, onTagClick }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="review-overlay" onClick={onClose}>
      <div className="review-card" onClick={(e) => e.stopPropagation()}>
        <div className="review-head">
          <span>{mode === "daily" ? "每日回顾" : "随机回顾"}</span>
          <button className="review-close" title="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="review-body md">{renderMarkdown(memo.content, { onTagClick })}</div>
        <div className="review-foot">
          <span title={memo.createdAt}>{memo.createdAt}</span>
          {mode === "random" && (
            <button className="btn-ghost" onClick={onAnother}>
              换一条
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
