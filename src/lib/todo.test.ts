import { describe, expect, it } from "vitest";
import { toggleTodo } from "./md";
import { collectTodos, filterTodos, groupTodos, searchTodos, todoStats } from "./todo";
import type { Memo } from "./types";

const memo = (id: number, content: string, createdAt = "2026-01-01 09:00:00"): Memo => ({
  id,
  content,
  createdAt,
  updatedAt: createdAt,
  pinnedAt: null,
});

describe("collectTodos", () => {
  it("聚合各笔记的待办，todoIndex 与笔记内顺序一致并携带标签", () => {
    const items = collectTodos([
      memo(1, "#工作\n- [ ] 写周报\n- [x] 回邮件", "2026-01-02 10:00:00"),
      memo(2, "没有待办的一行"),
      memo(3, "- [ ] 买菜"),
    ]);
    expect(items).toEqual([
      {
        memoId: 1,
        todoIndex: 0,
        text: "写周报",
        done: false,
        createdAt: "2026-01-02 10:00:00",
        tags: ["工作"],
      },
      {
        memoId: 1,
        todoIndex: 1,
        text: "回邮件",
        done: true,
        createdAt: "2026-01-02 10:00:00",
        tags: ["工作"],
      },
      {
        memoId: 3,
        todoIndex: 0,
        text: "买菜",
        done: false,
        createdAt: "2026-01-01 09:00:00",
        tags: [],
      },
    ]);
  });

  it("代码块里的伪待办不计入", () => {
    const items = collectTodos([memo(1, "```\n- [ ] code\n```\n- [ ] real")]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ todoIndex: 0, text: "real" });
  });

  it("聚合出的下标能直接回写原文（与 toggleTodo 配合）", () => {
    const content = "#工作\n- [ ] a\n- [ ] b";
    const [second] = collectTodos([memo(1, content)]).filter((it) => it.todoIndex === 1);
    expect(toggleTodo(content, second.todoIndex)).toBe("#工作\n- [ ] a\n- [x] b");
  });
});

describe("todoStats / filterTodos / searchTodos", () => {
  const items = collectTodos([
    memo(1, "#工作\n- [ ] 写周报\n- [x] 回邮件"),
    memo(2, "- [ ] 买菜\n- [x] 拖地"),
  ]);

  it("统计总数与完成情况", () => {
    expect(todoStats(items)).toEqual({ total: 4, done: 2, pending: 2 });
  });

  it("按状态筛选", () => {
    expect(filterTodos(items, "pending").map((it) => it.text)).toEqual(["写周报", "买菜"]);
    expect(filterTodos(items, "done").map((it) => it.text)).toEqual(["回邮件", "拖地"]);
    expect(filterTodos(items, "all")).toHaveLength(4);
  });

  it("按关键词过滤，多词命中任一即可", () => {
    expect(searchTodos(items, ["周报"]).map((it) => it.text)).toEqual(["写周报"]);
    expect(searchTodos(items, ["周报", "拖地"])).toHaveLength(2);
    expect(searchTodos(items, undefined)).toHaveLength(4);
  });
});

describe("groupTodos", () => {
  it("按标签分组取首个标签，无标签垫底，未完成多的在前", () => {
    const items = collectTodos([
      memo(1, "#工作 #紧急\n- [ ] 写周报\n- [ ] 发版"),
      memo(2, "#生活\n- [ ] 买菜"),
      memo(3, "- [ ] 换灯泡"),
    ]);
    const groups = groupTodos(items, "tag");
    expect(groups.map((g) => g.label)).toEqual(["工作", "生活", "无标签"]);
    expect(groups[0].items.map((it) => it.text)).toEqual(["写周报", "发版"]);
    // "#工作 #紧急" 只落在第一个标签下，不重复出现在两个组里
    expect(groups).toHaveLength(3);
    expect(groups[2].key).toBe("");
  });

  it("组内保持传入顺序，按日期分组时新日期在前", () => {
    const items = collectTodos([
      memo(1, "- [ ] 今天的事", "2026-03-05 08:00:00"),
      memo(2, "- [ ] 昨天的事", "2026-03-04 08:00:00"),
      memo(3, "- [ ] 今天第二件", "2026-03-05 09:00:00"),
    ]);
    const groups = groupTodos(items, "date");
    expect(groups.map((g) => g.key)).toEqual(["2026-03-05", "2026-03-04"]);
    expect(groups[0].items.map((it) => it.text)).toEqual(["今天的事", "今天第二件"]);
  });
});
