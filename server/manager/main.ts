/**
 * 后端管理器面板：NarraFork 的图形化启停界面。
 *
 * 启动流程见 `server/index.ts`：Windows 编译产物默认进入本模块；源码启动和 `--serve`
 * 走服务模式。开发面板时加 `--manager`。子进程模型见 backend-process.ts。
 *
 * 本模块只依赖 bun:ffi 与 Node 内置模块，不 import server 的重型模块 —— 管理器开窗
 * 不该顺带拉起数据库、事件总线或 HTTP 服务。
 *
 * 主题色跟随 NarraFork 自身的品牌色（settings.branding.iconColor）：改图标色即改面板色。
 * 视觉为扁平卡片式：窗口底浅灰、卡片白底圆角、按钮全部自绘（系统原生按钮在无 manifest 的
 * 编译产物里是经典灰色外观，与面板风格冲突）。
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { urlHost } from "@shared/server-host";
import { decodeRgbaPng, getBrandIcons } from "../lib/branding";
import {
	BackendProcess,
	type BackendState,
	probeServiceHealth,
	resolveNarraforkHome,
} from "./backend-process";
import { showCloseDialog } from "./close-dialog";
import { requestManagedShutdown } from "./control-client";
import {
	BUTTON_HEIGHT,
	BUTTON_Y,
	buttonWidth,
	buttonX,
	CARD_WIDTH,
	CARD_X,
	CONFIG_CARD_TOP,
	computeLayout,
	ID,
	IP_EDIT_MIN_WIDTH,
	LOG_CARD_TOP,
	MIN_WINDOW_HEIGHT,
	MIN_WINDOW_WIDTH,
} from "./layout";
import {
	type ManagerPreferences,
	readNarraForkSettings,
	readPreferences,
	readServerAddress,
	watchSettings,
	writePreferences,
	writeServerAddress,
} from "./manager-config";
import { setLanguage, t } from "./manager-i18n";
import { showSettingsDialog } from "./settings-window";
import {
	CARD_BG,
	DANGER_COLOR,
	DEFAULT_BRAND_COLOR,
	DEFAULT_BRAND_NAME,
	drawBanner,
	drawButton,
	drawCards,
	normalizeBrandColor,
	SUCCESS_COLOR,
	TEXT_FAINT,
	TEXT_MAIN,
	TEXT_MUTED,
	toColorRef,
	WARNING_COLOR,
	WHITE_REF,
	WINDOW_BG,
} from "./theme";
import {
	acquireSingleInstanceMutex,
	addTrayIcon,
	appendRichText,
	applyControlColors,
	BS_OWNERDRAW,
	clientSize,
	controlIdAtCursor,
	createControl,
	createFont,
	createIconFromRgba,
	createRichEdit,
	createWindow,
	ES_AUTOHSCROLL,
	ES_AUTOVSCROLL,
	ES_MULTILINE,
	ES_READONLY,
	fillRect,
	findWindowByTitle,
	focusWindow,
	focusWindowByTitle,
	getControlId,
	invalidate,
	isNativeAvailable,
	isOwnerDrawButton,
	isShiftPressed,
	loadAppIcon,
	loadIconFromFile,
	makeRectOf,
	moveWindow,
	openExternal,
	openWebPanel,
	type Pointer,
	paintBegin,
	paintEnd,
	postMessage,
	readDrawItem,
	readScrollPixelPos,
	readWstr,
	redrawWindow,
	removeTrayIcon,
	restoreScrollPixelPos,
	revealInFolder,
	richTextLength,
	SS_LEFT,
	SW_HIDE,
	SW_SHOW,
	scrollRichTextToBottom,
	setEnabled,
	setMinTrackSize,
	setText,
	setVisible,
	setWindowIcon,
	showTrayMenu,
	showWindow,
	trimRichTextHead,
	WM_APP,
	WM_COMMAND,
	WM_CTLCOLORSTATIC,
	WM_DRAWITEM,
	WM_ERASEBKGND,
	WM_GETMINMAXINFO,
	WM_LBUTTONDBLCLK,
	WM_PAINT,
	WM_RBUTTONUP,
	WM_SIZE,
	WS_BORDER,
	WS_VSCROLL,
	windowAtCursor,
} from "./win32";

// ── 托盘与消息 ──────────────────────────────────────────────────────────────
/** 托盘回调用自定义消息，避开系统消息区间。 */
const WM_TRAY = WM_APP + 10;
/** 第二个启动请求：已在托盘运行时，按用户设置打开前端，不把管理器窗口带到前面。 */
const WM_OPEN_FRONTEND = WM_APP + 6;
/** 窗口标题：单实例聚焦时按它查找已有窗口，必须与创建时一致。 */
const WINDOW_TITLE = "NarraFork Manager";
const TRAY_ID_OPEN = 9101;
const TRAY_ID_EXIT = 9103;

interface ManagerSettings {
	host: string;
	port: number;
	tls: boolean;
	brandColor: string;
	/** 实例显示名：前端页面标题用的就是它，用于查找已打开的前端窗口。 */
	brandName: string;
}

/** 子进程退出后，面板是否还在跟踪同一次更新拉起的替换进程。 */
type Supervision = "none" | "reconnecting" | "adopted";

/** 只读品牌色与实例显示名；监听地址由 manager-config 负责（同一份文件还要写入与回显）。 */
async function loadBranding(): Promise<{ color: string; name: string }> {
	try {
		const raw = (await Bun.file(join(resolveNarraforkHome(), "settings.json")).json()) as {
			branding?: { iconColor?: string; name?: string };
		};
		const name =
			typeof raw.branding?.name === "string" && raw.branding.name.trim()
				? raw.branding.name.trim()
				: DEFAULT_BRAND_NAME;
		return { color: normalizeBrandColor(raw.branding?.iconColor), name };
	} catch {
		return { color: DEFAULT_BRAND_COLOR, name: DEFAULT_BRAND_NAME };
	}
}

/**
 * 面板当前使用的端口。
 *
 * 托管服务运行中时以它实际监听的端口为准 —— 配置端口被占用时服务会自动换端口，
 * 地址显示与「打开面板」都应跟随实际值。
 */
function activePort(): number {
	return backend?.listeningPort ?? settings.port;
}

/** 面板当前使用的主机名；托管服务运行中时以它实际监听的值为准。 */
function activeHost(): string {
	return backend?.listeningHost ?? settings.host;
}

function activeTls(): boolean {
	return backend?.listeningTls ?? settings.tls;
}

/** 打开面板、健康检查和更新请求共用的源。 */
function serviceOrigin(): string {
	return `${activeTls() ? "https" : "http"}://${urlHost(activeHost())}:${activePort()}`;
}

// ── 状态 ────────────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<BackendState, { key: string; color: number }> = {
	running: { key: "status.running", color: SUCCESS_COLOR },
	starting: { key: "status.starting", color: WARNING_COLOR },
	stopping: { key: "status.stopping", color: WARNING_COLOR },
	stopped: { key: "status.stopped", color: TEXT_MUTED },
	error: { key: "status.error", color: DANGER_COLOR },
};

