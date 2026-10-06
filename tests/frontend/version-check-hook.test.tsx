import { afterEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useVersionCheck } from "../../frontend/hooks/useVersionCheck";
import { removeWSStatus, setWSStatus } from "../../frontend/lib/ws-status";

const restorers: Array<() => void> = [];
function install(key: string, value: unknown) {
	const original = Object.getOwnPropertyDescriptor(globalThis, key);
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	restorers.push(() => {
		if (original) Object.defineProperty(globalThis, key, original);
		else Reflect.deleteProperty(globalThis, key);
	});
}
afterEach(() => {
	removeWSStatus("version-test");
	for (const restore of restorers.reverse()) restore();
	restorers.length = 0;
});

test("mount, reconnect, foreground, online and SW hints probe live health; unmount unsubscribes", async () => {
	const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
	install("window", window);
	install("document", window.document);
	install("navigator", {});
	install("__APP_VERSION__", "1.0.0");
	install("IS_REACT_ACT_ENVIRONMENT", true);
	Object.defineProperty(window.document, "visibilityState", {
		configurable: true,
		value: "visible",
	});
	const sw = new EventTarget();
	install("navigator", { serviceWorker: sw });
	let requests = 0;
	install("fetch", async (_url: string, options: RequestInit) => {
		requests++;
		expect(options.cache).toBe("no-store");
		return Response.json({ status: "ok", version: "1.0.0" });
	});
	function Probe() {
		useVersionCheck(60_000);
		return null;
	}
	const container = window.document.getElementById("root");
	if (!container) throw new Error("Missing test root");
	const root = createRoot(container);
	try {
		await act(async () => root.render(<Probe />));
		expect(requests).toBe(1);
		await act(async () => {
			setWSStatus("version-test", { label: "test", connected: false });
			setWSStatus("version-test", { label: "test", connected: true });
		});
		expect(requests).toBe(2);
		await act(async () => window.document.dispatchEvent(new window.Event("visibilitychange")));
		expect(requests).toBe(3);
		await act(async () => window.dispatchEvent(new window.Event("online")));
		expect(requests).toBe(4);
		await act(async () =>
			sw.dispatchEvent(new MessageEvent("message", { data: { type: "VERSION_MISMATCH" } })),
		);
		expect(requests).toBe(5);
	} finally {
		await act(async () => root.unmount());
	}
	window.dispatchEvent(new window.Event("online"));
	setWSStatus("version-test", { label: "test", connected: false });
	setWSStatus("version-test", { label: "test", connected: true });
	expect(requests).toBe(5);
});
