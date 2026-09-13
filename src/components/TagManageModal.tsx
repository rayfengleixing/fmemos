import { useEffect, useMemo, useState } from "react";

interface Props {
  /** 正在管理的标签路径（如 "读书" 或 "读书/心理学"） */
  tag: string;
  /** 会被这次操作影响的笔记数（含子孙标签），由 App 用全量数据算出 */
  affected: number;
  /** 可用于「合并到」的已有标签（已排除自身与其子孙） */
  candidateTags: string[];
  /** 重命名 / 合并：失败时抛错，由弹窗展示 */
  onRename: (from: string, to: string) => Promise<void>;
  onDelete: (tag: string) => Promise<void>;
  onClose: () => void;
}

const MODE_LABEL = { rename: "重命名", merge: "合并到已有标签" } as const;

export default function TagManageModal({
  tag,
  affected,
  candidateTags,
  onRename,
  onDelete,
  onClose,
}: Props) {
  const [mode, setMode] = useState<keyof typeof MODE_LABEL>("rename");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 允许用户顺手输入带 # 的标签名
  const target = value.trim().replace(/^#/, "");
  const invalid = useMemo(() => {
    if (!target) return null;
    if (target === tag) return "和原标签一样";
    if (target.startsWith(`${tag}/`)) return "不能改成它自己的子标签";
    if (tag.startsWith(`${target}/`)) return "不能改成它的上级标签";
    return null;
  }, [target, tag]);

  const submit = async () => {
    if (!target || invalid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onRename(tag, target);
      onClose();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onDelete(tag);
      onClose();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span>
            管理标签 <span className="tag-hash">#</span>
            {tag}
          </span>
          <button className="review-close" title="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="settings-section">
          <p className="settings-desc">
            这条标签出现在 <b>{affected}</b> 条笔记的正文里（含 <code>#{tag}/子标签</code> 的
            笔记）。标签写在正文中，所以这里的操作会直接改写这些笔记的正文。
          </p>
          <div className="seg">
            {(Object.keys(MODE_LABEL) as (keyof typeof MODE_LABEL)[]).map((m) => (
              <button
                key={m}
                className={"seg-item" + (mode === m ? " active" : "")}
                onClick={() => {
                  setMode(m);
                  setValue("");
                  setErr(null);
                }}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-section">
          <input
            className="tag-manage-input"
            autoFocus
            value={value}
            placeholder={mode === "rename" ? "新的标签名，例如 阅读" : "要合并到的标签名"}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          {invalid && <p className="tag-manage-err">{invalid}</p>}
          {target && !invalid && (
            <p className="settings-desc tag-manage-preview">
              {mode === "rename" ? "重命名" : "合并"}后：
              <span className="tag-hash">#{tag}</span> → <span className="tag-hash">#{target}</span>
              {affected > 0 && ` ，共改写 ${affected} 条笔记`}
            </p>
          )}

          {mode === "merge" && candidateTags.length > 0 && (
            <div className="tag-manage-candidates">
              {candidateTags.map((t) => (
                <button key={t} className="tag-chip" onClick={() => setValue(t)}>
                  #{t}
                </button>
              ))}
            </div>
          )}
        </div>

        {err && <div className="error-banner">{err}</div>}

        <div className="settings-section tag-manage-foot">
          <button
            className="btn-primary"
            disabled={!target || !!invalid || busy}
            onClick={() => void submit()}
          >
            {busy ? "处理中..." : mode === "rename" ? "重命名" : "合并"}
          </button>
          <button
            className={"btn-ghost" + (confirmDelete ? " danger" : "")}
            disabled={busy}
            onClick={() => void remove()}
            onBlur={() => setConfirmDelete(false)}
          >
            {confirmDelete ? `确认移除 #${tag}？` : "删除这个标签"}
          </button>
        </div>
      </div>
    </div>
  );
}
