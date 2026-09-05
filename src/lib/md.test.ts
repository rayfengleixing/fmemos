import { describe, expect, it } from "vitest";
import { listEnterAction, parseBlocks, splitLinks, toggleTodo, trimUrl } from "./md";
import { TAG_FULL_RE, TAG_PARTIAL_RE } from "./tags";

describe("parseBlocks", () => {
  it("段落与多行", () => {
    expect(parseBlocks("hello\nworld")).toEqual([
      { type: "p", lines: ["hello", "world"] },
    ]);
  });

  it("空行分段", () => {
    expect(parseBlocks("a\n\nb")).toEqual([
      { type: "p", lines: ["a"] },
      { type: "p", lines: ["b"] },
    ]);
  });

  it("无序列表（连续行归一组）", () => {
    expect(parseBlocks("- 买菜\n- 做饭\n中间夹一句\n- 复盘")).toEqual([
      { type: "ul", lines: ["买菜", "做饭"] },
      { type: "p", lines: ["中间夹一句"] },
      { type: "ul", lines: ["复盘"] },
    ]);
  });

  it("有序列表", () => {
    expect(parseBlocks("1. 第一步\n2. 第二步")).toEqual([
      { type: "ol", lines: ["第一步", "第二步"] },
    ]);
  });

  it("代码块内容保持字面（# 与 - 不再解析）", () => {
    expect(parseBlocks("前文\n```\n# 不是标签\n- 不是列表\n```\n后文")).toEqual([
      { type: "p", lines: ["前文"] },
      { type: "code", lines: ["# 不是标签", "- 不是列表"] },
      { type: "p", lines: ["后文"] },
    ]);
  });

  it("未闭合代码块到 EOF 为止", () => {
    expect(parseBlocks("```\ncode line")).toEqual([
      { type: "code", lines: ["code line"] },
    ]);
  });

  it("TODO 列表（连续行归一组）", () => {
    expect(parseBlocks("- [ ] 买菜\n- [x] 做饭\n- [X] 大写也算完成")).toEqual([
      {
        type: "todo",
        items: [
          { text: "买菜", done: false },
          { text: "做饭", done: true },
          { text: "大写也算完成", done: true },
        ],
      },
    ]);
  });

  it("TODO 空文本与 `]` 后无空格视为普通列表", () => {
    expect(parseBlocks("- [ ]")).toEqual([
      { type: "todo", items: [{ text: "", done: false }] },
    ]);
    expect(parseBlocks("- [ ]没有空格")).toEqual([
      { type: "ul", lines: ["[ ]没有空格"] },
    ]);
  });

  it("普通列表与 TODO 相邻各自分组", () => {
    expect(parseBlocks("- 普通\n- [ ] 任务")).toEqual([
      { type: "ul", lines: ["普通"] },
      { type: "todo", items: [{ text: "任务", done: false }] },
    ]);
  });

  it("代码块里的 TODO 不解析", () => {
    expect(parseBlocks("```\n- [x] not todo\n```")).toEqual([
      { type: "code", lines: ["- [x] not todo"] },
    ]);
  });

  it("TODO 行不会被并入前一段落", () => {
    expect(parseBlocks("想法：\n- [ ] 记下来")).toEqual([
      { type: "p", lines: ["想法："] },
      { type: "todo", items: [{ text: "记下来", done: false }] },
    ]);
  });
});

describe("toggleTodo", () => {
  it("按全篇顺序号切换指定项", () => {
    const c = "- [ ] a\n- [x] b";
    expect(toggleTodo(c, 0)).toBe("- [x] a\n- [x] b");
    expect(toggleTodo(c, 1)).toBe("- [ ] a\n- [ ] b");
  });

  it("计数跳过代码块内的行，与渲染计数一致", () => {
    const c = "```\n- [x] code\n```\n- [ ] real";
    expect(toggleTodo(c, 0)).toBe("```\n- [x] code\n```\n- [x] real");
  });

  it("无对应序号时原样返回", () => {
    expect(toggleTodo("- [ ] a", 5)).toBe("- [ ] a");
  });
});

