import { useEffect } from "react";
import { renderMarkdown } from "../lib/md";
import type { Memo } from "../lib/types";

interface Props {
  /** 弹窗标题：随机回顾 / 每日回顾 / N 年前的今天 */
  title: string;
  memo: Memo;
  /** 是否展示「换一条」（随机与那年今日可换） */
  showAnother: boolean;
  onClose: () => void;
  onAnother: () => void;
  /** 在卡片流里定位并编辑这条 memo */
  onEdit: () => void;
  onTagClick: (tag: string) => void;
}

export default function ReviewModal({
  title,
  memo,
  showAnother,
  onClose,
  onAnother,
  onEdit,
  onTagClick,
}: Props) {
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
          <span>{title}</span>
          <button className="review-close" title="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="review-body md">{renderMarkdown(memo.content, { onTagClick })}</div>
        <div className="review-foot">
          <span title={memo.createdAt}>{memo.createdAt}</span>
          <span className="review-actions">
            <button className="btn-ghost" onClick={onEdit}>
              编辑
            </button>
            {showAnother && (
              <button className="btn-ghost" onClick={onAnother}>
                换一条
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
