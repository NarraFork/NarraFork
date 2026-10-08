import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import puppeteer from "puppeteer-core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createPluginAssetShell,
	createPluginNonce,
} from "../../../frontend/components/plugins/asset-shell";
import { routePluginUiHostLocalRequest } from "../../../frontend/components/plugins/host-local-router";
import {
	PluginContributionStore,
	toPluginUiContribution,
} from "../../../frontend/components/plugins/PluginContributionStore";
import { PluginDockPanelView } from "../../../frontend/components/plugins/PluginDockPanel";
import { PluginUiSurfaceProvider } from "../../../frontend/components/plugins/PluginUiSurfaceContext";
import {
	RuntimeContext,
	type RuntimeContextValue,
} from "../../../frontend/components/plugins/plugin-ui-runtime-context";
import type {
	JsonValue,
	PluginDockPanelParams,
	UiRpcResponse,
} from "../../../frontend/components/plugins/protocol";
import { PluginUiSession } from "../../../frontend/components/plugins/runtime";
import type { PluginUiContribution } from "../../../frontend/components/plugins/types";
import { parseManifest } from "../../../server/lib/plugins/manifest";

const hostileFixture = join(import.meta.dir, "../../fixtures/plugins/e2e/reference-ui-hostile");

const panelParams: PluginDockPanelParams = {
	panelType: "plugin",
	schemaVersion: 1,
	pluginId: "com.example.hostile-ui",
	contributionId: "hostile-panel",
	panelInstanceId: "hostile-panel-1",
	binding: { kind: "global" },
};

const contribution: PluginUiContribution = {
	pluginId: panelParams.pluginId,
	contributionId: panelParams.contributionId,
	version: "1.0.0",
	title: "Hostile sandbox probe",
	packageHash: "a".repeat(64),
	entryPath: "ui/hostile.iife.js",
	stylePath: "ui/hostile.css",
	entryUrl: "/api/plugins/ui/com.example.hostile-ui/1.0.0/hash/asset/session/ui/hostile.iife.js",
	styleUrl: "/api/plugins/ui/com.example.hostile-ui/1.0.0/hash/asset/session/ui/hostile.css",
	status: "available",
};

interface BootstrapMessage {
	nonce: string;
	pluginId: string;
	contributionId: string;
	panelInstanceId: string;
}

function fakeIframe(
	onBootstrap: (message: BootstrapMessage, pluginPort: MessagePort) => void,
): HTMLIFrameElement {
	return {
		contentWindow: {
			postMessage(message: unknown, _targetOrigin: string, transfer: MessagePort[]) {
				const pluginPort = transfer[0];
				if (!pluginPort) throw new Error("Plugin session did not transfer a MessagePort");
				onBootstrap(message as BootstrapMessage, pluginPort);
			},
		},
	} as unknown as HTMLIFrameElement;
}

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const poll = () => {
			if (predicate()) return resolve();
			if (Date.now() >= deadline) return reject(new Error("Timed out waiting for plugin UI state"));
			setTimeout(poll, 1);
		};
		poll();
	});
}

function attachAndHandshake(session: PluginUiSession): { pluginPort: MessagePort } {
	let pluginPortRef: MessagePort | undefined;
	session.attach(
		fakeIframe((bootstrap, pluginPort) => {
			pluginPortRef = pluginPort;
			pluginPort.start();
			queueMicrotask(() => {
				pluginPort.postMessage({
					protocol: "narrafork.ui/1",
					kind: "request",
					id: `handshake-${bootstrap.panelInstanceId}`,
					method: "handshake",
					params: {
						nonce: bootstrap.nonce,
						protocolVersion: 1,
						pluginId: bootstrap.pluginId,
						contributionId: bootstrap.contributionId,
						panelInstanceId: bootstrap.panelInstanceId,
					},
				});
			});
		}),
	);
	if (!pluginPortRef) throw new Error("Plugin iframe bootstrap was not delivered synchronously");
	return { pluginPort: pluginPortRef };
}

function activeMessagePorts(): number | undefined {
	const getActiveResourcesInfo = (
		process as typeof process & { getActiveResourcesInfo?: () => string[] }
	).getActiveResourcesInfo;
	return getActiveResourcesInfo?.().filter((name) => name === "MessagePort").length;
}

