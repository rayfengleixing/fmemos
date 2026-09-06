import { invoke } from "@tauri-apps/api/core";
import type { Memo } from "./types";

export async function listMemos(
  opts: {
    tag?: string | null;
    query?: string | null;
    untagged?: boolean;
    date?: string | null;
    /** true 时只列出回收站中的 memo */
    trash?: boolean;
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

/** 导出结果：file = 已写入另存为选定的位置；download = 浏览器下载；cancel = 用户取消 */
export type ExportResult = "file" | "download" | "cancel";

/**
 * 导出全部笔记为 Markdown。
 * Tauri 环境：系统另存为对话框选位置，由后端写文件；
 * 浏览器调试模式：对话框插件不可用，自动退回 Blob 下载。
 */
export async function exportMemos(): Promise<ExportResult> {
  const date = new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(
    date.getDate(),
  ).padStart(2, "0")}`;

  if ("__TAURI_INTERNALS__" in window) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        title: "导出为 Markdown",
        defaultPath: `FMemos-导出-${stamp}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return "cancel";
      await invoke<number>("export_to", { path });
      return "file";
    } catch {
      // 对话框不可用（如浏览器 mock），退回下载
    }
  }

  const content = await invoke<string>("export_markdown");
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `FMemos-导出-${stamp}.md`;
  a.click();
  URL.revokeObjectURL(url);
  return "download";
}