/** 按钮外观：文案存 i18n key，绘制时按当前语言取值，切换语言只需重绘。 */
const BUTTONS: Record<number, { key: string; primary: boolean }> = {
	[ID.start]: { key: "button.start", primary: true },
	[ID.restart]: { key: "button.restart", primary: false },
	[ID.stop]: { key: "button.stop", primary: false },
	[ID.open]: { key: "button.open", primary: false },
	[ID.settings]: { key: "button.settings", primary: false },
	[ID.save]: { key: "button.save", primary: false },
	[ID.openLogFile]: { key: "button.openLog", primary: false },
	[ID.serverLog]: { key: "button.serverLog", primary: false },
};

interface Controls {
	statusDot?: Pointer;
	statusText?: Pointer;
	address?: Pointer;
	bannerTitle?: Pointer;
	bannerSubtitle?: Pointer;
	start?: Pointer;
	restart?: Pointer;
	stop?: Pointer;
	open?: Pointer;
	settings?: Pointer;
	ipEdit?: Pointer;
	portEdit?: Pointer;
	save?: Pointer;
	configTitle?: Pointer;
	configHint?: Pointer;
	ipLabel?: Pointer;
	portLabel?: Pointer;
	logTitle?: Pointer;
	openLogFile?: Pointer;
	serverLog?: Pointer;
	logEdit?: Pointer;
}

const controls: Controls = {};
const settings: ManagerSettings = {
	host: "127.0.0.1",
	port: 7779,
	tls: false,
	brandColor: DEFAULT_BRAND_COLOR,
	brandName: DEFAULT_BRAND_NAME,
};
/** 只放进服务子进程。更新替换进程从子进程环境继承它。 */
const managerToken = randomBytes(32).toString("base64url");
let supervision: Supervision = "none";
/** 面板已请求应用更新，子进程退出后应等待替换进程而不是当成崩溃。 */
let expectRelaunch = false;
let brandColorRef = toColorRef(DEFAULT_BRAND_COLOR);
let backend: BackendProcess | undefined;
let preferences: ManagerPreferences = {
	askOnClose: true,
	closeAction: "exit",
	language: "zh-CN",
	startMinimized: false,
	autoStartBackend: false,
};
/** 托盘是否挂上了：没挂上时关闭窗口只能直接退出，否则窗口就再也找不回来了。 */
let trayAdded = false;
let closeDialogShown = false;
/** 外部启动的服务（终端里手动跑的那份）是否在响应；面板对它只读。 */
let externalRunning = false;
/** 用户已在外部运行状态下点了「启动 NarraFork 服务器」：等外部服务退出后自动启动托管实例。 */
let awaitingHandover = false;
let windowSizeSaveTimer: ReturnType<typeof setTimeout> | undefined;

/** 记住窗口尺寸：缩放停止 600ms 后落盘，下次启动按它恢复（首次用最小尺寸）。 */
function scheduleWindowSizeSave(hwnd: Pointer): void {
	if (windowSizeSaveTimer) clearTimeout(windowSizeSaveTimer);
	windowSizeSaveTimer = setTimeout(() => {
		windowSizeSaveTimer = undefined;
		const size = clientSize(hwnd);
		if (size.width <= 0 || size.height <= 0) return;
		if (preferences.windowWidth === size.width && preferences.windowHeight === size.height) return;
		preferences = { ...preferences, windowWidth: size.width, windowHeight: size.height };
		writePreferences(preferences);
	}, 600);
}
let mainWindow: ReturnType<typeof createWindow>;

// ── 日志 ────────────────────────────────────────────────────────────────────

const LOG_MAX_CHARS = 400_000;
/** 终端式滚动：超限时一次丢掉约 1/4 的最旧行，而不是清空重来。 */
const LOG_TRIM_CHARS = Math.floor(LOG_MAX_CHARS / 4);

/** 已写入行（含换行符）的字符数，用于按整行裁剪最旧的部分。 */
const logLineLengths: number[] = [];
/** 日志在内存里被裁断过（更早的行已不可见）—— 之后才提供"查看完整日志"入口。 */
let logTrimmed = false;
/**
 * 上次"自动跟随到底部"时的视图像素位置。
 *
 * RichEdit 不维护标准滚动条位置，GetScrollPos/GetScrollRange 对它不可靠，所以用
 * "当前位置是否仍等于上次跟随后的位置"判断用户有没有手动滚上去（-1 表示尚未跟随过）。
 */
let lastLogScrollY = -1;

/** 文件镜像：内存缓冲会裁断，文件保存完整历史（超过上限轮转一次到 .1）。 */
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
let logFilePath = "";
let logFileBytes = 0;
let logStream: ReturnType<typeof createWriteStream> | undefined;

/** 打开日志文件镜像（写在 NarraFork 数据目录下）。 */
function openLogFileMirror(): void {
	logFilePath = join(resolveNarraforkHome(), "manager.log");
	try {
		logFileBytes = statSync(logFilePath).size;
	} catch {
		logFileBytes = 0;
	}
	if (logFileBytes > LOG_FILE_MAX_BYTES) {
		// 简单轮转：旧文件挪到 .1（覆盖更早的备份）。
		try {
			renameSync(logFilePath, `${logFilePath}.1`);
			logFileBytes = 0;
		} catch {
			// 轮转失败就接着追加。
		}
	}
	try {
		logStream = createWriteStream(logFilePath, { flags: "a" });
	} catch {
		logStream = undefined;
	}
}

/** 把一行日志同步到文件镜像；超过上限先轮转。 */
function mirrorLogLine(line: string): void {
	if (!logStream || !logFilePath) return;
	if (logFileBytes > LOG_FILE_MAX_BYTES) {
		logStream.end();
		try {
			renameSync(logFilePath, `${logFilePath}.1`);
		} catch {
			// 忽略：继续写当前文件。
		}
		logStream = createWriteStream(logFilePath, { flags: "a" });
		logFileBytes = 0;
	}
	logStream.write(line);
	logFileBytes += Buffer.byteLength(line);
}

/** 日志行颜色：管理器自身的动作按语义着色，子进程的 JSON 日志按其 level 着色。 */
function logColor(tag: string | undefined): number {
	switch (tag) {
		case "OK":
			return SUCCESS_COLOR;
		case "WARN":
			return WARNING_COLOR;
		case "ERROR":
			return DANGER_COLOR;
		case "DEBUG":
			return TEXT_FAINT;
		case "RUN":
		case "PREP":
		case "WEB":
			return brandColorRef;
		default:
			return TEXT_MAIN;
	}
}

