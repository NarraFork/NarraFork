import { describe, expect, test } from "bun:test";
import type { PluginDockPanelParams } from "./protocol";
import { PluginUiSession } from "./runtime";
import type { PluginUiContribution } from "./types";

const params: PluginDockPanelParams = {
	panelType: "plugin",
	schemaVersion: 1,
	pluginId: "com.example.review",
	contributionId: "dashboard",
	panelInstanceId: "pui_review",
	binding: { kind: "global" },
};

const contribution: PluginUiContribution = {
	pluginId: params.pluginId,
	contributionId: params.contributionId,
	version: "1.0.0",
	title: "Review Dashboard",
	entryUrl: "/api/plugin-assets/com.example.review/1/hash/entry.js",
};

interface BootstrapMessage {
	nonce: string;
	pluginId: string;
	contributionId: string;
	panelInstanceId: string;
}

function fakeIframe(
	onBootstrap: (message: BootstrapMessage, port: MessagePort) => void,
): HTMLIFrameElement {
	return {
		contentWindow: {
			postMessage(message: unknown, _targetOrigin: string, transfer: MessagePort[]) {
				const port = transfer.at(0);
				if (!port) throw new Error("Missing transferred MessagePort");
				onBootstrap(message as BootstrapMessage, port);
			},
		},
	} as unknown as HTMLIFrameElement;
}

function waitFor(predicate: () => boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const check = () => {
			if (predicate()) return resolve();
			if (Date.now() - started > 1_000)
				return reject(new Error("Timed out waiting for plugin session"));
			setTimeout(check, 1);
		};
		check();
	});
}

describe("PluginUiSession", () => {
	test("binds the nonce, completes handshake, and routes request IDs", async () => {
		let session: PluginUiSession;
		let slowRequestId = "";
		let bootstrapCount = 0;
		const fake = fakeIframe((bootstrap, pluginPort) => {
			bootstrapCount += 1;
			pluginPort.addEventListener("message", (event) => {
				const request = event.data;
				if (request.method === "handshake") {
					pluginPort.postMessage({
						protocol: "narrafork.ui/1",
						kind: "response",
						id: request.id,
						result: { protocolVersion: 1, context: { panelInstanceId: bootstrap.panelInstanceId } },
					});
					return;
				}
				if (request.method === "context.get") {
					pluginPort.postMessage({
						protocol: "narrafork.ui/1",
						kind: "response",
						id: request.id,
						result: { ok: true },
					});
					return;
				}
				if (request.method === "slow") slowRequestId = request.id;
				if (request.method === "rpc.cancel") return;
			});
			pluginPort.start();
			queueMicrotask(() =>
				pluginPort.postMessage({
					protocol: "narrafork.ui/1",
					kind: "request",
					id: "plugin_handshake",
					method: "handshake",
					params: {
						nonce: bootstrap.nonce,
						protocolVersion: 1,
						pluginId: bootstrap.pluginId,
						contributionId: bootstrap.contributionId,
						panelInstanceId: bootstrap.panelInstanceId,
					},
				}),
			);
		});
		session = new PluginUiSession({ params, contribution });
		session.attach(fake);
		await waitFor(() => session.getSnapshot().status === "ready");
		session.attach(fake);
		expect(bootstrapCount).toBe(1);
		expect(session.getSnapshot().status).toBe("ready");
		expect(await session.request("context.get")).toEqual({ ok: true });
		await expect(session.request("slow", undefined, 5)).rejects.toMatchObject({ code: "TIMEOUT" });
		expect(slowRequestId).toMatch(/^ui_/);
		session.dispose();
		expect(session.getSnapshot().status).toBe("disposed");
	});

	test("fails closed when the plugin does not complete the handshake", async () => {
		const session = new PluginUiSession({ params, contribution, defaultTimeoutMs: 5 });
		session.attach(
			fakeIframe(() => {
				// Deliberately leave the transferred port silent.
			}),
		);
		await waitFor(() => session.getSnapshot().status === "crashed");
		expect(session.getSnapshot().error).toContain("handshake timed out");
		session.dispose();
	});

	test("returns structured HOST_UNAVAILABLE errors from an absent host handler", async () => {
		let pluginResponse: unknown;
		let pluginPortRef: MessagePort | undefined;
		const fake = fakeIframe((bootstrap, pluginPort) => {
			pluginPortRef = pluginPort;
			pluginPort.addEventListener("message", (event) => {
				const request = event.data;
				if (request.id === "missing-host") pluginResponse = request;
			});
			pluginPort.start();
			queueMicrotask(() =>
				pluginPort.postMessage({
					protocol: "narrafork.ui/1",
					kind: "request",
					id: "plugin_handshake",
					method: "handshake",
					params: {
						nonce: bootstrap.nonce,
						protocolVersion: 1,
						pluginId: bootstrap.pluginId,
						contributionId: bootstrap.contributionId,
						panelInstanceId: bootstrap.panelInstanceId,
					},
				}),
			);
		});
		const session = new PluginUiSession({ params, contribution });
		session.attach(fake);
		await waitFor(() => session.getSnapshot().status === "ready");
		pluginPortRef?.postMessage({
			protocol: "narrafork.ui/1",
			kind: "request",
			id: "missing-host",
			method: "context.get",
		});
		await waitFor(() => Boolean(pluginResponse));
		expect(pluginResponse).toMatchObject({
			kind: "response",
			error: { code: "HOST_UNAVAILABLE" },
		});
		session.dispose();
	});

	test("rejects a handshake with a mismatched nonce", async () => {
		const fake = fakeIframe((_bootstrap, pluginPort) => {
			pluginPort.start();
			pluginPort.postMessage({
				protocol: "narrafork.ui/1",
				kind: "request",
				id: "plugin_handshake",
				method: "handshake",
				params: {
					nonce: "wrong_nonce_wrong_nonce_wrong_nonce_wrong_nonce",
					protocolVersion: 1,
					pluginId: params.pluginId,
					contributionId: params.contributionId,
					panelInstanceId: params.panelInstanceId,
				},
			});
		});
		const session = new PluginUiSession({ params, contribution });
		session.attach(fake);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(session.getSnapshot().status).not.toBe("ready");
		session.dispose();
	});
});