describe("C2 UI contribution discovery and lifecycle states", () => {
	test("discovers contributions, preserves disabled/denied placeholders, and removes missing entries", () => {
		const store = new PluginContributionStore();
		let notifications = 0;
		store.subscribe(() => {
			notifications += 1;
		});
		const available = {
			pluginId: "com.example.hostile-ui",
			contributionId: "hostile-panel",
			version: "1.0.0",
			hash: "a".repeat(64),
			title: "Hostile sandbox probe",
			entryPath: "ui/hostile.iife.js",
			stylePath: "ui/hostile.css",
			status: "available",
		};

		expect(store.applySnapshot([available])).toBe(1);
		const first = store.get(available.pluginId, available.contributionId);
		expect(first?.availability).toBe("available");
		expect(toPluginUiContribution(first as NonNullable<typeof first>)).toMatchObject({
			packageHash: "a".repeat(64),
			entryPath: "ui/hostile.iife.js",
			stylePath: "ui/hostile.css",
		});

		store.applySnapshot([
			{ ...available, status: "disabled", unavailableReason: "administrator disabled plugin" },
		]);
		expect(store.list()).toHaveLength(1);
		expect(store.get(available.pluginId, available.contributionId)).toMatchObject({
			availability: "disabled",
			unavailableReason: "administrator disabled plugin",
		});

		store.applySnapshot([
			{ ...available, status: "denied", unavailableReason: "grant revision was revoked" },
		]);
		expect(store.get(available.pluginId, available.contributionId)).toMatchObject({
			availability: "denied",
			unavailableReason: "grant revision was revoked",
		});

		store.applySnapshot([]);
		expect(store.has(available.pluginId, available.contributionId)).toBe(false);
		expect(store.list()).toHaveLength(0);
		expect(notifications).toBe(4);
	});

	test("treats package hash/version changes as a new session identity", () => {
		const store = new PluginContributionStore();
		store.applySnapshot([
			{
				pluginId: panelParams.pluginId,
				contributionId: panelParams.contributionId,
				version: "1.0.0",
				hash: "a".repeat(64),
				title: contribution.title,
				entryPath: contribution.entryPath,
				stylePath: contribution.stylePath,
				status: "available",
			},
		]);
		const before = store.get(panelParams.pluginId, panelParams.contributionId);
		store.applySnapshot([
			{
				pluginId: panelParams.pluginId,
				contributionId: panelParams.contributionId,
				version: "1.1.0",
				hash: "b".repeat(64),
				title: contribution.title,
				entryPath: contribution.entryPath,
				stylePath: contribution.stylePath,
				status: "available",
			},
		]);
		const after = store.get(panelParams.pluginId, panelParams.contributionId);
		expect(after).not.toBe(before);
		expect(after).toMatchObject({ version: "1.1.0", hash: "b".repeat(64) });
		expect(store.getSnapshot().revision).toBe(2);
	});
});

function renderProductionIframe(shell: string): HTMLIFrameElement {
	// Only transport/host capabilities are supplied. The real panel renderer owns
	// iframe sandbox/allow/referrer attributes; no test-authored iframe can stand in.
	const runtime: RuntimeContextValue = {
		revision: 1,
		resolveContribution: () => contribution,
		getSessionSnapshot: () => ({ panelInstanceId: panelParams.panelInstanceId, status: "ready" }),
		getSessionController: () => ({
			getSrcdoc: () => shell,
			attach() {},
			setVisibility() {},
			setActive() {},
			setFocused() {},
		}),
		ensureSession() {},
		updateSessionParams() {},
		reloadSession() {},
		disposeSession() {},
		registerPanelDelegate: () => () => {},
		registerSlot: () => () => {},
		updateSlot() {},
		getSessions: () => [],
		getSlots: () => [],
	};
	const qc = new QueryClient();
	try {
		const markup = renderToStaticMarkup(
			createElement(
				MantineProvider,
				{ env: "test" },
				createElement(
					QueryClientProvider,
					{ client: qc },
					createElement(
						RuntimeContext.Provider,
						{ value: runtime },
						createElement(
							PluginUiSurfaceProvider,
							{
								hostContext: { surface: "settings" },
							} as Parameters<typeof PluginUiSurfaceProvider>[0],
							createElement(PluginDockPanelView, {
								rawParams: panelParams,
								hostApi: {
									isActive: true,
									setTitle() {},
									updateParameters() {},
									setActive() {},
									close() {},
								},
							}),
						),
					),
				),
			),
		);
		const iframe = parseHTML(markup).document.querySelector("iframe");
		if (!iframe) throw new Error("Production plugin panel did not render an iframe");
		return iframe;
	} finally {
		qc.clear();
	}
}