function appendLog(tag: string | undefined, message: string): void {
	const target = controls.logEdit;
	if (!target) return;
	const time = new Date().toTimeString().slice(0, 8);
	const line = tag ? `${time} [${tag}] ${message}\r\n` : `${time} ${message}\r\n`;
	mirrorLogLine(line);
	// 用户正在回看旧内容（视图不在上次跟随的位置）时不打断：记住滚动位置，追加后还原。
	const currentY = readScrollPixelPos(target).readInt32LE(4);
	const follow = lastLogScrollY < 0 || currentY === lastLogScrollY;
	const savedScroll = readScrollPixelPos(target);
	// 终端式滚动缓冲：超过上限时丢掉最旧的一批整行，而不是清空重来。
	if (richTextLength(target) > LOG_MAX_CHARS) {
		trimOldestLogLines(target, LOG_TRIM_CHARS);
	}
	appendRichText(target, line, logColor(tag));
	logLineLengths.push(line.length);
	if (follow) {
		scrollRichTextToBottom(target);
		lastLogScrollY = readScrollPixelPos(target).readInt32LE(4);
	} else {
		restoreScrollPixelPos(target, savedScroll);
	}
	maybeRevealLogFileButton();
}

/** 从日志控件头部删除至少 minChars 个字符对应的整行（终端式滚动）。 */
function trimOldestLogLines(target: Pointer, minChars: number): void {
	let chars = 0;
	let lines = 0;
	while (lines < logLineLengths.length && chars < minChars) {
		chars += logLineLengths[lines];
		lines += 1;
	}
	if (lines === 0) return;
	logLineLengths.splice(0, lines);
	trimRichTextHead(target, chars);
	logTrimmed = true;
}

/**
 * 日志被裁断过、且用户已滚到日志顶部时，显示"查看完整日志"入口 —— 此时用户正想回看
 * 更早的内容，而内存缓冲里已经没有它们了。
 */
function maybeRevealLogFileButton(): void {
	if (!logTrimmed || !controls.openLogFile || !controls.logEdit) return;
	// 滚到顶部的判据用像素滚动位置（RichEdit 不维护标准滚动条位置）。
	if (readScrollPixelPos(controls.logEdit).readInt32LE(4) !== 0) return;
	setVisible(controls.openLogFile, true);
}

/** NarraFork 的日志是单行 JSON；非 JSON 行（子进程原生输出）原样保留。 */
function formatBackendLine(line: string): string {
	if (!line.startsWith("{")) return line;
	try {
		const parsed = JSON.parse(line) as { level?: string; msg?: string };
		return `[${(parsed.level ?? "info").toUpperCase()}] ${parsed.msg ?? line}`;
	} catch {
		return line;
	}
}

// ── 状态与按钮 ──────────────────────────────────────────────────────────────

/** 子进程状态加上托管方式：灯、按钮可用性、主按钮高亮都由它推导。 */
function applyStatus(status: BackendState, detail?: string): void {
	const reconnecting = supervision === "reconnecting";
	const adopted = supervision === "adopted";
	// 外部启动的服务（终端里跑的那份）：面板只显示状态；点「启动 NarraFork 服务器」进入接管等待。
	const external = !reconnecting && !adopted && status === "stopped" && externalRunning;
	const shown: BackendState = reconnecting ? "starting" : adopted || external ? "running" : status;
	const style = STATUS_STYLE[shown];
	const suffix = reconnecting
		? t("status.detail", { detail: t("status.reconnecting") })
		: external
			? awaitingHandover
				? t("status.handover")
				: t("status.external")
			: detail
				? t("status.detail", { detail })
				: "";
	setText(controls.statusDot, "●");
	setText(controls.statusText, `${t(style.key)}${suffix}`);
	setText(controls.address, t("label.address", { url: `${serviceOrigin()}/` }));
	const childAlive = backend?.pid !== undefined;
	const startEnabled =
		reconnecting || adopted
			? false
			: external
				? !awaitingHandover
				: status === "stopped" || status === "error";
	setEnabled(controls.start, startEnabled);
	// 异常退出时也允许重启（等价于重新启动）：否则用户只能点「启动 NarraFork 服务器」，语义不符。
	setEnabled(
		controls.restart,
		adopted || (!external && !reconnecting && (status === "running" || status === "error")),
	);
	setEnabled(
		controls.stop,
		adopted || (!external && !reconnecting && childAlive && status !== "stopping"),
	);
	invalidate(controls.statusDot);
	invalidate(controls.start);
	invalidate(controls.restart);
	invalidate(controls.stop);
}

function currentStatusColor(): number {
	if (supervision === "reconnecting") return WARNING_COLOR;
	if (supervision === "adopted") return SUCCESS_COLOR;
	const status = backend?.current ?? "stopped";
	if (status === "stopped" && externalRunning) return STATUS_STYLE.running.color;
	return STATUS_STYLE[status].color;
}

function syncListenTarget(): void {
	backend?.setTarget({ host: settings.host, port: settings.port, tls: settings.tls });
}

/** 面板启动的服务，或更新后认领的替换进程，才带得动关闭和更新令牌。 */
function serviceIsManaged(): boolean {
	return supervision === "adopted" || backend?.pid !== undefined;
}

async function requestShutdownIfManaged(): Promise<void> {
	if (!serviceIsManaged() && supervision !== "reconnecting") return;
	const accepted = await requestManagedShutdown(serviceOrigin(), managerToken);
	if (!accepted) appendLog("WARN", t("error.shutdownFailed"));
}

/** 先请求优雅关闭，仍在则结束进程树。认领的替换进程没有子进程句柄，只走 HTTP。 */
async function stopSupervised(): Promise<void> {
	const adopted = supervision === "adopted";
	if (!adopted && backend?.pid === undefined) {
		supervision = "none";
		expectRelaunch = false;
		return;
	}
	await requestShutdownIfManaged();
	if (adopted) {
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			if (!(await probeServiceHealth(activeHost(), activePort(), activeTls()))) break;
			await Bun.sleep(500);
		}
		supervision = "none";
		externalRunning = false;
		frontendOpened = false;
		applyStatus("stopped");
		return;
	}
	await backend?.stop({ graceful: true });
	supervision = "none";
	expectRelaunch = false;
}

/** 更新替换进程脱离了面板的子进程关系。健康检查通过后按远程托管继续控制它。 */
async function adoptRelaunch(): Promise<void> {
	supervision = "reconnecting";
	applyStatus("starting");
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (await probeServiceHealth(activeHost(), activePort(), activeTls())) {
			supervision = "adopted";
			externalRunning = false;
			frontendOpened = false;
			appendLog("OK", t("log.relaunched"));
			applyStatus("running");
			openFrontendOnce();
			return;
		}
		await Bun.sleep(700);
	}
	supervision = "none";
	appendLog("ERROR", t("error.relaunchTimeout"));
	applyStatus("error", t("error.relaunchTimeout"));
}

// ── 绘制 ────────────────────────────────────────────────────────────────────

// ── 布局 ────────────────────────────────────────────────────────────────────

/**
 * IP 输入框宽度：按内容自适应（等宽估算：每字符约 7px + 输入框内边距）。
 * 上限保证保存按钮右侧仍留 16px 边距 —— 空间不够时收窄，框内可横向滚动。
 */
