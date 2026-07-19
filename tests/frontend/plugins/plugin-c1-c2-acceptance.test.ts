import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createPluginAssetShell,
	createPluginNonce,
} from "../../../frontend/components/plugins/asset-shell";
import {
	PluginContributionStore,
	toPluginUiContribution,
} from "../../../frontend/components/plugins/PluginContributionStore";
import type { PluginDockPanelParams } from "../../../frontend/components/plugins/protocol";
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

		expect(shell).toContain("sandbox allow-scripts");
		expect(shell).not.toContain("allow-same-origin");
		expect(shell).toContain("connect-src 'none'");
		expect(shell).toContain(`script-src 'nonce-${nonce}'`);
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
