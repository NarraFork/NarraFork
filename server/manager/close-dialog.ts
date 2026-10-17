/**
 * 关闭确认对话框：自绘窗口，与主面板同风格。
 *
 * 不用系统 MessageBox 的原因：它的按钮文案是「是/否/取消」，与「退出 / 最小化」的语义
 * 完全对不上（点「否」实际是最小化），而且没法放「记住选择」复选框。
 *
 * 模态方式：创建时禁用主窗口，对话框期间自转消息轮询，关闭后恢复主窗口并返回选择。
 */

import { t } from "./manager-i18n";
import { mixColor } from "./theme";
import {
	BS_AUTOCHECKBOX,
	BS_OWNERDRAW,
	brushFor,
	controlIdAtCursor,
	createControl,
	createFont,
	createWindow,
	destroyWindow,
	drawRoundedRect,
	drawText,
	enableWindow,
	fillRect,
	focusWindow,
	getControlId,
	isChecked,
	loadNative,
	makeRectOf,
	ODS_FOCUS,
	ODS_SELECTED,
	type Pointer,
	readDrawItem,
	WM_COMMAND,
	WM_CTLCOLORSTATIC,
	WM_DESTROY,
	WM_DRAWITEM,
	WM_ERASEBKGND,
} from "./win32";

export type CloseAction = "exit" | "minimize";

export interface CloseDialogResult {
	action: CloseAction;
	remember: boolean;
}

const DIALOG_WIDTH = 400;
const DIALOG_HEIGHT = 204;
const CARD_BG = 0x00ffffff;
const TEXT_MAIN = 0x0028231f;
const TEXT_FAINT = 0x008d8a8a;
const WHITE_REF = 0x00ffffff;
const DANGER_COLOR = 0x003131e0; // #e03131
const DANGER_PRESSED = 0x00c22f2f; // #c22f2f
const NEUTRAL_BORDER = 0x00ddd8dd; // #d5d8dd

const ID_CHECKBOX = 101;
const ID_EXIT = 102;
const ID_MINIMIZE = 103;
const ID_CANCEL = 104;
const ID_HINT = 105;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 文案存 i18n key，绘制与创建控件时按当前语言取值。 */
const BUTTONS: Record<number, { key: string; danger: boolean; primary: boolean }> = {
	[ID_MINIMIZE]: { key: "close.minimize", danger: false, primary: true },
	[ID_EXIT]: { key: "close.exit", danger: true, primary: false },
	[ID_CANCEL]: { key: "close.cancel", danger: false, primary: false },
};