function chromiumExecutable(): string {
	const cache = join(homedir(), ".cache/puppeteer");
	const cached = existsSync(cache)
		? Array.from(
				new Bun.Glob("chrome/*/chrome-linux64/chrome").scanSync({ cwd: cache, onlyFiles: true }),
				(path) => join(cache, path),
			)
		: [];
	const path = [
		process.env.NF_TEST_CHROMIUM_PATH,
		process.env.PUPPETEER_EXECUTABLE_PATH,
		"/usr/bin/chromium",
		"/usr/bin/google-chrome",
		...cached,
	].find((candidate): candidate is string => !!candidate && existsSync(candidate));
	if (!path) throw new Error("Chromium is required to verify plugin sandbox enforcement");
	return path;
}

describe("hostile iframe acceptance fixture", () => {
	test("is a strict self-contained view package with distinct per-view assets", async () => {
		const manifest = parseManifest(
			JSON.parse(await readFile(join(hostileFixture, "manifest.json"), "utf8")),
		);
		expect(manifest.pluginId).toBe(panelParams.pluginId);
		expect(manifest.permissions.host).toEqual(["ui.panel"]);
		expect(manifest.contributes.views.map((view) => view.entry)).toEqual([
			"ui/hostile.iife.js",
			"ui/quiet.iife.js",
		]);
		expect(new Set(manifest.contributes.views.map((view) => view.style)).size).toBe(2);
	});

	test("generates an opaque-origin shell and the fixture probes the required attack surfaces", async () => {
		const nonce = createPluginNonce();
		const shell = createPluginAssetShell({
			nonce,
			pluginId: panelParams.pluginId,
			contributionId: panelParams.contributionId,
			panelInstanceId: panelParams.panelInstanceId,
			entryUrl: contribution.entryUrl,
			styleUrl: contribution.styleUrl,
		});
		const hostileScript = await readFile(join(hostileFixture, "ui/hostile.iife.js"), "utf8");

		const iframe = renderProductionIframe(shell);
		expect(iframe.getAttribute("sandbox")?.split(/\s+/)).toEqual(["allow-scripts"]);
		expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
		expect(iframe.getAttribute("allow")).toBe("");
		expect(iframe.getAttribute("referrerPolicy")).toBe("no-referrer");
		expect(iframe.getAttribute("srcDoc")).toBe(shell);
		const csp = parseHTML(shell)
			.document.querySelector('meta[http-equiv="Content-Security-Policy"]')
			?.getAttribute("content");
		expect(csp).toBeDefined();
		// Sandbox in meta CSP is inert. Assert the actual DOM boundary above and
		// the executable CSP restrictions here, rather than a reassuring string.
		expect(csp).not.toMatch(/(?:^|;)\s*sandbox\b/);
		expect(shell).not.toContain("allow-same-origin");
		for (const directive of [
			"default-src",
			"connect-src",
			"frame-src",
			"child-src",
			"worker-src",
			"object-src",
			"base-uri",
			"form-action",
			"manifest-src",
			"media-src",
		])
			expect(csp).toContain(`${directive} 'none'`);
		expect(csp).toContain(`script-src 'nonce-${nonce}'`);
		expect(csp).not.toContain("'unsafe-eval'");
		expect(shell).not.toContain("narrafork_token");
		for (const probe of [
			"window.parent.document",
			"window.parent.localStorage",
			"localStorage.setItem",
			'fetch("/api/health"',
			"window.top.location.replace",
			'atob("ZXZhbA==")',
		]) {
			expect(hostileScript).toContain(probe);
		}
	});
});

