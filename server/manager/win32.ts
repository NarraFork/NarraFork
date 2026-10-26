/**
 * Windows 原生窗口与控件的 bun:ffi 封装（管理器专用）。
 *
 * 只覆盖管理器需要的最小子集，与 `server/lib/win-foreground.ts` 同一套模式：
 * dlopen + 显式 FFI 签名 + JSCallback。
 *
 * 消息循环必须用 PeekMessageW 轮询而不是 GetMessageW：后者会占住线程，Bun 的事件循环
 * （子进程日志、配置回显、托盘回调）就全停了。轮询间隔 50ms，开销可忽略。
 *
 * FFI 失败一律返回 undefined/false 而不是抛异常：面板少一块 UI 不该让服务起不来；
 * 调用方据返回值决定降级行为。
 */

import {
	dlopen,
	FFIType,
	JSCallback,
	type Pointer,
	read,
	toArrayBuffer,
	ptr as toPtr,
} from "bun:ffi";
import { existsSync } from "node:fs";
import { CHROMIUM_PATHS } from "@shared/browser-paths";
import {
	revealInFolder as revealInFolderWin,
	shellExecute as shellExecuteWin,
} from "../lib/shell-exec";

export type { Pointer };

/** 把指针、句柄或 TypedArray 统一写成结构体里的 64 位整数。 */
function ptrValue(value: unknown): bigint {
	if (value == null) return 0n;
	if (typeof value === "bigint") return value;
	if (typeof value === "number") return BigInt(value);
	if (ArrayBuffer.isView(value)) {
		return BigInt(toPtr(value as unknown as Uint8Array) as unknown as number);
	}
	return 0n;
}

// ── 窗口与控件样式 ──────────────────────────────────────────────────────────

export const WS_OVERLAPPEDWINDOW = 0x00cf0000;
export const WS_CAPTION = 0x00c00000;
export const WS_SYSMENU = 0x00080000;
export const WS_CHILD = 0x40000000;
export const WS_VISIBLE = 0x10000000;
export const WS_TABSTOP = 0x00010000;
export const WS_BORDER = 0x00800000;
export const WS_VSCROLL = 0x00200000;
export const WS_EX_CLIENTEDGE = 0x00000200;

export const ES_LEFT = 0x0000;
export const ES_MULTILINE = 0x0004;
export const ES_AUTOVSCROLL = 0x0040;
export const ES_AUTOHSCROLL = 0x0080;
export const ES_READONLY = 0x0800;
export const ES_NUMBER = 0x2000;

export const BS_PUSHBUTTON = 0x00000000;
/** 手动复选框：点击只发 BN_CLICKED，状态要父窗口自己切换。 */
export const BS_CHECKBOX = 0x00000002;
/** 自动复选框：点击由按钮类自行切换勾选状态（面板一律用这个）。 */
export const BS_AUTOCHECKBOX = 0x00000003;
/** 读取按钮/复选框的勾选状态（GET）。0x00F1 是 SETCHECK，写错会把状态改掉且读不到值。 */
export const BM_GETCHECK = 0x00f0;
export const BM_SETCHECK = 0x00f1;
export const BST_CHECKED = 0x0001;
export const BS_GROUPBOX = 0x00000007;
export const BS_LEFT = 0x0100;

/** 下拉框：只读列表（用户不能输入任意值），配合 CB_* 消息读写选项与选中项。 */
export const CBS_DROPDOWNLIST = 0x0003;
export const CB_ADDSTRING = 0x0143;
export const CB_GETCURSEL = 0x0147;
export const CB_SETCURSEL = 0x014e;

export const SS_LEFT = 0x00000000;

export const CW_USEDEFAULT = -2147483648;

// ── 消息 ────────────────────────────────────────────────────────────────────

export const WM_CREATE = 0x0001;
export const WM_DESTROY = 0x0002;
export const WM_SIZE = 0x0005;
export const WM_PAINT = 0x000f;
export const WM_CLOSE = 0x0010;
export const WM_ERASEBKGND = 0x0014;
export const WM_COMMAND = 0x0111;
export const WM_CTLCOLORSTATIC = 0x0138;
export const WM_CTLCOLOREDIT = 0x0133;
export const WM_SETFONT = 0x0030;
export const WM_SETICON = 0x0080;
export const WM_GETTEXT = 0x000d;
export const WM_GETTEXTLENGTH = 0x000e;
export const WM_SETTEXT = 0x000c;
export const WM_QUIT = 0x0012;
export const WM_APP = 0x8000;
export const WM_LBUTTONDBLCLK = 0x0203;
export const WM_RBUTTONUP = 0x0205;

export const SW_SHOW = 5;
export const SW_HIDE = 0;
export const SW_RESTORE = 9;

// ── FFI 装载 ────────────────────────────────────────────────────────────────

interface User32 {
	RegisterClassExW: (wndClass: Pointer) => number;
	UnregisterClassW: (className: Pointer, instance: Pointer) => number;
	CreateWindowExW: (
		exStyle: number,
		className: Pointer,
		windowName: Pointer,
		style: number,
		x: number,
		y: number,
		width: number,
		height: number,
		parent: Pointer,
		menu: Pointer,
		instance: Pointer,
		param: Pointer,
	) => Pointer;
	DestroyWindow: (hwnd: Pointer) => number;
	DefWindowProcW: (hwnd: Pointer, msg: number, wParam: number, lParam: number) => number;
	PeekMessageW: (
		message: Pointer,
		hwnd: Pointer,
		filterMin: number,
		filterMax: number,
		remove: number,
	) => number;
	TranslateMessage: (message: Pointer) => number;
	DispatchMessageW: (message: Pointer) => number;
	SendMessageW: (hwnd: Pointer, msg: number, wParam: Pointer, lParam: Pointer) => number;
	PostMessageW: (hwnd: Pointer, msg: number, wParam: number, lParam: number) => number;
	GetWindowTextW: (hwnd: Pointer, buffer: Pointer, max: number) => number;
	GetWindowTextLengthW: (hwnd: Pointer) => number;
	EnableWindow: (hwnd: Pointer, enable: number) => number;
	ShowWindow: (hwnd: Pointer, cmd: number) => number;
	UpdateWindow: (hwnd: Pointer) => number;
	InvalidateRect: (hwnd: Pointer, rect: Pointer, erase: number) => number;
	GetClientRect: (hwnd: Pointer, rect: Pointer) => number;
	GetWindowRect: (hwnd: Pointer, rect: Pointer) => number;
	IsWindow: (hwnd: Pointer) => number;
	IsWindowVisible: (hwnd: Pointer) => number;
	IsIconic: (hwnd: Pointer) => number;
	FindWindowW: (className: Pointer, windowName: Pointer) => Pointer;
	AdjustWindowRect: (rect: Pointer, style: number, menu: number) => number;
	SetForegroundWindow: (hwnd: Pointer) => number;
	CreateIconIndirect: (iconInfo: Pointer) => Pointer;
	SetFocus: (hwnd: Pointer) => Pointer;
	GetSystemMetrics: (index: number) => number;
	GetKeyState: (virtualKey: number) => number;
	LoadCursorW: (instance: Pointer, cursor: Pointer) => Pointer;
	LoadIconW: (instance: Pointer, icon: Pointer) => Pointer;
	MessageBoxW: (hwnd: Pointer, text: Pointer, caption: Pointer, type: number) => number;
	GetDlgCtrlID: (hwnd: Pointer) => number;
	CreatePopupMenu: () => Pointer;
	AppendMenuW: (menu: Pointer, flags: number, id: number, text: Pointer) => number;
	TrackPopupMenu: (
		menu: Pointer,
		flags: number,
		x: number,
		y: number,
		reserved: number,
		hwnd: Pointer,
		rect: Pointer,
	) => number;
	DestroyMenu: (menu: Pointer) => number;
	GetCursorPos: (point: Pointer) => number;
	WindowFromPoint: (point: Pointer) => Pointer;
	GetWindowLongW: (hwnd: Pointer, index: number) => number;
	DrawTextW: (hdc: Pointer, text: Pointer, length: number, rect: Pointer, format: number) => number;
	LoadImageW: (
		instance: Pointer,
		name: Pointer,
		type: number,
		width: number,
		height: number,
		flags: number,
	) => Pointer;
	BeginPaint: (hwnd: Pointer, paintStruct: Pointer) => Pointer;
	EndPaint: (hwnd: Pointer, paintStruct: Pointer) => number;
	FillRect: (hdc: Pointer, rect: Pointer, brush: Pointer) => number;
	MoveWindow: (
		hwnd: Pointer,
		x: number,
		y: number,
		width: number,
		height: number,
		repaint: number,
	) => number;
	SetProcessDPIAware: () => number;
	GetDC: (hwnd: Pointer) => Pointer;
	ReleaseDC: (hwnd: Pointer, hdc: Pointer) => number;
	RedrawWindow: (hwnd: Pointer, rect: Pointer, region: Pointer, flags: number) => number;
}

