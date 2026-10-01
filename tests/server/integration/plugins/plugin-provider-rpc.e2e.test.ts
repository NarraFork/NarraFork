import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "@server/lib/plugins/manifest";
import { PROVIDER_REQUEST_MAX_BYTES } from "@server/lib/plugins/protocol";
import { PluginManager } from "@server/services/plugin-manager";
import { createPluginProviderAdapterFactory } from "@server/services/plugin-provider-adapter-factory";
import { PluginProviderCatalogRefresher } from "@server/services/plugin-provider-catalog-refresh";
import {
	PluginProviderClientPool,
	type ProviderRuntimeLike,
} from "@server/services/plugin-provider-client";
import { providerRegistrationsFromManifest } from "@server/services/plugin-provider-manifest";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";
import {
	LocalProcessRunner,
	PluginRuntime,
	RuntimeSupervisor,
} from "@server/services/plugin-runtime";

/**
 * The provider counterpart of `plugin-reference-lifecycle.e2e.test.ts`: a real
 * child process, real Content-Length framed JSON-RPC over stdio, driven through the
 * whole host stack that Stage B built.
 *
 * Everything below this test is covered by unit tests with fake runtimes. What only
 * a real process can prove is that the pieces agree on the wire: notification
 * routing, sequence numbering, the accept-before-event ordering rule, and that a
 * cancel actually stops a stream in a separate OS process.
 */

const fixtureRoot = join(import.meta.dir, "../../../fixtures/plugins/e2e/reference-provider-rpc");
const exampleRoot = join(import.meta.dir, "../../../../examples/plugins/provider");

/**
 * Mirrors CHAT_WORDS in the fixture's server entry.
 *
 * The `[anonymous]` suffix is the fixture reporting that no credential reached it. This
 * path drives the adapter directly with a plain config and no vault, so the absence of a
 * key is the expected outcome rather than an incidental detail.
 */
const EXPECTED_CHAT_TEXT = "Hello from the example provider. [anonymous]";
const EXPECTED_CHAT_WORDS = 7;

