import { describe, expect, mock, test } from "bun:test";
import { createDesktopLifecycle, type DesktopWindow, desktopServerOrigin } from "./lifecycle";

test("desktop origin preserves localhost and handles IPv4/IPv6 binds", () => {
	for (const [host, expected] of [
		["localhost", "localhost"],
		["0.0.0.0", "127.0.0.1"],
		["::", "[::1]"],
		["[::]", "[::1]"],
		["::1", "[::1]"],
		["[::1]", "[::1]"],
	] as const) {
		expect(desktopServerOrigin({ protocol: "http", host, port: 7779 })).toBe(
			`http://${expected}:7779`,
		);
	}
});

function fixture(shutdown = async () => {}) {
	const windows: ReturnType<typeof makeWindow>[] = [];
	function makeWindow() {
		let close = () => {};
		return {
			activate: mock(() => {}),
			show: mock(() => {}),
			webview: { loadHTML: mock((_html: string) => {}), loadURL: mock((_url: string) => {}) },
			on: mock((_event: "close", listener: () => void) => {
				close = listener;
			}),
			close: () => close(),
		} satisfies DesktopWindow & { close(): void };
	}
	const deps = {
		createWindow: mock(() => {
			const window = makeWindow();
			windows.push(window);
			return window;
		}),
		loadingHtml: "<p>Loading</p>",
		shutdown: mock(shutdown),
		disposeTray: mock(() => {}),
		exit: mock(() => {}),
		onError: mock((_error: unknown) => {}),
	};
	return { lifecycle: createDesktopLifecycle(deps), deps, windows };
}

