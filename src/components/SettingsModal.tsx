import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import * as api from "../lib/api";
import type { ThemeMode } from "../lib/types";

const THEME_LABEL: Record<ThemeMode, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

interface Props {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  /** 操作结果提示（走 App 的浮条） */
  notify: (text: string) => void;
  onClose: () => void;
}

export default function SettingsModal({ theme, onThemeChange, notify, onClose }: Props) {
  const [appVersion, setAppVersion] = useState("");
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
          <div className="settings-label">自动备份</div>
          <p className="settings-desc">
            每天首次启动时自动把完整数据库备份到程序旁的 backup 文件夹，保留最近 5 份。
          </p>
          <button className="btn-ghost" onClick={() => void openBackup()}>
            打开备份文件夹
          </button>
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
