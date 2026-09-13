import { invoke } from "@tauri-apps/api/core";
import type { BackupInfo, ExportFormat, ImportReport, Memo, MemoFilter } from "./types";

export async function listMemos(
  opts: {
    tag?: string | null;
    query?: string | null;
    untagged?: boolean;
    date?: string | null;
    /** true 时只列出回收站中的 memo */
    trash?: boolean;
    /**
     * 置顶过滤：null / undefined = 不筛；true = 只要置顶（置顶区）；false = 只要未置顶（卡片流主列表）。
     * 置顶项不参与分页——主列表传 false 把它们排除，置顶区单独查，两边不会重复。
     */
    pinned?: boolean | null;
    /** 分页大小；不传返回全部 */
    limit?: number | null;
    /** 游标：取 (createdAt, id) 排序在该条之后的下一页 */
    before?: { createdAt: string; id: number } | null;
  } = {},
): Promise<Memo[]> {
  return invoke<Memo[]>("list_memos", {
    tag: opts.tag ?? null,
    query: opts.query ?? null,
    untagged: opts.untagged ?? false,
    date: opts.date ?? null,
    trash: opts.trash ?? false,
    pinned: opts.pinned ?? null,
    limit: opts.limit ?? null,
    beforeCreatedAt: opts.before?.createdAt ?? null,
    beforeId: opts.before?.id ?? null,
  });
}

export function createMemo(content: string): Promise<Memo> {
  return invoke<Memo>("create_memo", { content });
}

export function updateMemo(id: number, content: string): Promise<Memo> {
  return invoke<Memo>("update_memo", { id, content });
}

/** 删除 = 移入回收站（可 restoreMemo 撤销） */
export function deleteMemo(id: number): Promise<void> {
  return invoke<void>("delete_memo", { id });
}

/** 置顶 / 取消置顶，返回更新后的 memo（可直接替换列表里的那一条） */
export function setPin(id: number, pinned: boolean): Promise<Memo> {
  return invoke<Memo>("set_pin", { id, pinned });
}

export function restoreMemo(id: number): Promise<void> {
  return invoke<void>("restore_memo", { id });
}

export function purgeMemo(id: number): Promise<void> {
  return invoke<void>("purge_memo", { id });
}

export function emptyTrash(): Promise<number> {
  return invoke<number>("empty_trash");
}

export function openBackupDir(): Promise<void> {
  return invoke<void>("open_backup_dir");
}

/**
 * 重命名或合并标签：改写所有正文里的 `#from`（含 `from/` 子孙），返回受影响的笔记数。
 * 合并到已有标签即把 to 传成那个标签。
 */
export function renameTag(from: string, to: string): Promise<number> {
  return invoke<number>("rename_tag", { from, to });
}

/** 删除标签：从所有正文里移除 `#tag`（含子孙），返回受影响的笔记数 */
export function deleteTag(tag: string): Promise<number> {
  return invoke<number>("delete_tag", { tag });
}

/** 列出自动备份（最新在前）。浏览器调试模式返回假数据。 */
export function listBackups(): Promise<BackupInfo[]> {
  return invoke<BackupInfo[]>("list_backups");
}

/** 从备份恢复，返回恢复后的笔记条数 */
export function restoreBackup(path: string): Promise<number> {
  return invoke<number>("restore_backup", { path });
}

/** 导出结果：file = 已写入另存为选定的位置；download = 浏览器下载；cancel = 用户取消 */
export type ExportResult = "file" | "download" | "cancel";

/**
 * 从文件或文件夹导入笔记（.md / .markdown / .txt / flomo 的 .html 导出包）。
 * dryRun = true 时只解析统计、不写库，用于导入前确认；按正文去重，重复导入不会翻倍。
 */
export function importPath(path: string, dryRun: boolean): Promise<ImportReport> {
  return invoke<ImportReport>("import_path", { path, dryRun });
}

/**
 * 导出笔记。
 * Tauri 环境：系统另存为对话框选位置，由后端写文件；
 * 浏览器调试模式：对话框插件不可用，自动退回 Blob 下载。
 * filter 传当前筛选条件就是「只导出这一批」，传 null 表示导出全部。
 */
export async function exportMemos(
  format: ExportFormat = "md",
  filter: MemoFilter | null = null,
): Promise<ExportResult> {
  const date = new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(
    date.getDate(),
  ).padStart(2, "0")}`;
  const json = format === "json";
  const ext = json ? "json" : "md";

  if ("__TAURI_INTERNALS__" in window) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        title: json ? "导出为 JSON" : "导出为 Markdown",
        defaultPath: `FMemos-导出-${stamp}.${ext}`,
        filters: [
          json ? { name: "JSON", extensions: ["json"] } : { name: "Markdown", extensions: ["md"] },
        ],
      });
      if (!path) return "cancel";
      await invoke<number>("export_to", { path, format, filter });
      return "file";
    } catch {
      // 对话框不可用（如浏览器 mock），退回下载
    }
  }

  const content = await invoke<string>("export_text", { format, filter });
  const blob = new Blob([content], {
    type: json ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `FMemos-导出-${stamp}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
  return "download";
}

/** 读一个设置项；键不存在返回 null */
export function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("get_setting", { key });
}

/** 写一个设置项；值为空串等同删除该项 */
export function setSetting(key: string, value: string): Promise<void> {
  return invoke<void>("set_setting", { key, value });
}