interface Gdi32 {
	CreateFontW: (
		height: number,
		width: number,
		escapement: number,
		orientation: number,
		weight: number,
		italic: number,
		underline: number,
		strikeOut: number,
		charSet: number,
		outPrecision: number,
		clipPrecision: number,
		quality: number,
		pitchAndFamily: number,
		faceName: Pointer,
	) => Pointer;
	CreateSolidBrush: (color: number) => Pointer;
	SetTextColor: (hdc: Pointer, color: number) => number;
	SetBkColor: (hdc: Pointer, color: number) => number;
	SetBkMode: (hdc: Pointer, mode: number) => number;
	GetStockObject: (index: number) => Pointer;
	GetDeviceCaps: (hdc: Pointer, index: number) => number;
	DeleteObject: (object: Pointer) => number;
	RoundRect: (
		hdc: Pointer,
		left: number,
		top: number,
		right: number,
		bottom: number,
		width: number,
		height: number,
	) => number;
	CreatePen: (style: number, width: number, color: number) => Pointer;
	SelectObject: (hdc: Pointer, object: Pointer) => Pointer;
	CreateBitmap: (
		width: number,
		height: number,
		planes: number,
		bitCount: number,
		bits: Pointer,
	) => Pointer;
	CreateDIBSection: (
		hdc: Pointer,
		bitmapInfo: Pointer,
		usage: number,
		bits: Pointer,
		section: Pointer,
		offset: number,
	) => Pointer;
}

interface Kernel32 {
	GetModuleHandleW: (name: Pointer) => Pointer;
	GetLastError: () => number;
	CreateMutexW: (attrs: Pointer, initialOwner: number, name: Pointer) => Pointer;
	CloseHandle: (handle: Pointer) => number;
	GetConsoleWindow: () => Pointer;
	LoadLibraryW: (name: Pointer) => Pointer;
	RtlMoveMemory: (destination: Pointer, source: Pointer, length: number) => void;
}

let user32: User32 | undefined;
let gdi32: Gdi32 | undefined;
let kernel32: Kernel32 | undefined;
let loadError: string | undefined;

/** 最近一次原生装载失败的原因（诊断用）。 */
export function nativeLoadError(): string | undefined {
	return loadError;
}

/** 只加载一次；任何一层缺失都让 isAvailable() 返回 false，调用方据此降级。 */
export function loadNative(): { user32: User32; gdi32: Gdi32; kernel32: Kernel32 } | undefined {
	if (user32 && gdi32 && kernel32) return { user32, gdi32, kernel32 };
	if (process.platform !== "win32") return undefined;
	try {
		user32 = dlopen("user32.dll", {
			RegisterClassExW: { args: [FFIType.ptr], returns: FFIType.u16 },
			UnregisterClassW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			CreateWindowExW: {
				args: [
					FFIType.u32,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.u32,
					FFIType.i32,
					FFIType.i32,
					FFIType.i32,
					FFIType.i32,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
				],
				returns: FFIType.ptr,
			},
			DestroyWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
			DefWindowProcW: {
				args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
				returns: FFIType.ptr,
			},
			PeekMessageW: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32],
				returns: FFIType.i32,
			},
			TranslateMessage: { args: [FFIType.ptr], returns: FFIType.i32 },
			DispatchMessageW: { args: [FFIType.ptr], returns: FFIType.ptr },
			SendMessageW: {
				args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
				returns: FFIType.ptr,
			},
			PostMessageW: {
				args: [FFIType.ptr, FFIType.u32, FFIType.i64, FFIType.i64],
				returns: FFIType.i32,
			},
			GetWindowTextW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			GetWindowTextLengthW: { args: [FFIType.ptr], returns: FFIType.i32 },
			EnableWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			UpdateWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
			InvalidateRect: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			GetClientRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			GetWindowRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			IsWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
			IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 },
			IsIconic: { args: [FFIType.ptr], returns: FFIType.i32 },
			FindWindowW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			AdjustWindowRect: { args: [FFIType.ptr, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
			SetForegroundWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
			CreateIconIndirect: { args: [FFIType.ptr], returns: FFIType.ptr },
			SetFocus: { args: [FFIType.ptr], returns: FFIType.ptr },
			GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
			GetKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
			LoadCursorW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			LoadIconW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			MessageBoxW: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32],
				returns: FFIType.i32,
			},
			GetDlgCtrlID: { args: [FFIType.ptr], returns: FFIType.i32 },
			CreatePopupMenu: { args: [], returns: FFIType.ptr },
			AppendMenuW: {
				args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
				returns: FFIType.i32,
			},
			TrackPopupMenu: {
				args: [
					FFIType.ptr,
					FFIType.u32,
					FFIType.i32,
					FFIType.i32,
					FFIType.i32,
					FFIType.ptr,
					FFIType.ptr,
				],
				returns: FFIType.i32,
			},
			DestroyMenu: { args: [FFIType.ptr], returns: FFIType.i32 },
			GetCursorPos: { args: [FFIType.ptr], returns: FFIType.i32 },
			// POINT 是按值传递的结构体（x64 下装进一个寄存器）：用 i64 传打包坐标，
			// 声明成指针会把坐标值当地址解引用，永远找不到窗口。
			WindowFromPoint: { args: [FFIType.i64], returns: FFIType.ptr },
			GetWindowLongW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			SetProcessDPIAware: { args: [], returns: FFIType.i32 },
			GetDC: { args: [FFIType.ptr], returns: FFIType.ptr },
			ReleaseDC: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			RedrawWindow: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32],
				returns: FFIType.i32,
			},
			DrawTextW: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
				returns: FFIType.i32,
			},
			LoadImageW: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32],
				returns: FFIType.ptr,
			},
			BeginPaint: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			EndPaint: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			FillRect: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			MoveWindow: {
				args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32],
				returns: FFIType.i32,
			},
		}).symbols as unknown as User32;

		gdi32 = dlopen("gdi32.dll", {
			CreateFontW: {
				args: [
					FFIType.i32,
					FFIType.i32,
					FFIType.i32,
					FFIType.i32,
					FFIType.i32,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.ptr,
				],
				returns: FFIType.ptr,
			},
			CreateSolidBrush: { args: [FFIType.u32], returns: FFIType.ptr },
			SetTextColor: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
			SetBkColor: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
			SetBkMode: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			GetStockObject: { args: [FFIType.i32], returns: FFIType.ptr },
			GetDeviceCaps: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			DeleteObject: { args: [FFIType.ptr], returns: FFIType.i32 },
			RoundRect: {
				args: [
					FFIType.ptr,
					FFIType.i32,
					FFIType.i32,
					FFIType.i32,
					FFIType.i32,
					FFIType.i32,
					FFIType.i32,
				],
				returns: FFIType.i32,
			},
			CreatePen: { args: [FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
			SelectObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			CreateBitmap: {
				args: [FFIType.i32, FFIType.i32, FFIType.u32, FFIType.u32, FFIType.ptr],
				returns: FFIType.ptr,
			},
			CreateDIBSection: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32],
				returns: FFIType.ptr,
			},
		}).symbols as unknown as Gdi32;

		kernel32 = dlopen("kernel32.dll", {
			GetModuleHandleW: { args: [FFIType.ptr], returns: FFIType.ptr },
			GetLastError: { args: [], returns: FFIType.u32 },
			CreateMutexW: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
			CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
			GetConsoleWindow: { args: [], returns: FFIType.ptr },
			LoadLibraryW: { args: [FFIType.ptr], returns: FFIType.ptr },
			RtlMoveMemory: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
				returns: FFIType.void,
			},
		}).symbols as unknown as Kernel32;

		return { user32, gdi32, kernel32 };
	} catch (error) {
		loadError = error instanceof Error ? error.message : String(error);
		user32 = undefined;
		gdi32 = undefined;
		kernel32 = undefined;
		return undefined;
	}
}

