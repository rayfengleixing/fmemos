import { describe, expect, it } from "vitest";
import {
  listTodos,
  parseBlocks,
  splitHighlight,
  splitImages,
  splitLinks,
  toggleTodo,
  trimUrl,
} from "./md";
import { TAG_FULL_RE, TAG_PARTIAL_RE } from "./tags";

describe("splitHighlight", () => {
  it("按关键词切分并标记命中（不区分大小写）", () => {
    expect(splitHighlight("Hello World", ["world"])).toEqual([
      { text: "Hello ", hit: false },
      { text: "World", hit: true },
    ]);
  });

  it("多关键词同时生效，支持正则特殊字符", () => {
    expect(splitHighlight("a.b c", ["a.b", "c"])).toEqual([
      { text: "a.b", hit: true },
      { text: " ", hit: false },
      { text: "c", hit: true },
    ]);
  });

  it("无关键词或无命中时原样返回", () => {
    expect(splitHighlight("hello", [])).toEqual([{ text: "hello", hit: false }]);
    expect(splitHighlight("hello", ["xyz"])).toEqual([{ text: "hello", hit: false }]);
  });
});

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

describe("listTodos", () => {
  it("按出现顺序列出，含已完成与无文本项", () => {
    expect(listTodos("- [ ] a\n- [x] b\n- [ ]")).toEqual([
      { text: "a", done: false },
      { text: "b", done: true },
      { text: "", done: false },
    ]);
  });

  it("跳过代码块，且下标与 toggleTodo 对得上", () => {
    const c = "```\n- [x] code\n```\n- [ ] real\n- [ ] two";
    expect(listTodos(c)).toEqual([
      { text: "real", done: false },
      { text: "two", done: false },
    ]);
    // 列表第 i 项，正好是 toggleTodo(c, i) 会翻转的那一行
    expect(toggleTodo(c, 0)).toContain("- [x] real");
    expect(toggleTodo(c, 1)).toContain("- [x] two");
  });

  it("普通无序列表与正文不算待办", () => {
    expect(listTodos("- 买菜\ntext\n- [ ] 真待办")).toEqual([{ text: "真待办", done: false }]);
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

describe("splitImages", () => {
  it("切出 image:// 引用，其余文本保持原样", () => {
    expect(splitImages("看图 ![图片](image://12) 呢")).toEqual([
      { kind: "text", value: "看图 " },
      { kind: "image", value: "![图片](image://12)", id: 12, alt: "图片" },
      { kind: "text", value: " 呢" },
    ]);
  });

  it("没有图片引用时返回整段文本", () => {
    expect(splitImages("普通文字 #标签")).toEqual([
      { kind: "text", value: "普通文字 #标签" },
    ]);
  });

  it("普通 URL 图片链接不算 image 引用", () => {
    expect(splitImages("![图](https://example.com/a.png")).toEqual([
      { kind: "text", value: "![图](https://example.com/a.png" },
    ]);
  });
});

describe("parseBlocks 图片块", () => {
  it("独占一行的图片引用自成 image 块", () => {
    expect(parseBlocks("前面一行\n![截图](image://7)\n后面一行")).toEqual([
      { type: "p", lines: ["前面一行"] },
      { type: "image", id: 7, alt: "截图" },
      { type: "p", lines: ["后面一行"] },
    ]);
  });

  it("行内的图片引用不拆块，留给行内渲染处理", () => {
    const blocks = parseBlocks("看 ![图](image://3) 这张");
    expect(blocks).toEqual([{ type: "p", lines: ["看 ![图](image://3) 这张"] }]);
  });

  it("代码块里的图片引用不解析", () => {
    expect(parseBlocks("```\n![x](image://9)\n```")).toEqual([
      { type: "code", lines: ["![x](image://9)"] },
    ]);
  });
});
