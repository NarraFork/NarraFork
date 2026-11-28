import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { resetAppBaseForTest } from "../../frontend/lib/base-path";
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
	resetAppBaseForTest();
	install("document", { baseURI: "https://example.test/sub/" });
	install("location", { href });
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
	resetAppBaseForTest();
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
	install("caches", { keys: async () => ["narrafork-shell", "other-app"], delete: remove });
	await clearPwaCache();
	expect(remove).toHaveBeenCalledWith("narrafork-shell");
	expect(remove).toHaveBeenCalledTimes(1);
});
test("cache enumeration failure does not prevent unregistering workers", async () => {
	const unregister = mock(async () => true);
	install("navigator", {
		serviceWorker: {
			getRegistrations: async () => [{ scope: "https://example.test/sub/", unregister }],
		},
	});
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
		if (key === "narrafork-bad") throw Error("bad");
		return Promise.resolve(true);
	});
	install("navigator", {
		serviceWorker: {
			getRegistrations: async () => [
				{
					scope: "https://example.test/sub/",
					unregister: () => {
						throw Error("bad");
					},
				},
				{ scope: "https://example.test/sub/nested/", unregister },
			],
		},
	});
	install("caches", {
		keys: async () => ["narrafork-bad", "workbox-precache-good"],
		delete: remove,
	});
	await clearPwaCache();
	expect(unregister).toHaveBeenCalledTimes(1);
	expect(remove).toHaveBeenCalledWith("workbox-precache-good");
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
	install("caches", { keys: async () => ["narrafork-shell"], delete: remove });
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
	install("navigator", {
		serviceWorker: {
			getRegistrations: async () => [{ scope: "https://example.test/sub/", unregister }],
		},
	});
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

test("cleanup only unregisters scopes within the app base", async () => {
	const unregister = mock(async () => true);
	const unrelated = mock(async () => true);
	install("navigator", {
		serviceWorker: {
			getRegistrations: async () => [
				{ scope: "https://example.test/sub/", unregister },
				{ scope: "https://example.test/sub/deeper/", unregister },
				...[
					"https://example.test/",
					"https://example.test/submarine/",
					"https://other.test/sub/",
				].map((scope) => ({ scope, unregister: unrelated })),
			],
		},
	});
	await clearPwaCache();
	expect(unregister).toHaveBeenCalledTimes(2);
	expect(unrelated).not.toHaveBeenCalled();
});

function updatingWorker(
	update: (sw: EventTarget & { controller: unknown }, active: object) => Promise<void>,
) {
	const unregister = mock(async () => true);
	const remove = mock(async () => true);
	const active = {
		postMessage: (_message: unknown, ports: MessagePort[]) =>
			ports[0]?.postMessage({ version: "2.0.0+abc" }),
	};
	const sw = Object.assign(new EventTarget(), {
		controller: {} as unknown,
		getRegistration: mock(async (_url: string) => registration),
		getRegistrations: async () => [registration],
	});
	const registration = {
		scope: "https://example.test/sub/",
		active,
		update: mock(() => update(sw, active)),
		unregister,
	};
	install("navigator", { serviceWorker: sw });
	install("caches", { keys: async () => ["narrafork-shell"], delete: remove });
	install("fetch", async () => Response.json({ status: "ok", version: "2.0.0+abcdef" }));
	return { sw, registration, unregister, remove };
}

test("controllerchange after update reloads without destroying offline assets", async () => {
	const runtime = updatingWorker(async (sw, active) => {
		sw.controller = active;
		sw.dispatchEvent(new Event("controllerchange"));
	});
	await clearPwaCacheAndReload();
	expect(runtime.registration.update).toHaveBeenCalledTimes(1);
	expect(runtime.sw.getRegistration).toHaveBeenCalledWith("https://example.test/sub/");
	expect(runtime.unregister).not.toHaveBeenCalled();
	expect(runtime.remove).not.toHaveBeenCalled();
	expect(replace).toHaveBeenCalledTimes(1);
});

test("matching active worker avoids cleanup without a controllerchange", async () => {
	const runtime = updatingWorker(async () => {});
	await clearPwaCacheAndReload();
	expect(runtime.registration.update).toHaveBeenCalledTimes(1);
	expect(runtime.unregister).not.toHaveBeenCalled();
	expect(runtime.remove).not.toHaveBeenCalled();
	expect(replace).toHaveBeenCalledTimes(1);
});

test("update failure falls back to scoped cleanup", async () => {
	const runtime = updatingWorker(async () => {
		throw Error("offline");
	});
	await clearPwaCacheAndReload();
	expect(runtime.unregister).toHaveBeenCalledTimes(1);
	expect(runtime.remove).toHaveBeenCalledWith("narrafork-shell");
	expect(replace).toHaveBeenCalledTimes(1);
});

test("hung update expires after eight seconds and removes its listener", async () => {
	const runtime = updatingWorker(() => new Promise(() => {}));
	let expire: (() => void) | undefined;
	const originalWindow = window;
	install("window", {
		...originalWindow,
		setTimeout: (callback: () => void, ms: number) => {
			if (ms === 8000) {
				expire = callback;
				return 1;
			}
			return setTimeout(callback, ms);
		},
		clearTimeout,
	});
	const pending = clearPwaCacheAndReload();
	await Promise.resolve();
	expect(expire).toBeDefined();
	expire?.();
	await pending;
	expect(runtime.unregister).toHaveBeenCalledTimes(1);
	expect(runtime.remove).toHaveBeenCalledTimes(1);
	runtime.sw.controller = runtime.registration.active;
	runtime.sw.dispatchEvent(new Event("controllerchange"));
	expect(replace).toHaveBeenCalledTimes(1);
});