export function isNativeAvailable(): boolean {
	return loadNative() !== undefined;
}

// ── DPI 缩放 ────────────────────────────────────────────────────────────────

/**
 * DPI 缩放因子（1.0 = 96 DPI）。
 *
 * SetProcessDPIAware 之后窗口与字体都以物理像素计；为在 125% / 150% / 200% 等高 DPI
 * 屏幕上保持同样的视觉大小，所有界面坐标在 API 边界统一乘以该因子，clientSize 反向
 * 除以它 —— 调用方始终工作在"逻辑像素"上，布局常量无需感知 DPI。
 */
let dpiScale = 1;

/** 读取主屏 DPI 并更新缩放因子；createWindow 时自动调用一次。 */
function refreshDpiScale(): void {
	const native = loadNative();
	if (!native) return;
	const hdc = native.user32.GetDC(0 as unknown as Pointer);
	if (!hdc) return;
	const dpi = native.gdi32.GetDeviceCaps(hdc, 88 /* LOGPIXELSX */);
	native.user32.ReleaseDC(0 as unknown as Pointer, hdc);
	dpiScale = dpi > 0 ? dpi / 96 : 1;
}

/**
 * 当前生效的缩放因子。
 *
 * NARRAFORK_MANAGER_DPI_SCALE 可强制覆盖，供标准 DPI 机器上验证高 DPI 布局
 * （例如 =1.5 模拟 150%）。
 */
export function currentDpiScale(): number {
	const override = Number(process.env.NARRAFORK_MANAGER_DPI_SCALE);
	if (Number.isFinite(override) && override > 0) return override;
	return dpiScale;
}

/** 逻辑像素 → 物理像素。 */
function px(value: number): number {
	return Math.round(value * currentDpiScale());
}

// ── 字符串与内存 ────────────────────────────────────────────────────────────

/**
 * 传给 Win32 的缓冲区必须活到调用返回之后（窗口类名、菜单名会被系统长期引用），所以统一
 * 登记在模块级数组里保留。只用于创建期等低频调用 —— 高频路径（重绘、日志、SetWindowText）
 * 一律用 wstrTemp：同步 API 返回时系统已复制内容，登记保留只会让内存随时间增长。
 */
const retained: Buffer[] = [];

/** UTF-16LE 文本指针，内容登记保留（窗口类名等长期引用的字符串用）。 */
export function wstr(text: string): Pointer {
	const buffer = Buffer.from(`${text}\0`, "utf16le");
	retained.push(buffer);
	return toPtr(buffer);
}

/** UTF-16LE 文本指针，不登记保留：仅用于调用返回前就会复制文本的同步 API。 */
function wstrTemp(text: string): Pointer {
	return toPtr(Buffer.from(`${text}\0`, "utf16le"));
}

/** 读回控件的 UTF-16 文本。 */
export function readWstr(hwnd: Pointer, maxChars = 512): string {
	const native = loadNative();
	if (!native) return "";
	const buffer = Buffer.alloc(maxChars * 2);
	const length = native.user32.GetWindowTextW(hwnd, toPtr(buffer), maxChars);
	if (length <= 0) return "";
	return buffer.subarray(0, length * 2).toString("utf16le");
}

/** 16 字节 RECT，供 GetClientRect / FillRect 使用。 */
export function makeRect(): Buffer {
	return Buffer.alloc(16);
}

export function readRect(buffer: Buffer): {
	left: number;
	top: number;
	right: number;
	bottom: number;
} {
	return {
		left: buffer.readInt32LE(0),
		top: buffer.readInt32LE(4),
		right: buffer.readInt32LE(8),
		bottom: buffer.readInt32LE(12),
	};
}

// ── 窗口与控件 ──────────────────────────────────────────────────────────────

/** 消息结构的原始内存：MSG 在 x64 上共 48 字节，前 8 字节是 hwnd。 */
export function makeMessageBuffer(): Buffer {
	const buffer = Buffer.alloc(64);
	// PeekMessageW 只写实际用到的前 48 字节，多分配几字节防止越界。
	return buffer;
}

export interface WindowOptions {
	title: string;
	className: string;
	/** 客户区尺寸（不含标题栏与边框）：内容按此布局，外框由系统按样式换算。 */
	width: number;
	height: number;
	/** 默认 true；false 时去掉可缩放边框，窗口尺寸固定（对话框用）。 */
	resizable?: boolean;
	/** 默认 true；false 时创建为隐藏窗口，由调用方决定何时显示（避免启动时先闪一下）。 */
	visible?: boolean;
	/** owner 窗口：owned 窗口由系统保证永远显示在它之上（模态对话框用）。 */
	owner?: Pointer;
	/** 收到 WM_CLOSE 时的处理；未提供则走默认销毁（对话框点 X 即取消）。 */
	onClose?: () => void;
	onMessage: (
		hwnd: Pointer,
		msg: number,
		wParam: Pointer,
		lParam: Pointer,
	) => Pointer | number | undefined;
}

export interface NativeWindow {
	hwnd: Pointer;
	instance: Pointer;
	/** 排空一次消息队列，返回 false 表示收到 WM_QUIT。 */
	pump(): boolean;
	/** 注销窗口类并释放 WndProc 回调；窗口销毁后必须调用，否则重开同类窗口会挂到旧回调。 */
	dispose(): void;
}

/** 窗口类名唯一化计数：同名类重复注册会失败，而失败时新窗口仍会挂到旧类的 WndProc 上。 */
let windowClassSeq = 0;

