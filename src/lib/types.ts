export interface Memo {
  id: number;
  content: string;
  /** "YYYY-MM-DD HH:MM:SS" 本地时间，来自 SQLite */
  createdAt: string;
  updatedAt: string;
  /** 置顶时间；null = 未置顶 */
  pinnedAt: string | null;
}

/** 筛选条件：全空表示不筛（导出全部 / 当前视图无筛选） */
export interface MemoFilter {
  tag: string | null;
  query: string | null;
  untagged: boolean;
  date: string | null;
}

/** 导出格式：Markdown 便于阅读，JSON 保住时间戳与标签，可回灌 */
export type ExportFormat = "md" | "json";

/** 侧栏保存的智能列表：一个名字 + 一组筛选条件 */
export interface SavedFilter {
  id: string;
  name: string;
  filter: MemoFilter;
}

/** 已入库图片的元信息；字节走 get_image 单独取（base64） */
export interface ImageInfo {
  id: number;
  mime: string;
  sizeBytes: number;
}

/** 标签树节点：path 是从根到本级的完整路径（如 "读书/心理学"），count 含所有子孙 */
export interface TagNode {
  name: string;
  path: string;
  count: number;
  children: TagNode[];
}

/** 外观主题：浅色 / 深色 / 跟随系统 */
export type ThemeMode = "light" | "dark" | "system";

/** 自动备份文件信息（来自 exe 旁 backup/ 目录） */
export interface BackupInfo {
  name: string;
  path: string;
  /** 备份日期 "YYYY-MM-DD" */
  date: string;
  sizeBytes: number;
}

/** 导入报告：dryRun 时 added 表示「将新增」的条数 */
export interface ImportReport {
  /** 识别到的笔记条数（含重复与空内容） */
  total: number;
  /** 实际写入 / 将要写入的条数 */
  added: number;
  /** 因正文重复而跳过的条数 */
  skipped: number;
  /** 因正文为空而跳过的条数 */
  empty: number;
  /** 扫过的文件数 */
  files: number;
  /** 前几条正文摘要，供确认前预览 */
  samples: string[];
}

