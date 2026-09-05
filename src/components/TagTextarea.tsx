import { useRef } from "react";
import { TAG_SPLIT_RE } from "../lib/tags";

interface Props {
  value: string;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  /** caret 为光标位置，供 # 自动补全定位（不关心时忽略即可） */
  onChange: (value: string, caret: number) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
}

/**
 * 带标签高亮的多行输入框：透明 textarea 叠在高亮渲染层上，
 * 两层共用同一套字体/行高/padding 规则（见 App.css 中 .tt-*），保证文字对齐。
 */
export default function TagTextarea({
  value,
  placeholder,
  rows,
  autoFocus,
  onChange,
  onKeyDown,
  onBlur,
}: Props) {
  const highlightRef = useRef<HTMLDivElement>(null);
  const notify = (el: HTMLTextAreaElement) => onChange(el.value, el.selectionEnd ?? el.value.length);

  return (
    <div className="tt-stack">
      <div className="tt-highlight" ref={highlightRef} aria-hidden>
        {value.split(TAG_SPLIT_RE).map((part, i) =>
          part.startsWith("#") ? (
            <span key={i} className="tag-hl">
              {part}
            </span>
          ) : (
            part
          ),
        )}
        {/* 末尾零宽空格，保证内容以换行结尾时两层高度一致 */}
        {"\u200b"}
      </div>
      <textarea
        value={value}
        placeholder={placeholder}
        rows={rows}
        autoFocus={autoFocus}
        onChange={(e) => notify(e.currentTarget)}
        onSelect={(e) => notify(e.currentTarget)}
        onScroll={(e) => {
          if (highlightRef.current) {
            highlightRef.current.scrollTop = e.currentTarget.scrollTop;
          }
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
    </div>
  );
}
