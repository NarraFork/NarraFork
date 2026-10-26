import type { Pointer } from "bun:ffi";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SettingsDialogInput } from "../settings-window";
import type { ApplyOutcome, DownloadOutcome } from "../update-client";

// Run the real window/dialog modules; only the DLL boundary and update transport are fake.
let sequence = 100;
const memory = new Map<number, Buffer>();
function must<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing mock state");
	return value;
}
const pointers = new WeakMap<object, number>();
const callbacks = new Map<number, (...args: number[]) => number>();
const classes = new Map<string, number>();
const calls: Array<[string, ...Array<string | number>]> = [];
type FakeWindow = {
	parent: number;
	proc: number;
	className: string;
	id: number;
	style: number;
	visible: boolean;
	enabled: boolean;
	text: string;
	code: number;
	dropped: boolean;
};
const windows = new Map<number, FakeWindow>();
const queue: Array<{ hwnd: number; msg: number; key: number }> = [];
let active = 0;
let focused = 0;
let shift = false;
let failRegistration = false;
let failCreation = false;
let failDestruction = false;
let menuResult = 42;

function pointer(view: ArrayBufferView): number {
	let result = pointers.get(view);
	if (!result) {
		result = ++sequence;
		pointers.set(view, result);
		memory.set(result, Buffer.from(view.buffer, view.byteOffset, view.byteLength));
	}
	return result;
}
function wide(address: number): string {
	return memory.get(address)?.toString("utf16le").split("\0")[0] ?? "";
}
function root(hwnd: number): number {
	let current = hwnd;
	while (windows.get(current)?.parent) current = windows.get(current)?.parent ?? 0;
	return current;
}
function send(hwnd: number, msg: number, wParam = 0, lParam = 0): number {
	const window = windows.get(hwnd);
	if (!window) {
		calls.push(["send-to-missing", hwnd, msg]);
		return 0;
	}
	if (msg === 0x0087) return window.code;
	if (msg === 0x0157) return Number(window.dropped);
	if (msg === 0x000c) window.text = wide(lParam);
	if (msg === 0x00f5) {
		calls.push(["click", window.id]);
		return send(window.parent, 0x0111, window.id, hwnd);
	}
	return callbacks.get(window.proc)?.(hwnd, msg, wParam, lParam) ?? 0;
}
function destroy(hwnd: number): number {
	if (!windows.has(hwnd)) return 0;
	send(hwnd, 2);
	for (const [child, info] of [...windows]) if (info.parent === hwnd) destroy(child);
	calls.push(["destroyed", hwnd]);
	send(hwnd, 0x0082);
	windows.delete(hwnd);
	return 1;
}
const user32: Record<string, (...args: number[]) => number> = {
	RegisterWindowMessageW: (name) => {
		calls.push(["register-message", wide(name)]);
		return 0xc123;
	},
	RegisterClassExW: (address) => {
		if (failRegistration) return 0;
		const data = must(memory.get(address));
		classes.set(wide(Number(data.readBigUInt64LE(64))), Number(data.readBigUInt64LE(8)));
		return 1;
	},
	UnregisterClassW: (name) => {
		classes.delete(wide(name));
		calls.push(["unregister", wide(name)]);
		return 1;
	},
	CreateWindowExW: (_ex, name, title, style, _x, _y, _width, _height, parent, id) => {
		if (failCreation) return 0;
		const className = wide(name);
		const hwnd = ++sequence;
		windows.set(hwnd, {
			parent: style & 0x40000000 ? parent : 0,
			proc: classes.get(className) ?? 0,
			className,
			id,
			style,
			visible: Boolean(style & 0x10000000),
			enabled: true,
			text: wide(title),
			code: className === "BUTTON" ? 0x2000 : 0,
			dropped: false,
		});
		return hwnd;
	},
	DestroyWindow: (hwnd) => (failDestruction ? 0 : destroy(hwnd)),
	DefWindowProcW: (hwnd, msg) => (msg === 0x0010 ? destroy(hwnd) : 0),
	PeekMessageW: (address) => {
		const item = queue.shift();
		if (!item) return 0;
		const data = must(memory.get(address));
		data.fill(0);
		data.writeBigUInt64LE(BigInt(item.hwnd), 0);
		data.writeUInt32LE(item.msg, 8);
		data.writeBigUInt64LE(BigInt(item.key), 16);
		return 1;
	},
	TranslateMessage: (address) => {
		calls.push(["translate", must(memory.get(address)).readUInt32LE(8)]);
		return 1;
	},
	DispatchMessageW: (address) => {
		const data = must(memory.get(address));
		const msg = data.readUInt32LE(8);
		calls.push(["dispatch", msg]);
		return send(Number(data.readBigUInt64LE(0)), msg, Number(data.readBigUInt64LE(16)));
	},
	SendMessageW: send,
	PostMessageW: (hwnd, msg) => {
		calls.push(["post", hwnd, msg]);
		return 1;
	},
	GetActiveWindow: () => active,
	GetAncestor: root,
	GetKeyState: () => (shift ? -32768 : 0),
	GetDlgItem: (hwnd, id) =>
		[...windows].find(([, w]) => w.parent === hwnd && w.id === id)?.[0] ?? 0,
	GetClassNameW: (hwnd, address) => {
		const name = windows.get(hwnd)?.className ?? "";
		must(memory.get(address)).write(`${name}\0`, "utf16le");
		return name.length;
	},
	GetNextDlgTabItem: (hwnd, current, previous) => {
		const items = [...windows]
			.filter(([, w]) => w.parent === hwnd && w.visible && w.enabled && (w.style & 0x10000) !== 0)
			.map(([handle]) => handle);
		const index = current ? items.indexOf(current) : previous ? 0 : -1;
		return items[(index + (previous ? -1 : 1) + items.length) % items.length] ?? 0;
	},
	SetFocus: (hwnd) => {
		focused = hwnd;
		return hwnd;
	},
	SetForegroundWindow: (hwnd) => {
		active = hwnd;
		return 1;
	},
	IsWindow: (hwnd) => Number(windows.has(hwnd)),
	IsWindowEnabled: (hwnd) => Number(windows.get(hwnd)?.enabled),
	IsWindowVisible: (hwnd) => Number(windows.get(hwnd)?.visible),
	EnableWindow: (hwnd, enabled) => {
		const window = windows.get(hwnd);
		if (window) window.enabled = Boolean(enabled);
		return 1;
	},
	ShowWindow: (hwnd, command) => {
		const window = windows.get(hwnd);
		if (window) window.visible = command !== 0;
		return 1;
	},
	GetWindowLongW: (hwnd) => windows.get(hwnd)?.style ?? 0,
	GetSystemMetrics: () => 1920,
	CreatePopupMenu: () => 99,
	GetCursorPos: () => 1,
	TrackPopupMenu: () => {
		calls.push(["track"]);
		return menuResult;
	},
	DestroyMenu: () => {
		calls.push(["destroy-menu"]);
		return 1;
	},
	MessageBoxW: () => 6,
};
const gdi32: Record<string, (...args: number[]) => number> = {
	GetDeviceCaps: () => 96,
	CreateFontW: () => ++sequence,
	DeleteObject: (font) => {
		calls.push(["delete-font", font]);
		return 1;
	},
};
mock.module("bun:ffi", () => ({
	FFIType: new Proxy({}, { get: (_target, name) => name }),
	ptr: pointer,
	read: {},
	toArrayBuffer: () => new ArrayBuffer(0),
	JSCallback: class {
		ptr: number;
		constructor(callback: (...args: number[]) => number) {
			this.ptr = ++sequence;
			callbacks.set(this.ptr, callback);
		}
		close(): void {
			calls.push(["close-callback", this.ptr]);
			callbacks.delete(this.ptr);
		}
	},
	dlopen: (name: string, signatures: Record<string, unknown>) => {
		const implementations = name === "user32.dll" ? user32 : name === "gdi32.dll" ? gdi32 : {};
		return {
			symbols: Object.fromEntries(
				Object.keys(signatures).map((key) => [key, implementations[key] ?? (() => 1)]),
			),
		};
	},
}));
let applyBehavior: () => Promise<ApplyOutcome>;
let downloadBehavior: () => Promise<DownloadOutcome>;
const applyUpdate = mock(async () => applyBehavior());
const downloadUpdate = mock(async () => downloadBehavior());
mock.module("../update-client", () => ({
	applyUpdate,
	downloadUpdate,
	checkForUpdate: async () => ({
		updateAvailable: true,
		currentVersion: "1",
		latestVersion: "2",
		releaseInfo: {},
	}),
}));
const win = await import("../win32");
const { showCloseDialog } = await import("../close-dialog");
const { showSettingsDialog } = await import("../settings-window");
const { setLanguage } = await import("../manager-i18n");
const platform = must(Object.getOwnPropertyDescriptor(process, "platform"));
try {
	Object.defineProperty(process, "platform", { value: "win32" });
	expect(win.loadNative()).toBeDefined();
} finally {
	Object.defineProperty(process, "platform", platform);
}
const ownedWindows: Array<NonNullable<ReturnType<typeof win.createWindow>>> = [];
function windowWith(options: Partial<Parameters<typeof win.createWindow>[0]> = {}) {
	const window = must(
		win.createWindow({
			title: "test",
			className: "test",
			width: 200,
			height: 100,
			onMessage: () => undefined,
			...options,
		}),
	);
	ownedWindows.push(window);
	return window;
}
function control(
	parent: ReturnType<typeof windowWith>,
	id: number,
	className = "BUTTON",
	style = 0,
) {
	return must(
		win.createControl({
			parent: parent.hwnd,
			instance: parent.instance,
			id,
			className,
			style,
			text: "",
			x: 0,
			y: 0,
			width: 20,
			height: 20,
		}),
	);
}
function key(pump: ReturnType<typeof windowWith>, target: Pointer, code: number, msg = 0x0100) {
	queue.push({ hwnd: Number(target), msg, key: code });
	return pump.pump();
}
function child(hwnd: Pointer, id: number): number {
	return must(user32.GetDlgItem)(Number(hwnd), id);
}
async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}
function startSettings(
	owner: ReturnType<typeof windowWith>,
	extra: Partial<SettingsDialogInput> = {},
) {
	const pending = showSettingsDialog(owner.hwnd, {
		preferences: {
			language: "en",
			askOnClose: true,
			closeAction: "exit",
			startMinimized: false,
			autoStartBackend: false,
		},
		narrafork: { brandColor: "", brandName: "", openBrowser: "off" },
		brandColorRef: 0,
		serviceBaseUrl: "http://fake",
		managerToken: "fake",
		...extra,
	});
	return { pending, popup: active as Pointer };
}
beforeEach(() => {
	calls.length = 0;
	queue.length = 0;
	active = 0;
	focused = 0;
	shift = false;
	failRegistration = false;
	failCreation = false;
	failDestruction = false;
	menuResult = 42;
	applyBehavior = async () => ({ success: false, error: "business rejected" });
	downloadBehavior = async () => ({ success: true, version: "2", preparedIdentity: "prepared" });
	applyUpdate.mockClear();
	downloadUpdate.mockClear();
	setLanguage("en");
});
afterEach(() => {
	for (const [hwnd] of [...windows]) destroy(hwnd);
	for (const window of ownedWindows.splice(0)) window.dispose();
});

