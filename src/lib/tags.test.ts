import { describe, expect, it } from "vitest";
import { buildTagTree, extractTags } from "./tags";
import type { Memo } from "./types";

const memo = (id: number, content: string): Memo => ({
  id,
  content,
  createdAt: "2026-01-01 00:00:00",
  updatedAt: "2026-01-01 00:00:00",
});

describe("buildTagTree", () => {
  it("层级路径与计数：父级计数含所有子孙", () => {
    const tree = buildTagTree([
      memo(1, "#读书/心理学 锚定"),
      memo(2, "#读书 进度"),
      memo(3, "#运动 晨跑"),
    ]);
    expect(tree).toHaveLength(2);

    const reading = tree[0];
    expect(reading.name).toBe("读书");
    expect(reading.path).toBe("读书");
    expect(reading.count).toBe(2); // 自身 1 条 + 子标签 1 条
    expect(reading.children).toHaveLength(1);
    expect(reading.children[0].path).toBe("读书/心理学");
    expect(reading.children[0].count).toBe(1);

    expect(tree[1].path).toBe("运动");
    expect(tree[1].count).toBe(1);
  });

  it("同一笔记内重复标签只计一次", () => {
    const tree = buildTagTree([memo(1, "#a 一次 #a 两次 #a/a 子级")]);
    const node = tree.find((n) => n.path === "a");
    expect(node?.count).toBe(2); // extractTags 去重后：a 与 a/a 各一条
  });

  it("按计数降序，同数按名称升序", () => {
    const tree = buildTagTree([
      memo(1, "#b 一"),
      memo(2, "#b 二"),
      memo(3, "#a 三"),
      memo(4, "#c 四"),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["b", "a", "c"]);
  });

  it("空内容返回空树", () => {
    expect(buildTagTree([])).toEqual([]);
    expect(buildTagTree([memo(1, "没有标签")])).toEqual([]);
  });

  it("与 extractTags 一致：正文示例标签也会计入", () => {
    // 欢迎语里写了 "#读书/心理学 这样的层级" 也会被解析
    const tree = buildTagTree([memo(1, "支持 #读书/心理学 这样的层级")]);
    expect(extractTags("支持 #读书/心理学 这样的层级")).toEqual(["读书/心理学"]);
    // 层级标签的树根是父级节点
    expect(tree[0].path).toBe("读书");
    expect(tree[0].children[0].path).toBe("读书/心理学");
  });
});
