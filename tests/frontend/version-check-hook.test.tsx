import { afterEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useVersionCheck } from "../../frontend/hooks/useVersionCheck";
import { removeWSStatus, setWSStatus } from "../../frontend/lib/ws-status";

const restorers: Array<() => void> = [];
function install(key: string, value: unknown, target: object = globalThis) {
	const original = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, { configurable: true, writable: true, value });
	restorers.push(() => {
		if (original) Object.defineProperty(target, key, original);
		else Reflect.deleteProperty(target, key);
	});
}
afterEach(() => {
	removeWSStatus("version-test");
	for (const restore of restorers.reverse()) restore();
	restorers.length = 0;
});

async function mountVersionCheck({
	version = "1.0.0",
	vitePort,
}: {
	version?: string;
	vitePort?: number;
} = {}) {
	const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
	install("window", window);
	install("document", window.document);
	install("__APP_VERSION__", "1.0.0");
	install("__DEV_VITE_PORT__", vitePort);
	install("IS_REACT_ACT_ENVIRONMENT", true);
	Object.defineProperty(window.document, "visibilityState", {
		configurable: true,
		value: "visible",
	});
	const reload = mock(() => {});
	install("location", { href: "https://nf.test/proxy/41221/", replace: reload }, window);
	const values = new Map<string, string>();
	install("sessionStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	});
	const sw = Object.assign(new EventTarget(), { getRegistrations: async () => [] });
	install("navigator", { serviceWorker: sw });
	const fetchHealth = mock(async (_url: string, options: RequestInit) => {
		expect(options.cache).toBe("no-store");
		return Response.json({ status: "ok", version });
	});
	install("fetch", fetchHealth);
	let result: ReturnType<typeof useVersionCheck> | undefined;
	function Probe() {
		result = useVersionCheck(60_000);
		return null;
	}
	const container = window.document.getElementById("root");
	if (!container) throw new Error("Missing test root");
	const root = createRoot(container);
	await act(async () => root.render(<Probe />));
	return {
		window,
		sw,
		fetchHealth,
		reload,
		values,
		read: () => {
			if (!result) throw new Error("Missing hook result");
			return result;
		},
		unmount: () => act(async () => root.unmount()),
	};
}

test("mount, reconnect, foreground, online and SW hints probe live health; unmount unsubscribes", async () => {
	const { window, sw, fetchHealth, unmount } = await mountVersionCheck();
	try {
		expect(fetchHealth).toHaveBeenCalledTimes(1);
		await act(async () => {
			setWSStatus("version-test", { label: "test", connected: false });
			setWSStatus("version-test", { label: "test", connected: true });
		});
		expect(fetchHealth).toHaveBeenCalledTimes(2);
		await act(async () => window.document.dispatchEvent(new window.Event("visibilitychange")));
		expect(fetchHealth).toHaveBeenCalledTimes(3);
		await act(async () => window.dispatchEvent(new window.Event("online")));
		expect(fetchHealth).toHaveBeenCalledTimes(4);
		await act(async () =>
			sw.dispatchEvent(new MessageEvent("message", { data: { type: "VERSION_MISMATCH" } })),
		);
		expect(fetchHealth).toHaveBeenCalledTimes(5);
		await act(async () =>
			sw.dispatchEvent(new MessageEvent("message", { data: { type: "GET_VERSION" } })),
		);
		expect(fetchHealth).toHaveBeenCalledTimes(5);
	} finally {
		await unmount();
	}
	window.dispatchEvent(new window.Event("online"));
	setWSStatus("version-test", { label: "test", connected: false });
	setWSStatus("version-test", { label: "test", connected: true });
	expect(fetchHealth).toHaveBeenCalledTimes(5);
});

for (const vitePort of [41221, 51234]) {
	test(`Vite on ${vitePort} ignores build skew without probing, reloading or showing an update`, async () => {
		const { window, sw, fetchHealth, reload, values, read, unmount } = await mountVersionCheck({
			version: "0.9.16+72bbbcce3",
			vitePort,
		});
		try {
			await act(async () => {
				window.dispatchEvent(new window.Event("online"));
				window.dispatchEvent(new window.Event("pageshow"));
				window.document.dispatchEvent(new window.Event("visibilitychange"));
				sw.dispatchEvent(new MessageEvent("message", { data: { type: "VERSION_MISMATCH" } }));
				setWSStatus("version-test", { label: "test", connected: false });
				setWSStatus("version-test", { label: "test", connected: true });
			});
			expect(fetchHealth).not.toHaveBeenCalled();
			expect(reload).not.toHaveBeenCalled();
			expect(values.size).toBe(0);
			expect(read().updateAvailable).toBe(false);
			expect(read().serverVersion).toBeUndefined();
		} finally {
			await unmount();
		}
	});
}

test("built frontend still detects a changed build and reloads only once", async () => {
	const { window, fetchHealth, reload, values, read, unmount } = await mountVersionCheck({
		version: "0.9.16+72bbbcce3",
	});
	try {
		expect(fetchHealth).toHaveBeenCalledTimes(1);
		expect(read().updateAvailable).toBe(true);
		expect(read().serverVersion).toBe("0.9.16+72bbbcce3");
		expect(reload).toHaveBeenCalledTimes(1);
		expect(values.size).toBe(1);
		await act(async () => window.dispatchEvent(new window.Event("online")));
		expect(reload).toHaveBeenCalledTimes(1);
		await act(async () => read().dismiss());
		expect(read().updateAvailable).toBe(false);
	} finally {
		await unmount();
	}
});
