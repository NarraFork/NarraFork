/**
 * 面板的配色与自绘绘制。
 *
 * Win32 的 COLORREF 是 0x00BBGGRR（与 #rrggbb 字节序相反），注释里都写对应的 CSS 色值。
 * 绘制函数不依赖控件状态：按钮外观由调用方传入的 spec 与品牌色决定。
 */

import {
	BANNER_HEIGHT,
	BUTTON_RADIUS,
	CARD_RADIUS,
	CARD_X,
	CONFIG_CARD_HEIGHT,
	CONFIG_CARD_TOP,
	type Layout,
} from "./layout";
import {
	drawRoundedRect,
	drawText,
	fillRect,
	makeRectOf,
	ODS_DISABLED,
	ODS_FOCUS,
	ODS_SELECTED,
	type Pointer,
	type readDrawItem,
} from "./win32";

/** 自绘按钮的外观规格。 */
export interface ButtonSpec {
	text: string;
	primary: boolean;
}

export const WINDOW_BG = 0x00f3f1f0; // #f0f1f3
export const CARD_BG = 0x00ffffff; // #ffffff
export const CARD_BORDER = 0x00e9e5e3; // #e3e5e9
export const TEXT_MAIN = 0x0028231f; // #1f2328
export const TEXT_MUTED = 0x0080726b; // #6b7280
export const TEXT_FAINT = 0x00a89f96; // #969fa8
export const WHITE_REF = 0x00ffffff;
export const BUTTON_BG = 0x00ffffff;
export const BUTTON_BG_PRESSED = 0x00f2f0ee; // #eef0f2
export const BUTTON_BG_HOVER = 0x00f7f5f3; // #f3f5f7
export const BUTTON_BORDER = 0x00ddd8d5; // #d5d8dd
export const BUTTON_TEXT = 0x006b635f; // #5f636b
export const DISABLED_BG = 0x00fafaf9; // #f9fafa
export const DISABLED_BORDER = 0x00eeedec; // #ecedee
export const DISABLED_TEXT = 0x00b8b3ae; // #aeb3b8
export const SUCCESS_COLOR = 0x00449e2f; // #2f9e44
export const WARNING_COLOR = 0x000f7fd4; // #d47f0f
export const DANGER_COLOR = 0x003131e0; // #e03131
export const DEFAULT_BRAND_COLOR = "#4c6ef5";
/** 实例显示名缺省值：前端页面标题用的就是它（branding.name 为空时）。 */
export const DEFAULT_BRAND_NAME = "NarraFork";

/** #rrggbb → COLORREF。 */
export function toColorRef(hex: string): number {
	const value = Number.parseInt(hex.replace("#", ""), 16);
	const r = (value >> 16) & 0xff;
	const g = (value >> 8) & 0xff;
	const b = value & 0xff;
	return (b << 16) | (g << 8) | r;
}

/** COLORREF → #rrggbb（toColorRef 的逆运算，用于把系统取色结果写回配置）。 */
export function fromColorRef(ref: number): string {
	const r = ref & 0xff;
	const g = (ref >> 8) & 0xff;
	const b = (ref >> 16) & 0xff;
	return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** 两色线性混合，t∈[0,1]。 */
export function mixColor(a: number, b: number, t: number): number {
	const ar = a & 0xff;
	const ag = (a >> 8) & 0xff;
	const ab = (a >> 16) & 0xff;
	const br = b & 0xff;
	const bg = (b >> 8) & 0xff;
	const bb = (b >> 16) & 0xff;
	const r = Math.round(ar + (br - ar) * t);
	const g = Math.round(ag + (bg - ag) * t);
	const bl = Math.round(ab + (bb - ab) * t);
	return (bl << 16) | (g << 8) | r;
}

export function normalizeBrandColor(raw: unknown): string {
	if (typeof raw !== "string") return DEFAULT_BRAND_COLOR;
	const trimmed = raw.trim();
	return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed) ? trimmed : DEFAULT_BRAND_COLOR;
}
/** 横向渐变横条：从品牌色渐变到与白色混合 35% 的浅色。32 档足够平滑且不会创建上百个画刷。 */
export function drawBanner(hdc: Pointer, width: number, base: number): void {
	const steps = 32;
	const light = mixColor(base, WHITE_REF, 0.35);
	const stepWidth = Math.ceil(width / steps);
	for (let step = 0; step < steps; step++) {
		const left = step * stepWidth;
		const right = Math.min(width, left + stepWidth);
		if (right <= left) break;
		fillRect(
			hdc,
			makeRectOf(left, 0, right, BANNER_HEIGHT),
			mixColor(base, light, step / (steps - 1)),
		);
	}
}

export function drawCards(hdc: Pointer, layout: Layout): void {
	drawRoundedRect(
		hdc,
		makeRectOf(
			CARD_X,
			CONFIG_CARD_TOP,
			CARD_X + layout.cardWidth,
			CONFIG_CARD_TOP + CONFIG_CARD_HEIGHT,
		),
		CARD_BG,
		CARD_BORDER,
		CARD_RADIUS,
	);
	drawRoundedRect(
		hdc,
		makeRectOf(
			CARD_X,
			layout.logCardTop,
			CARD_X + layout.cardWidth,
			layout.logCardTop + layout.logCardHeight,
		),
		CARD_BG,
		CARD_BORDER,
		CARD_RADIUS,
	);
}

/** 自绘按钮：白底描边（主按钮为品牌色实底），按下与禁用各有配色。 */
export function drawButton(
	item: ReturnType<typeof readDrawItem>,
	spec: ButtonSpec,
	brandColorRef: number,
	hovered = false,
): void {
	const disabled = (item.itemState & ODS_DISABLED) !== 0;
	const pressed = (item.itemState & ODS_SELECTED) !== 0;
	// 键盘焦点（Tab 遍历）与鼠标悬停都算"当前交互对象"。
	const focused = (item.itemState & ODS_FOCUS) !== 0;
	const highlighted = !disabled && (hovered || focused);
	// 主按钮悬停时"提亮"（品牌色混白），次按钮悬停时染一层品牌浅色并点亮边框 ——
	// 两者都要一眼可见，否则用户会以为按钮没有反馈。
	const fill = disabled
		? DISABLED_BG
		: pressed
			? spec.primary
				? mixColor(brandColorRef, 0x000000, 0.12)
				: BUTTON_BG_PRESSED
			: highlighted
				? spec.primary
					? mixColor(brandColorRef, 0x00ffffff, 0.18)
					: mixColor(0x00ffffff, brandColorRef, 0.12)
				: spec.primary
					? brandColorRef
					: BUTTON_BG;
	const border = disabled
		? DISABLED_BORDER
		: spec.primary
			? fill
			: highlighted
				? brandColorRef
				: BUTTON_BORDER;
	const textColor = spec.primary && !disabled ? WHITE_REF : disabled ? DISABLED_TEXT : BUTTON_TEXT;
	drawRoundedRect(item.hdc, item.rect, fill, border, BUTTON_RADIUS);
	drawText(item.hdc, spec.text, item.rect, textColor);
}