function ipEditWidth(cardWidth: number): number {
	const text = controls.ipEdit ? readWstr(controls.ipEdit, 128) : "";
	const wanted = Math.max(IP_EDIT_MIN_WIDTH, text.length * 7 + 32);
	const available = Math.max(IP_EDIT_MIN_WIDTH, cardWidth - 352);
	return Math.min(wanted, available);
}

/** 响应式重排：卡片与日志随窗口伸缩，卡片内的右侧控件贴右边。 */
function relayout(hwnd: Pointer): void {
	const layout = computeLayout(hwnd);
	const handles = [
		controls.start,
		controls.restart,
		controls.stop,
		controls.open,
		controls.settings,
	];
	handles.forEach((handle, index) => {
		moveWindow(handle, buttonX(index), BUTTON_Y, buttonWidth(index), BUTTON_HEIGHT);
	});

	moveWindow(controls.bannerTitle, 22, 14, Math.max(200, layout.width - 44), 30);
	moveWindow(controls.bannerSubtitle, 24, 46, Math.max(200, layout.width - 48), 18);
	moveWindow(controls.statusText, 38, 90, Math.max(200, layout.width - 60), 24);
	moveWindow(controls.address, 40, 118, Math.max(200, layout.width - 60), 18);

	moveWindow(controls.configTitle, CARD_X + 16, CONFIG_CARD_TOP + 12, 200, 20);
	moveWindow(controls.configHint, CARD_X + 96, CONFIG_CARD_TOP + 14, 220, 18);
	// 监听配置卡片：IP 框按内容自适应，端口与保存按钮依次跟在其右侧 —— 不贴窗口右缘，
	// 拉宽窗口时它们停在原处；IP 很长且右侧仍有余量时，IP 框加宽并把后面两个一起带过去。
	const ipWidth = ipEditWidth(layout.cardWidth);
	const ipRight = CARD_X + 72 + ipWidth;
	moveWindow(controls.ipLabel, CARD_X + 16, CONFIG_CARD_TOP + 48, 56, 20);
	moveWindow(controls.ipEdit, CARD_X + 72, CONFIG_CARD_TOP + 45, ipWidth, 26);
	moveWindow(controls.portLabel, ipRight + 12, CONFIG_CARD_TOP + 48, 40, 20);
	moveWindow(controls.portEdit, ipRight + 60, CONFIG_CARD_TOP + 45, 68, 26);
	moveWindow(controls.save, ipRight + 140, CONFIG_CARD_TOP + 44, 124, 28);

	moveWindow(controls.logTitle, CARD_X + 16, layout.logCardTop + 12, 160, 20);
	moveWindow(controls.serverLog, layout.width - CARD_X - 132, layout.logCardTop + 10, 124, 24);
	moveWindow(controls.openLogFile, CARD_X + 180, layout.logCardTop + 11, 104, 22);
	moveWindow(
		controls.logEdit,
		CARD_X + 14,
		layout.logCardTop + 40,
		layout.cardWidth - 28,
		layout.logCardHeight - 50,
	);

	redrawWindow(hwnd);
}

// ── 窗口消息 ────────────────────────────────────────────────────────────────

function onCommand(id: number): void {
	switch (id) {
		case ID.start:
			if (externalRunning) {
				// 接管流程：外部实例还在跑，先等它退出，再启动面板托管的后端。
				if (!awaitingHandover) {
					awaitingHandover = true;
					appendLog("PREP", t("log.handoverWait"));
					applyStatus("stopped");
				}
				break;
			}
			appendLog("RUN", t("log.startingService"));
			void backend?.start();
			break;
		case ID.restart:
			appendLog("RUN", t("log.restartingService"));
			void (async () => {
				await stopSupervised();
				externalRunning = false;
				awaitingHandover = false;
				appendLog("RUN", t("log.startingService"));
				await backend?.start();
			})();
			break;
		case ID.stop:
			appendLog("RUN", t("log.stoppingService"));
			void stopSupervised();
			break;
		case ID.open:
			// Shift+点击 = 强制新建前端窗口（对齐浏览器 Shift+点击的惯例）。
			openPanel(isShiftPressed());
			break;
		case ID.settings:
			void openSettings();
			break;
		case ID.openLogFile:
			// 用系统默认程序打开日志文件（面板内存里被裁断的完整历史在这里）。
			openExternal(logFilePath);
			break;
		case ID.serverLog:
			revealServerLog();
			break;
		case ID.save: {
			const ip = controls.ipEdit
				? readWstr(controls.ipEdit, 128).trim() || settings.host
				: settings.host;
			const rawPort = controls.portEdit ? readWstr(controls.portEdit, 16).trim() : "";
			const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : Number.NaN;
			const portValid = Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535;
			if (!portValid) {
				appendLog("WARN", t("log.portInvalid", { value: rawPort || "(空)", port: settings.port }));
			}
			const port = portValid ? parsedPort : settings.port;
			if (writeServerAddress({ host: ip, port })) {
				settings.host = ip;
				settings.port = port;
				syncListenTarget();
				appendLog("OK", t("log.settingsSaved", { address: `${ip}:${port}` }));
			} else {
				appendLog("ERROR", t("log.settingsWriteFailed"));
			}
			// IP 内容可能变长/变短：重排让输入框宽度跟着内容走。
			if (mainWindow) relayout(mainWindow.hwnd);
			applyStatus(backend?.current ?? "stopped");
			break;
		}
		default:
			break;
	}
}

