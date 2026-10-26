/**
 * 面板文案表（中文 / English）。
 *
 * 面板是独立进程，语言偏好存在自己的 manager.json；这里集中所有面向用户的字符串，
 * 避免同一句文案散落在主窗口、对话框与托盘三处。运行时切语言只需 setLanguage() +
 * 调用方的刷新，不必重建窗口。
 */

export type ManagerLang = "zh-CN" | "en";

/** 设置窗口语言下拉框的选项顺序与它一致。 */
export const MANAGER_LANGUAGES: { value: ManagerLang; label: string }[] = [
	{ value: "zh-CN", label: "中文" },
	{ value: "en", label: "English" },
];

export function isManagerLang(value: unknown): value is ManagerLang {
	return value === "zh-CN" || value === "en";
}

type Message = { "zh-CN": string; en: string };

const MESSAGES: Record<string, Message> = {
	// ── 状态 ─────────────────────────────────────────────────────────────────
	"status.running": { "zh-CN": "运行中", en: "Running" },
	"status.starting": { "zh-CN": "启动中", en: "Starting" },
	"status.stopping": { "zh-CN": "正在停止", en: "Stopping" },
	"status.stopped": { "zh-CN": "已停止", en: "Stopped" },
	"status.error": { "zh-CN": "异常退出", en: "Failed" },
	"status.external": { "zh-CN": "（外部启动）", en: " (external)" },
	"status.reconnecting": { "zh-CN": "正在重新连接", en: "Reconnecting" },
	"status.detail": { "zh-CN": "（{detail}）", en: " ({detail})" },
	"status.handover": {
		"zh-CN": "（等待接管：请在终端停止外部服务）",
		en: " (waiting: stop the external service in its terminal)",
	},

	// ── 主窗口 ───────────────────────────────────────────────────────────────
	"button.start": { "zh-CN": "启动 NarraFork 服务器", en: "Start NarraFork Server" },
	"button.restart": { "zh-CN": "重启服务器", en: "Restart Server" },
	"button.stop": { "zh-CN": "停止服务器", en: "Stop Server" },
	"button.open": { "zh-CN": "打开 NarraFork", en: "Open NarraFork" },
	"button.settings": { "zh-CN": "设置", en: "Settings" },
	"button.save": { "zh-CN": "保存并应用", en: "Save" },
	"button.openLog": { "zh-CN": "查看完整日志", en: "Log" },
	"button.serverLog": { "zh-CN": "定位 server.log", en: "Show server.log" },
	"label.console": { "zh-CN": "NarraFork 服务器控制台", en: "NarraFork Server Console" },
	"label.listenConfig": { "zh-CN": "监听配置", en: "Listen Address" },
	"label.autoApply": { "zh-CN": "保存后自动生效", en: "Applied automatically after saving" },
	"label.ip": { "zh-CN": "IP 地址", en: "IP Address" },
	"label.port": { "zh-CN": "端口", en: "Port" },
	"label.output": { "zh-CN": "输出日志", en: "Output Log" },
	"label.address": { "zh-CN": "面板地址: {url}", en: "Panel: {url}" },

	// ── 日志与提示 ───────────────────────────────────────────────────────────
	"log.managerStarted": {
		"zh-CN": "管理器已启动（主题色 {color}）。",
		en: "Manager started (brand color {color}).",
	},
	"log.startingService": {
		"zh-CN": "正在启动 NarraFork 服务器...",
		en: "Starting the NarraFork server...",
	},
	"log.restartingService": {
		"zh-CN": "正在重启 NarraFork 服务器...",
		en: "Restarting the NarraFork server...",
	},
	"log.stoppingService": {
		"zh-CN": "正在停止 NarraFork 服务器...",
		en: "Stopping the NarraFork server...",
	},
	"log.settingsSaved": {
		"zh-CN": "监听配置已保存，后端将自动应用：{address}",
		en: "Listen address saved; the backend applies it automatically: {address}",
	},
	"log.settingsWriteFailed": {
		"zh-CN": "写入 settings.json 失败，配置未保存",
		en: "Failed to write settings.json; nothing was saved",
	},
	"log.portInvalid": {
		"zh-CN": "端口「{value}」无效（需为 1-65535），已保留原端口 {port}",
		en: "Port 「{value}」 is invalid (expected 1-65535); keeping {port}",
	},
	"log.addressChanged": {
		"zh-CN": "检测到外部修改的监听配置: {address}",
		en: "Listen address changed externally: {address}",
	},
	"log.externalStopped": {
		"zh-CN": "外部启动的服务已停止。",
		en: "The externally started service has stopped.",
	},
	"log.externalDetected": {
		"zh-CN":
			"NarraFork 服务器已在运行（外部启动）。点「启动 NarraFork 服务器」可在其退出后由托盘接管。",
		en: "The NarraFork server is already running (started externally). Click “Start NarraFork Server” to take over after it exits.",
	},
	"log.takeoverStart": {
		"zh-CN": "外部服务已停止，面板开始接管启动...",
		en: "The external service stopped; the manager is taking over...",
	},
	"log.updateHandoff": {
		"zh-CN": "更新已就绪：正在启动新版本服务，由它接替旧服务...",
		en: "Update ready: starting the new server, which takes over from the old one...",
	},
	"log.handoverWait": {
		"zh-CN": "已进入接管等待：请在终端中停止外部服务（Ctrl+C），面板会在其退出后自动启动托管实例。",
		en: "Waiting to take over: stop the external service in its terminal (Ctrl+C); the manager starts its own instance once it exits.",
	},
	"log.minimized": {
		"zh-CN": "已最小化到托盘。双击托盘图标按设置打开 NarraFork，右键可打开管理器窗口。",
		en: "Minimized to the tray. Double-click opens NarraFork; right-click opens the manager.",
	},
	"log.relaunched": {
		"zh-CN": "更新后的服务已重新就绪。",
		en: "The updated service is ready.",
	},
	"log.serviceLost": {
		"zh-CN": "托管服务连续无响应，请检查服务状态后重新启动。",
		en: "The managed service is not responding. Check its status before starting it again.",
	},
	"error.managedStopUnconfirmed": {
		"zh-CN": "尚未确认托管服务停止，已保留管理器连接；请稍后重试停止。",
		en: "The managed service has not stopped. The manager connection is retained; retry stopping later.",
	},
	"log.trayFailed": {
		"zh-CN": "托盘图标添加失败，关闭窗口将直接退出。",
		en: "Failed to add the tray icon; closing the window will exit.",
	},
	"log.serverLogMissing": {
		"zh-CN": "server.log 还不存在，已打开数据目录。",
		en: "server.log does not exist yet; opened the data folder.",
	},
	"log.startupFailed": {
		"zh-CN": "NarraFork 服务器启动失败，已打开管理器窗口。",
		en: "The NarraFork server failed to start. The manager window is open.",
	},
	"log.openedPanel": { "zh-CN": "已打开 NarraFork: {url}", en: "Opened NarraFork: {url}" },
	"log.openedPanelNew": {
		"zh-CN": "已打开新面板窗口: {url}",
		en: "Opened a new panel window: {url}",
	},
	"log.focusedPanel": {
		"zh-CN": "已聚焦打开的前端面板窗口。",
		en: "Focused the existing panel window.",
	},
	"log.askOnCloseOn": { "zh-CN": "关闭窗口时会询问", en: "Will ask before closing" },
	"log.askOnCloseOff": {
		"zh-CN": "关闭窗口时不再询问",
		en: "Will not ask before closing",
	},
	"log.rememberedExit": {
		"zh-CN": "已记住：关闭时直接退出",
		en: "Remembered: exit directly on close",
	},
	"log.rememberedMinimize": {
		"zh-CN": "已记住：关闭时最小化",
		en: "Remembered: minimize on close",
	},

	// ── 托盘 ─────────────────────────────────────────────────────────────────
	"tray.openWindow": { "zh-CN": "打开管理器窗口", en: "Open Manager Window" },
	"tray.openPanel": { "zh-CN": "打开 NarraFork", en: "Open NarraFork" },
	"tray.openNewWindow": { "zh-CN": "打开新窗口", en: "Open New Window" },
	"tray.askToggle": { "zh-CN": "关闭时不再询问", en: "Don't Ask on Close" },
	"tray.settings": { "zh-CN": "设置...", en: "Settings..." },
	"tray.exit": { "zh-CN": "退出 NarraFork", en: "Exit NarraFork" },

	// ── 关闭确认对话框 ───────────────────────────────────────────────────────
	"close.title": { "zh-CN": "关闭 NarraFork", en: "Close NarraFork" },
	"close.question": {
		"zh-CN": "要关闭后端服务并退出，还是最小化到任务栏继续在后台运行？",
		en: "Stop the backend and exit, or minimize to the tray and keep running in the background?",
	},
	"close.minimize": { "zh-CN": "最小化到托盘", en: "Minimize to Tray" },
	"close.exit": { "zh-CN": "退出 NarraFork", en: "Exit NarraFork" },
	"close.cancel": { "zh-CN": "取消", en: "Cancel" },
	"close.remember": {
		"zh-CN": "记住我的选择，下次不再询问",
		en: "Remember my choice and don't ask again",
	},
	"close.hint": {
		"zh-CN": "最小化到托盘后，NarraFork 服务器继续在后台运行。",
		en: "When minimized to the tray, the NarraFork server keeps running.",
	},

	// ── 设置窗口 ─────────────────────────────────────────────────────────────
	"settings.title": { "zh-CN": "设置", en: "Settings" },
	"settings.language": { "zh-CN": "语言", en: "Language" },
	"settings.languageHint": {
		"zh-CN": "面板界面语言，保存在管理器自己的配置里",
		en: "Panel language, stored in the manager's own configuration",
	},
	"settings.openBrowser": {
		"zh-CN": "启动时如何打开 NarraFork",
		en: "How to open NarraFork on start",
	},
	"settings.openBrowserHint": {
		"zh-CN": "同步 NarraFork 配置（settings.json）",
		en: "Synced with NarraFork configuration (settings.json)",
	},
	"settings.openBrowser.off": { "zh-CN": "不打开", en: "Don't open" },
	"settings.openBrowser.browser": { "zh-CN": "浏览器", en: "Browser" },
	"settings.openBrowser.app": { "zh-CN": "网页应用", en: "Web app" },
	"settings.instanceName": { "zh-CN": "实例名称", en: "Instance Name" },
	"settings.instanceNameHint": {
		"zh-CN": "留空使用默认名；同步 NarraFork 配置",
		en: "Blank uses the default name; synced with NarraFork configuration",
	},
	"settings.brandColor": { "zh-CN": "主题颜色", en: "Theme Color" },
	"settings.brandColorHint": {
		"zh-CN": "图标与面板强调色；同步 NarraFork 配置",
		en: "Icon and panel accent colour; synced with NarraFork configuration",
	},
	"settings.pickColor": { "zh-CN": "选择颜色", en: "Choose Colour" },
	"settings.closeAction": { "zh-CN": "关闭窗口时", en: "When closing the window" },
	"settings.closeAction.exit": { "zh-CN": "退出程序", en: "Exit" },
	"settings.closeAction.minimize": { "zh-CN": "最小化到托盘", en: "Minimize to tray" },
	"settings.askOnClose": { "zh-CN": "关闭时询问", en: "Ask before closing" },
	"settings.startMinimized": {
		"zh-CN": "运行管理端时不显示窗口",
		en: "Start without showing the window",
	},
	"settings.startMinimizedHint": {
		"zh-CN": "启动后只留托盘图标。双击打开 NarraFork，右键打开管理器窗口",
		en: "Starts to the tray only. Double-click opens NarraFork; right-click opens the manager",
	},
	"settings.autoStart": {
		"zh-CN": "运行时自动启动 NarraFork 服务器",
		en: "Start the NarraFork server on launch",
	},
	"settings.autoStartHint": {
		"zh-CN": "启动后自动拉起 NarraFork 服务器，已有服务在跑时跳过",
		en: "Starts the NarraFork server on launch; skipped if one is already running",
	},
	"settings.autoStarting": {
		"zh-CN": "正在启动 NarraFork 服务器...",
		en: "Starting the NarraFork server...",
	},
	"settings.update": { "zh-CN": "更新", en: "Updates" },
	"settings.checkUpdate": { "zh-CN": "检查更新", en: "Check for Updates" },
	"settings.updateNow": { "zh-CN": "立即更新", en: "Update Now" },
	"settings.checking": { "zh-CN": "正在检查...", en: "Checking..." },
	"settings.upToDate": {
		"zh-CN": "已是最新版本（{version}）",
		en: "Up to date ({version})",
	},
	"settings.updateAvailable": {
		"zh-CN": "发现新版本 {version}（当前 {current}）",
		en: "New version {version} available (current {current})",
	},
	"settings.checkFailed": {
		"zh-CN": "检查更新失败：{error}",
		en: "Update check failed: {error}",
	},
	"settings.updateConfirm": {
		"zh-CN": "确定要下载并立即应用更新吗？服务会重启。",
		en: "Download and apply the update now? The service will restart.",
	},
	"settings.downloading": {
		"zh-CN": "正在下载更新...{percent}%",
		en: "Downloading update... {percent}%",
	},
	"settings.downloadFailed": {
		"zh-CN": "下载更新失败：{error}",
		en: "Failed to download the update: {error}",
	},
	"settings.applying": {
		"zh-CN": "正在应用更新，服务将重启...",
		en: "Applying the update; the service will restart...",
	},
	"settings.applyFailed": {
		"zh-CN": "应用更新失败：{error}",
		en: "Failed to apply the update: {error}",
	},
	"settings.save": { "zh-CN": "保存", en: "Save" },
	"settings.cancel": { "zh-CN": "取消", en: "Cancel" },
	"settings.saved": {
		"zh-CN": "设置已保存，部分界面文字重启面板后生效。",
		en: "Settings saved; some labels take effect after restarting the manager.",
	},
	"settings.saveFailed": { "zh-CN": "保存失败：{error}", en: "Save failed: {error}" },
	"settings.nfUnavailable": {
		"zh-CN": "NarraFork 服务未运行，配置将在服务启动后生效",
		en: "The NarraFork service is not running; changes apply once it starts",
	},
	"settings.updateUnmanaged": {
		"zh-CN": "这个服务不是面板启动的，请在网页里用管理员账号更新",
		en: "This service was not started by the manager. Update it from the web UI as an admin.",
	},

	// ── 启动错误 ─────────────────────────────────────────────────────────────
	"error.nativeUnavailable": {
		"zh-CN": "管理器需要 Windows 原生窗口支持；请改用 `narrafork.exe --serve` 以控制台模式运行。",
		en: "The manager needs native Windows window support; use `narrafork.exe --serve` for console mode instead.",
	},
	"error.alreadyRunning": {
		"zh-CN": "NarraFork Manager 已在运行，但未能定位它的窗口。",
		en: "NarraFork Manager is already running, but its window could not be found.",
	},
	"error.windowCreateFailed": {
		"zh-CN": "创建管理器窗口失败；请改用 `narrafork.exe --serve`。",
		en: "Failed to create the manager window; use `narrafork.exe --serve` instead.",
	},
	"log.waitingLockHolder": {
		"zh-CN": "数据目录仍被上一个 NarraFork 进程（PID {pid}）占用，等待它退出...",
		en: "The data directory is still held by the previous NarraFork process (PID {pid}); waiting for it to exit...",
	},
	"log.slowStart": {
		"zh-CN": "服务仍在启动（可能正在迁移数据库，大库需要几分钟），继续等待...",
		en: "The server is still starting (likely migrating the database, which can take minutes); still waiting...",
	},
	"log.handingOver": {
		"zh-CN": "新版本管理器已启动，本窗口让位并在旧服务退出后关闭。",
		en: "The updated manager has started; this one is retiring and closes once the old server exits.",
	},
	"log.lockHolderExited": {
		"zh-CN": "上一个 NarraFork 进程（PID {pid}）已退出，重新启动服务...",
		en: "The previous NarraFork process (PID {pid}) has exited; starting the server again...",
	},
	"error.instanceLockConflict": {
		"zh-CN": "已有 NarraFork 实例在运行（PID {pid}）：同一数据目录只能运行一个，请先停止它",
		en: "Another NarraFork instance is running (PID {pid}): only one process may use a data directory, stop it first",
	},
	"error.relaunchTimeout": {
		"zh-CN": "更新后没有重新连上服务",
		en: "The service did not come back after the update",
	},
	"error.shutdownFailed": {
		"zh-CN": "优雅关闭请求失败，将直接结束进程",
		en: "Graceful shutdown was not accepted; the process will be stopped directly",
	},
	"error.exitedWithCode": { "zh-CN": "退出码 {code}", en: "exit code {code}" },
};

let currentLang: ManagerLang = "zh-CN";

export function setLanguage(lang: ManagerLang): void {
	currentLang = lang;
}

export function currentLanguage(): ManagerLang {
	return currentLang;
}

/** 取文案并按 `{name}` 插值；未知 key 原样返回 key，便于开发期发现遗漏。 */
export function t(key: string, params?: Record<string, string | number>): string {
	const message = MESSAGES[key];
	if (!message) return key;
	let text = message[currentLang] ?? message["zh-CN"];
	if (params) {
		for (const [name, value] of Object.entries(params)) {
			text = text.replace(`{${name}}`, String(value));
		}
	}
	return text;
}
