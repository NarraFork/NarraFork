import type { Pointer } from "bun:ffi";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { BackendProcessOptions, BackendState } from "../backend-process";
import { ID } from "../layout";
import type { SettingsDialogInput } from "../settings-window";

// Run the real manager entrypoint with fake native UI and child/HTTP boundaries.
const win = await import("../win32");
const timers: Array<{ callback: () => void; ms: number }> = [];
let messages: Parameters<typeof win.createWindow>[0]["onMessage"];
let addWorks = true;
let added = 0;
let removed = 0;
let shown = 0;
let healthy = false;
let healthChecks = 0;
let shutdownAccepted = true;
let shutdownWait: Promise<boolean> | undefined;
let advanceHealthClock = false;
let clock = Date.now();
let exits = 0;
let settingsInput: SettingsDialogInput | undefined;
const enabled = new Map<number, boolean>();
const text = new Map<number, string>();
const hwnd = 100 as Pointer;
const taskbarMessage = 0xc123;
let child: FakeBackend;

class FakeBackend {
	starts = 0;
	current: BackendState = "stopped";
	pid: number | undefined;
	listeningHost = "192.0.2.10";
	listeningPort = 7779;
	listeningTls = false;
	constructor(private readonly options: BackendProcessOptions) {
		child = this;
	}
	emit(state: BackendState): void {
		this.current = state;
		if (state === "stopped") this.pid = undefined;
		this.options.onState(state);
	}
	async start(): Promise<void> {
		this.starts++;
		this.pid = 123;
		this.emit("starting");
		this.emit("running");
	}
	async stop(): Promise<void> {
		this.emit("stopping");
		this.emit("stopped");
	}
	setTarget(): void {}
	dispose(): void {}
}

mock.module("../backend-process", () => ({
	BackendProcess: FakeBackend,
	SLOW_START_HINT_MS: 90_000,
	resolveNarraforkHome: () => {
		const home = process.env.NARRAFORK_HOME;
		if (!home) throw new Error("Test preload did not isolate NARRAFORK_HOME");
		return home;
	},
	probeServiceHealth: async () => {
		healthChecks++;
		if (advanceHealthClock) clock += 16_000;
		return healthy;
	},
}));
mock.module("../control-client", () => ({
	requestManagedShutdown: async () => shutdownWait ?? shutdownAccepted,
}));
mock.module("../manager-config", () => ({
	readServerAddress: () => ({ host: "192.0.2.10", port: 7779, tls: false }),
	readPreferences: () => ({ language: "en", closeAction: "minimize", askOnClose: false }),
	readNarraForkSettings: () => ({ openBrowser: "off", brandName: "", brandColor: "" }),
	watchSettings: () => () => {},
	writePreferences: () => true,
	writeServerAddress: () => true,
}));
mock.module("../settings-window", () => ({
	showSettingsDialog: async (_owner: Pointer, input: SettingsDialogInput) => {
		settingsInput = input;
		return null;
	},
}));
mock.module("../../lib/branding", () => ({
	getBrandIcons: async () => {
		throw new Error("Use the fallback icon in this test");
	},
	decodeRgbaPng: () => undefined,
}));
mock.module("../win32", () => ({
	...win,
	isNativeAvailable: () => true,
	acquireSingleInstanceMutex: () => true,
	releaseSingleInstanceMutex: () => {},
	registerWindowMessage: (name: string) => {
		expect(name).toBe("TaskbarCreated");
		return taskbarMessage;
	},
	createWindow: (options: Parameters<typeof win.createWindow>[0]) => {
		messages = options.onMessage;
		return {
			hwnd,
			instance: 1,
			ownFont: (font: Pointer) => font,
			pump: () => true,
			dispose: () => {},
		};
	},
	createControl: (options: { id: number }) => options.id,
	createRichEdit: () => ID.logEdit,
	loadIconFromFile: () => 2,
	setText: (target: Pointer | undefined, value: string) => text.set(Number(target), value),
	setEnabled: (target: Pointer | undefined, value: boolean) => enabled.set(Number(target), value),
	showWindow: (_target: Pointer, mode: number) => {
		if (mode === win.SW_SHOW) shown++;
	},
	addTrayIcon: () => {
		added++;
		return addWorks;
	},
	removeTrayIcon: () => {
		removed++;
	},
	showTrayMenu: () => 9103,
}));
const timerSpy = spyOn(globalThis, "setInterval").mockImplementation(((
	callback: () => void,
	ms: number,
) => {
	timers.push({ callback, ms });
	return timers.length;
}) as unknown as typeof setInterval);

