/**
 * 设置窗口：自绘模态窗口，与主面板同风格。
 *
 * 结构照抄 close-dialog.ts —— owner 关系置顶、禁用主窗口实现模态、消息由主窗口的泵
 * 统一派发（双泵会互相抢消息）、关闭时 dispose() 注销窗口类。
 *
 * 保存语义：一次性写两处配置
 *   - NarraFork settings.json：启动项目时的前端打开方式、实例名称、主题颜色（同步给前端）
 *   - 管理器 manager.json：界面语言、关闭偏好、启动时是否显示窗口
 * 更新区直连服务端的更新接口（本机回环免认证），下载与应用逻辑与前端的更新流程同源。
 */

import {
	type ManagerPreferences,
	type NarraForkSettings,
	writeNarraForkSettings,
	writePreferences,
} from "./manager-config";

import { MANAGER_LANGUAGES, type ManagerLang, setLanguage, t } from "./manager-i18n";
import { DEFAULT_BRAND_COLOR, fromColorRef, mixColor, toColorRef } from "./theme";
import {
	applyUpdate,
	checkForUpdate,
	downloadUpdate,
	type UpdateCheckSummary,
} from "./update-client";
import {
	BS_AUTOCHECKBOX,
	BS_OWNERDRAW,
	brushFor,
	checkBoxSetChecked,
	chooseColor,
	comboBoxAddItem,
	comboBoxSelect,
	comboBoxSelected,
	controlIdAtCursor,
	createControl,
	createFont,
	createWindow,
	destroyWindow,
	drawRoundedRect,
	drawText,
	ES_AUTOHSCROLL,
	enableWindow,
	fillRect,
	focusWindow,
	getControlId,
	invalidate,
	isChecked,
	loadNative,
	makeRectOf,
	messageBox,
	ODS_FOCUS,
	ODS_SELECTED,
	type Pointer,
	readDrawItem,
	readWstr,
	SS_LEFT,
	setText,
	setVisible,
	WM_COMMAND,
	WM_CTLCOLORSTATIC,
	WM_DESTROY,
	WM_DRAWITEM,
	WM_ERASEBKGND,
	WS_BORDER,
} from "./win32";

export interface SettingsDialogInput {
	preferences: ManagerPreferences;
	narrafork: NarraForkSettings;
	/** 面板强调色（可能已被实例主题色覆盖）。 */
	brandColorRef: number;
	/** 更新检查的服务基地址（如 http://127.0.0.1:7778）；服务未运行时为 undefined。 */
	serviceBaseUrl?: string;
	/** 面板拉起的服务才有令牌。外部启动的实例不传，更新按钮会说明原因。 */
	managerToken?: string;
	/** 应用更新即将发出。面板据此在子进程退出后等待替换进程。 */
	onApplyStarting?: () => void;
	/** 应用请求被服务拒绝。连接被重启打断不算失败。 */
	onApplyFailed?: () => void;
}

export interface SettingsDialogResult {
	preferences: ManagerPreferences;
	narrafork: NarraForkSettings;
	/** NarraFork 侧（打开方式/名称/颜色）是否有变化，调用方据此刷新图标与主题色。 */
	narraforkChanged: boolean;
}

const WIDTH = 460;
const HEIGHT = 470;
const CARD_BG = 0x00ffffff;
const TEXT_MAIN = 0x0028231f;
const TEXT_FAINT = 0x008d8a8a;
const NEUTRAL_BORDER = 0x00ddd8dd;
const PRESSED_BG = 0x00f2f0ee;
const HINT_ID = 990;

const LABEL_X = 20;
const CONTROL_X = 148;
const CONTROL_WIDTH = 292;
const CONTROL_HEIGHT = 26;

const ID = {
	language: 601,
	openBrowser: 602,
	instanceName: 603,
	colorButton: 604,
	closeAction: 605,
	askOnClose: 606,
	startMinimized: 607,
	autoStart: 613,
	checkUpdate: 608,
	updateNow: 609,
	status: 610,
	save: 611,
	cancel: 612,
} as const;