test("Chromium enforces the production iframe's opaque origin against parent, storage, workers and top navigation", async () => {
	const hostileScript = await readFile(join(hostileFixture, "ui/hostile.iife.js"), "utf8");
	let html = "";
	let healthRequests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/") return new Response(html, { headers: { "Content-Type": "text/html" } });
			if (path === "/api/health") {
				healthRequests++;
				return Response.json({ leaked: true });
			}
			if (path.endsWith("hostile.iife.js"))
				return new Response(hostileScript, {
					headers: { "Content-Type": "application/javascript" },
				});
			if (path.endsWith("hostile.css"))
				return new Response("", { headers: { "Content-Type": "text/css" } });
			return new Response("not found", { status: 404 });
		},
	});
	const origin = `http://127.0.0.1:${server.port}`;
	const nonce = createPluginNonce();
	let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
	try {
		const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
		let shell: string;
		try {
			Object.defineProperty(globalThis, "location", { configurable: true, value: { origin } });
			shell = createPluginAssetShell({
				nonce,
				pluginId: panelParams.pluginId,
				contributionId: panelParams.contributionId,
				panelInstanceId: panelParams.panelInstanceId,
				entryUrl: contribution.entryUrl,
				styleUrl: contribution.styleUrl,
			});
		} finally {
			if (previous) Object.defineProperty(globalThis, "location", previous);
			else Reflect.deleteProperty(globalThis, "location");
		}
		const frame = renderProductionIframe(shell);
		const bootstrap = JSON.stringify({
			type: "narrafork:ui-connect",
			protocol: "narrafork.ui/1",
			hostProtocolRange: { min: 1, max: 1 },
			nonce,
			pluginId: panelParams.pluginId,
			contributionId: panelParams.contributionId,
			panelInstanceId: panelParams.panelInstanceId,
		});
		// This fixture only transports the real shell handshake and probe result.
		// Sandbox enforcement is Chromium's, not a mocked successful/failed probe.
		html = `<!doctype html><html><body>${frame.outerHTML}<script>
		localStorage.setItem("narrafork_token", "host-only-secret");
		window.addEventListener("load", () => {
			const channel = new MessageChannel();
			channel.port1.onmessage = ({ data }) => {
				if (data.kind === "notification" && data.method === "hostile.probe") window.probe = data.params;
				if (data.kind === "request") channel.port1.postMessage({ protocol: "narrafork.ui/1", kind: "response", id: data.id,
					result: { plugin: { id: ${JSON.stringify(panelParams.pluginId)}, contributionId: ${JSON.stringify(panelParams.contributionId)} } } });
			};
			document.querySelector("iframe").contentWindow.postMessage(${bootstrap}, "*", [channel.port2]);
		});
		</script></body></html>`;
		browser = await puppeteer.launch({
			executablePath: chromiumExecutable(),
			headless: true,
			args: ["--no-sandbox"],
			timeout: 15_000,
		});
		const page = await browser.newPage();
		await page.goto(origin, { waitUntil: "load", timeout: 15_000 });
		await page.waitForFunction(() => "probe" in window, { timeout: 5_000 });
		const probe = await page.evaluate(
			() => (window as unknown as { probe: Record<string, unknown> }).probe,
		);
		expect(probe).toMatchObject({
			parentDocumentBlocked: true,
			parentStorageBlocked: true,
			opaqueStorageBlocked: true,
			networkBlocked: true,
			topNavigationBlocked: true,
			evalBlocked: true,
			contextPluginId: panelParams.pluginId,
			contextContributionId: panelParams.contributionId,
		});
		const pluginFrame = page
			.frames()
			.find((candidate) => candidate.parentFrame() === page.mainFrame());
		if (!pluginFrame) throw new Error("Missing browser plugin frame");
		const workers = await pluginFrame.evaluate(async () => {
			let serviceWorkerBlocked = false;
			let workerBlocked = false;
			try {
				await navigator.serviceWorker.register("/sw.js");
			} catch {
				serviceWorkerBlocked = true;
			}
			try {
				new Worker("/worker.js");
			} catch {
				workerBlocked = true;
			}
			return { serviceWorkerBlocked, workerBlocked, origin: globalThis.origin };
		});
		expect(workers).toEqual({ serviceWorkerBlocked: true, workerBlocked: true, origin: "null" });
		expect(page.url()).toBe(`${origin}/`);
		expect(healthRequests).toBe(0);
		expect(await page.evaluate(() => localStorage.getItem("narrafork_token"))).toBe(
			"host-only-secret",
		);
	} finally {
		await browser?.close();
		server.stop(true);
	}
}, 30_000);

