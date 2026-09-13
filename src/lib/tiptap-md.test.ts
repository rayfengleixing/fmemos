import { describe, expect, it } from "vitest";
import { docToMd, imageTokenToNode, mdToDoc } from "./tiptap-md";
import { listTodos, parseBlocks } from "./md";
import { extractTags } from "./tags";

/** 打开→不动→保存 字节级无损的「正形」样例（不含空行；空行保存时会归一化，单独测） */
const CANONICAL_SAMPLES = [
  "今天天气不错",
  "两行正文\n第二行也保留",
  "**加粗文字** 和 `code` 混排",
  "#工作 重点：https://example.com/a?b=1，记一下",
  "#随手记 #读书/心理学 多个标签 #tag1",
  "- 买菜\n- 做饭",
  "1. 第一\n2. 第二\n3. 第三",
  "- [ ] 买菜\n- [x] 写周报",
  "```\nconst x = 1;\n// 多行\n```",
  "![图片](image://12)",
  "看图 ![图片](image://3) 完",
  "**加粗**、`行内代码`、#标签、https://a.b/c 与 - [ ] 待办 同段",
];

describe("tiptap-md 往返", () => {
  it.each(CANONICAL_SAMPLES)("字节级往返：%s", (sample) => {
    expect(docToMd(mdToDoc(sample))).toBe(sample);
  });

  it("序列化幂等：二次往返不再变化", () => {
    for (const sample of CANONICAL_SAMPLES) {
      const once = docToMd(mdToDoc(sample));
      expect(docToMd(mdToDoc(once))).toBe(once);
    }
  });

  it("空行段落边界与软换行都能无损往返", () => {
    // 空行 = 两个独立段落；无空行 = 一个段落里的软换行（渲染结构不同，必须都保真）
    const twoParas = "段一\n\n段二";
    expect(docToMd(mdToDoc(twoParas))).toBe(twoParas);
    expect(parseBlocks(docToMd(mdToDoc(twoParas)))).toEqual(parseBlocks(twoParas));

    const softBreak = "段一\n段二";
    expect(docToMd(mdToDoc(softBreak))).toBe(softBreak);
    expect(parseBlocks(docToMd(mdToDoc(softBreak)))).toEqual(parseBlocks(softBreak));
  });

  it("有序列表编号按渲染口径归一化（<ol> 恒显示 1..n）", () => {
    expect(docToMd(mdToDoc("1. 第一\n2. 第二\n10. 第十"))).toBe(
      "1. 第一\n2. 第二\n3. 第十",
    );
  });

  it("空正文得到空串", () => {
    expect(docToMd(mdToDoc(""))).toBe("");
  });

  it("待办计数与完成态经往返不变（待办聚合视图的依赖）", () => {
    const md = "前言\n- [ ] 一\n- [x] 二\n```\n- [ ] 围栏内不算\n```\n- [ ] 三";
    const round = docToMd(mdToDoc(md));
    expect(listTodos(round)).toEqual(listTodos(md));
    expect(listTodos(round)).toEqual([
      { text: "一", done: false },
      { text: "二", done: true },
      { text: "三", done: false },
    ]);
  });

  it("标签经往返不变（标签治理的依赖）", () => {
    const md = "#读书/心理学 笔记\n- [ ] #工作/周报 待办";
    expect(extractTags(docToMd(mdToDoc(md)))).toEqual(extractTags(md));
  });

  it("行内代码里的标记保持字面", () => {
    const md = "code 里 `**不解析**` 加粗外 `#tag` 字面";
    expect(docToMd(mdToDoc(md))).toBe(md);
  });

  it("代码块里的待办与标签不算正文语义", () => {
    const md = "```\n- [ ] not a todo\n#not-a-tag\n```";
    expect(listTodos(docToMd(mdToDoc(md)))).toEqual([]);
  });
});

describe("docToMd 鲁棒性", () => {
  it("未知节点类型静默跳过", () => {
    expect(
      docToMd({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "保留" }] },
          { type: "alienBlock", content: [{ type: "text", text: "丢弃" }] },
        ],
      }),
    ).toBe("保留");
  });

  it("空任务项保留占位（- [ ] ），不丢行", () => {
    const md = docToMd({
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [{ type: "taskItem", attrs: { checked: false }, content: [] }],
        },
      ],
    });
    expect(listTodos(md)).toEqual([{ text: "", done: false }]);
  });
});

describe("imageTokenToNode", () => {
  it("合法 token 转图片节点", () => {
    expect(imageTokenToNode("![图片](image://7)")).toEqual({
      type: "memoImage",
      attrs: { id: 7, alt: "图片" },
    });
  });

  it("非法 token 返回 null", () => {
    expect(imageTokenToNode("普通文本")).toBe(null);
    expect(imageTokenToNode("![x](https://a.png)")).toBe(null);
  });
});