function handleMessage(
	hwnd: Pointer,
	msg: number,
	wParam: Pointer,
	lParam: Pointer,
): Pointer | number | undefined {
	switch (msg) {
		case WM_PAINT: {
			const paint = paintBegin(hwnd);
			if (!paint) return undefined;
			const layout = computeLayout(hwnd);
			// GDI 不会自动擦除背景（窗口类没有背景刷时），漏掉的区域会显示为黑色，所以先铺满。
			fillRect(paint.hdc, makeRectOf(0, 0, layout.width, layout.height), WINDOW_BG);
			drawBanner(paint.hdc, layout.width, brandColorRef);
			drawCards(paint.hdc, layout);
			paintEnd(hwnd, paint.paintStruct);
			return 0;
		}
		case WM_ERASEBKGND: {
			// 直接填背景色再声明已处理。吞掉擦除会让自绘按钮所在的区域在重绘后留下残影/空白。
			const size = clientSize(hwnd);
			fillRect(wParam, makeRectOf(0, 0, size.width, size.height), WINDOW_BG);
			return 1;
		}
		case WM_CTLCOLORSTATIC: {
			// 文字会变的控件必须带背景色（擦掉旧内容，否则新旧文本叠印）；横幅上的固定文字
			// 保持透明，露出父窗口自绘的渐变。位置：状态区在窗口底色上，标题在白色卡片里。
			const id = getControlId(lParam);
			if (id === ID.bannerTitle || id === ID.bannerSubtitle) {
				return applyControlColors(wParam, WHITE_REF);
			}
			if (id === ID.statusDot) return applyControlColors(wParam, currentStatusColor(), WINDOW_BG);
			if (id === ID.statusText) return applyControlColors(wParam, TEXT_MAIN, WINDOW_BG);
			if (id === ID.address) return applyControlColors(wParam, TEXT_FAINT, WINDOW_BG);
			if (id === ID.configTitle || id === ID.logTitle) {
				return applyControlColors(wParam, TEXT_MAIN, CARD_BG);
			}
			return applyControlColors(wParam, TEXT_MUTED, CARD_BG);
		}
		case WM_DRAWITEM: {
			const item = readDrawItem(lParam);
			const spec = BUTTONS[item.controlId];
			if (spec) {
				const hovered = controlIdAtCursor() === item.controlId;
				drawButton(item, { primary: spec.primary, text: t(spec.key) }, brandColorRef, hovered);
			}
			return 1;
		}
		case WM_TRAY: {
			// 双击按用户设置打开 NarraFork 前端。右键只提供管理器窗口和优雅退出。
			const event = Number(lParam) & 0xffff;
			if (event === WM_LBUTTONDBLCLK) {
				openPanel(false, true);
				return 0;
			}
			if (event === WM_RBUTTONUP) {
				const choice = showTrayMenu(hwnd, [
					{ id: TRAY_ID_OPEN, text: t("tray.openWindow") },
					{ separator: true, id: 0, text: "" },
					{ id: TRAY_ID_EXIT, text: t("tray.exit") },
				]);
				if (choice === TRAY_ID_OPEN) restoreFromTray(hwnd);
				else if (choice === TRAY_ID_EXIT) void exitApplication(hwnd);
				return 0;
			}
			return 0;
		}
		case WM_COMMAND: {
			// wParam 低位是控件 id，高位是通知码。
			const id = Number(wParam) & 0xffff;
			const notify = (Number(wParam) >> 16) & 0xffff;
			// 日志滚动（EN_VSCROLL = 0x0602）：滚到顶部时该露出"查看完整日志"入口。
			if (id === ID.logEdit && notify === 0x0602) {
				maybeRevealLogFileButton();
				return 0;
			}
			onCommand(id);
			return 0;
		}
		case WM_SIZE: {
			relayout(hwnd);
			scheduleWindowSizeSave(hwnd);
			return 0;
		}
		case WM_GETMINMAXINFO: {
			// 再小按钮就会互相遮挡；上限由用户拖拽决定，不设。
			setMinTrackSize(lParam, MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT);
			return 0;
		}
		case WM_APP + 5: {
			invalidate(hwnd);
			return 0;
		}
		case WM_OPEN_FRONTEND: {
			requestOpenFrontend();
			return 0;
		}
		default:
			return undefined;
	}
}

/** 窗口/托盘图标的边长。 */
const WINDOW_ICON_SIZE = 32;

/** 简单盒式缩放：把 RGBA 缓冲缩到方形目标尺寸（alpha 加权，避免透明边缘发黑）。 */
function scaleRgba(pixels: Uint8Array, width: number, height: number, size: number): Uint8Array {
	const output = new Uint8Array(size * size * 4);
	if (width === size && height === size) {
		output.set(pixels);
		return output;
	}
	const scaleX = width / size;
	const scaleY = height / size;
	for (let y = 0; y < size; y += 1) {
		const y0 = Math.floor(y * scaleY);
		const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));
		for (let x = 0; x < size; x += 1) {
			const x0 = Math.floor(x * scaleX);
			const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));
			let r = 0;
			let g = 0;
			let b = 0;
			let alphaSum = 0;
			let count = 0;
			for (let sy = y0; sy < y1 && sy < height; sy += 1) {
				for (let sx = x0; sx < x1 && sx < width; sx += 1) {
					const i = (sy * width + sx) * 4;
					const alpha = pixels[i + 3];
					r += pixels[i] * alpha;
					g += pixels[i + 1] * alpha;
					b += pixels[i + 2] * alpha;
					alphaSum += alpha;
					count += 1;
				}
			}
			const o = (y * size + x) * 4;
			if (count === 0 || alphaSum === 0) continue;
			output[o] = Math.round(r / alphaSum);
			output[o + 1] = Math.round(g / alphaSum);
			output[o + 2] = Math.round(b / alphaSum);
			output[o + 3] = Math.round(alphaSum / count);
		}
	}
	return output;
}

/**
 * 主题色窗口图标：复用 server 侧的图标管线（含嵌入资源查找、按色重着色与缓存）生成，
 * 再缩到窗口图标尺寸构造 HICON。素材不可用时返回 undefined，调用方回退静态 ico。
 */
async function loadBrandedIcon(colorHex: string): Promise<Pointer | undefined> {
	try {
		// 复用 server 侧的图标管线：嵌入资源/工作区文件的查找、按色重着色与缓存都在里面，
		// 面板不再自己读 PNG。icon192 是面板窗口图标需要的尺寸。
		const icons = await getBrandIcons(colorHex);
		const decoded = decodeRgbaPng(new Uint8Array(icons.icon192.body));
		if (!decoded) return undefined;
		const scaled = scaleRgba(decoded.pixels, decoded.width, decoded.height, WINDOW_ICON_SIZE);
		return createIconFromRgba(WINDOW_ICON_SIZE, scaled);
	} catch {
		return undefined;
	}
}

/**
 * 取窗口图标：优先按主题色实时生成（品牌 PNG 素材重着色），否则开发目录的 ico、exe 旁的
 * ico，最后回退 exe 内嵌资源。都拿不到只是没有图标，不该影响面板可用性。
 */
function resolveWindowIcon(instance: Pointer): Pointer | undefined {
	const candidates = [
		join(process.cwd(), "dist", "narrafork.ico"),
		join(dirname(process.execPath), "narrafork.ico"),
	];
	for (const path of candidates) {
		try {
			const icon = loadIconFromFile(path, 32);
			if (icon) return icon;
		} catch {
			// 换下一个候选。
		}
	}
	return loadAppIcon(instance);
}

/** 关闭窗口：能缩到托盘时才询问，否则直接退出（否则窗口再也找不回来）。 */
async function handleCloseRequest(hwnd: Pointer): Promise<void> {
	if (!trayAdded) {
		exitApplication(hwnd);
		return;
	}
	if (preferences.askOnClose) {
		// WM_CLOSE 在对话框弹出期间仍可能到达（连点 X），防重入避免叠开多个对话框。
		if (closeDialogShown) return;
		closeDialogShown = true;
		try {
			const answer = await showCloseDialog(hwnd, brandColorRef);
			if (!answer) return;
			if (answer.remember) {
				preferences = { ...preferences, closeAction: answer.action, askOnClose: false };
				writePreferences(preferences);
				appendLog(
					"PREP",
					answer.action === "exit" ? t("log.rememberedExit") : t("log.rememberedMinimize"),
				);
			}
			if (answer.action === "exit") exitApplication(hwnd);
			else minimizeToTray(hwnd);
		} finally {
			closeDialogShown = false;
		}
		return;
	}
	if (preferences.closeAction === "minimize") minimizeToTray(hwnd);
	else exitApplication(hwnd);
}