/** 模态弹出关闭确认（禁用主窗口），返回用户的选择；点标题栏 X 或「取消」视为取消（null）。 */
export async function showCloseDialog(
	owner: Pointer,
	brandColorRef: number,
): Promise<CloseDialogResult | null> {
	let result: CloseDialogResult | null = null;
	let closed = false;
	let checkbox: Pointer | undefined;
	let dialog: ReturnType<typeof createWindow> | undefined;
	const native = loadNative();
	// FFI 不可用时窗口也创建不出来，这里的判空只为类型收窄。
	const gdi = native?.gdi32;

	const finish = (action: CloseAction): void => {
		result = { action, remember: isChecked(checkbox) };
		enableWindow(owner, true);
		closed = true;
		if (dialog) destroyWindow(dialog.hwnd);
	};

	// 取消：不产生结果，只关对话框恢复主窗口。
	const cancel = (): void => {
		enableWindow(owner, true);
		closed = true;
		if (dialog) destroyWindow(dialog.hwnd);
	};

	dialog = createWindow({
		title: t("close.title"),
		className: "NarraForkCloseDialog",
		width: DIALOG_WIDTH,
		height: DIALOG_HEIGHT,
		resizable: false,
		// owner 关系：系统保证该对话框永远显示在主窗口之上，切不到它后面去。
		owner,
		onMessage: (_hwnd, msg, wParam, lParam): Pointer | number | undefined => {
			switch (msg) {
				case WM_COMMAND: {
					const id = Number(wParam) & 0xffff;
					if (id === ID_EXIT) finish("exit");
					else if (id === ID_MINIMIZE) finish("minimize");
					else if (id === ID_CANCEL) cancel();
					return 0;
				}
				case WM_ERASEBKGND: {
					fillRect(wParam, makeRectOf(0, 0, DIALOG_WIDTH, DIALOG_HEIGHT), CARD_BG);
					return 1;
				}
				case WM_CTLCOLORSTATIC: {
					// 提示行用浅灰弱化，其余（说明文字）保持正文色；背景都是卡片白。
					const id = getControlId(lParam as unknown as Pointer);
					gdi?.SetTextColor(wParam, id === ID_HINT ? TEXT_FAINT : TEXT_MAIN);
					return brushFor(CARD_BG) as unknown as Pointer;
				}
				case WM_DRAWITEM: {
					// 与主面板同款的自绘按钮：主选项白底品牌色描边，退出用红色实底。
					const item = readDrawItem(lParam);
					const spec = BUTTONS[item.controlId];
					if (!spec) return 0;
					const pressed = (item.itemState & ODS_SELECTED) !== 0;
					const focused = (item.itemState & ODS_FOCUS) !== 0;
					const hovered = controlIdAtCursor() === item.controlId;
					const highlighted = focused || hovered;
					const fill = spec.danger
						? pressed
							? DANGER_PRESSED
							: DANGER_COLOR
						: pressed
							? 0x00f2f0ee // #eef0f2
							: hovered
								? mixColor(CARD_BG, brandColorRef, 0.12) // 品牌浅色，悬停一眼可见
								: CARD_BG;
					// 危险按钮悬停/聚焦时用白描边（红底上更醒目），其余点亮品牌色。
					const border = spec.danger
						? highlighted
							? WHITE_REF
							: fill
						: spec.primary || highlighted
							? brandColorRef
							: NEUTRAL_BORDER;
					drawRoundedRect(item.hdc, item.rect, fill, border, 6);
					drawText(item.hdc, t(spec.key), item.rect, spec.danger ? WHITE_REF : TEXT_MAIN);
					return 1;
				}
				case WM_DESTROY: {
					closed = true;
					// 主窗口在对话框创建期间被禁用，无论以哪种方式结束都要恢复。
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

	const uiFont = createFont(13);
	const buttonFont = createFont(13, 600);

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

	add("STATIC", t("close.question"), 0x00000000, 0, 26, 22, DIALOG_WIDTH - 52, 36, uiFont);
	// 按钮排在复选框上方：最小化是主选项（品牌色边框），退出用红色警示。
	const buttonWidth = 108;
	const buttonY = 74;
	add(
		"BUTTON",
		t(BUTTONS[ID_MINIMIZE].key),
		BS_OWNERDRAW,
		ID_MINIMIZE,
		26,
		buttonY,
		buttonWidth,
		34,
		buttonFont,
	);
	add(
		"BUTTON",
		t(BUTTONS[ID_EXIT].key),
		BS_OWNERDRAW,
		ID_EXIT,
		26 + (buttonWidth + 12) * 1,
		buttonY,
		buttonWidth,
		34,
		buttonFont,
	);
	add(
		"BUTTON",
		t(BUTTONS[ID_CANCEL].key),
		BS_OWNERDRAW,
		ID_CANCEL,
		26 + (buttonWidth + 12) * 2,
		buttonY,
		buttonWidth,
		34,
		buttonFont,
	);
	checkbox = add(
		"BUTTON",
		t("close.remember"),
		BS_AUTOCHECKBOX,
		ID_CHECKBOX,
		26,
		124,
		340,
		22,
		uiFont,
	);
	add("STATIC", t("close.hint"), 0x00000000, ID_HINT, 26, 156, DIALOG_WIDTH - 52, 18, uiFont);

	enableWindow(owner, false);
	// 必须激活对话框：SW_SHOW 只显示不激活，用户第一次点击会被"激活窗口"吃掉，
	// 表现成按钮点不动。
	focusWindow(hwnd);

	// 只等状态：消息由主窗口的泵统一派发（双泵会互相抢消息，导致点击偶发丢失）。
	while (!closed) {
		await sleep(30);
	}
	// 每个窗口一个类，销毁后注销并释放 WndProc，否则下次打开会挂到旧回调上。
	dialog.dispose();
	// 对话框没有 owner 关系，销毁后焦点不会自动回到主窗口，不还给它会失焦被其他窗口遮挡；
	// 「最小化到托盘」的主窗口随后就要隐藏，不必也不该再抢一次焦点。（断言：TS 追踪不到
	// 闭包内对 result 的赋值。）
	const finished = result as CloseDialogResult | null;
	if (finished?.action !== "minimize") focusWindow(owner);

	return finished;
}
