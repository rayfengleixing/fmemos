import { extractTags, removeTagInContent, renameTagInContent } from "./tags";
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

/** 演示数据构造：updatedAt 取创建时间，pinnedAt 默认 null，省得每条都写全 */
function demo(
  id: number,
  content: string,
  createdAt: string,
  pinnedAt: string | null = null,
): Memo {
  return { id, content, createdAt, updatedAt: createdAt, pinnedAt };
}

const memos: Memo[] = [
  demo(1, "欢迎使用 FMemos！正文里打 #标签 会自动归档到左侧，支持 #读书/心理学 这样的层级。", stamp(0, "09:30:00")),
  demo(7, "去年今天记下的一条笔记，用来演示「那年今日」回顾。#回顾", lastYearTodayStamp()),
  demo(2, "Markdown 试试：**加粗文字**、`行内代码`、- 列表项一\n- 列表项二\n\n```\nconst x = 1;\n```\n", stamp(0, "08:12:00")),
  // 置顶演示：让浏览器模式也能看到置顶区
  demo(3, "#读书/心理学 这本书讲到了锚定效应。", stamp(1, "21:05:00"), stamp(0, "12:00:00")),
  demo(4, "#读书 读了 30 页，先记个进度。", stamp(1, "07:40:00")),
  demo(5, "#运动 晨跑 5 公里。", stamp(3, "07:00:00")),
  demo(6, "没有标签的一条备忘。", stamp(5, "22:00:00")),
  // 待办清单视图的演示数据：带标签的、无标签的、已完成的都有
  demo(8, "#工作 本周要做的：\n- [ ] 写周报\n- [ ] 发版前回归测试\n- [x] 回邮件", stamp(0, "10:20:00")),
  demo(9, "顺手记两件小事：\n- [ ] 换灯泡\n- [ ] 约牙医", stamp(2, "20:00:00")),
];

/** 设置项（浏览器 mock）：与后端 settings 表同语义 */
const settings = new Map<string, string>();

/** 图片存储（浏览器 mock）：id → {mime, base64}，与后端 images 表同语义 */
const images = new Map<number, { mime: string; data: string; sizeBytes: number }>();