function minimizeToTray(hwnd: Pointer): void {
	showWindow(hwnd, SW_HIDE);
	appendLog("PREP", t("log.minimized"));
}

let exiting = false;

async function exitApplication(hwnd: Pointer): Promise<void> {
	if (exiting) return;
	exiting = true;
	try {
		await stopSupervised();
	} finally {
		if (trayAdded) {
			removeTrayIcon(hwnd);
			trayAdded = false;
		}
		backend?.dispose();
		// 直接退出进程：WM_QUIT 是线程消息，穿过对话框的模态泵并可靠送达主循环
		// 的路径并不总是成立（实测存在关不干净的残留），停止完成后硬退出最稳。
		process.exit(0);
	}
}

function restoreFromTray(hwnd: Pointer): void {
	showWindow(hwnd, SW_SHOW);
	focusWindow(hwnd);
	redrawWindow(hwnd);
}

/**
 * 打开前端面板。
 *
 * 打开方式沿用 NarraFork 的 server.openBrowser 设置：应用 → 无地址栏窗口，网页 → 默认浏览器。
 * forceNewWindow 表示"用户明确要求打开"（托盘「打开新窗口」、Shift+点击）：此时即使设置是
 * "不打开"，也回落为浏览器网页 —— 否则那个菜单项会像坏掉一样毫无反应。
 */
function openPanel(forceNewWindow = false, explicit = false): void {
	// 已有前端窗口（--app 窗口的标题就是实例显示名）时直接聚焦，不重复打开。
	if (!forceNewWindow && focusWindowByTitle(settings.brandName)) {
		appendLog("WEB", t("log.focusedPanel"));
		return;
	}
	const mode = readNarraForkSettings().openBrowser;
	// 托盘双击是明确要求打开。设置为「不打开」时仍回落为浏览器，避免点了没反应。
	if (mode === "off" && !forceNewWindow && !explicit) return;
	const url = `${serviceOrigin()}/`;
	appendLog(
		"WEB",
		forceNewWindow ? t("log.openedPanelNew", { url }) : t("log.openedPanel", { url }),
	);
	if (mode === "app") openWebPanel(url, forceNewWindow);
	else openExternal(url);
}

function revealServerLog(): void {
	const path = join(resolveNarraforkHome(), "server.log");
	if (!existsSync(path)) {
		appendLog("WARN", t("log.serverLogMissing"));
		openExternal(resolveNarraforkHome());
		return;
	}
	revealInFolder(path);
}

/** 启动失败时才把管理器窗口带到前面，方便看日志。 */
function showManagerWindow(): void {
	if (!mainWindow) return;
	showWindow(mainWindow.hwnd, SW_SHOW);
	focusWindow(mainWindow.hwnd);
	redrawWindow(mainWindow.hwnd);
	relayout(mainWindow.hwnd);
	invalidate(mainWindow.hwnd);
}

/** 按当前语言刷新静态文案；自绘按钮与状态行的文字在重绘时自动取新值。 */
function refreshControlTexts(): void {
	if (!mainWindow) return;
	setText(controls.bannerSubtitle, t("label.console"));
	setText(controls.configTitle, t("label.listenConfig"));
	setText(controls.configHint, t("label.autoApply"));
	setText(controls.ipLabel, t("label.ip"));
	setText(controls.portLabel, t("label.port"));
	setText(controls.logTitle, t("label.output"));
	invalidate(mainWindow.hwnd);
}

/** 服务就绪后是否已经按设置打开过前端；服务停下时复位。 */
let frontendOpened = false;
/** 再次启动时服务还没就绪，等进入运行后再按用户的明确要求打开前端。 */
let openWhenReady = false;
/** 同一次启动失败只打开一次管理器，避免 error 之后的退出码再弹一次。 */
let startupFailureShown = false;

/** 托盘双击，或再次启动已在运行的管理器：按用户设置打开前端，不显示管理器窗口。 */
function requestOpenFrontend(): void {
	const running = backend?.current === "running" || externalRunning || supervision === "adopted";
	if (!running) {
		openWhenReady = true;
		return;
	}
	openWhenReady = false;
	frontendOpened = true;
	openPanel(false, true);
}

/**
 * 服务就绪后打开前端。
 *
 * 与「打开 NarraFork」按钮走同一条路径：先聚焦已存在的窗口，没有才新建。
 * 启动时是否打开由 settings.json 的 openBrowser 决定；再次启动若带了明确要求，则仍会打开。
 */
function openFrontendOnce(): void {
	if (frontendOpened && !openWhenReady) return;
	const explicit = openWhenReady;
	openWhenReady = false;
	frontendOpened = true;
	if (!explicit && readNarraForkSettings().openBrowser === "off") return;
	openPanel(false, explicit);
}

/**
 * 打开设置窗口（模态），保存后即时应用：语言立即切换，主题色/实例名变化时刷新窗口图标与强调色。
 * 更新检查与下载走服务端自带接口。只有面板自己拉起（或更新后认领）的服务才带令牌。
 */
async function openSettings(): Promise<void> {
	if (!mainWindow) return;
	const managed = serviceIsManaged();
	const result = await showSettingsDialog(mainWindow.hwnd, {
		preferences,
		narrafork: readNarraForkSettings(),
		brandColorRef,
		serviceBaseUrl: managed || externalRunning ? serviceOrigin() : undefined,
		managerToken: managed ? managerToken : undefined,
		onApplyStarting: () => {
			expectRelaunch = true;
		},
		onApplyFailed: () => {
			expectRelaunch = false;
		},
	});
	if (!result) return;
	preferences = result.preferences;
	setLanguage(result.preferences.language);
	if (result.narraforkChanged) {
		settings.brandColor = result.narrafork.brandColor || DEFAULT_BRAND_COLOR;
		settings.brandName = result.narrafork.brandName || DEFAULT_BRAND_NAME;
		brandColorRef = toColorRef(settings.brandColor);
		const icon =
			(await loadBrandedIcon(settings.brandColor)) ?? resolveWindowIcon(mainWindow.instance);
		if (icon) setWindowIcon(mainWindow.hwnd, icon);
	}
	refreshControlTexts();
	applyStatus(backend?.current ?? "stopped", undefined);
	appendLog("PREP", t("settings.saved"));
}

// ── 启动 ────────────────────────────────────────────────────────────────────

