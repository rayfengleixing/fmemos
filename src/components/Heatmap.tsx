import { useMemo } from "react";
import { toDateKey } from "../lib/format";

interface Props {
  /** 日期 "YYYY-MM-DD" -> 当天条数 */
  counts: Map<string, number>;
  activeDate: string | null;
  onSelectDate: (date: string | null) => void;
}

const WEEKS = 15;

function levelOf(count: number): number {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

/** GitHub 风格热力图：近 15 周，7 行 × 15 列（列 = 周，行 = 周日到周六），点击某天筛选 */
export default function Heatmap({ counts, activeDate, onSelectDate }: Props) {
  // 网格只依赖数据本身，筛选等无关重渲染不必重建 105 个格子
  const cells = useMemo(() => {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + (6 - end.getDay())); // 网格终点对齐本周周六，当前周是最后一列（未到的天隐藏）
    const start = new Date(end);
    start.setDate(start.getDate() - (WEEKS * 7 - 1)); // end 为周六，减 104 天后必为周日

    const out: { key: string; count: number; future: boolean }[] = [];
    const cursor = new Date(start);
    for (let i = 0; i < WEEKS * 7; i += 1) {
      const key = toDateKey(cursor);
      const future = cursor > end;
      out.push({ key, count: future ? 0 : counts.get(key) ?? 0, future });
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }, [counts]);

  return (
    <div className="hm-grid">
      {cells.map((cell) => (
        <button
          key={cell.key}
          className={
            "hm-cell hm-l" +
            levelOf(cell.count) +
            (cell.future ? " future" : "") +
            (cell.key === activeDate ? " active" : "")
          }
          title={cell.future ? undefined : `${cell.key.slice(5)} · ${cell.count} 条`}
          disabled={cell.future}
          onClick={() => onSelectDate(cell.key === activeDate ? null : cell.key)}
        />
      ))}
    </div>
  );
}
