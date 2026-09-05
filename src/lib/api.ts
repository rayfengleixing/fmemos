import { invoke } from "@tauri-apps/api/core";
import type { Memo } from "./types";

export async function listMemos(
  opts: {
    tag?: string | null;
    query?: string | null;
    untagged?: boolean;
    date?: string | null;
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

export function deleteMemo(id: number): Promise<void> {
  return invoke<void>("delete_memo", { id });
}
