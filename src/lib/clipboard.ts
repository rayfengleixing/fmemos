/**
 * 把文本写入系统剪贴板；返回是否成功。
 *
 * 三层策略，按可靠性排序：
 * 1. Tauri 剪贴板插件（真机主路径，走 Rust 侧写入，不受 WebView 剪贴板权限影响；
 *    浏览器 mock 里该命令被拦到 navigator.clipboard，同样可用）；
 * 2. navigator.clipboard.writeText（无插件时的标准 API，localhost / 安全上下文可用）；
 * 3. 临时 textarea + execCommand('copy') 兜底（需用户手势，按钮点击场景满足）。
 */
export async function copyText(text: string): Promise<boolean> {
  // 1. Tauri 插件路径：插件未注册 / 浏览器环境 / mock 拒绝时抛错，静默落到下一层
  try {
    const mod = await import("@tauri-apps/plugin-clipboard-manager");
    await mod.writeText(text);
    return true;
  } catch {
    // 继续
  }
  // 2. 标准 Clipboard API
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒等情况，落到下面的兜底
  }
  // 3. execCommand 兜底：移出可视区但保持可选中（display:none 会导致 execCommand 失效）
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