export function createWindow(options: WindowOptions): NativeWindow | undefined {
	const native = loadNative();
	if (!native) return undefined;
	const { user32, gdi32, kernel32 } = native;

	const instance = kernel32.GetModuleHandleW(0 as unknown as Pointer);
	if (!instance) return undefined;

	// 声明进程 DPI 感知：否则系统会虚拟化缩放，客户区像素尺寸与控件坐标对不上，布局会错位。
	user32.SetProcessDPIAware();
	// 感知生效后读取真实 DPI，后续所有界面坐标按此缩放。
	refreshDpiScale();

	const wndProc = new JSCallback(
		(hwnd: Pointer | null, msg: number, wParam: Pointer, lParam: Pointer): Pointer | number => {
			if (hwnd == null) return 0;
			if (msg === WM_CLOSE && options.onClose) {
				options.onClose();
				return 0;
			}
			const handled = options.onMessage(hwnd, msg, wParam, lParam);
			if (handled !== undefined) return handled;
			return user32.DefWindowProcW(hwnd, msg, wParam, lParam);
		},
		{ args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	);

	// 类名带上序号：同名类第二次注册会失败，而失败后 CreateWindowExW 仍会成功，
	// 结果是新窗口的消息全部落进旧窗口的 WndProc（旧闭包状态），新闭包永远等不到消息。
	const className = wstr(`${options.className}#${++windowClassSeq}`);
	const wndClass = Buffer.alloc(80);
	wndClass.writeUInt32LE(80, 0); // cbSize
	wndClass.writeUInt32LE(0x0002 | 0x0001, 4); // CS_HREDRAW | CS_VREDRAW
	wndClass.writeBigUInt64LE(ptrValue(wndProc.ptr), 8); // lpfnWndProc
	wndClass.writeUInt32LE(0, 16); // cbClsExtra
	wndClass.writeUInt32LE(0, 20); // cbWndExtra
	wndClass.writeBigUInt64LE(ptrValue(instance), 24); // hInstance
	wndClass.writeBigUInt64LE(0n, 32); // hIcon：顶层窗口用 exe 资源图标
	wndClass.writeBigUInt64LE(
		ptrValue(user32.LoadCursorW(0 as unknown as Pointer, 32512 as unknown as Pointer)),
		40,
	); // IDC_ARROW
	wndClass.writeBigUInt64LE(ptrValue(gdi32.GetStockObject(4)), 48); // COLOR_WINDOW brush
	wndClass.writeBigUInt64LE(0n, 56); // lpszMenuName
	wndClass.writeBigUInt64LE(ptrValue(className), 64); // lpszClassName
	wndClass.writeBigUInt64LE(0n, 72); // hIconSm
	retained.push(wndClass);

	if (!user32.RegisterClassExW(toPtr(wndClass))) {
		// 已注册（同一进程重复创建）也算可用：继续建窗口。
		console.error(
			`[manager] RegisterClassExW 失败 class=${options.className} err=${kernel32.GetLastError()}`,
		);
	}

	// options.width/height 是客户区尺寸：内容按它布局，窗口外框由样式换算，
	// 否则标题栏和边框会把内容挤出可视区（弹窗/面板尺寸与背景对不上的根源）。
	const style = options.resizable === false ? WS_CAPTION | WS_SYSMENU : WS_OVERLAPPEDWINDOW;
	const frame = makeRect();
	frame.writeInt32LE(0, 0);
	frame.writeInt32LE(0, 4);
	frame.writeInt32LE(px(options.width), 8);
	frame.writeInt32LE(px(options.height), 12);
	user32.AdjustWindowRect(toPtr(frame), style, 0);
	const frameRect = readRect(frame);
	const windowWidth = frameRect.right - frameRect.left;
	const windowHeight = frameRect.bottom - frameRect.top;

	const screenWidth = user32.GetSystemMetrics(0);
	const screenHeight = user32.GetSystemMetrics(1);
	// 有 owner 时居中于 owner（对话框贴着它出现），否则居中于屏幕。
	let anchorX = Math.floor(screenWidth / 2);
	let anchorY = Math.floor(screenHeight / 3);
	if (options.owner) {
		const ownerRect = makeRect();
		if (user32.GetWindowRect(options.owner, toPtr(ownerRect))) {
			const rect = readRect(ownerRect);
			anchorX = Math.floor((rect.left + rect.right) / 2);
			anchorY = Math.floor((rect.top + rect.bottom) / 2);
		}
	}
	const x = Math.max(0, anchorX - Math.floor(windowWidth / 2));
	const y = Math.max(0, anchorY - Math.floor(windowHeight / 2));

	const hwnd = user32.CreateWindowExW(
		0,
		className,
		wstrTemp(options.title),
		options.visible === false ? style : style | WS_VISIBLE,
		x,
		y,
		windowWidth,
		windowHeight,
		options.owner ?? (0 as unknown as Pointer),
		0 as unknown as Pointer,
		instance,
		0 as unknown as Pointer,
	);
	if (!hwnd) {
		console.error(
			`[manager] CreateWindowExW 失败 class=${options.className} style=0x${style.toString(16)} size=${windowWidth}x${windowHeight} err=${kernel32.GetLastError()}`,
		);
		wndProc.close();
		return undefined;
	}

	const message = makeMessageBuffer();
	return {
		hwnd,
		instance,
		pump(): boolean {
			// PM_REMOVE = 1：取走消息；每次最多排空 64 条，避免长队列饿死事件循环。
			// 不过滤 hwnd：对话框等子窗口的消息也由这一个泵派发；WM_QUIT 是线程消息，
			// 带窗口过滤时会被 PeekMessage 挡住，导致退出信号永远到不了调用方。
			for (let i = 0; i < 64; i++) {
				if (!user32.PeekMessageW(toPtr(message), 0 as unknown as Pointer, 0, 0, 1)) return true;
				const msg = message.readUInt32LE(8);
				if (msg === WM_QUIT) return false;
				user32.TranslateMessage(toPtr(message));
				user32.DispatchMessageW(toPtr(message));
			}
			return true;
		},
		dispose(): void {
			user32.UnregisterClassW(className, instance);
			wndProc.close();
		},
	};
}

export interface ControlOptions {
	parent: Pointer;
	className: string;
	text: string;
	style: number;
	exStyle?: number;
	id: number;
	x: number;
	y: number;
	width: number;
	height: number;
	instance: Pointer;
	font?: Pointer;
}

/** 创建子控件；失败返回 undefined（调用方跳过后续对该控件的操作）。 */
export function createControl(options: ControlOptions): Pointer | undefined {
	const native = loadNative();
	if (!native) return undefined;
	const hwnd = native.user32.CreateWindowExW(
		options.exStyle ?? 0,
		wstr(options.className),
		wstrTemp(options.text),
		WS_CHILD | WS_VISIBLE | options.style,
		px(options.x),
		px(options.y),
		px(options.width),
		px(options.height),
		options.parent,
		options.id as unknown as Pointer,
		options.instance,
		0 as unknown as Pointer,
	);
	if (!hwnd) return undefined;
	if (options.font) setFont(hwnd, options.font);
	return hwnd;
}

export function setFont(hwnd: Pointer, font: Pointer): void {
	const native = loadNative();
	if (!native) return;
	native.user32.SendMessageW(hwnd, WM_SETFONT, font, 1 as unknown as Pointer);
}

/** 创建 UI 字体（负高度表示按像素高度）。 */
export function createFont(
	sizePx: number,
	weight = 400,
	faceName = "Microsoft YaHei UI",
	italic = false,
): Pointer | undefined {
	const native = loadNative();
	if (!native) return undefined;
	return native.gdi32.CreateFontW(
		// 负高度 = 字符高度；按 DPI 缩放保持高分辨率屏幕上的可读性。
		-px(sizePx),
		0,
		0,
		0,
		weight,
		italic ? 1 : 0,
		0,
		0,
		1, // DEFAULT_CHARSET
		0,
		0,
		5, // CLEARTYPE_QUALITY
		0,
		wstrTemp(faceName),
	);
}

export function setText(hwnd: Pointer | undefined, text: string): void {
	const native = loadNative();
	if (!native || !hwnd) return;
	native.user32.SendMessageW(hwnd, WM_SETTEXT, 0 as unknown as Pointer, wstrTemp(text));
}

export function setEnabled(hwnd: Pointer | undefined, enabled: boolean): void {
	const native = loadNative();
	if (!native || !hwnd) return;
	native.user32.EnableWindow(hwnd, enabled ? 1 : 0);
}

export function showWindow(hwnd: Pointer, cmd: number): void {
	const native = loadNative();
	if (!native) return;
	native.user32.ShowWindow(hwnd, cmd);
}

/** 前置窗口并聚焦。只在最小化时唤出；唤出用 SW_RESTORE 恢复"最小化前的状态"（从最大化
 *  最小化的窗口回到最大化、普通状态回到普通），不会改变窗口尺寸；非最小化窗口只做前置，
 *  因为 SW_RESTORE 对最大化窗口会把它还原成普通尺寸。 */
export function focusWindow(hwnd: Pointer): void {
	const native = loadNative();
	if (!native) return;
	if (native.user32.IsIconic(hwnd)) native.user32.ShowWindow(hwnd, SW_RESTORE);
	native.user32.SetForegroundWindow(hwnd);
	native.user32.SetFocus(hwnd);
}

/** 按标题找顶层窗口；找不到返回 null。隐藏窗口也能找到，本函数不改变它的可见性。 */
export function findWindowByTitle(title: string): Pointer | null {
	const native = loadNative();
	if (!native) return null;
	const hwnd = native.user32.FindWindowW(0 as unknown as Pointer, wstrTemp(title));
	return hwnd ? hwnd : null;
}

/** 按标题找顶层窗口并前置它；找不到返回 false。 */
export function focusWindowByTitle(title: string): boolean {
	const native = loadNative();
	const hwnd = findWindowByTitle(title);
	if (!native || !hwnd) return false;
	// 只唤出最小化的窗口（恢复其最小化前的状态）；非最小化的一律只前置，不碰尺寸。
	if (native.user32.IsIconic(hwnd)) native.user32.ShowWindow(hwnd, SW_RESTORE);
	native.user32.SetForegroundWindow(hwnd);
	return true;
}

/** GetLastError 的 ERROR_ALREADY_EXISTS：命名互斥体已被其他实例持有。 */
const ERROR_ALREADY_EXISTS = 183;

/** Shift 键当前是否按下（在点击消息处理时读取，对应点击那一刻的状态）。 */
export function isShiftPressed(): boolean {
	const native = loadNative();
	if (!native) return false;
	const VK_SHIFT = 0x10;
	// 高位置 1 表示按下。
	return (native.user32.GetKeyState(VK_SHIFT) & 0x8000) !== 0;
}

/**
 * 取得单实例互斥体；返回 false 表示已有管理器实例在运行。
 *
 * 句柄故意不关闭：进程退出由系统回收，持有它才是整个进程生命周期内"单实例"的依据。
 */
/** 本进程持有的单实例互斥体句柄；让位给新版本面板时关闭。 */
let singleInstanceMutex: Pointer | undefined;

export function acquireSingleInstanceMutex(name: string): boolean {
	const native = loadNative();
	if (!native) return true; // 非原生环境不限制。
	const handle = native.kernel32.CreateMutexW(0 as unknown as Pointer, 0, wstr(name));
	if (!handle) return true; // 创建失败不阻塞启动。
	if (native.kernel32.GetLastError() === ERROR_ALREADY_EXISTS) {
		// 打开的是别人的互斥体：必须关掉，否则这个句柄会让它在对方释放后继续存在，重试永远失败。
		native.kernel32.CloseHandle(handle);
		return false;
	}
	singleInstanceMutex = handle;
	return true;
}

/** 释放单实例互斥体，让新版本面板可以接手。 */
export function releaseSingleInstanceMutex(): void {
	const native = loadNative();
	if (!native || !singleInstanceMutex) return;
	native.kernel32.CloseHandle(singleInstanceMutex);
	singleInstanceMutex = undefined;
}

export function isWindow(hwnd: Pointer): boolean {
	const native = loadNative();
	if (!native) return false;
	return native.user32.IsWindow(hwnd) !== 0;
}

/** 读取复选框的勾选状态。 */
/** 下拉框：追加一个选项，返回其序号（失败为 -1）。 */
export function comboBoxAddItem(hwnd: Pointer | undefined, text: string): number {
	const native = loadNative();
	if (!native || !hwnd) return -1;
	return native.user32.SendMessageW(hwnd, CB_ADDSTRING, 0 as unknown as Pointer, wstrTemp(text));
}

/** 选中下拉框第 index 项；-1 表示清空选择。 */
export function comboBoxSelect(hwnd: Pointer | undefined, index: number): void {
	const native = loadNative();
	if (!native || !hwnd) return;
	native.user32.SendMessageW(
		hwnd,
		CB_SETCURSEL,
		index as unknown as Pointer,
		0 as unknown as Pointer,
	);
}

/** 下拉框当前选中的序号；无选择时为 -1。 */
export function comboBoxSelected(hwnd: Pointer | undefined): number {
	const native = loadNative();
	if (!native || !hwnd) return -1;
	// SendMessageW 按指针返回：选中第 0 项时原始值 0 会被 Bun 转成 null，不归一化的话
	// "选第一项"会被当成读不到选择（语言改不回中文就是这么来的）。
	const selected = native.user32.SendMessageW(
		hwnd,
		CB_GETCURSEL,
		0 as unknown as Pointer,
		0 as unknown as Pointer,
	);
	if (selected == null) return 0;
	const value = Number(selected);
	// 未选中时 Win32 返回 -1，按指针返回时可能变成无符号最大值。
	return value === 0xffffffff ? -1 : value;
}

export function isChecked(hwnd: Pointer | undefined): boolean {
	const native = loadNative();
	if (!native || !hwnd) return false;
	return (
		Number(
			native.user32.SendMessageW(
				hwnd,
				BM_GETCHECK,
				0 as unknown as Pointer,
				0 as unknown as Pointer,
			),
		) === BST_CHECKED
	);
}

/** 设置复选框勾选状态：创建后要用已保存的偏好回显，否则每次打开都是默认未勾选。 */
export function checkBoxSetChecked(hwnd: Pointer | undefined, checked: boolean): void {
	const native = loadNative();
	if (!native || !hwnd) return;
	native.user32.SendMessageW(
		hwnd,
		BM_SETCHECK,
		(checked ? BST_CHECKED : 0) as unknown as Pointer,
		0 as unknown as Pointer,
	);
}

/** 标记窗口需要重绘；erase 为 true 时先擦背景，自绘控件应传 false（擦除会造成闪烁）。 */
export function invalidate(hwnd: Pointer | undefined, erase = true): void {
	const native = loadNative();
	if (!native || !hwnd) return;
	native.user32.InvalidateRect(hwnd, null as unknown as Pointer, erase ? 1 : 0);
}

/** 是否 owner-draw 按钮：悬停高亮只对这类控件有意义，其它控件不必跟着重绘。 */
export function isOwnerDrawButton(hwnd: Pointer | undefined): boolean {
	const native = loadNative();
	if (!native || !hwnd) return false;
	// GWL_STYLE = -16
	return (native.user32.GetWindowLongW(hwnd, -16) & BS_OWNERDRAW) !== 0;
}

export function destroyWindow(hwnd: Pointer): void {
	const native = loadNative();
	if (!native) return;
	native.user32.DestroyWindow(hwnd);
}

export function enableWindow(hwnd: Pointer | undefined, enabled: boolean): void {
	const native = loadNative();
	if (!native || !hwnd) return;
	native.user32.EnableWindow(hwnd, enabled ? 1 : 0);
}

export function postMessage(hwnd: Pointer, msg: number, wParam = 0, lParam = 0): void {
	const native = loadNative();
	if (!native) return;
	native.user32.PostMessageW(hwnd, msg, wParam, lParam);
}

/** 用系统默认程序打开 URL 或文件：复用 server 侧实现（其内部走 ShellExecuteW，无中间控制台进程）。 */
export function openExternal(url: string): boolean {
	return shellExecuteWin(url);
}

/** 在资源管理器中选中文件。 */
export function revealInFolder(filePath: string): boolean {
	return revealInFolderWin(filePath);
}

/**
 * 打开前端面板：优先 Chromium 的 --app 窗口。
 *
 * 同一 URL 再次启动 --app 时会交给已运行的浏览器会话去聚焦既有窗口，而不是新建标签页 ——
 * 满足"再次打开应聚焦已有面板"的诉求。用绝对路径直启：`cmd start msedge` 在 msedge 不在
 * PATH 时会静默失败。都没装则回落默认浏览器。
 */
export function openWebPanel(url: string, forceNewWindow = false): void {
	const browser = CHROMIUM_PATHS.find((path) => existsSync(path));
	if (!browser) {
		openExternal(url);
		return;
	}
	// --new-window 让同 URL 也开新窗口（否则 Chromium 会把 --app 复用为聚焦已有窗口）。
	const args = forceNewWindow
		? [browser, "--new-window", `--app=${url}`]
		: [browser, `--app=${url}`];
	try {
		Bun.spawn(args, {
			windowsHide: true,
			stdout: "ignore",
			stderr: "ignore",
		});
	} catch {
		openExternal(url);
	}
}

export function messageBox(hwnd: Pointer, text: string, caption: string, type: number): number {
	const native = loadNative();
	if (!native) return 0;
	return native.user32.MessageBoxW(hwnd, wstrTemp(text), wstrTemp(caption), type);
}

/** CHOOSECOLORW 在 x64 下的固定大小与标志位。 */
const CHOOSECOLOR_SIZE = 72;
const CC_RGBINIT = 0x00000001;
const CC_FULLOPEN = 0x00000002;

let comdlg: { ChooseColorW: (params: Pointer) => number } | undefined;

function loadComDlg(): typeof comdlg {
	if (comdlg) return comdlg;
	if (process.platform !== "win32") return undefined;
	try {
		const loaded = dlopen("comdlg32.dll", {
			ChooseColorW: { args: [FFIType.ptr], returns: FFIType.i32 },
		}).symbols as unknown as typeof comdlg;
		comdlg = loaded;
	} catch {
		comdlg = undefined;
	}
	return comdlg;
}

/**
 * 打开系统颜色选择对话框，返回选中的颜色（COLORREF）；用户取消时为 undefined。
 *
 * CHOOSECOLORW 是固定布局的结构体，必须按 x64 偏移逐字段写入；lpCustColors 指向
 * 一块 16 个 COLORREF 的缓冲，由调用方跨次持有以保留用户的最近自定义色。
 */
export function chooseColor(
	owner: Pointer | undefined,
	initialRef: number,
	customColors: Buffer,
): number | undefined {
	const lib = loadComDlg();
	if (!lib) return undefined;
	const frame = Buffer.alloc(CHOOSECOLOR_SIZE);
	frame.writeUInt32LE(CHOOSECOLOR_SIZE, 0); // lStructSize
	frame.writeBigUInt64LE(ptrValue(owner), 8); // hwndOwner
	frame.writeUInt32LE(initialRef >>> 0, 24); // rgbResult（初值）
	frame.writeBigUInt64LE(ptrValue(toPtr(customColors)), 32); // lpCustColors
	frame.writeUInt32LE(CC_RGBINIT | CC_FULLOPEN, 40); // Flags
	if (!lib.ChooseColorW(toPtr(frame))) return undefined;
	return frame.readUInt32LE(24);
}

export function clientSize(hwnd: Pointer): { width: number; height: number } {
	const native = loadNative();
	if (!native) return { width: 0, height: 0 };
	const rect = makeRect();
	if (!native.user32.GetClientRect(hwnd, toPtr(rect))) return { width: 0, height: 0 };
	const size = readRect(rect);
	// 除以缩放因子：调用方看到的始终是逻辑像素。
	const scale = currentDpiScale();
	return {
		width: Math.round((size.right - size.left) / scale),
		height: Math.round((size.bottom - size.top) / scale),
	};
}

/** 从 exe 资源加载图标（--windows-icon 写入的资源 id 为 1）；资源缺失时回退系统默认
 * 应用图标 —— 托盘图标必须非空才能挂载，缺图标会让关闭逻辑退化。 */
export function loadAppIcon(instance: Pointer): Pointer | undefined {
	const native = loadNative();
	if (!native) return undefined;
	const icon = native.user32.LoadIconW(instance, 1 as unknown as Pointer);
	if (icon) return icon;
	return native.user32.LoadIconW(0 as unknown as Pointer, 32512 as unknown as Pointer) ?? undefined; // IDI_APPLICATION
}

/**
 * 用 RGBA 像素构造方形 HICON（如 32x32），不需要 .ico 文件 —— 运行时按主题色生成图标。
 *
 * 32bpp 顶向下 DIB + 全零掩码：现代 Windows 用颜色位图的 alpha 通道做透明，掩码只保证
 * 旧路径不出现黑底。位图句柄在图标构造后即可释放（系统已复制内容）。
 */
export function createIconFromRgba(size: number, rgba: Uint8Array): Pointer | undefined {
	const native = loadNative();
	if (!native) return undefined;
	if (size <= 0 || rgba.length < size * size * 4) return undefined;

	// BITMAPINFOHEADER：负高度 = top-down，行序与 RGBA 缓冲一致。
	const header = Buffer.alloc(40);
	header.writeUInt32LE(40, 0);
	header.writeInt32LE(size, 4);
	header.writeInt32LE(-size, 8);
	header.writeUInt16LE(1, 12);
	header.writeUInt16LE(32, 14);
	header.writeUInt32LE(0, 16); // BI_RGB
	header.writeUInt32LE(size * size * 4, 20);

	const bitsHolder = Buffer.alloc(8);
	const colorBitmap = native.gdi32.CreateDIBSection(
		0 as unknown as Pointer,
		toPtr(header),
		0, // DIB_RGB_COLORS
		toPtr(bitsHolder),
		0 as unknown as Pointer,
		0,
	);
	if (!colorBitmap) return undefined;
	const bits = bitsHolder.readBigUInt64LE(0);
	if (!bits) {
		native.gdi32.DeleteObject(colorBitmap);
		return undefined;
	}

	// RGBA → 32bpp DIB 的 BGRA。
	const target = new Uint8Array(toArrayBuffer(Number(bits), 0, size * size * 4));
	for (let i = 0; i < size * size; i += 1) {
		target[i * 4] = rgba[i * 4 + 2];
		target[i * 4 + 1] = rgba[i * 4 + 1];
		target[i * 4 + 2] = rgba[i * 4];
		target[i * 4 + 3] = rgba[i * 4 + 3];
	}

	// 掩码显式清零（CreateBitmap 不保证零初始化）：透明度由颜色位图的 alpha 承担。
	const maskStride = Math.floor((size + 15) / 16) * 2;
	const maskBitmap = native.gdi32.CreateBitmap(
		size,
		size,
		1,
		1,
		toPtr(new Uint8Array(maskStride * size)),
	);
	if (!maskBitmap) {
		native.gdi32.DeleteObject(colorBitmap);
		return undefined;
	}

	// ICONINFO（x64）：fIcon(0) xHotspot(4) yHotspot(8) pad(12) hbmMask(16) hbmColor(24)。
	const info = Buffer.alloc(32);
	info.writeInt32LE(1, 0);
	info.writeBigUInt64LE(ptrValue(maskBitmap), 16);
	info.writeBigUInt64LE(ptrValue(colorBitmap), 24);
	const icon = native.user32.CreateIconIndirect(toPtr(info));
	native.gdi32.DeleteObject(maskBitmap);
	native.gdi32.DeleteObject(colorBitmap);
	return icon ?? undefined;
}

export function paintBegin(hwnd: Pointer): { hdc: Pointer; paintStruct: Buffer } | undefined {
	const native = loadNative();
	if (!native) return undefined;
	const paintStruct = Buffer.alloc(72);
	const hdc = native.user32.BeginPaint(hwnd, toPtr(paintStruct));
	if (!hdc) return undefined;
	return { hdc, paintStruct };
}

export function paintEnd(hwnd: Pointer, paintStruct: Buffer): void {
	const native = loadNative();
	if (!native) return;
	native.user32.EndPaint(hwnd, toPtr(paintStruct));
}

export function fillRect(hdc: Pointer, rect: Buffer, color: number): void {
	const native = loadNative();
	if (!native) return;
	const brush = native.gdi32.CreateSolidBrush(color);
	if (!brush) return;
	native.user32.FillRect(hdc, toPtr(rect), brush);
	native.gdi32.DeleteObject(brush);
}

// ── 自绘 ────────────────────────────────────────────────────────────────────

export const WM_DRAWITEM = 0x002b;
export const BS_OWNERDRAW = 0x0000000b;
export const ODS_SELECTED = 0x0001;
export const ODS_DISABLED = 0x0004;
export const ODS_FOCUS = 0x0010;
export const DT_LEFT = 0x00000000;
export const DT_CENTER = 0x00000001;
export const DT_VCENTER = 0x00000004;
export const DT_SINGLELINE = 0x00000020;
/** 单行放不下时以省略号收尾，而不是折行或硬切。 */
export const DT_END_ELLIPSIS = 0x00008000;
export const LR_LOADFROMFILE = 0x00000010;
export const IMAGE_ICON = 1;

/** 从 .ico 文件加载图标：开发模式没有 exe 资源，只能按文件取。 */
export function loadIconFromFile(path: string, size = 32): Pointer | undefined {
	const native = loadNative();
	if (!native) return undefined;
	const icon = native.user32.LoadImageW(
		0 as unknown as Pointer,
		wstr(path),
		IMAGE_ICON,
		size,
		size,
		LR_LOADFROMFILE,
	);
	return icon ?? undefined;
}

/** 圆角矩形：填充 + 1px 描边。 */
export function drawRoundedRect(
	hdc: Pointer,
	rect: Buffer,
	fill: number,
	border: number,
	radius = 8,
): void {
	const native = loadNative();
	if (!native) return;
	const brush = brushFor(fill);
	const pen = native.gdi32.CreatePen(0, 1, border);
	const previousBrush = brush ? native.gdi32.SelectObject(hdc, brush) : undefined;
	const previousPen = pen ? native.gdi32.SelectObject(hdc, pen) : undefined;
	native.gdi32.RoundRect(
		hdc,
		rect.readInt32LE(0),
		rect.readInt32LE(4),
		rect.readInt32LE(8),
		rect.readInt32LE(12),
		radius,
		radius,
	);
	if (previousBrush) native.gdi32.SelectObject(hdc, previousBrush);
	if (previousPen) native.gdi32.SelectObject(hdc, previousPen);
	if (pen) native.gdi32.DeleteObject(pen);
}

/** 在矩形内画一行文字（默认居中，透明背景）。 */
export function drawText(
	hdc: Pointer,
	text: string,
	rect: Buffer,
	color: number,
	format = DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS,
): void {
	const native = loadNative();
	if (!native) return;
	native.gdi32.SetTextColor(hdc, color);
	native.gdi32.SetBkMode(hdc, 1); // TRANSPARENT
	native.user32.DrawTextW(hdc, wstrTemp(text), -1, toPtr(rect), format);
}

/** 造一个 RECT 结构。 */
export function makeRectOf(left: number, top: number, right: number, bottom: number): Buffer {
	const rect = makeRect();
	rect.writeInt32LE(px(left), 0);
	rect.writeInt32LE(px(top), 4);
	rect.writeInt32LE(px(right), 8);
	rect.writeInt32LE(px(bottom), 12);
	return rect;
}

export interface DrawItemInfo {
	controlId: number;
	itemState: number;
	hdc: Pointer;
	rect: Buffer;
}

/**
 * 解析 WM_DRAWITEM 的 DRAWITEMSTRUCT（x64 布局）：
 * CtlType/CtlID/itemID/itemAction/itemState（0..20）+ 对齐 + hwndItem(24) + hDC(32) + rcItem(40) + itemData(56)。
 */
export function readDrawItem(lParam: Pointer): DrawItemInfo {
	const rect = makeRect();
	rect.writeInt32LE(read.i32(lParam, 40), 0);
	rect.writeInt32LE(read.i32(lParam, 44), 4);
	rect.writeInt32LE(read.i32(lParam, 48), 8);
	rect.writeInt32LE(read.i32(lParam, 52), 12);
	return {
		controlId: read.u32(lParam, 4),
		itemState: read.u32(lParam, 16),
		// GDI/USER 句柄是 32 位值，必须零扩展进 64 位槽；read.ptr 会符号扩展，高位污染的
		// 句柄会被 GDI 拒绝（按钮空白且随句柄值随机复现）。
		hdc: read.u32(lParam, 32) as unknown as Pointer,
		rect,
	};
}

export const WM_GETMINMAXINFO = 0x0024;

/**
 * 设置窗口可拖拽的最小**客户区**尺寸：MINMAXINFO.ptMinTrackSize 位于偏移 24（两个 int32，
 * 语义是窗口外框）。没有这个，窗口能被缩到按钮互相遮挡。入参按客户区换算成外框后写入。
 */
export function setMinTrackSize(lParam: Pointer, width: number, height: number): void {
	const native = loadNative();
	if (!native) return;
	const frame = makeRect();
	frame.writeInt32LE(0, 0);
	frame.writeInt32LE(0, 4);
	frame.writeInt32LE(px(width), 8);
	frame.writeInt32LE(height, 12);
	native.user32.AdjustWindowRect(toPtr(frame), WS_OVERLAPPEDWINDOW, 0);
	const rect = readRect(frame);
	// 直接按指针偏移写：Number(lParam) 在超过 2^53 时会丢精度。
	const target = new DataView(toArrayBuffer(lParam, 0, 32));
	target.setInt32(24, rect.right - rect.left, true);
	target.setInt32(28, rect.bottom - rect.top, true);
}

// ── 富文本日志 ──────────────────────────────────────────────────────────────

export const EM_SETSEL = 0x00b1;
export const EM_REPLACESEL = 0x00c2;
export const EM_SETCHARFORMAT = 0x0444;
const SCF_SELECTION = 0x0001;
/** 只改字符颜色，其它格式位不动。 */
const CFM_COLOR = 0x40000000;

/**
 * 创建日志控件：优先 RichEdit（可给单行上色），Msftedit 加载失败时退回普通只读文本框。
 * RichEdit 需要显式 LoadLibrary，否则类名 RICHEDIT50W 不存在。
 */
export function createRichEdit(options: Omit<ControlOptions, "className">): Pointer | undefined {
	const native = loadNative();
	if (!native) return undefined;
	const loaded = native.kernel32.LoadLibraryW(wstrTemp("Msftedit.dll"));
	return createControl({ ...options, className: loaded ? "RICHEDIT50W" : "EDIT" });
}

/** CHARFORMAT2W：x64 上 116 字节，只填 cbSize / dwMask / crTextColor，其余保持 0。 */
function charFormat(color: number): Buffer {
	const format = Buffer.alloc(116);
	format.writeUInt32LE(116, 0);
	format.writeUInt32LE(CFM_COLOR, 4);
	format.writeUInt32LE(color, 20);
	return format;
}

/** 把一行文本追加到富文本控件末尾并给这行上色，然后滚到底。 */
export function appendRichText(hwnd: Pointer, text: string, color: number): void {
	const native = loadNative();
	if (!native) return;
	const { user32 } = native;
	const end = richTextLength(hwnd);
	user32.SendMessageW(hwnd, EM_SETSEL, end as unknown as Pointer, end as unknown as Pointer);
	user32.SendMessageW(hwnd, EM_REPLACESEL, 0 as unknown as Pointer, wstrTemp(text));
	user32.SendMessageW(
		hwnd,
		EM_SETCHARFORMAT,
		SCF_SELECTION as unknown as Pointer,
		toPtr(charFormat(color)),
	);
	// 光标移到实际末尾（RichEdit 会把 \r\n 规范化为 \r，不能按入参长度估算）。
	// 注意 EM_SETSEL 会把视图滚到插入符，所以"不打断用户浏览"由调用方在追加后还原滚动位置。
	const actualEnd = richTextLength(hwnd);
	user32.SendMessageW(
		hwnd,
		EM_SETSEL,
		actualEnd as unknown as Pointer,
		actualEnd as unknown as Pointer,
	);
}

/** WM_VSCROLL：配合 SB_BOTTOM 把视图滚到末尾。 */
const WM_VSCROLL = 0x0115;
/** EM_GETSCROLLPOS / EM_SETSCROLLPOS：读写视图的像素滚动位置（数据是 POINT）。 */
const EM_GETSCROLLPOS = 0x04dd;
const EM_SETSCROLLPOS = 0x04de;

/** 读取视图的像素滚动位置（追加日志前保存，用于不打断用户的浏览）。 */
export function readScrollPixelPos(hwnd: Pointer): Buffer {
	const pos = Buffer.alloc(8);
	const native = loadNative();
	if (native) {
		native.user32.SendMessageW(hwnd, EM_GETSCROLLPOS, 0 as unknown as Pointer, toPtr(pos));
	}
	return pos;
}

/** 还原视图的像素滚动位置。 */
export function restoreScrollPixelPos(hwnd: Pointer, pos: Buffer): void {
	const native = loadNative();
	if (native) {
		native.user32.SendMessageW(hwnd, EM_SETSCROLLPOS, 0 as unknown as Pointer, toPtr(pos));
	}
}

/** 把视图滚到文本末尾。SCROLLCARET 依赖控件焦点，滚动条的 SB_BOTTOM 更可靠。 */
export function scrollRichTextToBottom(hwnd: Pointer): void {
	const native = loadNative();
	if (!native) return;
	const SB_BOTTOM = 7;
	native.user32.SendMessageW(
		hwnd,
		WM_VSCROLL,
		SB_BOTTOM as unknown as Pointer,
		0 as unknown as Pointer,
	);
}

/** 读取富文本控件的当前字符数。 */
export function richTextLength(hwnd: Pointer): number {
	const native = loadNative();
	if (!native) return 0;
	return Number(
		native.user32.SendMessageW(
			hwnd,
			WM_GETTEXTLENGTH,
			0 as unknown as Pointer,
			0 as unknown as Pointer,
		),
	);
}

/** 切换控件的显示/隐藏。 */
export function setVisible(hwnd: Pointer | undefined, visible: boolean): void {
	if (!hwnd) return;
	showWindow(hwnd, visible ? SW_SHOW : SW_HIDE);
}

/** 控件当前是否可见。 */
export function isWindowVisible(hwnd: Pointer | undefined): boolean {
	const native = loadNative();
	if (!native || !hwnd) return false;
	return native.user32.IsWindowVisible(hwnd) !== 0;
}

/**
 * 删除富文本控件开头的一段文本（终端式滚动缓冲用），返回实际删除的字符数。
 * 用 EM_SETSEL + 空 EM_REPLACESEL 删除；完成后把光标放回末尾，保持追加行为。
 */
export function trimRichTextHead(hwnd: Pointer, count: number): number {
	const native = loadNative();
	if (!native) return 0;
	const total = richTextLength(hwnd);
	const remove = Math.min(count, total);
	if (remove <= 0) return 0;
	native.user32.SendMessageW(
		hwnd,
		EM_SETSEL,
		0 as unknown as Pointer,
		remove as unknown as Pointer,
	);
	native.user32.SendMessageW(hwnd, EM_REPLACESEL, 0 as unknown as Pointer, wstrTemp(""));
	const end = total - remove;
	native.user32.SendMessageW(hwnd, EM_SETSEL, end as unknown as Pointer, end as unknown as Pointer);
	return remove;
}

/**
 * 重绘窗口与全部子控件。
 *
 * 自绘按钮在父窗口重绘后不一定跟着更新，重排布局或切回窗口时会出现按钮空白/残影；
 * RDW_ALLCHILDREN 强制把它们一起标脏。
 */
export function redrawWindow(hwnd: Pointer): void {
	const native = loadNative();
	if (!native) return;
	const flags = 0x0001 | 0x0080 | 0x0100; // RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW
	native.user32.RedrawWindow(hwnd, 0 as unknown as Pointer, 0 as unknown as Pointer, flags);
}

const TPM_RIGHTBUTTON = 0x0002;
const TPM_RETURNCMD = 0x0100;
const MF_STRING = 0x0000;
const MF_SEPARATOR = 0x0800;
const MF_CHECKED = 0x0008;

/** 托盘菜单项；separator 为 true 时忽略其余字段。 */
export interface TrayMenuItem {
	id: number;
	text: string;
	separator?: boolean;
	checked?: boolean;
}

/**
 * 弹出托盘右键菜单并阻塞等待选择，返回选中项 id（未选择返回 0）。
 */
export function showTrayMenu(hwnd: Pointer, items: TrayMenuItem[]): number {
	const native = loadNative();
	if (!native) return 0;
	const menu = native.user32.CreatePopupMenu();
	if (!menu) return 0;
	try {
		for (const item of items) {
			const flags = item.separator ? MF_SEPARATOR : MF_STRING | (item.checked ? MF_CHECKED : 0);
			native.user32.AppendMenuW(
				menu,
				flags,
				item.id,
				toPtr(Buffer.from(`${item.text}\0`, "utf16le")),
			);
		}
		const point = Buffer.alloc(8);
		if (!native.user32.GetCursorPos(toPtr(point))) return 0;
		// 弹菜单前先抢前台，否则点击别处菜单不会消失（托盘菜单的经典要求）。
		native.user32.SetForegroundWindow(hwnd);
		return Number(
			native.user32.TrackPopupMenu(
				menu,
				TPM_RETURNCMD | TPM_RIGHTBUTTON,
				point.readInt32LE(0),
				point.readInt32LE(4),
				0,
				hwnd,
				0 as unknown as Pointer,
			),
		);
	} finally {
		native.user32.DestroyMenu(menu);
	}
}

// ── 托盘图标 ────────────────────────────────────────────────────────────────

const NIM_ADD = 0x0000;
const NIM_DELETE = 0x0002;
const NIF_MESSAGE = 0x0001;
const NIF_ICON = 0x0002;
const NIF_TIP = 0x0004;

/** NOTIFYICONDATAW 在 x64 上的结构大小与 szTip 字段偏移。 */
const NID_SIZE = 976;
const NID_TIP_OFFSET = 40;

interface Shell32 {
	Shell_NotifyIconW: (message: number, data: Pointer) => number;
}

let shell32: Shell32 | undefined;

/** 托盘图标走 shell32；加载失败返回 undefined，调用方降级为无托盘。 */
function loadShell32(): Shell32 | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		shell32 ??= dlopen("shell32.dll", {
			Shell_NotifyIconW: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		}).symbols as unknown as Shell32;
		return shell32;
	} catch {
		return undefined;
	}
}