describe("desktop lifecycle", () => {
	test("construction is inert; opening loads once and repeated opening focuses the window", () => {
		const { lifecycle, deps, windows } = fixture();
		expect(deps.createWindow).not.toHaveBeenCalled();
		expect(lifecycle.hasWindow).toBe(false);
		const first = lifecycle.openWindow();
		expect(lifecycle.openWindow()).toBe(first);
		expect(deps.createWindow).toHaveBeenCalledTimes(1);
		expect(windows[0]?.webview.loadHTML).toHaveBeenCalledWith(deps.loadingHtml);
		expect(windows[0]?.show).toHaveBeenCalledTimes(2);
		expect(windows[0]?.activate).toHaveBeenCalledTimes(2);
		expect(deps.shutdown).not.toHaveBeenCalled();
	});

	test("closing with a tray preserves service and reopening restores the latest ready page", () => {
		const { lifecycle, deps, windows } = fixture();
		lifecycle.setBackgroundAvailable(true);
		lifecycle.openWindow();
		windows[0]?.close();
		expect(lifecycle.hasWindow).toBe(false);
		lifecycle.setReady("http://127.0.0.1:7779");
		expect(deps.createWindow).toHaveBeenCalledTimes(1);
		expect(windows[0]?.webview.loadURL).not.toHaveBeenCalled();
		lifecycle.openWindow();
		expect(windows[1]?.webview.loadURL).toHaveBeenCalledWith("http://127.0.0.1:7779");
		expect(deps.shutdown).not.toHaveBeenCalled();
		windows[0]?.close();
		expect(lifecycle.hasWindow).toBe(true);
	});

	test("error pages are cached without a window and replace ready pages", () => {
		const { lifecycle, windows } = fixture();
		lifecycle.setBackgroundAvailable(true);
		lifecycle.setReady("http://localhost:7779");
		lifecycle.setError("<p>Failed</p>");
		lifecycle.openWindow();
		expect(windows[0]?.webview.loadHTML).toHaveBeenCalledWith("<p>Failed</p>");
		lifecycle.setReady("http://localhost:7780");
		expect(windows[0]?.webview.loadURL).toHaveBeenCalledWith("http://localhost:7780");
		lifecycle.setError("<p>Failed again</p>");
		expect(windows[0]?.webview.loadHTML).toHaveBeenLastCalledWith("<p>Failed again</p>");
		windows[0]?.close();
		lifecycle.openWindow();
		expect(windows[1]?.webview.loadHTML).toHaveBeenCalledWith("<p>Failed again</p>");
	});

	test("quit is shared, waits for shutdown, and suppresses reopening and page changes", async () => {
		let finish = () => {};
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const { lifecycle, deps, windows } = fixture(() => pending);
		lifecycle.openWindow();
		const completion = lifecycle.quit();
		expect(lifecycle.quit()).toBe(completion);
		expect(lifecycle.isQuitting).toBe(true);
		expect(lifecycle.openWindow()).toBeNull();
		lifecycle.setReady("http://localhost:7779");
		lifecycle.setError("ignored");
		expect(windows[0]?.webview.loadURL).not.toHaveBeenCalled();
		expect(windows[0]?.webview.loadHTML).toHaveBeenCalledTimes(1);
		windows[0]?.close();
		await Promise.resolve();
		expect(deps.shutdown).toHaveBeenCalledTimes(1);
		expect(deps.disposeTray).not.toHaveBeenCalled();
		expect(deps.exit).not.toHaveBeenCalled();
		finish();
		await completion;
		expect(deps.disposeTray).toHaveBeenCalledTimes(1);
		expect(deps.exit).toHaveBeenCalledTimes(1);
		expect(lifecycle.quit()).toBe(completion);
		expect(lifecycle.openWindow()).toBeNull();
	});

	test("tray failure makes close quit instead of leaving an unreachable process", async () => {
		const { lifecycle, deps, windows } = fixture();
		lifecycle.setBackgroundAvailable(true);
		lifecycle.openWindow();
		lifecycle.setBackgroundAvailable(false);
		windows[0]?.close();
		expect(lifecycle.isQuitting).toBe(true);
		await lifecycle.quit();
		expect(deps.shutdown).toHaveBeenCalledTimes(1);
		expect(deps.exit).toHaveBeenCalledTimes(1);
	});

	test("background operation is opt-in", async () => {
		const { lifecycle, windows } = fixture();
		lifecycle.openWindow();
		windows[0]?.close();
		expect(lifecycle.isQuitting).toBe(true);
		await lifecycle.quit();
	});

	test("shutdown rejection preserves the tray and allows reopening and retry", async () => {
		const order: string[] = [];
		const failure = new Error("shutdown failed");
		let shouldFail = true;
		const { lifecycle, deps } = fixture(async () => {
			order.push("shutdown");
			if (shouldFail) throw failure;
		});
		deps.disposeTray.mockImplementation(() => {
			order.push("tray");
		});
		deps.exit.mockImplementation(() => {
			order.push("exit");
		});
		const completion = lifecycle.quit();
		expect(lifecycle.quit()).toBe(completion);
		await expect(completion).rejects.toBe(failure);
		expect(order).toEqual(["shutdown"]);
		expect(deps.disposeTray).not.toHaveBeenCalled();
		expect(deps.exit).not.toHaveBeenCalled();
		expect(lifecycle.isQuitting).toBe(false);
		expect(lifecycle.openWindow()).not.toBeNull();
		shouldFail = false;
		const retry = lifecycle.quit();
		expect(retry).not.toBe(completion);
		expect(lifecycle.quit()).toBe(retry);
		await retry;
		expect(order).toEqual(["shutdown", "shutdown", "tray", "exit"]);
		expect(lifecycle.isQuitting).toBe(true);
	});

	test("close-triggered shutdown rejection is reported", async () => {
		const failure = new Error("shutdown failed");
		const { lifecycle, deps, windows } = fixture(async () => {
			throw failure;
		});
		deps.onError.mockImplementation(() => {
			expect(lifecycle.isQuitting).toBe(false);
			lifecycle.setError("<p>Shutdown failed</p>");
			lifecycle.openWindow();
		});
		lifecycle.openWindow();
		windows[0]?.close();
		await expect(lifecycle.quit()).rejects.toBe(failure);
		expect(deps.onError).toHaveBeenCalledWith(failure);
		expect(deps.disposeTray).not.toHaveBeenCalled();
		expect(deps.exit).not.toHaveBeenCalled();
		expect(lifecycle.hasWindow).toBe(true);
		expect(windows[1]?.webview.loadHTML).toHaveBeenCalledWith("<p>Shutdown failed</p>");
	});

	test("exit still runs when tray disposal throws", async () => {
		const { lifecycle, deps } = fixture();
		deps.disposeTray.mockImplementation(() => {
			throw new Error("tray failed");
		});
		await expect(lifecycle.quit()).rejects.toThrow("tray failed");
		expect(deps.exit).toHaveBeenCalledTimes(1);
	});
});
