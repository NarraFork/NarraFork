import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type CoordinatorOptions, startCoordinator } from "../../remote-coordinator";
import { buildPeer } from "../../scripts/webrtc-prototype";
import { createProductionRemoteBackendHarness } from "../../server/services/__tests__/remote-access-harness";
import { RemotePeerProcess } from "../../server/services/remote-access-ipc";
import type { RemoteBackendIdentity } from "../../shared/remote-access/application";
import type { RemotePeerOpen } from "../../shared/remote-access/ipc";
import type { RemoteAccessInvitation } from "../../shared/remote-access/management";
import { REMOTE_REQUEST_POLICY } from "../../shared/remote-access/request-policy";

const ROOT = resolve(import.meta.dir, "../..");

export function productionTestBrowserExecutable(): string {
	const candidates = [
		process.env.NF_TEST_CHROMIUM_PATH,
		process.env.PUPPETEER_EXECUTABLE_PATH,
		"/usr/bin/chromium",
		"/usr/bin/google-chrome",
	];
	for (const home of new Set([process.env.NARRAFORK_ORIGINAL_HOME, homedir()])) {
		if (!home) continue;
		const cache = join(home, ".cache/puppeteer");
		if (!existsSync(cache)) continue;
		for (const path of new Bun.Glob("chrome/*/chrome-linux64/chrome").scanSync({ cwd: cache }))
			candidates.push(join(cache, path));
	}
	const executable = candidates.find((path): path is string => !!path && existsSync(path));
	if (!executable) throw new Error("CHROMIUM_REQUIRED: production RTC acceptance cannot skip");
	return executable;
}

export async function waitForProductionTest(
	check: () => boolean | Promise<boolean>,
	label: string,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error(`RTC acceptance timed out: ${label}`);
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	}
}

/** Real Go, signaling and NF application. No fixture auth/routes and no main/serve startup. */
export async function startProductionRemoteTestRuntime(
	options: {
		/** Test identities exercise version selection, not historical backend implementations. */
		identity?: RemoteBackendIdentity;
		assetHandler?: CoordinatorOptions["assetHandler"];
	} = {},
) {
	if (process.env.NARRAFORK_TEST !== "1") throw new Error("Isolated test HOME required");
	const directory = await mkdtemp(join(ROOT, ".webrtc-prototype-production-"));
	let coordinator: Awaited<ReturnType<typeof startCoordinator>> | undefined;
	let backend: ReturnType<typeof createProductionRemoteBackendHarness> | undefined;
	let peer: RemotePeerProcess | undefined;
	let closing = false;
	let peerFailed = false;
	let stopped: Promise<void> | undefined;
	const errors: string[] = [];
	function stop() {
		stopped ??= (async () => {
			closing = true;
			try {
				await peer?.stop();
			} finally {
				await backend?.stop();
				await coordinator?.stop();
				await rm(directory, { recursive: true, force: true });
			}
		})();
		return stopped;
	}
	try {
		const binary = join(directory, process.platform === "win32" ? "peer.exe" : "peer");
		await buildPeer(binary, AbortSignal.timeout(120_000));
		const clientBuild = await Bun.build({
			entrypoints: [join(ROOT, "shared/remote-access/browser-client.ts")],
			target: "browser",
			format: "esm",
		});
		if (!clientBuild.success) throw new Error("Production browser client build failed");
		const javascript = clientBuild.outputs.find((output) => output.path.endsWith(".js"));
		if (!javascript) throw new Error("Production browser client output missing");
		coordinator = await startCoordinator({
			allowLocalhost: true,
			async assetHandler(request) {
				const injected = await options.assetHandler?.(request);
				if (injected !== undefined) return injected;
				const path = new URL(request.url).pathname;
				if (path === "/")
					return new Response('<!doctype html><html><body><main id="root"></main></body></html>', {
						headers: { "Content-Type": "text/html; charset=utf-8" },
					});
				if (path === "/client.js")
					return new Response(javascript, { headers: { "Content-Type": "text/javascript" } });
				return undefined;
			},
		});
		backend = createProductionRemoteBackendHarness({
			identity: options.identity,
			notify(type, payload) {
				if (!closing && !peerFailed) peer?.send(type, payload);
			},
		});
		const liveBackend = backend;
		peer = new RemotePeerProcess(
			binary,
			backend.epoch,
			{
				mode: "narrafork",
				signalUrl: coordinator.signalUrl,
				bridgeUrl: backend.bridge.url,
				bridgeSecret: backend.processCapability,
				statePath: join(directory, "state", "peer.json"),
				stunUrls: [],
				allowLocalhost: true,
				leaseSeconds: 300,
				backendIdentity: backend.identity,
				requestPolicy: REMOTE_REQUEST_POLICY,
			},
			(event) => {
				if (closing) return;
				if (event.type === "peer.open") {
					const accepted = liveBackend.registry.accept(event.payload as unknown as RemotePeerOpen);
					peer?.send("peer.accept", { ...accepted }, event.requestId);
				} else if (event.type === "peer.closed" && typeof event.payload.peerId === "string")
					liveBackend.registry.closePeer(event.payload.peerId);
			},
			(code) => {
				peerFailed = true;
				if (!closing) {
					errors.push(code);
					liveBackend.registry.dispose();
				}
			},
		);
		await peer.ready;
		const liveCoordinator = coordinator;
		await waitForProductionTest(() => liveCoordinator.stats().instances === 1, "Go registration");
		const result = await peer.command("pair.create");
		const invitation = result.invitation as RemoteAccessInvitation;
		if (!invitation?.instanceId || !invitation.pairingSecret || !invitation.signalUrl)
			throw new Error("Production one-time invitation missing");
		await waitForProductionTest(
			() => liveCoordinator.stats().discoveries > 0,
			"invitation discovery",
		);
		return { directory, coordinator, backend, peer, invitation, errors, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}