test("the real MessagePort bridge denies forged permission/keybinding methods and unsafe navigation", async () => {
	const navigated: string[] = [];
	let hostRequests = 0;
	const session = new PluginUiSession({
		params: panelParams,
		contribution,
		defaultTimeoutMs: 250,
		onRequest: (context) => {
			hostRequests++;
			return routePluginUiHostLocalRequest(context, { navigate: (to) => navigated.push(to) });
		},
	});
	const { pluginPort } = attachAndHandshake(session);
	const replies = new Map<string, UiRpcResponse>();
	pluginPort.addEventListener("message", (event) => {
		const message = event.data as UiRpcResponse;
		if (message.kind === "response") replies.set(message.id, message);
	});
	try {
		await waitFor(() => session.getSnapshot().status === "ready");
		let seq = 0;
		async function request(method: string, params?: JsonValue) {
			const id = `attack-${++seq}`;
			pluginPort.postMessage({
				protocol: "narrafork.ui/1",
				kind: "request",
				id,
				method,
				...(params === undefined ? {} : { params }),
			});
			await waitFor(() => replies.has(id));
			return replies.get(id) as UiRpcResponse;
		}
		async function rejectedRequest(method: string, params: JsonValue) {
			const response = await request(method, params);
			expect(response).toHaveProperty("error");
			if (!("error" in response))
				throw new Error(`Attack method unexpectedly succeeded: ${method}`);
			return response.error.code;
		}
		for (const method of ["permissions.request", "keybindings.register", "keybindings.dispatch"])
			expect(
				await rejectedRequest(method, { granted: true, command: "approve-all", key: "Ctrl+Enter" }),
			).toBe("METHOD_NOT_FOUND");
		expect(hostRequests).toBe(0);
		expect(
			await rejectedRequest("ui.openExternal", { url: "https://example.invalid", granted: true }),
		).toBe("NOT_SUPPORTED");
		for (const to of [
			"https://example.invalid",
			"javascript:alert(1)",
			"//example.invalid",
			"/admin",
		])
			expect(await rejectedRequest("ui.navigate", { to })).toBe("INVALID_PARAMS");
		expect(navigated).toEqual([]);
		const accepted = await request("ui.navigate", { to: "/narrators/n1" });
		expect(accepted).toHaveProperty("result");
		if (!("result" in accepted)) throw new Error("Valid navigation failed");
		expect(accepted.result).toEqual({ ok: true });
		expect(navigated).toEqual(["/narrators/n1"]);
	} finally {
		session.dispose();
		pluginPort.close();
	}
});

describe("PluginUiSession resource cleanup", () => {
	test("completes 50 handshake/dispose cycles without retained MessagePorts", async () => {
		const beforePorts = activeMessagePorts();
		for (let cycle = 0; cycle < 50; cycle += 1) {
			const params = { ...panelParams, panelInstanceId: `hostile-panel-${cycle}` };
			const session = new PluginUiSession({ params, contribution, defaultTimeoutMs: 250 });
			const { pluginPort } = attachAndHandshake(session);
			await waitFor(() => session.getSnapshot().status === "ready");
			session.dispose();
			pluginPort.close();
			expect(session.getSnapshot().status).toBe("disposed");
		}
		await Bun.sleep(25);
		const afterPorts = activeMessagePorts();
		if (beforePorts !== undefined && afterPorts !== undefined) {
			expect(afterPorts).toBeLessThanOrEqual(beforePorts + 1);
		}
	}, 20_000);

	test("drops messages from a disposed generation after reload", async () => {
		let hostCalls = 0;
		const session = new PluginUiSession({
			params: panelParams,
			contribution,
			defaultTimeoutMs: 250,
			onRequest: () => {
				hostCalls += 1;
				return { ok: true };
			},
		});
		const first = attachAndHandshake(session);
		await waitFor(() => session.getSnapshot().status === "ready");
		session.reload();
		const second = attachAndHandshake(session);
		await waitFor(() => session.getSnapshot().status === "ready");

		first.pluginPort.postMessage({
			protocol: "narrafork.ui/1",
			kind: "request",
			id: "stale-generation",
			method: "context.get",
		});
		second.pluginPort.postMessage({
			protocol: "narrafork.ui/1",
			kind: "request",
			id: "current-generation",
			method: "context.get",
		});
		await waitFor(() => hostCalls === 1);
		await Bun.sleep(10);
		expect(hostCalls).toBe(1);

		session.dispose();
		first.pluginPort.close();
		second.pluginPort.close();
	});
});

test.skip("[BLOCKER] contribution picker discovers and opens a new plugin panel", () => {
	// Unskip when the mounted workspace picker has a stable addPanel acceptance harness.
});

test.skip("[BLOCKER] disable/revoke propagates to two browser windows within one second", () => {
	// Unskip in the browser smoke once lifecycle invalidation + authoritative refetch are wired.
});
