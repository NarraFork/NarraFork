/**
 * 面板的尺寸与布局计算。
 *
 * 所有坐标都是客户区像素。最小窗口宽由按钮排反推，保证最小尺寸下四个按钮恰好占满；
 * 按钮用固定坐标布局，放大窗口不改变它们的尺寸。
 */

import { clientSize, type Pointer } from "./win32";

/** 控件标识：WM_COMMAND / WM_CTLCOLOR* / WM_DRAWITEM 都靠它区分控件。 */
export const ID = {
	bannerTitle: 101,
	bannerSubtitle: 102,
	statusDot: 103,
	statusText: 104,
	address: 105,
	start: 201,
	restart: 202,
	stop: 203,
	open: 204,
	settings: 205,
	ipLabel: 301,
	ipEdit: 302,
	portLabel: 303,
	portEdit: 304,
	save: 305,
	configTitle: 306,
	logTitle: 307,
	/** 日志被裁断后出现的"查看完整日志"按钮。 */
	openLogFile: 308,
	/** 在资源管理器中定位 server.log。 */
	serverLog: 309,
	logEdit: 401,
} as const;

export const BANNER_HEIGHT = 74;
export const CARD_X = 16;
export const CARD_RADIUS = 10;
export const BUTTON_RADIUS = 6;
export const CONFIG_CARD_TOP = 198;
export const CONFIG_CARD_HEIGHT = 98;
export const BUTTON_Y = 148;
/** 启动按钮要放下「启动 NarraFork 服务器」，其余按钮按各自文案收窄。 */
export const ACTION_WIDTHS = [172, 104, 104, 120, 64] as const;
export const BUTTON_WIDTH = ACTION_WIDTHS[0];
export const BUTTON_HEIGHT = 32;
export const BUTTON_GAP = 8;
/** 初始值；窗口缩放后由 computeLayout 重算。 */
export const LOG_CARD_TOP = CONFIG_CARD_TOP + CONFIG_CARD_HEIGHT + 14;
/** 最小窗口（客户区）刚好排下五个动作按钮。放大后按钮保持该尺寸。 */
export const MIN_WINDOW_WIDTH =
	CARD_X * 2 +
	ACTION_WIDTHS.reduce((sum, width) => sum + width, 0) +
	BUTTON_GAP * (ACTION_WIDTHS.length - 1);
/** 日志区需要一块固定高度；不再按 3:4 把窗口拉得比屏幕还高。 */
export const MIN_WINDOW_HEIGHT = 720;
export function buttonWidth(index: number): number {
	return ACTION_WIDTHS[index] ?? BUTTON_WIDTH;
}
/** 初始卡片宽：内容按最小窗口排版，创建后再由 computeLayout 跟随实际客户区。 */
export const CARD_WIDTH = MIN_WINDOW_WIDTH - 32;
/** IP 输入框的最小宽度；更宽由内容自适应（见 main.ts 的 ipEditWidth）。 */
export const IP_EDIT_MIN_WIDTH = 100;
export function buttonX(index: number): number {
	let x = CARD_X;
	for (let i = 0; i < index; i++) x += buttonWidth(i) + BUTTON_GAP;
	return x;
}

/** 窗口伸缩时只让日志卡与日志框跟随，其余元素保持设计位置（参考图本身就是固定列）。 */
export interface Layout {
	width: number;
	height: number;
	cardWidth: number;
	logCardTop: number;
	logCardHeight: number;
}

/** 尺寸全部由客户区推导：WM_PAINT、控件重排共用同一份，避免两处算错。 */
export function computeLayout(hwnd: Pointer): Layout {
	const size = clientSize(hwnd);
	const logCardTop = CONFIG_CARD_TOP + CONFIG_CARD_HEIGHT + 14;
	return {
		width: size.width,
		height: size.height,
		cardWidth: Math.max(360, size.width - 32),
		logCardTop,
		logCardHeight: Math.max(160, size.height - logCardTop - 16),
	};
}