describe("real Win32 wrapper with mocked DLL calls", () => {
	test("registers TaskbarCreated and posts WM_NULL after selected/cancelled menus", () => {
		expect(win.registerWindowMessage("TaskbarCreated")).toBe(0xc123);
		expect(calls).toContainEqual(["register-message", "TaskbarCreated"]);
		const window = windowWith();
		for (const result of [42, 0]) {
			calls.length = 0;
			menuResult = result;
			expect(win.showTrayMenu(window.hwnd, [{ id: 42, text: "Open" }])).toBe(result);
			expect(calls).toEqual([["track"], ["post", Number(window.hwnd), 0], ["destroy-menu"]]);
		}
	});

	test("one thread pump navigates the active popup and skips hidden/disabled/static controls", () => {
		const owner = windowWith();
		const popup = windowWith({ owner: owner.hwnd });
		control(owner, 1);
		control(popup, 2, "STATIC");
		const first = control(popup, 3, "EDIT");
		const hidden = control(popup, 4);
		win.setVisible(hidden, false);
		const disabled = control(popup, 5);
		win.enableWindow(disabled, false);
		const last = control(popup, 6, "COMBOBOX");
		active = Number(popup.hwnd);
		key(owner, popup.hwnd, 9);
		expect(focused).toBe(Number(first));
		key(owner, first, 9);
		expect(focused).toBe(Number(last));
		shift = true;
		key(owner, last, 9);
		expect(focused).toBe(Number(first));
		expect(calls.filter(([name]) => name === "dispatch")).toHaveLength(0);
	});

	test("Enter/Esc use explicit buttons, focused push buttons override default; controls and Alt+F4 retain keys", () => {
		const window = windowWith({ defaultButtonId: 11, cancelButtonId: 12 });
		const defaultButton = control(window, 11);
		control(window, 12);
		const focusedButton = control(window, 13, "BUTTON", win.BS_OWNERDRAW);
		const edit = control(window, 14, "EDIT");
		const combo = control(window, 15, "COMBOBOX");
		active = Number(window.hwnd);
		key(window, edit, 13);
		key(window, edit, 27);
		key(window, focusedButton, 13);
		expect(calls.filter(([name]) => name === "click")).toEqual([
			["click", 11],
			["click", 12],
			["click", 13],
		]);
		must(windows.get(Number(edit))).code = 4; // DLGC_WANTALLKEYS / WANTMESSAGE
		key(window, edit, 13);
		must(windows.get(Number(edit))).code = 2; // DLGC_WANTTAB
		key(window, edit, 9);
		must(windows.get(Number(combo))).dropped = true;
		key(window, combo, 27);
		key(window, combo, 13);
		key(window, edit, 0x73, 0x0104); // WM_SYSKEYDOWN, Alt+F4
		win.enableWindow(defaultButton, false);
		key(window, window.hwnd, 13);
		expect(calls.filter(([name]) => name === "click")).toHaveLength(3);
		expect(calls.filter(([name]) => name === "dispatch")).toHaveLength(5);
		const plain = windowWith();
		active = Number(plain.hwnd);
		key(window, plain.hwnd, 13);
		key(window, plain.hwnd, 27);
		expect(calls.filter(([name]) => name === "click")).toHaveLength(3);
	});

	test("fonts are window-owned, released after children, and never double-deleted on reopen/dispose", () => {
		for (let round = 0; round < 2; round++) {
			const window = windowWith();
			const font = must(window.ownFont(win.createFont(13)));
			window.ownFont(font);
			const button = control(window, 1);
			win.setFont(button, font);
			window.dispose();
			window.dispose();
			window.ownFont(font);
			expect(
				calls.filter(([name, value]) => name === "delete-font" && value === Number(font)),
			).toHaveLength(1);
			expect(
				calls.findIndex(([name, value]) => name === "destroyed" && value === Number(button)),
			).toBeLessThan(
				calls.findIndex(([name, value]) => name === "delete-font" && value === Number(font)),
			);
		}
	});

	test("destroy failure retains live fonts and callbacks, then a later dispose releases them", () => {
		const window = windowWith();
		const font = must(window.ownFont(win.createFont(13)));
		failDestruction = true;
		window.dispose();
		expect(calls.some(([name]) => name === "delete-font" || name === "close-callback")).toBe(false);
		expect(windows.has(Number(window.hwnd))).toBe(true);
		failDestruction = false;
		window.dispose();
		expect(calls).toContainEqual(["delete-font", Number(font)]);
		expect(calls.filter(([name]) => name === "close-callback")).toHaveLength(1);
	});

	test("nested pump cannot steal thread messages; WM_QUIT stays visible to outer pump", () => {
		let nestedResult: boolean | undefined;
		const owner = windowWith({
			onMessage: (_hwnd, msg) => {
				if (msg === win.WM_APP) nestedResult = owner.pump();
				return undefined;
			},
		});
		queue.push(
			{ hwnd: Number(owner.hwnd), msg: win.WM_APP, key: 0 },
			{ hwnd: 0, msg: win.WM_QUIT, key: 0 },
		);
		expect(owner.pump()).toBe(false);
		expect(nestedResult).toBe(true);
	});

	test("failed registration never creates a window; failed creation unregisters and closes its callback", () => {
		const before = windows.size;
		failRegistration = true;
		expect(
			win.createWindow({
				title: "fail",
				className: "fail",
				width: 1,
				height: 1,
				onMessage: () => undefined,
			}),
		).toBeUndefined();
		expect(windows.size).toBe(before);
		failRegistration = false;
		failCreation = true;
		expect(
			win.createWindow({
				title: "fail",
				className: "fail",
				width: 1,
				height: 1,
				onMessage: () => undefined,
			}),
		).toBeUndefined();
		expect(classes.size).toBe(0);
		expect(calls.filter(([name]) => name === "close-callback")).toHaveLength(2);
	});
});