const OPEN_BROWSER_MODES: NarraForkSettings["openBrowser"][] = ["off", "browser", "app"];
const OPEN_BROWSER_LABEL_KEYS = [
	"settings.openBrowser.off",
	"settings.openBrowser.browser",
	"settings.openBrowser.app",
];

/** MB_YESNO | MB_ICONQUESTION / IDYES：系统的"是/否"确认框。 */
const MB_YESNO_QUESTION = 0x00000004 | 0x00000020;
const IDYES = 6;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const BUTTONS: Record<number, { danger: boolean; primary: boolean }> = {
	[ID.save]: { danger: false, primary: true },
	[ID.cancel]: { danger: false, primary: false },
	[ID.checkUpdate]: { danger: false, primary: false },
	[ID.updateNow]: { danger: false, primary: true },
	[ID.colorButton]: { danger: false, primary: false },
};

/** 每个按钮的文字在 drawButtons 里按当前语言取，避免把文案固化进常量表。 */
function buttonText(id: number): string {
	switch (id) {
		case ID.save:
			return t("settings.save");
		case ID.cancel:
			return t("settings.cancel");
		case ID.checkUpdate:
			return t("settings.checkUpdate");
		case ID.updateNow:
			return t("settings.updateNow");
		default:
			return "";
	}
}