/** 在托盘区添加图标；callbackMessage 是托盘事件发往窗口的消息 id。 */
export function addTrayIcon(
	hwnd: Pointer,
	icon: Pointer,
	tip: string,
	callbackMessage: number,
): boolean {
	const shell = loadShell32();
	if (!shell) return false;
	const data = Buffer.alloc(NID_SIZE);
	data.writeUInt32LE(NID_SIZE, 0);
	data.writeBigUInt64LE(ptrValue(hwnd), 8);
	data.writeUInt32LE(0, 16); // uID
	data.writeUInt32LE(NIF_MESSAGE | NIF_ICON | NIF_TIP, 20);
	data.writeUInt32LE(callbackMessage, 24);
	data.writeBigUInt64LE(ptrValue(icon), 32);
	data.write(`${tip.slice(0, 127)}\0`, NID_TIP_OFFSET, "utf16le");
	return shell.Shell_NotifyIconW(NIM_ADD, toPtr(data)) !== 0;
}

/** 移除托盘图标。 */
export function removeTrayIcon(hwnd: Pointer): void {
	const shell = loadShell32();
	if (!shell) return;
	const data = Buffer.alloc(NID_SIZE);
	data.writeUInt32LE(NID_SIZE, 0);
	data.writeBigUInt64LE(ptrValue(hwnd), 8);
	shell.Shell_NotifyIconW(NIM_DELETE, toPtr(data));
}

