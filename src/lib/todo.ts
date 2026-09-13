import { dateHeaderLabel } from "./format";
import { listTodos } from "./md";
import { extractTags } from "./tags";
import type { Memo } from "./types";

/** 聚合出的一条待办；todoIndex 是它在所属笔记正文里的全篇顺序号（回写正文时定位用） */
export interface TodoItem {
  memoId: number;
  todoIndex: number;
  text: string;
  done: boolean;
  /** 所属笔记的创建时间 "YYYY-MM-DD HH:MM:SS" */
  createdAt: string;
  /** 所属笔记的标签（已去 #，含层级路径），按正文出现顺序 */
  tags: string[];
}

export interface TodoStats {
  total: number;
  done: number;
  pending: number;
}

export type TodoStatus = "pending" | "done" | "all";
export type TodoGroupBy = "tag" | "date";

export interface TodoGroup {
  /** 分组标识：标签路径（无标签为空串）或日期 "YYYY-MM-DD" */
  key: string;
  label: string;
  items: TodoItem[];
}

/** 无标签分组的键（标签路径不可能为空串，用空串做哨兵最省事） */
export const UNTAGGED_KEY = "";
const UNTAGGED_LABEL = "无标签";

/**
 * 把笔记里的待办聚合成一条条清单项。
 * 顺序沿用传入顺序（App 传的是最新在前的全量笔记），todoIndex 与 toggleTodo 的下标一致，
 * 所以点勾选时可以把 (memoId, todoIndex) 直接回写原卡片正文。
 */
export function collectTodos(memos: Memo[]): TodoItem[] {
  const out: TodoItem[] = [];
  for (const memo of memos) {
    const todos = listTodos(memo.content);
    if (todos.length === 0) continue;
    const tags = extractTags(memo.content);
    todos.forEach((t, todoIndex) => {
      out.push({
        memoId: memo.id,
        todoIndex,
        text: t.text,
        done: t.done,
        createdAt: memo.createdAt,
        tags,
      });
    });
  }
  return out;
}

/** 统计总条数 / 已完成 / 未完成 */
export function todoStats(items: TodoItem[]): TodoStats {
  let done = 0;
  for (const it of items) if (it.done) done += 1;
  return { total: items.length, done, pending: items.length - done };
}

/** 按完成状态筛选 */
export function filterTodos(items: TodoItem[], status: TodoStatus): TodoItem[] {
  if (status === "all") return items;
  return items.filter((it) => (status === "done" ? it.done : !it.done));
}

/** 按关键词过滤待办文本（大小写不敏感，多关键词取「命中任一」） */
export function searchTodos(items: TodoItem[], terms: string[] | undefined): TodoItem[] {
  const valid = (terms ?? []).filter(Boolean).map((t) => t.toLowerCase());
  if (valid.length === 0) return items;
  return items.filter((it) => {
    const text = it.text.toLowerCase();
    return valid.some((t) => text.includes(t));
  });
}

/**
 * 分组：按标签时取所属笔记的第一个标签（多标签的笔记不重复出现在多个组里），
 * 解析不出标签的归入「无标签」；按日期时以创建日期为组。
 * 组内保持传入顺序（最新在前）。
 * 组顺序：按日期 → 新日期在前；按标签 → 未完成多的在前，无标签组垫底。
 */
export function groupTodos(items: TodoItem[], by: TodoGroupBy): TodoGroup[] {
  const map = new Map<string, TodoGroup>();
  for (const it of items) {
    const key = by === "tag" ? (it.tags[0] ?? UNTAGGED_KEY) : it.createdAt.slice(0, 10);
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        label: by === "tag" ? (it.tags[0] ?? UNTAGGED_LABEL) : dateHeaderLabel(key),
        items: [],
      };
      map.set(key, group);
    }
    group.items.push(it);
  }
  const groups = [...map.values()];
  if (by === "date") {
    groups.sort((a, b) => b.key.localeCompare(a.key));
  } else {
    groups.sort((a, b) => {
      if (a.key === UNTAGGED_KEY) return 1;
      if (b.key === UNTAGGED_KEY) return -1;
      return todoStats(b.items).pending - todoStats(a.items).pending || a.label.localeCompare(b.label);
    });
  }
  return groups;
}