describe("real native dialogs", () => {
	test("close popup has explicit minimize default/cancel action and releases fonts on repeated opening", async () => {
		const owner = windowWith();
		for (const code of [13, 27]) {
			const pending = showCloseDialog(owner.hwnd, 0);
			const popup = active as Pointer;
			expect(popup).not.toBe(owner.hwnd);
			key(owner, popup, code);
			const result = await pending;
			expect(result).toEqual(code === 13 ? { action: "minimize", remember: false } : null);
			expect(windows.get(Number(owner.hwnd))?.enabled).toBe(true);
		}
		expect(calls.filter(([name]) => name === "delete-font")).toHaveLength(4);
	});

	test("settings apply failures display error, notify caller and allow retry", async () => {
		const owner = windowWith();
		const failed = mock(() => {});
		const starting = mock(() => {});
		const { pending, popup } = startSettings(owner, {
			onApplyStarting: starting,
			onApplyFailed: failed,
		});
		send(Number(popup), win.WM_COMMAND, 608);
		await tick();
		for (let attempt = 1; attempt <= 2; attempt++) {
			send(Number(popup), win.WM_COMMAND, 609);
			await tick();
			expect(starting).toHaveBeenCalledTimes(attempt);
			expect(failed).toHaveBeenCalledTimes(attempt);
			expect(windows.get(child(popup, 610))?.text).toContain("business rejected");
			expect(windows.get(child(popup, 609))?.visible).toBe(true);
			expect(windows.get(child(popup, 608))?.enabled).toBe(true);
		}
		key(owner, popup, 27);
		expect(await pending).toBeNull();
		expect(calls.filter(([name]) => name === "delete-font")).toHaveLength(4);
	});

	test("unknown apply transport failure stays failed; download failures and exceptions remain retryable", async () => {
		const owner = windowWith();
		const failed = mock(() => {});
		const { pending, popup } = startSettings(owner, { onApplyFailed: failed });
		send(Number(popup), win.WM_COMMAND, 608);
		await tick();
		for (const outcome of ["download-failed", "download-threw", "unknown-network"]) {
			downloadBehavior = async () => {
				if (outcome === "download-threw") throw new Error("download threw");
				if (outcome === "download-failed") return { success: false, error: "checksum mismatch" };
				return { success: true, preparedIdentity: "prepared" };
			};
			applyBehavior = async () => {
				throw new Error("unknown network outcome");
			};
			send(Number(popup), win.WM_COMMAND, 609);
			await tick();
			expect(windows.get(child(popup, 609))?.visible).toBe(true);
			expect(windows.get(child(popup, 608))?.enabled).toBe(true);
			expect(windows.get(child(popup, 610))?.text).toContain(
				outcome === "download-failed"
					? "checksum mismatch"
					: outcome === "download-threw"
						? "download threw"
						: "unknown network outcome",
			);
		}
		expect(failed).toHaveBeenCalledTimes(1);
		key(owner, popup, 27);
		expect(await pending).toBeNull();
	});

	test("apply completion after closing only notifies lifecycle failure and never writes destroyed controls", async () => {
		const owner = windowWith();
		let finishApply: (result: ApplyOutcome) => void = () => {};
		applyBehavior = () =>
			new Promise((resolve) => {
				finishApply = resolve;
			});
		const failed = mock(() => {});
		const { pending, popup } = startSettings(owner, { onApplyFailed: failed });
		send(Number(popup), win.WM_COMMAND, 608);
		await tick();
		send(Number(popup), win.WM_COMMAND, 609);
		send(Number(popup), win.WM_COMMAND, 609); // re-entry cannot launch another request
		await tick();
		expect(applyUpdate).toHaveBeenCalledTimes(1);
		key(owner, popup, 27);
		expect(await pending).toBeNull();
		calls.length = 0;
		finishApply({ success: false, error: "late rejection" });
		await tick();
		expect(failed).toHaveBeenCalledTimes(1);
		expect(calls).toEqual([]);
	});

	test("acknowledged apply success waits for restart rather than exposing another update action", async () => {
		const owner = windowWith();
		applyBehavior = async () => ({ success: true });
		const failed = mock(() => {});
		const { pending, popup } = startSettings(owner, { onApplyFailed: failed });
		send(Number(popup), win.WM_COMMAND, 608);
		await tick();
		send(Number(popup), win.WM_COMMAND, 609);
		await tick();
		expect(failed).not.toHaveBeenCalled();
		expect(windows.get(child(popup, 609))?.visible).toBe(false);
		expect(windows.get(child(popup, 608))?.enabled).toBe(false);
		key(owner, popup, 27);
		expect(await pending).toBeNull();
	});
});
