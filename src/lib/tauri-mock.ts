import { extractTags } from "./tags";
import type { Memo } from "./types";

/**
 * 纯浏览器调试模式：没有 Tauri 外壳时（直接 `npm run dev` 开浏览器），
 * 用内存版后端替代 invoke，方便不启动 Tauri 就调试 UI。
 * 在 Tauri 窗口里运行时完全不生效。
 */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function stamp(dayOffset: number, time: string): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

function nowStamp(): string {
  const d = new Date();
  return stamp(0, `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
}

/** 去年今天：供「那年今日」回顾演示 */
function lastYearTodayStamp(): string {
  const d = new Date();
  return `${d.getFullYear() - 1}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 10:00:00`;
}

const memos: Memo[] = [
  { id: 1, content: "欢迎使用 FMemos！正文里打 #标签 会自动归档到左侧，支持 #读书/心理学 这样的层级。", createdAt: stamp(0, "09:30:00"), updatedAt: stamp(0, "09:30:00") },
  { id: 7, content: "去年今天记下的一条笔记，用来演示「那年今日」回顾。#回顾", createdAt: lastYearTodayStamp(), updatedAt: lastYearTodayStamp() },
  { id: 2, content: "Markdown 试试：**加粗文字**、`行内代码`、- 列表项一\n- 列表项二\n\n```\nconst x = 1;\n```\n", createdAt: stamp(0, "08:12:00"), updatedAt: stamp(0, "08:12:00") },
  { id: 3, content: "#读书/心理学 这本书讲到了锚定效应。", createdAt: stamp(1, "21:05:00"), updatedAt: stamp(1, "21:05:00") },
  { id: 4, content: "#读书 读了 30 页，先记个进度。", createdAt: stamp(1, "07:40:00"), updatedAt: stamp(1, "07:40:00") },
  { id: 5, content: "#运动 晨跑 5 公里。", createdAt: stamp(3, "07:00:00"), updatedAt: stamp(3, "07:00:00") },
  { id: 6, content: "没有标签的一条备忘。", createdAt: stamp(5, "22:00:00"), updatedAt: stamp(5, "22:00:00") },
];

function listMemos(args: {
  tag?: string | null;
  query?: string | null;
  untagged?: boolean;
  date?: string | null;
  trash?: boolean | null;
  limit?: number | null;
  beforeCreatedAt?: string | null;
  beforeId?: number | null;
}): Memo[] {
  let out = [...memos].filter((m) =>
    args.trash ? trashed.has(m.id) : !trashed.has(m.id),
  );
  const tag = args.tag?.trim();
  if (tag) {
    out = out.filter((m) =>
      extractTags(m.content).some((t) => t === tag || t.startsWith(`${tag}/`)),
    );
  }
  const query = args.query?.trim();
  if (query) {
    // 与后端一致：多关键词 AND，不区分大小写
    const terms = query.split(/\s+/).filter(Boolean);
    out = out.filter((m) => {
      const content = m.content.toLowerCase();
      return terms.every((t) => content.includes(t.toLowerCase()));
    });
  }
  if (args.untagged) out = out.filter((m) => extractTags(m.content).length === 0);
  const date = args.date?.trim();
  if (date) out = out.filter((m) => m.createdAt.startsWith(date));
  // 与后端一致：created_at DESC, id DESC；游标分页在排序后截取
  out.sort((a, b) =>
    a.createdAt === b.createdAt ? b.id - a.id : a.createdAt < b.createdAt ? 1 : -1,
  );
  if (args.beforeCreatedAt) {
    const at = args.beforeCreatedAt;
    const id = args.beforeId ?? 0;
    out = out.filter((m) => m.createdAt < at || (m.createdAt === at && m.id < id));
  }
  if (typeof args.limit === "number") out = out.slice(0, args.limit);
  return out;
}

let nextId = 100;
/** 回收站：软删除的 memo id（浏览器 mock 语义与后端一致） */
const trashed = new Set<number>();

export function installBrowserMock(): void {
  if ("__TAURI_INTERNALS__" in window) return;

  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
      switch (cmd) {
        case "list_memos":
          return Promise.resolve(listMemos(args as Parameters<typeof listMemos>[0]));
        case "create_memo": {
          const memo: Memo = {
            id: (nextId += 1),
            content: String(args.content).trim(),
            createdAt: nowStamp(),
            updatedAt: nowStamp(),
          };
          memos.unshift(memo);
          return Promise.resolve(memo);
        }
        case "update_memo": {
          const memo = memos.find((m) => m.id === args.id);
          if (!memo) return Promise.reject(`memo #${args.id} 不存在`);
          memo.content = String(args.content).trim();
          memo.updatedAt = nowStamp();
          return Promise.resolve(memo);
        }
        case "delete_memo": {
          // 软删除：与后端一致，可恢复
          if (!memos.some((m) => m.id === args.id && !trashed.has(m.id))) {
            return Promise.reject(`memo #${args.id} 不存在`);
          }
          trashed.add(args.id as number);
          return Promise.resolve();
        }
        case "restore_memo": {
          trashed.delete(args.id as number);
          return Promise.resolve();
        }
        case "purge_memo": {
          const i = memos.findIndex((m) => m.id === args.id);
          if (i >= 0) memos.splice(i, 1);
          trashed.delete(args.id as number);
          return Promise.resolve();
        }
        case "empty_trash": {
          const n = trashed.size;
          for (let i = memos.length - 1; i >= 0; i -= 1) {
            if (trashed.has(memos[i].id)) memos.splice(i, 1);
          }
          trashed.clear();
          return Promise.resolve(n);
        }
        case "export_markdown": {
          const active = memos.filter((m) => !trashed.has(m.id));
          const lines = [
            "# FMemos 导出",
            "",
            `> 导出时间：${nowStamp()} · 共 ${active.length} 条`,
            "",
          ];
          for (const m of active) lines.push(`## ${m.createdAt}`, "", m.content, "", "---", "");
          return Promise.resolve(lines.join("\n"));
        }
        // 事件系统只需返回 id，浏览器里 quick-open 永远不会触发
        case "plugin:event|listen":
          return Promise.resolve(++nextId);
        case "plugin:event|unlisten":
          return Promise.resolve();
        // opener 插件：浏览器里记录 URL 供测试断言，不真的打开新标签
        case "plugin:opener|open_url":
          (window as unknown as { __lastOpenedUrl?: string }).__lastOpenedUrl = String(
            args.url ?? "",
          );
          return Promise.resolve();
        default:
          return Promise.reject(new Error(`browser mock: unknown command ${cmd}`));
      }
    },
    transformCallback(): number {
      return ++nextId;
    },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
}
