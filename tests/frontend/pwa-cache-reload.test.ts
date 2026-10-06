import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
	clearPwaCache,
	clearPwaCacheAndReload,
	fetchServerHealth,
	waitForUpdatedServerAndReload,
} from "../../frontend/lib/pwa";

const originals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
	if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const href = "https://example.test/sub/projects/abc?filter=a%20b&filter=c#details";
let replace = mock((_url: string) => {});
beforeEach(() => {
	replace = mock((_url: string) => {});
	install("window", { setTimeout, clearTimeout, location: { href, replace }, caches: {} });
	install("navigator", { serviceWorker: { getRegistrations: async () => [] } });
	install("caches", { keys: async () => [], delete: async () => true });
});
afterEach(() => {
	for (const [name, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originals.clear();
});

test("worker enumeration failure does not prevent cache cleanup", async () => {
	const remove = mock(async () => true);
	install("navigator", {
		serviceWorker: {
			getRegistrations: async () => {
				throw Error("SW");
			},
		},
	});
	install("caches", { keys: async () => ["shell"], delete: remove });
	await clearPwaCache();
	expect(remove).toHaveBeenCalledWith("shell");
});
test("cache enumeration failure does not prevent unregistering workers", async () => {
	const unregister = mock(async () => true);
	install("navigator", { serviceWorker: { getRegistrations: async () => [{ unregister }] } });
	install("caches", {
		keys: async () => {
			throw Error("cache");
		},
	});
	await clearPwaCache();
	expect(unregister).toHaveBeenCalledTimes(1);
});
test("synchronous per-entry failures do not skip other entries", async () => {
	const unregister = mock(async () => true);
	const remove = mock((key: string) => {
		if (key === "bad") throw Error("bad");
		return Promise.resolve(true);
	});
	install("navigator", {
		serviceWorker: {
			getRegistrations: async () => [
				{
					unregister: () => {
						throw Error("bad");
					},
				},
				{ unregister },
			],
		},
	});
	install("caches", { keys: async () => ["bad", "good"], delete: remove });
	await clearPwaCache();
	expect(unregister).toHaveBeenCalledTimes(1);
	expect(remove).toHaveBeenCalledWith("good");
});
test("hung cleanup has one total deadline while independent work starts", async () => {
	const never = new Promise<never>(() => {});
	const remove = mock(async () => true);
	let expire: (() => void) | undefined;
	let deadline = 0;
	install("window", {
		caches: {},
		clearTimeout: mock(() => {}),
		setTimeout: (callback: () => void, ms: number) => {
			expire = callback;
			deadline = ms;
			return 1;
		},
	});
	install("navigator", { serviceWorker: { getRegistrations: () => never } });
	install("caches", { keys: async () => ["shell"], delete: remove });
	const pending = clearPwaCache();
	await Promise.resolve();
	await Promise.resolve();
	expect(remove).toHaveBeenCalledTimes(1);
	expect(deadline).toBe(3000);
	expect(expire).toBeDefined();
	expire?.();
	await pending;
});
test("health rejects malformed versions but preserves failed/recovering readiness", async () => {
	for (const version of [undefined, null, 42, {}, "", "   "]) {
		install("fetch", async () => Response.json({ version }));
		expect(await fetchServerHealth()).toBeNull();
	}
	for (const readiness of ["recovering", "failed"]) {
		const health = { status: readiness, readiness, version: "1.2.3" };
		install("fetch", async () => Response.json(health, { status: 503 }));
		expect(await fetchServerHealth()).toEqual(health);
	}
});
test("concurrent refresh and updated-server polling share one URL-preserving navigation", async () => {
	const unregister = mock(async () => true);
	install("navigator", { serviceWorker: { getRegistrations: async () => [{ unregister }] } });
	install("fetch", async () => Response.json({ status: "recovering", version: "1.2.3" }));
	const first = clearPwaCacheAndReload();
	expect(clearPwaCacheAndReload()).toBe(first);
	await Promise.all([first, waitForUpdatedServerAndReload({ targetVersion: "1.2.3" })]);
	expect(unregister).toHaveBeenCalledTimes(1);
	expect(replace).toHaveBeenCalledTimes(1);
	const destination = new URL(replace.mock.calls[0]?.[0] ?? "");
	expect(destination.origin).toBe("https://example.test");
	expect(destination.pathname).toBe("/sub/projects/abc");
	expect(destination.searchParams.getAll("filter")).toEqual(["a b", "c"]);
	expect(destination.hash).toBe("#details");
	expect(destination.searchParams.get("_nf_reload")).toMatch(/^\d+-[a-f0-9-]+$/);
});
test("cancelled navigation leaves a later manual refresh available", async () => {
	// Cancelling beforeunload leaves the document alive while replace returns normally.
	// The no-op location mock models that outcome; no unload means module state survives.
	const first = clearPwaCacheAndReload();
	expect(clearPwaCacheAndReload()).toBe(first);
	await first;
	expect(replace).toHaveBeenCalledTimes(1);

	// The user saves the file and retries without recreating the page/module.
	const retry = clearPwaCacheAndReload();
	expect(retry).not.toBe(first);
	expect(clearPwaCacheAndReload()).toBe(retry);
	await retry;
	expect(replace).toHaveBeenCalledTimes(2);
});
test("failed navigation does not permanently cache a rejected refresh", async () => {
	replace.mockImplementationOnce(() => {
		throw new Error("Navigation blocked");
	});
	await expect(clearPwaCacheAndReload()).rejects.toThrow("Navigation blocked");
	await clearPwaCacheAndReload();
	expect(replace).toHaveBeenCalledTimes(2);
});
