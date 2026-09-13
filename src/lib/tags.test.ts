import { describe, expect, it } from "vitest";
import {
  buildTagTree,
  countMemosWithTag,
  extractTags,
  removeTagInContent,
  renameTagInContent,
  tagMatchesPrefix,
} from "./tags";
import type { Memo } from "./types";

const memo = (id: number, content: string): Memo => ({
  id,
  content,
  createdAt: "2026-01-01 00:00:00",
  updatedAt: "2026-01-01 00:00:00",
  pinnedAt: null,
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

// 以下语义必须与后端 src-tauri/src/tags.rs 保持一致（浏览器 mock 直接复用这些函数）
describe("标签前缀语义", () => {
  it("tagMatchesPrefix：精确命中与子孙命中，前缀子串不命中", () => {
    expect(tagMatchesPrefix("读书", "读书")).toBe(true);
    expect(tagMatchesPrefix("读书/心理学", "读书")).toBe(true);
    expect(tagMatchesPrefix("读书笔记", "读书")).toBe(false);
    expect(tagMatchesPrefix("读书", "读书/心理学")).toBe(false);
  });

  it("countMemosWithTag：按笔记数统计，同一条里的重复标签只算一次", () => {
    const memos = [memo(1, "#读书 #读书/心理学"), memo(2, "#读书笔记"), memo(3, "#运动")];
    expect(countMemosWithTag(memos, "读书")).toBe(1);
    expect(countMemosWithTag(memos, "读书笔记")).toBe(1);
    expect(countMemosWithTag(memos, "不存在")).toBe(0);
  });
});

describe("标签改写（与后端同语义）", () => {
  it("renameTagInContent：只动标签边界内，子孙连带改前缀", () => {
    expect(renameTagInContent("#读书笔记 很好", "读书", "阅读")).toBeNull();
    expect(renameTagInContent("#读书 打卡", "读书", "阅读")).toBe("#阅读 打卡");
    expect(renameTagInContent("看了 #读书/心理学", "读书", "阅读")).toBe("看了 #阅读/心理学");
    expect(renameTagInContent("#读书 #读书/心理学", "读书", "阅读")).toBe(
      "#阅读 #阅读/心理学",
    );
    expect(renameTagInContent("no tags", "读书", "阅读")).toBeNull();
  });

  it("removeTagInContent：删标签并清掉相邻的一个空格", () => {
    expect(removeTagInContent("#运动 晨跑 5km", "运动")).toBe("晨跑 5km");
    expect(removeTagInContent("晨跑 5km #运动", "运动")).toBe("晨跑 5km");
    expect(removeTagInContent("晨跑 #运动 5km", "运动")).toBe("晨跑 5km");
    expect(removeTagInContent("#读书/心理学 书评", "读书")).toBe("书评");
    expect(removeTagInContent("#读书笔记 ok", "读书")).toBeNull();
    expect(removeTagInContent("#a x #a/子 y", "a")).toBe("x y");
  });
});