describe("listEnterAction", () => {
  it("有内容的列表行回车延续标记", () => {
    expect(listEnterAction("- 买菜", 4)).toEqual({ type: "continue", marker: "- " });
    expect(listEnterAction("- [ ] 写周报", 7)).toEqual({ type: "continue", marker: "- [ ] " });
    // 新任务行始终未完成，已完成的也重置
    expect(listEnterAction("- [X] 晨会", 7)).toEqual({ type: "continue", marker: "- [ ] " });
    expect(listEnterAction("3. 第三步", 6)).toEqual({ type: "continue", marker: "4. " });
    expect(listEnterAction("10. 第十步", 7)).toEqual({ type: "continue", marker: "11. " });
  });

  it("光标在行中间时拆分条目，同样延续标记", () => {
    expect(listEnterAction("- 买菜做饭", 4)).toEqual({ type: "continue", marker: "- " });
  });

  it("空标记项回车退出列表", () => {
    expect(listEnterAction("- ", 2)).toEqual({ type: "exit", markerLen: 2 });
    expect(listEnterAction("- [ ] ", 6)).toEqual({ type: "exit", markerLen: 6 });
    expect(listEnterAction("- [x]", 5)).toEqual({ type: "exit", markerLen: 5 });
    expect(listEnterAction("2. ", 3)).toEqual({ type: "exit", markerLen: 3 });
    // 单个 "-" 不构成标记，走默认换行
    expect(listEnterAction("-", 1)).toBe(null);
  });

  it("非列表行或光标在标记内部走默认换行", () => {
    expect(listEnterAction("普通文字", 4)).toBe(null);
    expect(listEnterAction("3.点号后没空格", 2)).toBe(null);
    expect(listEnterAction("- 买菜", 1)).toBe(null);
    expect(listEnterAction("- [ ] 买菜", 3)).toBe(null);
  });
});

describe("TAG_FULL_RE", () => {
  it("整段判定避免 C# 之类误判", () => {
    expect(TAG_FULL_RE.test("C#")).toBe(false);
    expect(TAG_FULL_RE.test("#!")).toBe(false);
    expect(TAG_FULL_RE.test("#读书/心理学")).toBe(true);
  });
});

describe("splitLinks", () => {
  it("识别正文中的 URL，尾随中文标点归入文本段", () => {
    expect(splitLinks("详见 https://example.com/a?b=1。后续")).toEqual([
      { kind: "text", value: "详见 " },
      { kind: "link", value: "https://example.com/a?b=1" },
      { kind: "text", value: "。后续" },
    ]);
  });

  it("多条链接与英文标点", () => {
    expect(splitLinks("a https://x.io, b http://y.cn!")).toEqual([
      { kind: "text", value: "a " },
      { kind: "link", value: "https://x.io" },
      { kind: "text", value: ", b " },
      { kind: "link", value: "http://y.cn" },
      { kind: "text", value: "!" },
    ]);
  });

  it("无链接文本原样返回", () => {
    expect(splitLinks("普通文字 #标签 不含链接")).toEqual([
      { kind: "text", value: "普通文字 #标签 不含链接" },
    ]);
  });
});

describe("trimUrl", () => {
  it("剥离多种尾随标点但保留路径字符", () => {
    expect(trimUrl("https://x.io/a_1。")).toBe("https://x.io/a_1");
    expect(trimUrl("https://x.io/path)")).toBe("https://x.io/path");
    expect(trimUrl("https://x.io/path")).toBe("https://x.io/path");
  });
});

describe("TAG_PARTIAL_RE", () => {
  const partial = (text: string) => TAG_PARTIAL_RE.exec(text)?.[1] ?? null;

  it("光标前文本以 # 或半个标签结尾时捕获查询词", () => {
    expect(partial("#")).toBe("");
    expect(partial("hello #读")).toBe("读");
    expect(partial("#读书/心")).toBe("读书/心");
    expect(partial("今天 #读书 #运")).toBe("运");
  });

  it("空白或标点截断后不再匹配", () => {
    expect(partial("#读书 ")).toBe(null);
    expect(partial("#读书，后面")).toBe(null);
    expect(partial("没有标签")).toBe(null);
    expect(partial("C# is not")).toBe(null);
    // 行首的 # 已被空格隔开，末尾是普通文本
    expect(partial("#a b")).toBe(null);
  });
});