/** 模态弹出设置窗口；点「保存」返回新配置，点「取消」或标题栏 X 返回 null。 */
export async function showSettingsDialog(
	owner: Pointer,
	input: SettingsDialogInput,
): Promise<SettingsDialogResult | null> {
	let result: SettingsDialogResult | null = null;
	let closed = false;
	let dialog: ReturnType<typeof createWindow> | undefined;
	const native = loadNative();
	const gdi = native?.gdi32;

	// 待保存的主题色（#rrggbb）与最近一次更新检查结果。
	let pendingColor = input.narrafork.brandColor || DEFAULT_BRAND_COLOR;
	let latestCheck: UpdateCheckSummary | undefined;

	const controls: Record<string, Pointer | undefined> = {};
	const finish = (): void => {
		enableWindow(owner, true);
		closed = true;
		if (dialog) destroyWindow(dialog.hwnd);
	};

	dialog = createWindow({
		title: t("settings.title"),
		className: "NarraForkSettingsDialog",
		width: WIDTH,
		height: HEIGHT,
		resizable: false,
		owner,
		onMessage: (_hwnd, msg, wParam, lParam): Pointer | number | undefined => {
			switch (msg) {
				case WM_COMMAND: {
					const id = Number(wParam) & 0xffff;
					if (id === ID.cancel) {
						finish();
					} else if (id === ID.save) {
						saveSettings();
					} else if (id === ID.colorButton) {
						pickColor();
					} else if (id === ID.checkUpdate) {
						runCheck();
					} else if (id === ID.updateNow) {
						runUpdate();
					}
					return 0;
				}
				case WM_ERASEBKGND: {
					fillRect(wParam, makeRectOf(0, 0, WIDTH, HEIGHT), CARD_BG);
					return 1;
				}
				case WM_CTLCOLORSTATIC: {
					const id = getControlId(lParam as unknown as Pointer);
					const faint = id === HINT_ID;
					gdi?.SetTextColor(wParam, faint ? TEXT_FAINT : TEXT_MAIN);
					return brushFor(CARD_BG) as unknown as Pointer;
				}
				case WM_DRAWITEM: {
					const item = readDrawItem(lParam);
					const spec = BUTTONS[item.controlId];
					if (!spec) return 0;
					const pressed = (item.itemState & ODS_SELECTED) !== 0;
					const focused = (item.itemState & ODS_FOCUS) !== 0;
					const hovered = controlIdAtCursor() === item.controlId;
					const highlighted = focused || hovered;
					const hoverFill = mixColor(CARD_BG, input.brandColorRef, 0.12);
					if (item.controlId === ID.colorButton) {
						// 颜色按钮同时充当预览：白底按钮 + 左侧色块 + 十六进制值。
						drawRoundedRect(
							item.hdc,
							item.rect,
							pressed ? PRESSED_BG : hovered ? hoverFill : CARD_BG,
							highlighted ? input.brandColorRef : NEUTRAL_BORDER,
							6,
						);
						const swatch = makeRectOf(
							item.rect.readInt32LE(0) + 8,
							item.rect.readInt32LE(4) + 6,
							item.rect.readInt32LE(0) + 40,
							item.rect.readInt32LE(12) - 6,
						);
						drawRoundedRect(item.hdc, swatch, toColorRef(pendingColor), NEUTRAL_BORDER, 4);
						drawText(item.hdc, `${t("settings.pickColor")}  ${pendingColor}`, item.rect, TEXT_MAIN);
						return 1;
					}
					// 悬停染品牌浅色（而不是近白的灰），让反馈一眼可见。
					const fill = pressed ? PRESSED_BG : hovered ? hoverFill : CARD_BG;
					const border = spec.primary || highlighted ? input.brandColorRef : NEUTRAL_BORDER;
					drawRoundedRect(item.hdc, item.rect, fill, border, 6);
					drawText(item.hdc, buttonText(item.controlId), item.rect, TEXT_MAIN);
					return 1;
				}
				case WM_DESTROY: {
					closed = true;
					enableWindow(owner, true);
					return 0;
				}
				default:
					return undefined;
			}
		},
	});
	if (!dialog) {
		enableWindow(owner, true);
		return null;
	}
	const { hwnd, instance } = dialog;
	/** 系统取色框的自定义色槽（16 个 COLORREF），本窗口生命周期内保留以便回填。 */
	const customColors = Buffer.alloc(64);

	const uiFont = createFont(13);
	const hintFont = createFont(12);
	const buttonFont = createFont(13, 600);
	const titleFont = createFont(13, 600);

	const add = (
		className: string,
		text: string,
		style: number,
		id: number,
		x: number,
		y: number,
		width: number,
		height: number,
		font?: Pointer,
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

	const addLabel = (text: string, y: number, id: number): void => {
		add("STATIC", text, SS_LEFT, id, LABEL_X, y + 4, 120, 20, uiFont);
	};
	const addHint = (text: string, y: number): void => {
		add("STATIC", text, SS_LEFT, HINT_ID, CONTROL_X, y, CONTROL_WIDTH, 18, hintFont);
	};

	// ── NarraFork 配置（写入 settings.json，前端设置页同源）──────────────────
	let y = 18;
	addLabel(t("settings.language"), y, 621);
	controls.language = add(
		"COMBOBOX",
		"",
		0x0003,
		ID.language,
		CONTROL_X,
		y,
		CONTROL_WIDTH,
		200,
		uiFont,
	);
	for (const option of MANAGER_LANGUAGES) comboBoxAddItem(controls.language, option.label);
	const currentLangIndex = MANAGER_LANGUAGES.findIndex(
		(option) => option.value === input.preferences.language,
	);
	comboBoxSelect(controls.language, currentLangIndex >= 0 ? currentLangIndex : 0);
	addHint(t("settings.languageHint"), y + 30);

	y = 78;
	addLabel(t("settings.openBrowser"), y, 622);
	controls.openBrowser = add(
		"COMBOBOX",
		"",
		0x0003,
		ID.openBrowser,
		CONTROL_X,
		y,
		CONTROL_WIDTH,
		200,
		uiFont,
	);
	for (const key of OPEN_BROWSER_LABEL_KEYS) comboBoxAddItem(controls.openBrowser, t(key));
	const modeIndex = OPEN_BROWSER_MODES.indexOf(input.narrafork.openBrowser);
	comboBoxSelect(controls.openBrowser, modeIndex >= 0 ? modeIndex : 1);
	addHint(t("settings.openBrowserHint"), y + 30);

	y = 138;
	addLabel(t("settings.instanceName"), y, 623);
	controls.instanceName = add(
		"EDIT",
		input.narrafork.brandName,
		ES_AUTOHSCROLL | WS_BORDER,
		ID.instanceName,
		CONTROL_X,
		y,
		CONTROL_WIDTH,
		CONTROL_HEIGHT,
		uiFont,
	);
	addHint(t("settings.instanceNameHint"), y + 30);

	y = 198;
	addLabel(t("settings.brandColor"), y, 624);
	controls.colorButton = add(
		"BUTTON",
		t("settings.pickColor"),
		BS_OWNERDRAW,
		ID.colorButton,
		CONTROL_X,
		y,
		CONTROL_WIDTH,
		CONTROL_HEIGHT,
		uiFont,
	);
	addHint(t("settings.brandColorHint"), y + 30);

	// ── 管理器偏好（写入 manager.json）────────────────────────────────────
	y = 258;
	addLabel(t("settings.closeAction"), y, 625);
	controls.closeAction = add(
		"COMBOBOX",
		"",
		0x0003,
		ID.closeAction,
		CONTROL_X,
		y,
		CONTROL_WIDTH,
		200,
		uiFont,
	);
	comboBoxAddItem(controls.closeAction, t("settings.closeAction.exit"));
	comboBoxAddItem(controls.closeAction, t("settings.closeAction.minimize"));
	comboBoxSelect(controls.closeAction, input.preferences.closeAction === "minimize" ? 1 : 0);

	y = 292;
	controls.askOnClose = add(
		"BUTTON",
		t("settings.askOnClose"),
		BS_AUTOCHECKBOX,
		ID.askOnClose,
		CONTROL_X,
		y,
		CONTROL_WIDTH,
		22,
		uiFont,
	);
	// 双击 exe 固定为托盘启动并拉起服务器，不再提供这两项开关。
	checkBoxSetChecked(controls.askOnClose, input.preferences.askOnClose);

	// ── 更新（服务端自带接口，本机回环免认证）─────────────────────────────
	y = 328;
	add("STATIC", t("settings.update"), SS_LEFT, 626, LABEL_X, y + 4, 120, 20, titleFont);
	controls.checkUpdate = add(
		"BUTTON",
		t("settings.checkUpdate"),
		BS_OWNERDRAW,
		ID.checkUpdate,
		CONTROL_X,
		y,
		136,
		CONTROL_HEIGHT,
		uiFont,
	);
	controls.updateNow = add(
		"BUTTON",
		t("settings.updateNow"),
		BS_OWNERDRAW,
		ID.updateNow,
		CONTROL_X + 148,
		y,
		144,
		CONTROL_HEIGHT,
		uiFont,
	);
	setVisible(controls.updateNow, false);
	controls.status = add(
		"STATIC",
		"",
		SS_LEFT,
		ID.status,
		LABEL_X,
		y + 36,
		WIDTH - 2 * LABEL_X,
		40,
		hintFont,
	);

	// ── 底部按钮 ──────────────────────────────────────────────────────────
	controls.save = add(
		"BUTTON",
		"",
		BS_OWNERDRAW,
		ID.save,
		CONTROL_X + 40,
		HEIGHT - 52,
		110,
		32,
		buttonFont,
	);
	controls.cancel = add(
		"BUTTON",
		"",
		BS_OWNERDRAW,
		ID.cancel,
		CONTROL_X + 162,
		HEIGHT - 52,
		110,
		32,
		buttonFont,
	);

	enableWindow(owner, false);
	focusWindow(hwnd);

	/** 取色后更新预览按钮（自绘，需要重绘）。 */
	function pickColor(): void {
		const chosen = chooseColor(hwnd, toColorRef(pendingColor), customColors);
		if (chosen === undefined) return;
		pendingColor = fromColorRef(chosen);
		invalidate(controls.colorButton);
	}

	/** 保存两处配置；任一处失败都留在窗口里显示原因。 */
	function saveSettings(): void {
		const langOption = MANAGER_LANGUAGES[comboBoxSelected(controls.language)];
		const language: ManagerLang = langOption?.value ?? input.preferences.language;
		const mode = OPEN_BROWSER_MODES[comboBoxSelected(controls.openBrowser)];
		const nextPreferences: ManagerPreferences = {
			...input.preferences,
			language,
			closeAction: comboBoxSelected(controls.closeAction) === 1 ? "minimize" : "exit",
			askOnClose: isChecked(controls.askOnClose),
		};
		const nextNarrafork: NarraForkSettings = {
			openBrowser: mode ?? input.narrafork.openBrowser,
			brandName: controls.instanceName ? readWstr(controls.instanceName).trim() : "",
			brandColor: pendingColor === DEFAULT_BRAND_COLOR ? "" : pendingColor,
		};

		const preferencesSaved = writePreferences(nextPreferences);
		const narraforkSaved = writeNarraForkSettings({
			openBrowser: nextNarrafork.openBrowser,
			brandName: nextNarrafork.brandName,
			brandColor: nextNarrafork.brandColor,
		});
		if (!preferencesSaved || !narraforkSaved) {
			setText(controls.status, t("settings.saveFailed", { error: "write failed" }));
			return;
		}
		const narraforkChanged =
			nextNarrafork.openBrowser !== input.narrafork.openBrowser ||
			nextNarrafork.brandName !== input.narrafork.brandName ||
			nextNarrafork.brandColor !== input.narrafork.brandColor;
		// 语言立即生效，让"设置已保存"这类收尾提示用新语言显示。
		setLanguage(language);
		result = { preferences: nextPreferences, narrafork: nextNarrafork, narraforkChanged };
		finish();
	}

	/** 检查更新：结果写入状态行，检测到新版本时露出「立即更新」。 */
	function runCheck(): void {
		const baseUrl = input.serviceBaseUrl;
		const token = input.managerToken;
		if (!baseUrl) {
			setText(controls.status, t("settings.nfUnavailable"));
			return;
		}
		if (!token) {
			setText(controls.status, t("settings.updateUnmanaged"));
			return;
		}
		setText(controls.status, t("settings.checking"));
		setVisible(controls.updateNow, false);
		void (async () => {
			const summary = await checkForUpdate(baseUrl, token);
			if (closed) return;
			if (summary.error) {
				latestCheck = undefined;
				setText(controls.status, t("settings.checkFailed", { error: summary.error }));
				return;
			}
			if (summary.updateAvailable && summary.latestVersion) {
				latestCheck = summary;
				setText(
					controls.status,
					t("settings.updateAvailable", {
						version: summary.latestVersion,
						current: summary.currentVersion,
					}),
				);
				setVisible(controls.updateNow, true);
			} else {
				latestCheck = undefined;
				setText(controls.status, t("settings.upToDate", { version: summary.currentVersion }));
			}
		})();
	}

	/** 下载并应用：进度进状态行；服务端应用后重启，连接中断属正常。 */
	function runUpdate(): void {
		const baseUrl = input.serviceBaseUrl;
		const token = input.managerToken;
		const releaseInfo = latestCheck?.releaseInfo;
		if (!baseUrl || !token || !releaseInfo) return;
		if (
			messageBox(hwnd, t("settings.updateConfirm"), t("settings.title"), MB_YESNO_QUESTION) !==
			IDYES
		) {
			return;
		}
		setVisible(controls.updateNow, false);
		setText(controls.status, t("settings.downloading", { percent: 0 }));
		void (async () => {
			const outcome = await downloadUpdate(baseUrl, token, releaseInfo, (percent) => {
				if (closed) return;
				setText(controls.status, t("settings.downloading", { percent: Math.round(percent) }));
			});
			if (closed) return;
			if (!outcome.success || !outcome.preparedIdentity) {
				setText(
					controls.status,
					t("settings.downloadFailed", { error: outcome.error ?? "download failed" }),
				);
				return;
			}
			setText(controls.status, t("settings.applying"));
			input.onApplyStarting?.();
			const applied = await applyUpdate(baseUrl, token, outcome.version, outcome.preparedIdentity);
			if (!applied.success && !applied.interrupted) input.onApplyFailed?.();
		})();
	}

	while (!closed) {
		await sleep(30);
	}
	dialog.dispose();
	focusWindow(owner);
	return result;
}