function listMemos(args: {
  tag?: string | null;
  query?: string | null;
  untagged?: boolean;
  date?: string | null;
  trash?: boolean | null;
  pinned?: boolean | null;
  limit?: number | null;
  beforeCreatedAt?: string | null;
  beforeId?: number | null;
}): Memo[] {
  let out = [...memos].filter((m) =>
    args.trash ? trashed.has(m.id) : !trashed.has(m.id),
  );
  // 与后端一致：true = 只要置顶（置顶区），false = 只要未置顶（卡片流主列表）
  if (args.pinned === true) out = out.filter((m) => m.pinnedAt !== null);
  else if (args.pinned === false) out = out.filter((m) => m.pinnedAt === null);
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
  // 与后端一致：置顶区按 pinned_at DESC，其余按 created_at DESC, id DESC。
  // 游标分页在排序后截取——置顶项不参与分页，所以游标始终单调。
  out.sort((a, b) => {
    if (args.pinned === true) {
      const pa = a.pinnedAt ?? "";
      const pb = b.pinnedAt ?? "";
      if (pa !== pb) return pa < pb ? 1 : -1;
      return b.id - a.id;
    }
    return a.createdAt === b.createdAt ? b.id - a.id : a.createdAt < b.createdAt ? 1 : -1;
  });
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
            pinnedAt: null,
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
        case "set_pin": {
          const memo = memos.find((m) => m.id === args.id);
          if (!memo) return Promise.reject(`memo #${args.id} 不存在`);
          memo.pinnedAt = args.pinned ? nowStamp() : null;
          return Promise.resolve(memo);
        }
        // 导出：与后端一样支持 format（md / json）与筛选条件
        case "export_text": {
          const f = (args.filter ?? {}) as {
            tag?: string | null;
            query?: string | null;
            untagged?: boolean;
            date?: string | null;
          };
          const active = listMemos({
            tag: f.tag ?? null,
            query: f.query ?? null,
            untagged: f.untagged ?? false,
            date: f.date ?? null,
          });
          if (args.format === "json") {
            const items = active.map((m) => ({ ...m, tags: extractTags(m.content) }));
            return Promise.resolve(
              JSON.stringify(
                {
                  app: "FMemos",
                  version: "mock",
                  exportedAt: nowStamp(),
                  count: items.length,
                  filter: f,
                  memos: items,
                },
                null,
                2,
              ),
            );
          }
          const lines = [
            "# FMemos 导出",
            "",
            `> 导出时间：${nowStamp()} · 共 ${active.length} 条`,
            "",
          ];
          for (const m of active) lines.push(`## ${m.createdAt}`, "", m.content, "", "---", "");
          return Promise.resolve(lines.join("\n"));
        }
        case "get_setting":
          return Promise.resolve(settings.get(String(args.key)) ?? null);
        case "set_setting": {
          const key = String(args.key);
          const value = String(args.value ?? "");
          if (!value.trim()) settings.delete(key);
          else settings.set(key, value);
          return Promise.resolve();
        }
        // 图片：浏览器模式把 base64 存进 Map，同样按内容去重
        case "add_image": {
          const data = String(args.data ?? "");
          const mime = String(args.mime ?? "image/png");
          if (!data) return Promise.reject("图片内容为空");
          for (const [id, v] of images) {
            if (v.data === data) return Promise.resolve({ id, mime: v.mime, sizeBytes: v.sizeBytes });
          }
          const id = images.size > 0 ? Math.max(...images.keys()) + 1 : 1;
          const sizeBytes = Math.floor((data.length * 3) / 4); // base64 长度估算
          images.set(id, { mime, data, sizeBytes });
          return Promise.resolve({ id, mime, sizeBytes });
        }
        case "get_image": {
          const img = images.get(Number(args.id));
          return img
            ? Promise.resolve({ id: Number(args.id), mime: img.mime, data: img.data })
            : Promise.reject(`图片 #${args.id} 不存在`);
        }
        case "rename_tag": {
          const from = String(args.from).trim();
          const to = String(args.to).trim();
          if (!from || !to) return Promise.reject("标签名不能为空");
          if (from === to) return Promise.reject("新标签名和原标签一样");          let n = 0;
          for (const m of memos) {
            const next = renameTagInContent(m.content, from, to);
            if (next === null) continue;
            m.content = next;
            m.updatedAt = nowStamp();
            n += 1;
          }
          return Promise.resolve(n);
        }
        case "delete_tag": {
          const tag = String(args.tag).trim();
          if (!tag) return Promise.reject("标签名不能为空");
          let n = 0;
          for (const m of memos) {
            const next = removeTagInContent(m.content, tag)?.trim();
            // 与后端一致：删完正文会变空的那条跳过
            if (!next) continue;
            m.content = next;
            m.updatedAt = nowStamp();
            n += 1;
          }
          return Promise.resolve(n);
        }
        // 浏览器模式没有真实备份目录，给两条假数据供 UI 调试
        case "list_backups":
          return Promise.resolve([
            {
              name: "fmemos-backup-20260913.db",
              path: "(mock) fmemos-backup-20260913.db",
              date: stamp(0, "00:00:00").slice(0, 10),
              sizeBytes: 131072,
            },
            {
              name: "fmemos-backup-20260912.db",
              path: "(mock) fmemos-backup-20260912.db",
              date: stamp(1, "00:00:00").slice(0, 10),
              sizeBytes: 126976,
            },
          ]);
        case "restore_backup":
          return Promise.resolve(memos.length);
        // 浏览器模式没有真实文件系统 / 文件选择框：给一份空报告，链路能走通
        case "import_path":
          return Promise.resolve({
            total: 0,
            added: 0,
            skipped: 0,
            empty: 0,
            files: 0,
            samples: [] as string[],
          });
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
