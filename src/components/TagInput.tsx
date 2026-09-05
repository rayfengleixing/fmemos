import { useLayoutEffect, useMemo, useRef, useState } from "react";
import TagTextarea from "./TagTextarea";
import { listEnterAction } from "../lib/md";
import { TAG_PARTIAL_RE } from "../lib/tags";

const MAX_SUGGESTIONS = 6;

/**
 * 程序化移动光标（自动补全、列表延续）后浏览器不会自动跟随，
 * 主动调整 textarea 内部滚动和页面滚动容器，让光标行保持可见。
 * 光标 Y 用镜像节点精确测量（含软换行）。
 */
function revealCaret(ta: HTMLTextAreaElement) {
  const caret = ta.selectionStart;
  const cs = getComputedStyle(ta);
  const mirror = document.createElement("div");
  for (const p of [
    "fontFamily",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "paddingTop",
    "paddingBottom",
    "width",
    "boxSizing",
  ] as const) {
    mirror.style[p] = cs[p];
  }
  mirror.style.position = "absolute";
  mirror.style.top = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordBreak = "break-word";
  mirror.textContent = ta.value.slice(0, caret);
  const probe = document.createElement("span");
  probe.textContent = "\u200b";
  mirror.appendChild(probe);
  document.body.appendChild(mirror);
  const caretTop = probe.offsetTop + parseFloat(cs.paddingTop || "0");
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.7;
  mirror.remove();

  // textarea 内部滚动：光标行落在可视区内
  if (caretTop - lineHeight < ta.scrollTop) {
    ta.scrollTop = Math.max(0, caretTop - lineHeight);
  } else if (caretTop > ta.scrollTop + ta.clientHeight - lineHeight) {
    ta.scrollTop = caretTop - ta.clientHeight + lineHeight;
  }

  // 页面滚动容器跟随
  const scroller = ta.closest(".main") as HTMLElement | null;
  if (!scroller) return;
  const caretY = ta.getBoundingClientRect().top - ta.scrollTop + caretTop;
  const sRect = scroller.getBoundingClientRect();
  if (caretY < sRect.top) {
    scroller.scrollTop -= sRect.top - caretY;
  } else if (caretY + lineHeight > sRect.bottom) {
    scroller.scrollTop += caretY + lineHeight - sRect.bottom;
  }
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** 全部标签路径（按热度排序），供 # 自动补全 */
  allTags: string[];
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  /** 补全弹层未消费的按键（如 Ctrl+Enter 发送、Esc 取消编辑）透传给调用方 */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
}

/**
 * 带 # 标签自动补全的输入区：新建输入框与卡片编辑框共用的同一套交互。
 * ↑↓ 选择、Enter/Tab 确认、Esc 关闭，确认后补成 "#标签 " 并把光标停在空格后。
 */
export default function TagInput({
  value,
  onChange,
  allTags,
  placeholder,
  rows,
  autoFocus,
  onKeyDown,
  onBlur,
}: Props) {
  // 补全锚点：start 为 # 下标，caret 为光标位置，query = value.slice(start+1, caret)
  const [suggest, setSuggest] = useState<{ start: number; caret: number } | null>(null);
  const [hl, setHl] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  // 选中补全项后等 React 渲染完新 value 再恢复光标
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (pendingCaret.current == null) return;
    const ta = wrapRef.current?.querySelector("textarea");
    if (ta) {
      ta.focus();
      ta.setSelectionRange(pendingCaret.current, pendingCaret.current);
      revealCaret(ta);
    }
    pendingCaret.current = null;
  }, [value]);

  const query = suggest ? value.slice(suggest.start + 1, suggest.caret) : "";
  const suggestions = useMemo(() => {
    if (!suggest) return [];
    const q = query.toLowerCase();
    return allTags.filter((t) => t.toLowerCase().includes(q)).slice(0, MAX_SUGGESTIONS);
  }, [suggest, allTags, query]);
  // allTags 在弹层打开期间可能收缩，钳制高亮下标避免取到 undefined
  const activeHl = Math.min(hl, suggestions.length - 1);

  const updateSuggest = (v: string, caret: number) => {
    const m = TAG_PARTIAL_RE.exec(v.slice(0, caret));
    if (m) {
      setSuggest({ start: caret - m[0].length, caret });
      setHl(0);
    } else {
      setSuggest(null);
    }
  };

  const apply = (tag: string) => {
    if (!suggest) return;
    onChange(value.slice(0, suggest.start) + "#" + tag + " " + value.slice(suggest.caret));
    pendingCaret.current = suggest.start + tag.length + 2;
    setSuggest(null);
  };

  /** 回车时延续当前行的列表标记（- 、1. 、- [ ]）；空标记项再按回车退出列表 */
  const continueList = (ta: HTMLTextAreaElement): boolean => {
    if (ta.selectionStart !== ta.selectionEnd) return false;
    const caret = ta.selectionStart;
    const lineStart = caret === 0 ? 0 : value.lastIndexOf("\n", caret - 1) + 1;
    const nl = value.indexOf("\n", caret);
    const line = value.slice(lineStart, nl === -1 ? undefined : nl);
    const action = listEnterAction(line, caret - lineStart);
    if (!action) return false;
    if (action.type === "exit") {
      // 只删除标记，光标留在当前空行（便于接着写非列表内容）
      onChange(value.slice(0, lineStart) + value.slice(lineStart + action.markerLen));
      pendingCaret.current = lineStart;
    } else {
      onChange(value.slice(0, caret) + "\n" + action.marker + value.slice(caret));
      pendingCaret.current = caret + 1 + action.marker.length;
    }
    setSuggest(null);
    return true;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法组词中的回车/方向键是确认候选，不拦截
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (suggest && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHl((activeHl + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHl((activeHl - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        apply(suggestions[activeHl]);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        apply(suggestions[activeHl]);
        return;
      }
      if (e.key === "Escape") {
        setSuggest(null);
        return;
      }
    }
    // 普通回车延续列表标记；Ctrl/Cmd+Enter（发送）、Shift+Enter（普通换行）不接管
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && continueList(e.currentTarget)) {
      e.preventDefault();
      return;
    }
    onKeyDown?.(e);
  };

  return (
    <div className="tag-input" ref={wrapRef}>
      <TagTextarea
        value={value}
        placeholder={placeholder}
        rows={rows}
        autoFocus={autoFocus}
        onChange={(v, caret) => {
          onChange(v);
          updateSuggest(v, caret);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setSuggest(null);
          onBlur?.();
        }}
      />
      {suggest && suggestions.length > 0 && (
        <div className="tag-suggest">
          {suggestions.map((t, i) => (
            <button
              key={t}
              type="button"
              className={"tag-suggest-item" + (i === activeHl ? " hl" : "")}
              onMouseDown={(e) => {
                // 阻止抢焦点触发 textarea blur 关掉弹层
                e.preventDefault();
                apply(t);
              }}
              onMouseEnter={() => setHl(i)}
            >
              <span className="tag-hash">#</span>
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
