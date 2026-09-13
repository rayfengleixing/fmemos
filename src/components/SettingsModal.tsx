import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import * as api from "../lib/api";
import type { BackupInfo, ExportFormat, MemoFilter, ThemeMode } from "../lib/types";

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
  /** 当前筛选条件，供「只导出当前筛选」使用 */
  currentFilter: MemoFilter;
  /** 当前筛选的可读描述（如 `#读书`）；无筛选时为空串 */
  filterLabel: string;
  /** 操作结果提示（走 App 的浮条） */
  notify: (text: string) => void;
  /** 数据整体变化后调用（从备份恢复 / 批量导入）：App 侧重新拉数据并回到「全部笔记」 */
  onDataReloaded: () => Promise<void> | void;
  onClose: () => void;
}

export default function SettingsModal({
  theme,
  onThemeChange,
  currentFilter,
  filterLabel,
  notify,
  onDataReloaded,
  onClose,
}: Props) {
  const [appVersion, setAppVersion] = useState("");
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("md");
  const [onlyFiltered, setOnlyFiltered] = useState(false);
  const [mdDir, setMdDir] = useState<string | null>(null);

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

  /** 每日 Markdown 导出的目录：存在后端 settings 表里，启动时由后端自己读取 */
  useEffect(() => {
    api
      .getSetting("md_export_dir")
      .then(setMdDir)
      .catch(() => setMdDir(null));
  }, []);

  const exportNow = async () => {
    try {
      const filter = onlyFiltered && filterLabel ? currentFilter : null;
      const result = await api.exportMemos(format, filter);
      if (result === "file") notify("已导出到所选位置");
      else if (result === "download") notify("已通过浏览器下载");
    } catch (e) {
      notify(`导出失败：${e}`);
    }
  };

  const pickMdDir = async () => {
    let picked: string;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const r = await open({ title: "选择每日 Markdown 导出的目录", directory: true });
      if (typeof r !== "string") return;
      picked = r;
    } catch {
      notify("浏览器调试模式没有目录选择框，请在应用里设置");
      return;
    }
    try {
      await api.setSetting("md_export_dir", picked);
      setMdDir(picked);
      notify("已开启每日 Markdown 导出");
    } catch (e) {
      notify(`设置失败：${e}`);
    }
  };

  const clearMdDir = async () => {
    try {
      await api.setSetting("md_export_dir", "");
      setMdDir(null);
      notify("已关闭每日 Markdown 导出");
    } catch (e) {
      notify(`关闭失败：${e}`);
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
      await onDataReloaded();
      setBackups(await api.listBackups());
      notify(`已恢复到 ${b.date} 的备份，共 ${count} 条笔记`);
    } catch (e) {
      notify(`恢复失败：${e}`);
    } finally {
      setRestoring(null);
    }
  };

  /**
   * 导入：选文件 / 文件夹 → 先跑一次 dryRun 拿到统计与样本 → 确认后才真正写库。
   * 后端按正文去重，重复导入同一个文件不会翻倍，所以选错了也不会污染数据。
   */
  const pickAndImport = async (directory: boolean) => {
    let path: string;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = directory
        ? await open({ title: "选择要导入的文件夹", directory: true })
        : await open({
            title: "选择要导入的文件",
            multiple: false,
            filters: [
              {
                name: "Markdown / 文本 / flomo 导出 / FMemos 备份",
                extensions: ["md", "markdown", "txt", "html", "htm", "json"],
              },
            ],
          });
      if (typeof picked !== "string") return;
      path = picked;
    } catch {
      // 浏览器调试模式没有文件选择框
      notify("浏览器调试模式没有文件选择框，请在应用里导入");
      return;
    }

    setImporting(true);
    try {
      const preview = await api.importPath(path, true);
      if (preview.added === 0) {
        notify(
          `没有可导入的新内容：扫过 ${preview.files} 个文件，识别 ${preview.total} 条，` +
            `重复 ${preview.skipped} 条，空内容 ${preview.empty} 条`,
        );
        return;
      }
      const lines = [
        `扫过 ${preview.files} 个文件，识别 ${preview.total} 条笔记`,
        `将新增 ${preview.added} 条，跳过重复 ${preview.skipped} 条` +
          (preview.empty > 0 ? `，空内容 ${preview.empty} 条` : ""),
        "",
        ...preview.samples.map((s) => `· ${s}`),
        preview.added > preview.samples.length ? "· …" : "",
        "",
        "确认导入？（按正文去重，重复导入同一个文件不会翻倍）",
      ].filter((l) => l !== "");
      if (!confirm(lines.join("\n"))) return;

      const report = await api.importPath(path, false);
      await onDataReloaded();
      notify(`已导入 ${report.added} 条笔记（跳过重复 ${report.skipped} 条）`);
    } catch (e) {
      notify(`导入失败：${e}`);
    } finally {
      setImporting(false);
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
                      disabled={restoring !== null || importing}
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
          <p className="settings-desc">
            Markdown 便于阅读；JSON 会额外保留精确时间戳、置顶状态与标签数组，适合结构化备份。
          </p>
          <div className="seg">
            {(["md", "json"] as const).map((f) => (
              <button
                key={f}
                className={"seg-item" + (format === f ? " active" : "")}
                onClick={() => setFormat(f)}
              >
                {f === "md" ? "Markdown" : "JSON"}
              </button>
            ))}
          </div>
          {filterLabel && (
            <label className="settings-check">
              <input
                type="checkbox"
                checked={onlyFiltered}
                onChange={(e) => setOnlyFiltered(e.target.checked)}
              />
              只导出当前筛选（{filterLabel}）
            </label>
          )}
          <div className="settings-actions">
            <button className="btn-ghost" onClick={() => void exportNow()}>
              导出{format === "md" ? "为 Markdown" : "为 JSON"}
            </button>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-label">每日 Markdown 导出</div>
          <p className="settings-desc">
            指定一个目录后，每天首次启动会顺带把全部笔记写一份 Markdown 到那里（文件名带日期）。
            适合丢进同步盘或网盘——数据库快照在 WAL 下直接同步并不稳妥，Markdown 没这个问题。
          </p>
          <div className="settings-actions">
            <button className="btn-ghost" onClick={() => void pickMdDir()}>
              选择目录
            </button>
            {mdDir && (
              <button className="btn-ghost" onClick={() => void clearMdDir()}>
                关闭
              </button>
            )}
          </div>
          <p className="settings-desc settings-note">
            {mdDir ? `当前目录：${mdDir}` : "当前：未开启"}
          </p>
        </div>

        <div className="settings-section">
          <div className="settings-label">导入</div>
          <p className="settings-desc">
            从 flomo 导出的 HTML、Markdown / 纯文本文件（整个文件夹也行）、或 FMemos 导出的
            JSON 备份（回灌会原样恢复时间戳与置顶状态）。
            按正文去重，重复导入同一个文件不会翻倍；真正写入前会先给出条数预览让你确认。
          </p>
          <div className="settings-actions">
            <button
              className="btn-ghost"
              disabled={importing}
              onClick={() => void pickAndImport(false)}
            >
              {importing ? "导入中..." : "导入文件"}
            </button>
            <button
              className="btn-ghost"
              disabled={importing}
              onClick={() => void pickAndImport(true)}
            >
              导入文件夹
            </button>
          </div>
          <p className="settings-desc settings-note">
            文件夹里每个 .md / .txt 算一条；文件里若有 <code>## 2021-04-05 09:43:21</code> 这样的分节标题，
            会按节拆成多条，没写时间的用文件修改时间。
          </p>
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
