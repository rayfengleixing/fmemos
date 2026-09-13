import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import * as api from "../lib/api";
import type { BackupInfo, ThemeMode } from "../lib/types";

const THEME_LABEL: Record<ThemeMode, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

interface Props {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  /** 操作结果提示（走 App 的浮条） */
  notify: (text: string) => void;
  /** 从备份恢复完成后调用：App 侧重新拉数据并回到「全部笔记」 */
  onRestored: () => Promise<void> | void;
  onClose: () => void;
}

export default function SettingsModal({
  theme,
  onThemeChange,
  notify,
  onRestored,
  onClose,
}: Props) {
  const [appVersion, setAppVersion] = useState("");
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    // 浏览器调试模式没有该命令，回退显示 dev
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("dev"));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const exportMarkdown = async () => {
    try {
      const result = await api.exportMemos();
      if (result === "file") notify("已导出到所选位置");
      else if (result === "download") notify("已通过浏览器下载");
    } catch (e) {
      notify(`导出失败：${e}`);
    }
  };

  const openBackup = async () => {
    try {
      await api.openBackupDir();
    } catch (e) {
      notify(String(e));
    }
  };

  /** 展开时读一次备份列表，收起时清掉 */
  const toggleBackups = async () => {
    if (backups) {
      setBackups(null);
      return;
    }
    try {
      setBackups(await api.listBackups());
    } catch (e) {
      notify(`读取备份列表失败：${e}`);
    }
  };

  const restore = async (b: BackupInfo) => {
    if (
      !confirm(
        `用 ${b.date} 的备份覆盖当前数据？\n\n` +
          "恢复前会自动把当前数据另存一份到备份文件夹（before-restore 开头），万一恢复错了还能找回来。\n" +
          "恢复立即生效，不需要重启。",
      )
    ) {
      return;
    }
    setRestoring(b.path);
    try {
      const count = await api.restoreBackup(b.path);
      await onRestored();
      setBackups(await api.listBackups());
      notify(`已恢复到 ${b.date} 的备份，共 ${count} 条笔记`);
    } catch (e) {
      notify(`恢复失败：${e}`);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span>设置</span>
          <button className="review-close" title="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="settings-section">
          <div className="settings-label">外观</div>
          <div className="seg">
            {(["light", "dark", "system"] as const).map((t) => (
              <button
                key={t}
                className={"seg-item" + (theme === t ? " active" : "")}
                onClick={() => onThemeChange(t)}
              >
                {THEME_LABEL[t]}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-label">自动备份与恢复</div>
          <p className="settings-desc">
            每天首次启动时自动把完整数据库备份到程序旁的 backup 文件夹，保留最近 5 份。
            恢复会用所选备份覆盖当前数据（恢复前自动留安全副本），立即生效、不用重启。
          </p>
          <div className="settings-actions">
            <button className="btn-ghost" onClick={() => void openBackup()}>
              打开备份文件夹
            </button>
            <button className="btn-ghost" onClick={() => void toggleBackups()}>
              {backups ? "收起备份列表" : "从备份恢复"}
            </button>
          </div>

          {backups &&
            (backups.length === 0 ? (
              <p className="settings-desc settings-note">
                还没有备份文件。首次启动完成自动备份后就会出现在这里。
              </p>
            ) : (
              <ul className="backup-list">
                {backups.map((b) => (
                  <li key={b.path} className="backup-item">
                    <span className="backup-date">{b.date}</span>
                    <span className="backup-size">{fmtSize(b.sizeBytes)}</span>
                    <button
                      className="btn-ghost"
                      disabled={restoring !== null}
                      onClick={() => void restore(b)}
                    >
                      {restoring === b.path ? "恢复中..." : "恢复"}
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </div>

        <div className="settings-section">
          <div className="settings-label">导出</div>
          <p className="settings-desc">将全部笔记导出为一个 Markdown 文件（含创建时间，标签随正文保留）。</p>
          <button className="btn-ghost" onClick={() => void exportMarkdown()}>
            导出为 Markdown
          </button>
        </div>

        <div className="settings-section settings-about">
          <div className="settings-label">关于</div>
          <p className="settings-desc">
            FMemos {appVersion} · flomo 风格的本地卡片笔记
          </p>
        </div>
      </div>
    </div>
  );
}
