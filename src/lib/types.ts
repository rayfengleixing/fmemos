export interface Memo {
  id: number;
  content: string;
  /** "YYYY-MM-DD HH:MM:SS" 本地时间，来自 SQLite */
  createdAt: string;
  updatedAt: string;
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

