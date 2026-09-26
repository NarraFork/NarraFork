import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserContext, Target } from "puppeteer-core";
import { installDialogProtection } from "../dialogs";

function fixture(
	options: {
		failHandle?: boolean;
		failEnable?: boolean;
		openDuringEnable?: boolean;
		alreadyOpen?: boolean;
		context?: BrowserContext;
		manager?: EventEmitter;
	} = {},
) {
	let open = options.alreadyOpen ?? false;
	const manager = options.manager ?? new EventEmitter();
	const emitter = new EventEmitter();
	const emit = emitter.emit.bind(emitter);
	const client = Object.assign(emitter, {
		emit: (name: string | symbol, ...args: unknown[]) => {
			if (name === "Page.javascriptDialogOpening") open = true;
			return emit(name, ...args);
		},
		send: mock(async (method: string, _params?: unknown, _options?: unknown) => {
			if (method === "Page.enable") {
				if (options.failEnable) throw new Error("enable failed");
				if (options.openDuringEnable) {
					client.emit("Page.javascriptDialogOpening", { type: "alert", message: "new dialog" });
				}
			}
			if (method === "Page.handleJavaScriptDialog") {
				if (!open) throw new Error("No dialog is showing");
				if (options.failHandle) throw new Error("handle failed");
				open = false;
			}
		}),
		detach: mock(async () => {}),
	});
	const targets: Target[] = [];
	const browser = { _targetManager: () => manager };
	const context =
		options.context ??
		(Object.assign(new EventEmitter(), {
			browser: () => browser,
			targets: () => targets,
		}) as unknown as BrowserContext);
	const target = {
		type: () => "page",
		browserContext: () => context,
		_session: mock(() => client),
		createCDPSession: mock(async () => {
			throw new Error("Must borrow the existing session");
		}),
		page: mock(async () => {
			throw new Error("Must not wait for page initialization");
		}),
	};
	targets.push(target as unknown as Target);
	const messages: string[] = [];
	return { client, target, targets, browser, manager, context, messages, options };
}

