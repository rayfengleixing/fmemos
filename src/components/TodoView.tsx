import { useCallback, useMemo, useState } from "react";
import { formatTime } from "../lib/format";
import { renderInline, toggleTodo } from "../lib/md";
import {
  collectTodos,
  filterTodos,
  groupTodos,
  searchTodos,
  todoStats,
  type TodoGroupBy,
  type TodoItem,
  type TodoStatus,
} from "../lib/todo";
import type { Memo } from "../lib/types";

interface Props {
  /** 全量笔记（不含回收站），在本地聚合成待办清单，无需后端支持 */
  memos: Memo[];
  /** 搜索关键词，用于过滤待办文本 */
  searchTerms?: string[];
  /** 勾选回写：App 侧保存后会刷新全量数据，清单随之更新 */
  onUpdate: (memoId: number, content: string) => Promise<void>;
  /** 点标签：跳到该标签的笔记流 */
  onTagClick: (tag: string) => void;
  /** 定位到原笔记卡片 */
  onOpenMemo: (memoId: number) => void;
}

const STATUSES: { value: TodoStatus; label: string }[] = [
  { value: "pending", label: "未完成" },
  { value: "all", label: "全部" },
  { value: "done", label: "已完成" },
];

/** 待办聚合视图：把散落在各笔记里的 - [ ] 收拢成一份清单，勾选直接回写原卡片 */
export default function TodoView({
  memos,
  searchTerms,
  onUpdate,
  onTagClick,
  onOpenMemo,
}: Props) {
  const [status, setStatus] = useState<TodoStatus>("pending");
  const [groupBy, setGroupBy] = useState<TodoGroupBy>("tag");

  const all = useMemo(() => collectTodos(memos), [memos]);
  const stats = useMemo(() => todoStats(all), [all]);
  const contentById = useMemo(() => new Map(memos.map((m) => [m.id, m.content])), [memos]);

  const groups = useMemo(
    () => groupTodos(searchTodos(filterTodos(all, status), searchTerms), groupBy),
    [all, status, searchTerms, groupBy],
  );

  const toggle = useCallback(
    (item: TodoItem) => {
      const content = contentById.get(item.memoId);
      if (content == null) return;
      // 失败时错误横幅已由 App 展示，这里吞掉异常避免 unhandled rejection
      onUpdate(item.memoId, toggleTodo(content, item.todoIndex)).catch(() => {});
    },
    [contentById, onUpdate],
  );

  return (
    <div className="todo-view">
      <div className="todo-header">
        <span>
          待办清单 · 未完成 {stats.pending} 项
          <span className="todo-hint">（共 {stats.total} 项，勾选会同步回原笔记）</span>
        </span>
        <div className="todo-toolbar">
          <div className="seg seg-sm">
            {STATUSES.map((s) => (
              <button
                key={s.value}
                className={"seg-item" + (status === s.value ? " active" : "")}
                onClick={() => setStatus(s.value)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="seg seg-sm">
            <button
              className={"seg-item" + (groupBy === "tag" ? " active" : "")}
              onClick={() => setGroupBy("tag")}
            >
              按标签
            </button>
            <button
              className={"seg-item" + (groupBy === "date" ? " active" : "")}
              onClick={() => setGroupBy("date")}
            >
              按日期
            </button>
          </div>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="empty-state">
          {stats.total === 0 ? (
            <>
              还没有待办
              <br />
              在笔记里写一行 <code>- [ ] 待办事项</code>，就会出现在这里
            </>
          ) : (
            "当前筛选下没有待办"
          )}
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.key || "__untagged__"} className="todo-group">
            <div className="date-header">
              <span>{group.label}</span>
              <span className="date-count">{group.items.length} 项</span>
            </div>
            <ul className="todo-agenda">
              {group.items.map((item) => (
                <li
                  key={`${item.memoId}-${item.todoIndex}`}
                  className={item.done ? "todo-done" : undefined}
                >
                  <span
                    className="todo-check"
                    role="checkbox"
                    aria-checked={item.done}
                    aria-label={`待办：${item.text || "空"}`}
                    onClick={() => toggle(item)}
                  >
                    {item.done ? "✓" : ""}
                  </span>
                  <span className="todo-text">
                    {renderInline(item.text || "（空待办）", { onTagClick, highlight: searchTerms })}
                  </span>
                  <span className="todo-meta">
                    {groupBy === "date" ? (
                      item.tags.map((tag) => (
                        <span key={tag} className="todo-tag" onClick={() => onTagClick(tag)}>
                          #{tag}
                        </span>
                      ))
                    ) : (
                      <span>{formatTime(item.createdAt)}</span>
                    )}
                    <button
                      className="todo-jump"
                      title="定位到原笔记"
                      onClick={() => onOpenMemo(item.memoId)}
                    >
                      原文
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