export function moveWindow(
	hwnd: Pointer | undefined,
	x: number,
	y: number,
	width: number,
	height: number,
): void {
	const native = loadNative();
	if (!native || !hwnd) return;
	native.user32.MoveWindow(hwnd, px(x), px(y), px(width), px(height), 1);
}

/** 控件 id：WM_COMMAND 与 WM_CTLCOLOR* 都靠它区分控件。 */
export function getControlId(hwnd: Pointer): number {
	const native = loadNative();
	if (!native) return 0;
	return native.user32.GetDlgCtrlID(hwnd);
}

/** 光标正下方的窗口（含子控件）；查询失败时 undefined。 */
export function windowAtCursor(): Pointer | undefined {
	const native = loadNative();
	if (!native) return undefined;
	const point = Buffer.alloc(8);
	if (!native.user32.GetCursorPos(toPtr(point))) return undefined;
	// WindowFromPoint 的 POINT 按值传递：把 x/y 打包成一个 64 位值（低 32 位 x、高 32 位 y）。
	const packed = BigInt(point.readUInt32LE(0)) | (BigInt(point.readUInt32LE(4)) << 32n);
	const target = native.user32.WindowFromPoint(packed as unknown as Pointer);
	return target ? target : undefined;
}

/**
 * 光标下方控件的 id；不在任何控件上时为 0。
 *
 * 自绘按钮据此做悬停高亮：比跟踪 WM_MOUSEMOVE/TrackMouseEvent 简单，且对对话框里的按钮
 * 同样有效（消息泵统一派发，不必每个窗口各自维护悬停状态）。
 */
