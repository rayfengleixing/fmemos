import { Fragment, memo, useState } from "react";
import Heatmap from "./Heatmap";
import type { TagNode } from "../lib/types";

interface Props {
  total: number;
  tags: TagNode[];
  activeTag: string | null;
  untagged: boolean;
  untaggedCount: number;
  /** 日期 "YYYY-MM-DD" -> 当天条数 */
  heatCounts: Map<string, number>;
  activeDate: string | null;
  onSelectAll: () => void;
  onSelectTag: (tag: string) => void;
  onSelectUntagged: () => void;
  onSelectDate: (date: string | null) => void;
  onReview: (mode: "random" | "daily") => void;
}

function Sidebar({
  total,
  tags,
  activeTag,
  untagged,
  untaggedCount,
  heatCounts,
  activeDate,
  onSelectAll,
  onSelectTag,
  onSelectUntagged,
  onSelectDate,
  onReview,
}: Props) {
  // 记录被展开的节点路径；默认全部收起，点开的层级在新笔记进来后保持展开
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <aside className="sidebar">
      <div className="logo">FMemos</div>
      <nav>
        {total > 0 && (
          <>
            <div className="side-section">统计</div>
            <Heatmap counts={heatCounts} activeDate={activeDate} onSelectDate={onSelectDate} />
            <div className="side-section">回顾</div>
            <button className="side-item" onClick={() => onReview("random")}>
              随机回顾
            </button>
            <button className="side-item" onClick={() => onReview("daily")}>
              每日回顾
            </button>
          </>
        )}

        <button
          className={"side-item" + (activeTag === null && !untagged ? " active" : "")}
          onClick={onSelectAll}
        >
          全部笔记
          <span className="side-count">{total}</span>
        </button>

        <button className={"side-item" + (untagged ? " active" : "")} onClick={onSelectUntagged}>
          无标签
          <span className="side-count">{untaggedCount}</span>
        </button>

        {tags.length > 0 && <div className="side-section">标签</div>}
        <TagTree
          nodes={tags}
          activeTag={activeTag}
          expanded={expanded}
          onToggle={toggle}
          onSelectTag={onSelectTag}
        />
        {tags.length === 0 && (
          <div className="side-empty">
            在正文里输入 #标签名，笔记会自动归档到这里；
            <br />
            用 #一级/二级 可以建立层级
          </div>
        )}
      </nav>
    </aside>
  );
}

function TagTree({
  nodes,
  activeTag,
  expanded,
  onToggle,
  onSelectTag,
}: {
  nodes: TagNode[];
  activeTag: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelectTag: (tag: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isExpanded = expanded.has(node.path);
        return (
          <Fragment key={node.path}>
            <button
              className={"side-item" + (activeTag === node.path ? " active" : "")}
              onClick={() => {
                onSelectTag(node.path);
                // 点击父标签筛选时自动展开子级（再点一次箭头才收起）
                if (hasChildren && !isExpanded) onToggle(node.path);
              }}
            >
              {hasChildren ? (
                <span
                  className={"tag-toggle" + (isExpanded ? "" : " collapsed")}
                  title={isExpanded ? "收起" : "展开"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(node.path);
                  }}
                >
                  ▾
                </span>
              ) : (
                <span className="tag-toggle leaf" />
              )}
              <span className="tag-hash">#</span>
              {node.name}
              <span className="side-count">{node.count}</span>
            </button>
            {hasChildren && isExpanded && (
              <div className="tag-branch">
                <TagTree
                  nodes={node.children}
                  activeTag={activeTag}
                  expanded={expanded}
                  onToggle={onToggle}
                  onSelectTag={onSelectTag}
                />
              </div>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

// 按 props 浅比较跳过重渲染：配合 App 侧稳定的回调，搜索输入时侧栏不再重渲染
export default memo(Sidebar);