const clockSpy = spyOn(Date, "now").mockImplementation(() => clock);
const exitSpy = spyOn(process, "exit").mockImplementation(() => {
	exits++;
	throw new Error("The manager must not exit in this test");
});

afterEach(() => {
	timerSpy.mockRestore();
	clockSpy.mockRestore();
	exitSpy.mockRestore();
});

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

test("manager wires taskbar recovery, loopback control and adopted health monitoring", async () => {
	const { runManager } = await import("../main");
	expect(await runManager()).toBe("done");
	await flush();
	expect(child.current).toBe("running");
	expect(added).toBe(1);
	expect(shown).toBe(0);

	messages(hwnd, taskbarMessage, 0 as Pointer, 0 as Pointer);
	expect(added).toBe(2);
	addWorks = false;
	messages(hwnd, taskbarMessage, 0 as Pointer, 0 as Pointer);
	expect(shown).toBeGreaterThan(0);

	messages(hwnd, win.WM_COMMAND, ID.settings as Pointer, 0 as Pointer);
	await flush();
	expect(settingsInput?.serviceBaseUrl).toBe("http://127.0.0.1:7779");
	expect(text.get(ID.address)).toContain("192.0.2.10:7779");

	settingsInput?.onApplyStarting?.();
	healthy = true;
	child.emit("stopped");
	await flush();
	expect(enabled.get(ID.start)).toBe(false);

	// Rejected or timed-out stops retain adopted ownership, including a tray exit request.
	const adoptedStarts = child.starts;
	shutdownAccepted = false;
	messages(hwnd, win.WM_COMMAND, ID.restart as Pointer, 0 as Pointer);
	await flush();
	expect(child.starts).toBe(adoptedStarts);
	expect(enabled.get(ID.start)).toBe(false);
	expect(enabled.get(ID.stop)).toBe(true);
	messages(hwnd, win.WM_APP + 10, 0 as Pointer, win.WM_RBUTTONUP as Pointer);
	await flush();
	expect(exits).toBe(0);
	expect(removed).toBe(0);
	expect(enabled.get(ID.stop)).toBe(true);
	shutdownAccepted = true;
	advanceHealthClock = true;
	messages(hwnd, win.WM_COMMAND, ID.restart as Pointer, 0 as Pointer);
	await flush();
	expect(child.starts).toBe(adoptedStarts);
	expect(enabled.get(ID.start)).toBe(false);
	advanceHealthClock = false;

	const timer = timers.find((entry) => entry.ms === 4000);
	expect(timer).toBeDefined();
	healthy = false;
	const before = healthChecks;
	for (let i = 0; i < 3; i++) {
		timer?.callback();
		await flush();
	}
	expect(healthChecks - before).toBe(3);
	expect(enabled.get(ID.start)).toBe(true);
	expect(text.get(ID.statusText)).toContain("Stopped");

	addWorks = true;
	messages(hwnd, taskbarMessage, 0 as Pointer, 0 as Pointer);
	messages(hwnd, win.WM_COMMAND, ID.start as Pointer, 0 as Pointer);
	await flush();
	let releaseShutdown: (accepted: boolean) => void = () => {};
	shutdownWait = new Promise((resolve) => {
		releaseShutdown = resolve;
	});
	const beforeHandover = added;
	const beforeRestart = child.starts;
	messages(hwnd, win.WM_COMMAND, ID.restart as Pointer, 0 as Pointer);
	messages(hwnd, win.WM_APP + 7, 0 as Pointer, 0 as Pointer);
	releaseShutdown(true);
	await flush();
	messages(hwnd, taskbarMessage, 0 as Pointer, 0 as Pointer);
	expect(child.starts).toBe(beforeRestart);
	expect(added).toBe(beforeHandover);
	expect(removed).toBe(1);
	expect(exits).toBe(0);
});