export function controlIdAtCursor(): number {
	const target = windowAtCursor();
	return target ? getControlId(target) : 0;
}

/** 画刷缓存：WM_CTLCOLOR* 每次重绘都要返回画刷，反复新建会泄漏 GDI 对象。 */
const brushCache = new Map<number, Pointer>();

export function brushFor(color: number): Pointer | undefined {
	const cached = brushCache.get(color);
	if (cached) return cached;
	const native = loadNative();
	if (!native) return undefined;
	const brush = native.gdi32.CreateSolidBrush(color);
	if (!brush) return undefined;
	brushCache.set(color, brush);
	return brush;
}

/**
 * 给静态文本上色并决定背景处理。
 *
 * 传入 backgroundColor 时返回实心画刷，控件重绘前会用它擦掉旧内容 —— 文字会变化的控件
 * 必须这样，否则新旧文本叠印。不传则返回 NULL_BRUSH 保持完全透明，用于叠在父窗口自绘
 * 渐变上的固定文字（实心刷会露出一块与渐变不匹配的纯色）。
 */
export function applyControlColors(
	hdc: Pointer,
	textColor: number,
	backgroundColor?: number,
): Pointer | undefined {
	const native = loadNative();
	if (!native) return undefined;
	native.gdi32.SetTextColor(hdc, textColor);
	native.gdi32.SetBkMode(hdc, 1); // TRANSPARENT
	if (backgroundColor !== undefined) return brushFor(backgroundColor);
	return native.gdi32.GetStockObject(5); // NULL_BRUSH
}

export function setWindowIcon(hwnd: Pointer, icon: Pointer | undefined): void {
	if (!icon) return;
	const native = loadNative();
	if (!native) return;
	native.user32.SendMessageW(hwnd, WM_SETICON, 0 as unknown as Pointer, icon); // ICON_SMALL
	native.user32.SendMessageW(hwnd, WM_SETICON, 1 as unknown as Pointer, icon); // ICON_BIG
}
