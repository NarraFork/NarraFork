import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	claimVersionReload,
	createVersionRefreshMonitor,
} from "../../frontend/lib/version-refresh";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
afterEach(() => {
	if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "sessionStorage");
});

function setup(version: string | null) {
	const fetchHealth = mock(async () => (version ? { status: "ok", version } : null));
	const reload = mock(async () => {});
	const claim = mock(() => true);
	const onVersion = mock(() => {});
	return {
		fetchHealth,
		reload,
		claim,
		onVersion,
		monitor: createVersionRefreshMonitor("1.0.0", onVersion, { fetchHealth, reload, claim }),
	};
}

describe("live version refresh", () => {
	test("same version and unreachable server never refresh", async () => {
		for (const version of [null, "v1.0.0"]) {
			const { monitor, reload, claim } = setup(version);
			await monitor.check();
			expect(reload).not.toHaveBeenCalled();
			expect(claim).not.toHaveBeenCalled();
		}
	});
	test("different version refreshes once even with concurrent and later checks", async () => {
		const { monitor, reload, fetchHealth, onVersion } = setup("v2.0.0");
		await Promise.all([monitor.check(), monitor.check(), monitor.check()]);
		await monitor.check();
		expect(fetchHealth).toHaveBeenCalledTimes(1);
		expect(onVersion).toHaveBeenCalledWith("2.0.0");
		expect(reload).toHaveBeenCalledTimes(1);
	});
	test("checks again after a failed request and discovers replacement", async () => {
		const { monitor, reload, fetchHealth } = setup(null);
		await monitor.check();
		fetchHealth.mockResolvedValueOnce({ status: "ok", version: "2.0.0" });
		await monitor.check();
		expect(reload).toHaveBeenCalledTimes(1);
	});
	test("unmount cancels a pending response and prevents further checks", async () => {
		const { monitor, reload, fetchHealth, onVersion } = setup("2.0.0");
		const pending = monitor.check();
		monitor.stop();
		await pending;
		await monitor.check();
		expect(fetchHealth).toHaveBeenCalledTimes(1);
		expect(onVersion).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});
	test("loop guard leaves server version available for manual refresh", async () => {
		const { monitor, reload, claim, onVersion } = setup("2.0.0");
		claim.mockReturnValue(false);
		await monitor.check();
		expect(onVersion).toHaveBeenCalledWith("2.0.0");
		expect(reload).not.toHaveBeenCalled();
	});
	test("persists one attempt per normalized build pair across monitor lifetimes", () => {
		const values = new Map<string, string>();
		Object.defineProperty(globalThis, "sessionStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => values.set(key, value),
			},
		});
		expect(claimVersionReload("v1.0.0", "2.0.0")).toBe(true);
		expect(claimVersionReload("1.0.0", "v2.0.0")).toBe(false);
		expect(claimVersionReload("1.0.0", "3.0.0")).toBe(true);
	});
	test("storage denied keeps manual fallback rather than risking a reload loop", () => {
		Object.defineProperty(globalThis, "sessionStorage", {
			configurable: true,
			get() {
				throw new Error("denied");
			},
		});
		expect(claimVersionReload("1.0.0", "2.0.0")).toBe(false);
	});
});