export async function runManager(): Promise<void> {
	if (!isNativeAvailable()) {
		console.error(t("error.nativeUnavailable"));
		process.exit(1);
	}

	// 单实例：再次双击 exe 时通知已有托盘进程打开前端，不把隐藏的管理器窗口显示出来。
	if (!acquireSingleInstanceMutex("Local\\NarraFork.Manager")) {
		const existing = findWindowByTitle(WINDOW_TITLE);
		if (existing) postMessage(existing, WM_OPEN_FRONTEND);
		else console.error(t("error.alreadyRunning"));
		return;
	}

	// 地址与品牌都来自 NarraFork 的 settings；地址的读写与回显由 manager-config 负责。
	preferences = readPreferences();
	setLanguage(preferences.language);
	openLogFileMirror();
	const address = readServerAddress();
	settings.host = address.host;
	settings.port = address.port;
	settings.tls = address.tls;
	const branding = await loadBranding();
	settings.brandColor = branding.color;
	settings.brandName = branding.name;
	brandColorRef = toColorRef(settings.brandColor);

	// 子进程管理器必须在配置就绪之后创建：它捕获 host/port 用于健康检查。
	backend = new BackendProcess({
		host: settings.host,
		port: settings.port,
		tls: settings.tls,
		managerToken,
		onLine: (line) => appendLog(undefined, formatBackendLine(line)),
		onState: (state, detail) => {
			if (state === "stopped" && expectRelaunch) {
				expectRelaunch = false;
				void adoptRelaunch();
				return;
			}
			if (state === "running") {
				supervision = "none";
				startupFailureShown = false;
				openFrontendOnce();
			} else if (state === "error" || (state === "stopped" && detail)) {
				if (supervision !== "reconnecting" && supervision !== "adopted") {
					frontendOpened = false;
					openWhenReady = false;
					if (!startupFailureShown) {
						startupFailureShown = true;
						appendLog("ERROR", t("log.startupFailed"));
						showManagerWindow();
					}
				}
			} else if (
				state === "stopped" &&
				supervision !== "reconnecting" &&
				supervision !== "adopted"
			) {
				frontendOpened = false;
			}
			if (supervision === "reconnecting" || supervision === "adopted") return;
			applyStatus(state, detail);
		},
	});

	mainWindow = createWindow({
		title: WINDOW_TITLE,
		className: "NarraForkManagerWindow",
		// 先以隐藏方式创建：托盘挂好后再决定显示，避免"先闪一下再隐藏"。
		visible: false,
		// 首次启动用最小尺寸；用户调整过后按上次的尺寸恢复。按钮从 4 个增至 5 个后，旧偏好
		// 可能小于新的最小值，这里取较大者，避免按钮被挤出窗口。
		width: Math.max(preferences.windowWidth ?? MIN_WINDOW_WIDTH, MIN_WINDOW_WIDTH),
		height: Math.max(preferences.windowHeight ?? MIN_WINDOW_HEIGHT, MIN_WINDOW_HEIGHT),
		onClose: () => {
			if (mainWindow) void handleCloseRequest(mainWindow.hwnd);
		},
		onMessage: handleMessage,
	});
	if (!mainWindow) {
		console.error(t("error.windowCreateFailed"));
		process.exit(1);
	}
	const { hwnd, instance } = mainWindow;
	const window = mainWindow;

	const uiFont = createFont(13);
	const titleFont = createFont(21, 700);
	const subtitleFont = createFont(12);
	const statusFont = createFont(15, 700);
	const cardTitleFont = createFont(13, 700);
	const monoFont = createFont(12, 400, "Consolas");

	const add = (
		className: string,
		text: string,
		style: number,
		id: number,
		x: number,
		y: number,
		width: number,
		height: number,
		font: Pointer | undefined,
	): Pointer | undefined =>
		createControl({
			parent: hwnd,
			className,
			text,
			style,
			id,
			x,
			y,
			width,
			height,
			instance,
			font,
		});

	// 横幅：WM_PAINT 画渐变底，两个白色静态文本叠在上面。
	controls.bannerTitle = add(
		"STATIC",
		"NarraFork Manager",
		SS_LEFT,
		ID.bannerTitle,
		22,
		14,
		420,
		30,
		titleFont,
	);
	controls.bannerSubtitle = add(
		"STATIC",
		t("label.console"),
		SS_LEFT,
		ID.bannerSubtitle,
		24,
		46,
		320,
		18,
		subtitleFont,
	);

	// 状态区。
	controls.statusDot = add("STATIC", "●", SS_LEFT, ID.statusDot, 18, 92, 18, 20, uiFont);
	controls.statusText = add("STATIC", "", SS_LEFT, ID.statusText, 38, 90, 320, 24, statusFont);
	controls.address = add("STATIC", "", SS_LEFT, ID.address, 40, 118, 480, 18, subtitleFont);

	// 四个动作按钮（位置与尺寸由 relayout 统一管理）。
	controls.start = add(
		"BUTTON",
		t("button.start"),
		BS_OWNERDRAW,
		ID.start,
		buttonX(0),
		BUTTON_Y,
		buttonWidth(0),
		BUTTON_HEIGHT,
		uiFont,
	);
	controls.restart = add(
		"BUTTON",
		t("button.restart"),
		BS_OWNERDRAW,
		ID.restart,
		buttonX(1),
		BUTTON_Y,
		buttonWidth(1),
		BUTTON_HEIGHT,
		uiFont,
	);
	controls.stop = add(
		"BUTTON",
		t("button.stop"),
		BS_OWNERDRAW,
		ID.stop,
		buttonX(2),
		BUTTON_Y,
		buttonWidth(2),
		BUTTON_HEIGHT,
		uiFont,
	);
	controls.open = add(
		"BUTTON",
		t("button.open"),
		BS_OWNERDRAW,
		ID.open,
		buttonX(3),
		BUTTON_Y,
		buttonWidth(3),
		BUTTON_HEIGHT,
		uiFont,
	);
	controls.settings = add(
		"BUTTON",
		t("button.settings"),
		BS_OWNERDRAW,
		ID.settings,
		buttonX(4),
		BUTTON_Y,
		buttonWidth(4),
		BUTTON_HEIGHT,
		uiFont,
	);

	// 监听配置卡片（白底由 WM_PAINT 画，文字与控件叠在上面）。
	controls.configTitle = add(
		"STATIC",
		"监听配置",
		SS_LEFT,
		ID.configTitle,
		CARD_X + 16,
		CONFIG_CARD_TOP + 12,
		200,
		20,
		cardTitleFont,
	);
	controls.configHint = add(
		"STATIC",
		"保存后自动生效",
		SS_LEFT,
		ID.configTitle + 10,
		CARD_X + 96,
		CONFIG_CARD_TOP + 14,
		200,
		18,
		subtitleFont,
	);
	controls.ipLabel = add(
		"STATIC",
		"IP 地址",
		SS_LEFT,
		ID.ipLabel,
		CARD_X + 16,
		CONFIG_CARD_TOP + 48,
		56,
		20,
		uiFont,
	);
	controls.ipEdit = add(
		"EDIT",
		settings.host,
		ES_AUTOHSCROLL | WS_BORDER,
		ID.ipEdit,
		CARD_X + 72,
		CONFIG_CARD_TOP + 45,
		100,
		26,
		uiFont,
	);
	controls.portLabel = add(
		"STATIC",
		"端口",
		SS_LEFT,
		ID.portLabel,
		CARD_X + 184,
		CONFIG_CARD_TOP + 48,
		40,
		20,
		uiFont,
	);
	controls.portEdit = add(
		"EDIT",
		String(settings.port),
		ES_AUTOHSCROLL | WS_BORDER,
		ID.portEdit,
		CARD_X + 226,
		CONFIG_CARD_TOP + 45,
		68,
		26,
		uiFont,
	);
	controls.save = add(
		"BUTTON",
		"保存并应用",
		BS_OWNERDRAW,
		ID.save,
		CARD_X + CARD_WIDTH - 140,
		CONFIG_CARD_TOP + 44,
		124,
		28,
		uiFont,
	);

	// 输出日志卡片。
	controls.logTitle = add(
		"STATIC",
		t("label.output"),
		SS_LEFT,
		ID.logTitle,
		CARD_X + 16,
		LOG_CARD_TOP + 12,
		160,
		20,
		cardTitleFont,
	);
	controls.serverLog = add(
		"BUTTON",
		t("button.serverLog"),
		BS_OWNERDRAW,
		ID.serverLog,
		CARD_X + CARD_WIDTH - 140,
		LOG_CARD_TOP + 10,
		124,
		24,
		uiFont,
	);
	// 日志被裁断后、用户滚到顶部时才显示：打开完整日志文件。
	controls.openLogFile = add(
		"BUTTON",
		t("button.openLog"),
		BS_OWNERDRAW,
		ID.openLogFile,
		CARD_X + 110,
		LOG_CARD_TOP + 11,
		104,
		22,
		uiFont,
	);
	setVisible(controls.openLogFile, false);
	// 日志用 RichEdit：普通 EDIT 只能单色，无法按 level 区分。
	controls.logEdit = createRichEdit({
		parent: hwnd,
		text: "",
		style: ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL | WS_BORDER,
		id: ID.logEdit,
		x: CARD_X + 14,
		y: LOG_CARD_TOP + 40,
		width: CARD_WIDTH - 28,
		height: MIN_WINDOW_HEIGHT - LOG_CARD_TOP - 90,
		instance,
		font: monoFont,
	});

	// 图标：优先按主题色实时生成（品牌素材重着色），失败回退静态 ico / exe 内嵌资源。
	const icon = (await loadBrandedIcon(settings.brandColor)) ?? resolveWindowIcon(instance);
	if (icon) {
		setWindowIcon(hwnd, icon);
		trayAdded = addTrayIcon(hwnd, icon, WINDOW_TITLE, WM_TRAY);
		if (!trayAdded) appendLog("WARN", t("log.trayFailed"));
	}

	// 正常启动不显示管理器。托盘没挂上时必须显示窗口，否则再也找不回来。
	if (!trayAdded) showManagerWindow();
	else appendLog("PREP", t("log.minimized"));
	// 必须在显示之后：RedrawWindow 对隐藏窗口不生效，否则自绘按钮首次显示时是空白，要等用户
	// 改变窗口大小才画出来。
	relayout(hwnd);
	invalidate(hwnd);
	applyStatus("stopped");
	appendLog("PREP", t("log.managerStarted", { color: settings.brandColor }));

	// 前端改的也是同一份 settings，按 mtime 回显到输入框。
	const stopWatching = watchSettings(() => {
		const current = readServerAddress();
		if (
			current.host === settings.host &&
			current.port === settings.port &&
			current.tls === settings.tls
		) {
			return;
		}
		settings.host = current.host;
		settings.port = current.port;
		settings.tls = current.tls;
		syncListenTarget();
		if (controls.ipEdit) setText(controls.ipEdit, current.host);
		if (controls.portEdit) setText(controls.portEdit, String(current.port));
		appendLog("PREP", t("log.addressChanged", { address: `${current.host}:${current.port}` }));
		applyStatus(backend?.current ?? "stopped");
	});

	// 终端里手动启动的服务面板也要能看见：立即探测一次，之后每 4 秒复查。
	let firstProbeDone = false;
	const probeExternal = (): void => {
		if (backend?.current !== "stopped") return;
		if (supervision !== "none" || expectRelaunch) return;
		void probeServiceHealth(settings.host, settings.port, settings.tls).then((alive) => {
			if (awaitingHandover && !alive) {
				// 外部服务已退出：完成接管，启动面板托管的后端。
				awaitingHandover = false;
				externalRunning = false;
				appendLog("RUN", t("log.takeoverStart"));
				applyStatus("stopped");
				void backend?.start();
				return;
			}
			if (!firstProbeDone) firstProbeDone = true;
			if (alive === externalRunning) return;
			externalRunning = alive;
			appendLog("PREP", alive ? t("log.externalDetected") : t("log.externalStopped"));
			applyStatus("stopped");
		});
	};
	const launchOnStartup = async (): Promise<void> => {
		const alive = await probeServiceHealth(settings.host, settings.port, settings.tls);
		firstProbeDone = true;
		if (backend?.current !== "stopped") return;
		if (alive) {
			externalRunning = true;
			appendLog("PREP", t("log.externalDetected"));
			applyStatus("stopped");
			openFrontendOnce();
			return;
		}
		appendLog("RUN", t("log.startingService"));
		await backend?.start();
	};
	void launchOnStartup();
	const externalTimer = setInterval(probeExternal, 4000);

	// 悬停高亮：光标下的控件变化时重绘两侧 —— 自绘按钮不会自己收到"已进入/已离开"通知。
	let lastHovered: Pointer | undefined;
	// 状态点动效：启动/停止过程中让圆点闪烁，"正在变化"一眼可见。
	let statusDotBlinking = false;
	const timer = setInterval(() => {
		const hovered = windowAtCursor();
		if (hovered !== lastHovered) {
			// 只重绘 owner-draw 按钮，而且不擦背景：否则鼠标划过日志等大控件时整块重绘，
			// 界面会持续闪烁。
			for (const target of [lastHovered, hovered]) {
				if (isOwnerDrawButton(target)) invalidate(target, false);
			}
			lastHovered = hovered;
		}
		const currentStatus = backend?.current ?? "stopped";
		const shouldBlink =
			supervision === "reconnecting" ||
			currentStatus === "starting" ||
			currentStatus === "stopping";
		if (shouldBlink) {
			const on = Math.floor(Date.now() / 450) % 2 === 0;
			if (on !== statusDotBlinking) {
				statusDotBlinking = on;
				setText(controls.statusDot, on ? "●" : "○");
				invalidate(controls.statusDot);
			}
		} else if (statusDotBlinking) {
			statusDotBlinking = false;
			setText(controls.statusDot, "●");
			invalidate(controls.statusDot);
		}
		if (!window.pump()) {
			clearInterval(timer);
			clearInterval(externalTimer);
			stopWatching();
			backend?.dispose();
			process.exit(0);
		}
	}, 50);
}
