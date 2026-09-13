import { useCallback, useEffect, useRef, useState } from "react";
import { renderMarkdown } from "../lib/md";
import { copyText } from "../lib/clipboard";
import MemoImage from "./MemoImage";
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
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const copyTimer = useRef(0);

  const handleCopy = useCallback(async () => {
    setCopied((await copyText(memo.content)) ? "ok" : "fail");
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(""), 1500);
  }, [memo.content]);

  // 换了一条后反馈状态复位
  useEffect(() => {
    setCopied("");
    window.clearTimeout(copyTimer.current);
  }, [memo.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(copyTimer.current);
    };
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
        <div className="review-body md">
          {renderMarkdown(memo.content, { onTagClick, renderImage: (id, alt) => <MemoImage id={id} alt={alt} /> })}
        </div>
        <div className="review-foot">
          <span title={memo.createdAt}>{memo.createdAt}</span>
          <span className="review-actions">
            <button className="btn-ghost" onClick={() => void handleCopy()}>
              {copied === "ok" ? "已复制" : copied === "fail" ? "复制失败" : "复制"}
            </button>
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
