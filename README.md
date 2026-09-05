# FMemos

flomo 风格的本地卡片笔记：**Tauri 2 + React 19 + SQLite**，数据完全存在本地，无账号、无网络依赖。

![版本](https://img.shields.io/badge/版本-0.2.0-3eb477)

## 功能

**记录**

- 卡片笔记增删改：输入框写入，`Ctrl + Enter` 发送；卡片可编辑（`Esc` 取消）、删除（带确认）
- 列表输入辅助：在 `- `、`1. `、`- [ ]` 列表行按 `Enter` 自动补下一行标记（有序列表自动递增，新任务始终未完成）；空标记项再按 `Enter` 退出列表；`Shift + Enter` 强制普通换行
- Markdown 渲染：**加粗**、`行内代码`、代码块、无序 / 有序列表、网址自动识别为链接（点击用系统浏览器打开）；编辑态仍是纯文本
- TODO 复选框：正文写 `- [ ] 任务` / `- [x] 任务` 渲染为可勾选列表，点击直接切换并保存
- 草稿自动保存：未发送的内容实时存 localStorage，重启或误关窗口后自动恢复
- 光标跟随：列表回车、标签补全等操作后，编辑框与页面滚动自动跟随，光标行始终可见
- 增删改失败时顶部横幅提示，输入内容不丢失

**标签**

- 正文里 `#标签名` 自动解析归档，支持层级：`#读书/心理学`
- 侧栏层级树展示与计数；点击标签筛选，父标签连带子孙（`#读书` 命中 `#读书/心理学`，且不误命中 `#读书笔记`）
- 输入框与卡片编辑框输入 `#` 自动补全已有标签（`↑`/`↓` 选择、`Enter`/`Tab` 确认、`Esc` 关闭）
- 「无标签」一键筛出没有打标签的笔记

**搜索**

- 全文搜索：FTS5 trigram 分词，≥3 字符任意子串可命中（中英文均可）；两字以内自动回退 LIKE
- 搜索输入 150ms 防抖，过期响应自动丢弃
- 可与标签 / 日期筛选叠加

**统计与回顾**

- 卡片流按日期分组（今天 / 昨天 / M月D日 周X · N 条）
- 侧栏近 15 周热力图，点击某天筛选当天笔记
- 随机回顾（可「换一条」）/ 每日回顾（同一天固定一条）
- 连续点击体验：卡片流 50 条一页，滚动到底自动加载

**窗口**

- 全局快捷键 `Ctrl + Shift + M`：随时呼出 / 隐藏窗口，呼出后自动聚焦输入框

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `Ctrl + Shift + M` | 全局呼出 / 隐藏窗口 |
| `Ctrl + Enter` | 发送（输入框）/ 保存（卡片编辑） |
| `Enter` | 列表行自动延续标记；空标记项退出列表 |
| `Shift + Enter` | 列表行内强制普通换行 |
| `Esc` | 取消卡片编辑 / 关闭回顾弹窗 / 关闭补全 |
| `#` + `↑↓` `Enter` `Tab` | 标签自动补全 |

## 数据与备份

- **便携模式**：单文件 SQLite（`fmemos.db` + WAL 文件）与 exe 同目录，跟着程序走
  - 开发模式：`src-tauri/target/debug/fmemos.db`
  - 打包后：exe 所在目录（建议放非系统目录；装进 Program Files 会因权限不足无法写入）
- 备份：关闭应用后复制 `fmemos.db` 即可
- 同步盘（Syncthing / 坚果云等）：WAL 文件不适合直接同步，建议在应用关闭状态下同步，或只同步定期备份出的副本
- 派生数据（全文索引、标签关联）按数据版本（`PRAGMA user_version`）在启动时按需重建，版本不变不重建

## 开发

本项目是 `D:\Code` npm workspaces 的成员，依赖统一装在**工作区根目录**（根目录执行 `npm install`），项目内不单独装依赖。

```bash
# 开发模式（Tauri 窗口，改动热重载），在 fmemos 目录执行
npm run tauri dev

# 纯浏览器调试：不启动 Tauri，自动启用内存版假后端（src/lib/tauri-mock.ts），数据不落盘
npm run dev   # 打开 http://localhost:1420
```

**测试**

```bash
cargo test    # 在 src-tauri 执行：FTS 搜索、标签精确匹配、分页游标、事务等（:memory: 库）
npm test      # 在工作区根目录执行：Markdown 分块 / TODO / 标签树（vitest）
```

**代码结构**

```
src/
  components/   # Editor、MemoCard、Sidebar、Heatmap、ReviewModal、TagInput(+Textarea)
  lib/
    api.ts        # invoke 封装（含分页参数）
    md.tsx        # 手写 Markdown 渲染（分块解析 + TODO/链接/加粗），纯函数可测
    tags.ts       # 标签解析与标签树构建（与后端语义一致）
    format.ts     # 时间显示
    tauri-mock.ts # 浏览器调试用假后端
src-tauri/src/
  commands.rs   # Tauri 命令与业务实现（增删改查、分页、测试）
  db.rs         # 连接初始化、建表迁移、派生数据版本门控重建
  tags.rs       # 后端标签提取（与前端 tags.ts 保持一致）
  lib.rs        # 应用入口、全局快捷键
```

## 打包

```bash
npm run tauri build   # 在 fmemos 目录执行
```

- 产物：`src-tauri/target/release/bundle/nsis/FMemos_{版本}_{架构}-setup.exe`，文件名自带版本号
- 发版前把版本号三处同步修改：`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`
- 注：`Cargo.toml` 里 `opt-level = 1` 是 8GB 内存机器的编译求生配置（压低 rustc 内存峰值防 OOM），代价是运行时性能；内存宽裕的机器可调回 2

## 技术要点

- 全文索引：SQLite FTS5 + trigram 分词（unicode61 对中文整串分词不可用），触发器与 memos 表保持同步
- 标签匹配：`memo_tags` 关联表精确匹配 + `LIKE 'tag/%'` 连带子孙，避免子串误命中
- 分页：keyset 分页，游标为 `(created_at, id)` 复合键，同秒创建不重不漏
- 渲染性能：App 回调全部 `useCallback` 稳定化，Sidebar / MemoCard / Editor 包 `React.memo`，Markdown 渲染按内容记忆化
- 写安全：增删改均包事务；两字以内 LIKE 搜索对 `%` `_` `\` 转义；Tauri CSP 收紧为 `default-src 'self'`

## 后续路线

- [ ] 数据导入导出（flomo HTML / Markdown）
- [ ] 自动备份（启动时快照 fmemos.db）
- [ ] 删除撤销 / 回收站