async function flush() {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function expectReleased(f: ReturnType<typeof fixture>) {
	expect(f.client.listenerCount("Page.javascriptDialogOpening")).toBe(0);
	expect(f.client.eventNames()).toEqual([]);
	expect(f.client.detach).not.toHaveBeenCalled();
	expect(f.client.send.mock.calls.some(([method]) => method === "Page.disable")).toBe(false);
}

describe("native dialog protection", () => {
	for (const type of ["alert", "confirm", "prompt", "beforeunload"]) {
		test(`dismisses ${type} without accepting business actions`, async () => {
			const f = fixture();
			await installDialogProtection(f.context, (text) => f.messages.push(text));
			f.client.emit("Page.javascriptDialogOpening", { type, message: "message" });
			await flush();
			expect(f.client.send).toHaveBeenCalledWith(
				"Page.handleJavaScriptDialog",
				{ accept: false },
				{ timeout: 3_000 },
			);
			expect(f.messages).toEqual([`Automatically dismissed native dialog (${type}: message)`]);
			expect(f.target.createCDPSession).not.toHaveBeenCalled();
			expect(f.target.page).not.toHaveBeenCalled();
		});
	}

	test("listens before enabling Page and tolerates the probe losing the race", async () => {
		const f = fixture({ openDuringEnable: true });
		await installDialogProtection(f.context, (text) => f.messages.push(text));
		expect(f.messages).toEqual(["Automatically dismissed native dialog (alert: new dialog)"]);
	});

	test("probes already-open dialogs that Page.enable does not replay", async () => {
		const f = fixture({ alreadyOpen: true });
		await installDialogProtection(f.context, (text) => f.messages.push(text));
		expect(f.messages).toEqual([
			"Automatically dismissed native dialog (already open at attachment; type and message unavailable)",
		]);
	});

	test("enqueues Page.enable synchronously on early targetAvailable, before public events", async () => {
		const f = fixture();
		await installDialogProtection(f.context, (text) => f.messages.push(text));
		const popup = fixture({ context: f.context, openDuringEnable: true });
		f.manager.emit("targetAvailable", popup.target);
		// Deliberately assert before yielding: the renderer can resume as soon as emit returns.
		expect(popup.client.send).toHaveBeenCalledWith("Page.enable", undefined, { timeout: 3_000 });
		expect(popup.target._session).toHaveBeenCalledTimes(1);
		expect(popup.target.createCDPSession).not.toHaveBeenCalled();
		expect(popup.target.page).not.toHaveBeenCalled();
		expect(f.context.listenerCount("targetcreated")).toBe(0);
		await flush();
		expect(f.messages).toEqual(["Automatically dismissed native dialog (alert: new dialog)"]);
	});

	test("hooks before enumerating existing targets", async () => {
		const f = fixture();
		const popup = fixture({ context: f.context });
		f.context.targets = () => {
			f.manager.emit("targetAvailable", popup.target);
			return f.targets;
		};
		await installDialogProtection(f.context, () => {});
		expect(popup.target._session).toHaveBeenCalledTimes(1);
	});

	test("deduplicates pending installs, target events and shared-manager hooks", async () => {
		const f = fixture();
		const first = installDialogProtection(f.context, (text) => f.messages.push(text));
		const latest: string[] = [];
		const second = installDialogProtection(f.context, (text) => latest.push(text));
		expect(first).toBe(second);
		f.manager.emit("targetAvailable", f.target);
		await first;
		const other = fixture({ manager: f.manager });
		await installDialogProtection(other.context, () => {});
		expect(f.manager.listenerCount("targetAvailable")).toBe(1);
		expect(f.target._session).toHaveBeenCalledTimes(1);
		expect(f.client.listenerCount("Page.javascriptDialogOpening")).toBe(1);
		f.client.emit("Page.javascriptDialogOpening", { type: "alert", message: "new" });
		await flush();
		expect(f.messages).toEqual([]);
		expect(latest).toEqual(["Automatically dismissed native dialog (alert: new)"]);
	});

	test("does not touch targets from unprotected contexts or non-page targets", async () => {
		const f = fixture();
		await installDialogProtection(f.context, () => {});
		const unrelated = fixture({ manager: f.manager });
		f.manager.emit("targetAvailable", unrelated.target);
		const worker = fixture({ context: f.context });
		worker.target.type = () => "service_worker";
		f.manager.emit("targetAvailable", worker.target);
		await flush();
		for (const ignored of [unrelated, worker]) {
			expect(ignored.target._session).not.toHaveBeenCalled();
			expect(ignored.target.createCDPSession).not.toHaveBeenCalled();
			expect(ignored.target.page).not.toHaveBeenCalled();
			expect(ignored.client.send).not.toHaveBeenCalled();
		}
	});

	test("reports handling failure and bounds captured text", async () => {
		const f = fixture({ failHandle: true });
		await installDialogProtection(f.context, (text) => f.messages.push(text));
		f.client.emit("Page.javascriptDialogOpening", { type: "alert", message: "x".repeat(20_000) });
		await flush();
		expect(f.messages[0]).toContain("Failed to dismiss native dialog");
		expect(f.messages[0]).toContain("handle failed");
		expect(f.messages[0]?.length).toBeLessThan(2_200);
	});

	test("initialization failure cleans all listeners without detaching and permits retry", async () => {
		const f = fixture({ failEnable: true });
		const healthy = fixture({ context: f.context });
		f.targets.unshift(healthy.target as unknown as Target);
		await expect(installDialogProtection(f.context, () => {})).rejects.toThrow(
			"Native dialog protection could not be initialized",
		);
		expectReleased(f);
		expectReleased(healthy);
		expect(f.context.listenerCount("targetdestroyed")).toBe(0);
		f.options.failEnable = false;
		await installDialogProtection(f.context, () => {});
		expect(f.client.listenerCount("Page.javascriptDialogOpening")).toBe(1);
		expect(healthy.client.listenerCount("Page.javascriptDialogOpening")).toBe(1);
		expect(f.manager.listenerCount("targetAvailable")).toBe(1);
		expect(f.target._session).toHaveBeenCalledTimes(2);
	});

	test("reports popup initialization failure and releases the borrowed client listeners", async () => {
		const f = fixture();
		await installDialogProtection(f.context, (text) => f.messages.push(text));
		const popup = fixture({ context: f.context, failEnable: true });
		f.manager.emit("targetAvailable", popup.target);
		await flush();
		expect(f.messages[0]).toContain("Failed to install native dialog protection");
		expect(f.messages[0]).toContain("enable failed");
		expectReleased(popup);
	});

	test("targetdestroyed releases listeners across repeated popup lifecycles without hook accumulation", async () => {
		const f = fixture();
		await installDialogProtection(f.context, () => {});
		for (let i = 0; i < 20; i++) {
			const popup = fixture({ context: f.context });
			f.manager.emit("targetAvailable", popup.target);
			await flush();
			expect(popup.client.listenerCount("Page.javascriptDialogOpening")).toBe(1);
			f.context.emit("targetdestroyed", popup.target as unknown as Target);
			expectReleased(popup);
			const calls = popup.client.send.mock.calls.length;
			popup.client.emit("Page.javascriptDialogOpening", { type: "alert", message: "closed" });
			expect(popup.client.send).toHaveBeenCalledTimes(calls);
		}
		expect(f.manager.listenerCount("targetAvailable")).toBe(1);
		expect(f.context.listenerCount("targetdestroyed")).toBe(1);
	});

	test("fails explicitly if the internal target manager is unavailable", async () => {
		const f = fixture();
		Reflect.deleteProperty(f.browser, "_targetManager");
		await expect(installDialogProtection(f.context, () => {})).rejects.toThrow(
			"Puppeteer target manager unavailable",
		);
		expect(f.target._session).not.toHaveBeenCalled();
	});

	test("fails explicitly if the existing session adapter is unavailable", async () => {
		const f = fixture();
		Reflect.deleteProperty(f.target, "_session");
		await expect(installDialogProtection(f.context, () => {})).rejects.toThrow(
			"Puppeteer target has no existing CDP session",
		);
		expect(f.target.createCDPSession).not.toHaveBeenCalled();
		expect(f.target.page).not.toHaveBeenCalled();
	});
});
