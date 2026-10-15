/**
 * Windows 前台激活：把标题匹配的资源管理器窗口提到最前。
 *
 * 服务端是后台进程，而 Windows 只允许"最近收到输入"的进程切换前台窗口，因此
 * AllowSetForegroundWindow（要求调用者本身具备该权限）与 WScript.Shell.AppActivate 都会被
 * 静默拒绝。这里改用通行的 AttachThreadInput 方案：短暂把当前前台线程的输入队列与目标窗口
 * 线程挂在一起，再 SetForegroundWindow；仍失败时补一次合成的 ALT 按下/抬起解开前台锁。
 *
 * 任何一步失败都静默返回：打开目录本身不受影响，只是窗口可能仍留在后排。
 */

import { dlopen, FFIType, JSCallback, type Pointer } from "bun:ffi";

const SW_RESTORE = 9;
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 0x2;
const FIND_WINDOW_TIMEOUT_MS = 3000;
const FIND_WINDOW_INTERVAL_MS = 150;
/** 资源管理器窗口类名（现代 / 旧版）。 */
const EXPLORER_WINDOW_CLASSES = ["CabinetWClass", "ExploreWClass"];

/** 让窗口短暂成为最顶层再取消，实现"无条件置顶一次"（不依赖前台权限）。 */
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const SWP_NOSIZE = 0x1;
const SWP_NOMOVE = 0x2;
const SWP_SHOWWINDOW = 0x40;
const SWP_FLAGS = SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW;

/** 指针参数既接受地址，也接受 TypedArray（bun:ffi 会把后者的缓冲区地址传进去）。 */
type NativeBuffer = Pointer | ArrayBufferView;

interface User32Api {
	EnumWindows: (callback: Pointer, lParam: number) => number;
	GetClassNameW: (hwnd: Pointer, buffer: NativeBuffer, max: number) => number;
	GetWindowTextW: (hwnd: Pointer, buffer: NativeBuffer, max: number) => number;
	IsWindowVisible: (hwnd: Pointer) => number;
	GetWindowThreadProcessId: (hwnd: Pointer, processId: NativeBuffer) => number;
	GetForegroundWindow: () => Pointer;
	AttachThreadInput: (attach: number, attachTo: number, attachFlag: number) => number;
	SetForegroundWindow: (hwnd: Pointer) => number;
	ShowWindow: (hwnd: Pointer, cmd: number) => number;
	SetWindowPos: (
		hwnd: Pointer,
		insertAfter: number,
		x: number,
		y: number,
		cx: number,
		cy: number,
		flags: number,
	) => number;
	keybd_event: (virtualKey: number, scanCode: number, flags: number, extra: number) => void;
}

let api: User32Api | undefined;

function loadUser32(): User32Api | undefined {
	if (api) return api;
	try {
		api = dlopen("user32.dll", {
			EnumWindows: { args: [FFIType.function, FFIType.i64], returns: FFIType.bool },
			GetClassNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			GetWindowTextW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.bool },
			GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
			GetForegroundWindow: { args: [], returns: FFIType.ptr },
			AttachThreadInput: {
				args: [FFIType.u32, FFIType.u32, FFIType.bool],
				returns: FFIType.bool,
			},
			SetForegroundWindow: { args: [FFIType.ptr], returns: FFIType.bool },
			ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.bool },
			SetWindowPos: {
				args: [
					FFIType.ptr,
					FFIType.i64,
					FFIType.i32,
					FFIType.i32,
					FFIType.i32,
					FFIType.i32,
					FFIType.u32,
				],
				returns: FFIType.bool,
			},
			keybd_event: {
				args: [FFIType.u8, FFIType.u8, FFIType.u32, FFIType.u64],
				returns: FFIType.void,
			},
		}).symbols as unknown as User32Api;
		return api;
	} catch {
		api = undefined;
		return undefined;
	}
}

function readWindowText(
	user32: User32Api,
	read: (hwnd: Pointer, buffer: NativeBuffer, max: number) => number,
	hwnd: Pointer,
): string {
	const buffer = new Uint16Array(512);
	const length = read(hwnd, buffer, buffer.length);
	if (length <= 0) return "";
	return Buffer.from(buffer.buffer, 0, length * 2).toString("utf16le");
}

/** 找到可见、类名为资源管理器、标题（不区分大小写）含 title 的窗口。 */
function findExplorerWindow(title: string): Pointer | undefined {
	const user32 = loadUser32();
	if (!user32) return undefined;
	const needle = title.toLowerCase();
	let found: Pointer | undefined;
	const callback = new JSCallback(
		(hwnd: Pointer | null) => {
			if (hwnd == null) return true;
			const window: Pointer = hwnd;
			if (!user32.IsWindowVisible(window)) return true;
			const className = readWindowText(user32, user32.GetClassNameW, window);
			if (!EXPLORER_WINDOW_CLASSES.includes(className)) return true;
			if (!readWindowText(user32, user32.GetWindowTextW, window).toLowerCase().includes(needle)) {
				return true;
			}
			found = window;
			return false; // 找到即停止枚举
		},
		{ args: [FFIType.ptr, FFIType.i64], returns: FFIType.bool },
	);
	const pointer = callback.ptr;
	try {
		if (pointer != null) user32.EnumWindows(pointer, 0);
	} finally {
		callback.close();
	}
	return found;
}

/** 置顶：共享前台线程输入队列 → SetForegroundWindow；仍被拒时用合成 ALT 解锁后再试。 */
function bringToForeground(hwnd: Pointer): void {
	const user32 = loadUser32();
	if (!user32) return;
	const processIdBuffer = new Int32Array(1);
	const foregroundThread = user32.GetWindowThreadProcessId(
		user32.GetForegroundWindow(),
		processIdBuffer,
	);
	const targetThread = user32.GetWindowThreadProcessId(hwnd, processIdBuffer);
	user32.AttachThreadInput(foregroundThread, targetThread, 1);
	try {
		user32.ShowWindow(hwnd, SW_RESTORE);
		// TOPMOST→NOTOPMOST 翻转不依赖前台权限，能把窗口无条件抬到最上层一次。
		user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_FLAGS);
		user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_FLAGS);
		if (!user32.SetForegroundWindow(hwnd)) {
			user32.keybd_event(VK_MENU, 0, 0, 0);
			user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
			user32.SetForegroundWindow(hwnd);
		}
	} finally {
		user32.AttachThreadInput(foregroundThread, targetThread, 0);
	}
}

/**
 * 轮询等待标题含 title 的资源管理器窗口出现后激活它；超时或任何失败都静默放弃。
 * 调用方拿到的是"已经发起"的语义，不阻塞请求。
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待窗口出现并置顶；返回是否找到窗口、是否完成激活（供调用方记录/反馈）。 */
export async function raiseExplorerWindowByTitle(
	title: string,
): Promise<{ found: boolean; raised: boolean }> {
	if (process.platform !== "win32" || !title) return { found: false, raised: false };
	const deadline = Date.now() + FIND_WINDOW_TIMEOUT_MS;
	for (;;) {
		const hwnd = findExplorerWindow(title);
		if (hwnd) {
			bringToForeground(hwnd);
			return { found: true, raised: true };
		}
		if (Date.now() >= deadline) return { found: false, raised: false };
		await sleep(FIND_WINDOW_INTERVAL_MS);
	}
}
