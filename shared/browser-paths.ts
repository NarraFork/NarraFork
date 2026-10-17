/**
 * Chromium 系浏览器的标准安装路径。
 *
 * Windows 上 Edge/Chrome 不在 PATH 里，`Bun.which` 找不到它们，必须按安装位置探测；
 * 服务端启动时自动打开前端与面板的「打开面板」共用这一份列表，避免两处判断不一致。
 */
export const CHROMIUM_PATHS = [
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
