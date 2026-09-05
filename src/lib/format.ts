/** SQLite 存的 "YYYY-MM-DD HH:MM:SS" 转成展示用短时间：今天只显示时分，其他显示月-日 */
export function formatTime(ts: string): string {
  const [date, time] = ts.split(" ");
  if (!date) return ts;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (date === today) return time ? time.slice(0, 5) : date;
  return date.slice(5);
}

/** Date -> "YYYY-MM-DD"（本地时区） */
export function toDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 卡片流日期头：今天 / 昨天 / M月D日 周X（跨年带年份） */
export function dateHeaderLabel(dateKey: string): string {
  const now = new Date();
  const today = toDateKey(now);
  const yesterday = toDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  if (dateKey === today) return "今天";
  if (dateKey === yesterday) return "昨天";
  const [y, m, d] = dateKey.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  const md = `${m}月${d}日 ${weekday}`;
  return y === now.getFullYear() ? md : `${y}年${md}`;
}