async function loadManifest() {
	return parseManifest(JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8")));
}

function createRuntime(manifest: Awaited<ReturnType<typeof loadManifest>>): PluginRuntime {
	if (!manifest.server) throw new Error("provider fixture must declare a server entry");
	return new PluginRuntime({
		pluginId: manifest.pluginId,
		pluginVersion: manifest.version,
		command: [process.execPath, join(fixtureRoot, manifest.server.entry)],
		cwd: fixtureRoot,
		rpcProtocol: manifest.server.protocol,
		hostApiVersion: "1.0",
		grantedCapabilities: manifest.permissions.host,
		activationReason: "provider-rpc-e2e",
		runner: new LocalProcessRunner({
			allowedCwds: [fixtureRoot],
			maxHeaderBytes: 8 * 1024,
			maxBodyBytes: 128 * 1024,
			maxStdoutBytes: 256 * 1024,
			stderrRingBytes: 8 * 1024,
			maxStderrBytes: 16 * 1024,
			maxStderrBytesPerSecond: 16 * 1024,
			// Generous on purpose. These are real subprocesses, and the full suite now spawns
			// enough of them in parallel that a 5s spawn/handshake budget is occasionally missed
			// on a loaded machine — a scheduling artefact, not a protocol failure. The values
			// still bound a genuinely hung plugin; they just do not race the CPU.
			spawnTimeoutMs: 20_000,
			idleTimeoutMs: 30_000,
			totalTimeoutMs: 45_000,
			killProcessTree: true,
			resourceLimits: { cpuTimeSeconds: 30, memoryBytes: 1024 * 1024 * 1024 },
			allowUnboundedResourceUsage: process.platform === "win32",
		}),
		timeouts: {
			handshakeMs: 20_000,
			activationMs: 20_000,
			rpcMs: 20_000,
			drainMs: 200,
			shutdownMs: 1_000,
			cancelGraceMs: 1_000,
		},
		idleTimeoutMs: 30_000,
		totalTimeoutMs: 45_000,
		maxInFlight: 4,
	});
}

/**
 * Build the registry exactly as production does: manifest-derived registration plus
 * a client pool whose runtime resolver hands back the already-started process.
 */
function createStack(runtime: PluginRuntime, manifest: Awaited<ReturnType<typeof loadManifest>>) {
	const registry = new PluginProviderRegistry();
	const pool = new PluginProviderClientPool(async () => runtime as unknown as ProviderRuntimeLike);
	registry.setRemoteProviderAdapterFactory(
		createPluginProviderAdapterFactory({ clientPool: pool }),
	);
	for (const registration of providerRegistrationsFromManifest({
		manifest,
		generation: `${manifest.version}:e2e`,
	})) {
		registry.register(registration);
	}
	const refresher = new PluginProviderCatalogRefresher({ registry, clientPool: pool });
	return { registry, pool, refresher };
}

function chatParams(model: string) {
	return {
		conversationId: "conv-provider-e2e",
		content: "hello",
		model,
		cwd: fixtureRoot,
		history: [],
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
	};
}

describe("provider plugin over real stdio RPC", () => {
	test("e2e fixture stays in sync with the shipped example plugin", async () => {
		// The fixture exists so the test does not depend on the examples tree layout,
		// but a drift between them would mean this test stops covering what we ship.
		expect(await readFile(join(fixtureRoot, "server/index.js"), "utf8")).toBe(
			await readFile(join(exampleRoot, "server/index.js"), "utf8"),
		);
		expect(await readFile(join(fixtureRoot, "manifest.json"), "utf8")).toBe(
			await readFile(join(exampleRoot, "manifest.json"), "utf8"),
		);
	});

	test("describes, discovers models, streams chat, and cancels mid-stream", async () => {
		const manifest = await loadManifest();
		const runtime = createRuntime(manifest);
		try {
			await runtime.start();
			expect(runtime.state).toBe("active");

			const { registry, refresher } = createStack(runtime, manifest);
			const instanceId = registry.list()[0].providerInstanceId;

			// --- Model discovery over the real transport ---
			// Registration alone yields no catalog; listModels must fill it.
			expect(registry.get(instanceId)?.modelCount).toBe(0);
			const refreshed = await refresher.refresh(instanceId);
			expect(refreshed.error).toBeUndefined();
			expect(refreshed.modelCount).toBe(1);
			expect(refreshed.catalogVersion).toBe("example-1");

			const entry = registry.get(instanceId);
			expect(entry?.catalogStale).toBe(false);
			expect(entry?.getModel("example/offline")).toMatchObject({
				displayName: "Example Offline Model",
				contextWindow: 4096,
				maxOutputTokens: 512,
			});

			// --- Model resolution through the registered prefix ---
			const resolution = registry.resolveProvider("example:example/offline", {
				requireKnownModel: true,
			});
			expect(resolution.providerTypeId).toBe(`${manifest.pluginId}/example-provider`);
			const adapter = resolution.adapter;
			if (!adapter) throw new Error("resolution did not produce an adapter");

			// --- Streaming chat: text deltas then a terminal done ---
			const deltas: string[] = [];
			let stopReason: string | undefined;
			for await (const event of adapter.chat(chatParams(resolution.model))) {
				if (event.text) deltas.push(event.text);
				if (event.stopReason) stopReason = event.stopReason;
			}
			// The fixture streams a fixed sentence one word per event, so both the
			// assembled text and the fact it arrived in pieces are assertable.
			expect(deltas).toHaveLength(EXPECTED_CHAT_WORDS);
			expect(deltas.join("")).toBe(EXPECTED_CHAT_TEXT);
			expect(stopReason).toBe("end_turn");

			// --- Cancel mid-stream ---
			const controller = new AbortController();
			const cancelledDeltas: string[] = [];
			let aborted = false;
			try {
				for await (const event of adapter.chat({
					...chatParams(resolution.model),
					signal: controller.signal,
				})) {
					if (event.text) cancelledDeltas.push(event.text);
					// Abort as soon as output is flowing, so the cancel lands mid-stream
					// rather than before the operation started or after it finished.
					if (cancelledDeltas.length === 1) controller.abort();
				}
			} catch (error) {
				aborted = (error as Error).name === "AbortError";
			}
			expect(aborted).toBe(true);
			// Bracket the delta count on both sides. A bare "not the full sentence"
			// assertion would also pass if zero deltas arrived — i.e. if the cancel
			// landed before streaming began, or streaming never worked at all — which
			// is exactly the case this test exists to rule out.
			expect(cancelledDeltas.length).toBeGreaterThanOrEqual(1);
			expect(cancelledDeltas.length).toBeLessThan(EXPECTED_CHAT_WORDS);

			// --- The process survives a cancel and still serves requests ---
			const afterCancel = await refresher.refresh(instanceId, { force: true });
			expect(afterCancel.error).toBeUndefined();
			expect(afterCancel.modelCount).toBe(1);
			expect(runtime.state).toBe("active");
		} finally {
			await runtime.shutdown();
		}
		expect(runtime.state).toBe("stopped");
	}, 30_000);

	test("production runner delivers large histories and base64 images through every outbound limit", async () => {
		const root = await mkdtemp(join(tmpdir(), "provider-long-history-"));
		const supervisor = new RuntimeSupervisor();
		const manager = new PluginManager({ root, disabled: false, runtimeSupervisor: supervisor });
		try {
			const manifest = await loadManifest();
			await manager.install(fixtureRoot);
			await manager.enable(manifest.pluginId);
			await manager.activate(manifest.pluginId);
			const runtime = supervisor.get(manifest.pluginId);
			if (!runtime) throw new Error("Missing production runtime");
			expect(runtime.rpcConnection?.getLimits()).toMatchObject({
				maxInboundFrameBytes: 1024 * 1024,
				maxOutboundFrameBytes: PROVIDER_REQUEST_MAX_BYTES,
			});
			const { registry, pool } = createStack(runtime, manifest);
			const entry = registry.list()[0];
			const client = await pool
				.get({
					pluginId: manifest.pluginId,
					providerTypeId: entry.providerTypeId,
					providerInstanceId: entry.providerInstanceId,
				})
				.acquire();
			const block = "x".repeat(512 * 1024);
			const history = (count: number) =>
				Array.from({ length: count }, () => ({
					role: "user" as const,
					content: [{ type: "text" as const, text: block }],
				}));
			// Cross the former connection (1 MiB), writer (8 MiB), receiver (16 MiB),
			// and provider request (32 MiB) ceilings without enlarging inbound frames.
			const sharedContent = [{ type: "text" as const, text: "shared history block" }];
			const histories = [
				...[4, 20, 40, 80].map(history),
				// Many small nodes, aliased content and a single >1M-character block
				// used to fail JSON validation before reaching the frame budget.
				[
					...Array.from({ length: 12_000 }, () => ({
						role: "user" as const,
						content: sharedContent,
					})),
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: "文".repeat(1_100_000) }],
					},
				],
			];
			const requests = histories.map((requestHistory) => ({
				history: requestHistory,
				current: { text: "hello", toolResults: [] },
				tools: [],
			}));
			// 27 MiB of binary data becomes 36 MiB of base64, before JSON/RPC overhead.
			// Synthetic data keeps the subprocess test completely offline.
			const imageRequest = {
				history: [],
				current: {
					text: "describe this image",
					images: [{ mediaType: "image/png", dataBase64: "AAAA".repeat(9 * 1024 * 1024) }],
					toolResults: [],
				},
				tools: [],
			};
			expect(Buffer.byteLength(JSON.stringify(imageRequest), "utf8")).toBeGreaterThan(
				32 * 1024 * 1024,
			);
			for (const request of [...requests, imageRequest]) {
				const operation = await client.chat({
					providerTypeId: entry.providerTypeId,
					providerInstanceId: entry.providerInstanceId,
					providerPrefix: entry.providerPrefix,
					modelId: "example/offline",
					config: {},
					conversation: { conversationId: "large-request" },
					request,
				});
				let text = "";
				for await (const event of operation.events())
					if (event.type === "text.delta") text += event.text;
				expect(text).toBe(EXPECTED_CHAT_TEXT);
			}
			// 65 MiB cannot fit even before the outer JSON-RPC envelope is added.
			await expect(runtime.request("provider.chat", { history: history(130) })).rejects.toThrow(
				"connection frame limit",
			);
			expect(runtime.state).toBe("active");
			expect(runtime.rpcConnection?.outboundPending.size).toBe(0);
			await expect(runtime.request("health")).resolves.toBeDefined();
			pool.clear();
		} catch (error) {
			const stderr = supervisor.get("com.example.provider")?.getDiagnostics().stderr ?? "";
			throw new Error(`${String(error)}\n${stderr.slice(-2000)}`);
		} finally {
			await manager.shutdown();
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	test("reports a provider error without killing the runtime", async () => {
		const manifest = await loadManifest();
		const runtime = createRuntime(manifest);
		try {
			await runtime.start();
			const { registry, refresher } = createStack(runtime, manifest);
			const instanceId = registry.list()[0].providerInstanceId;

			// The fixture rejects listModels for an unknown providerTypeId. Reaching it
			// requires a mismatched type, which a wrong-instance refresh produces.
			await refresher.refresh(instanceId);

			// A bad request must surface as an RPC error, not a dead process.
			await expect(
				runtime.request("provider.listModels", {
					protocolVersion: "1.0",
					providerTypeId: "com.example.provider/does-not-exist",
					providerInstanceId: instanceId,
					config: {},
					limit: 10,
				}),
			).rejects.toBeDefined();
			expect(runtime.state).toBe("active");
		} finally {
			await runtime.shutdown();
		}
	}, 30_000);
});
