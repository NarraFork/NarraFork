import { describe, expect, test } from "bun:test";
import type { ManifestInput } from "@server/lib/plugins/manifest";
import { COMMANDS_INVOKE_METHOD } from "@server/lib/plugins/protocol";
import {
	commandFullId,
	PluginCommandRegistry,
	PluginCommandRegistryError,
	type PluginCommandRuntime,
} from "@server/services/plugin-command-registry";

/**
 * The command dispatch path that `commands.execute` previously lacked.
 *
 * The failure this guards against is the one that shipped last round: a manifest declares
 * `handler: "server"`, a UI calls it, and nothing resolves it — dead code that type-checks
 * and passes every test. So these tests assert the full round trip, including the cases
 * where dispatch must be *refused* rather than silently doing nothing.
 */

const PLUGIN_ID = "com.example.commands";
const OTHER_PLUGIN_ID = "com.example.other";

function manifestInput(
	overrides: {
		pluginId?: string;
		commands?: Array<{ id: string; title: string; handler: "server" | "ui" }>;
	} = {},
): ManifestInput {
	const commands = overrides.commands ?? [
		{ id: "status", title: "Status", handler: "server" as const },
		{ id: "open-panel", title: "Open panel", handler: "ui" as const },
	];
	return {
		schemaVersion: 1,
		pluginId: overrides.pluginId ?? PLUGIN_ID,
		version: "1.0.0",
		displayName: "Command fixture",
		engine: {
			runtime: "bun",
			hostApi: ">=1.0 <2",
			rpc: "narrafork.rpc/1",
			runner: "local-process",
		},
		server: {
			entry: "server/index.js",
			transport: "stdio",
			protocol: "narrafork.rpc/1",
			args: [],
			workingDirectory: "package",
		},
		// The manifest requires every activation event to reference a declared contribution,
		// so this is derived rather than hardcoded.
		activationEvents: commands.map((command) => `onCommand:${command.id}`),
		contributes: {
			providers: [],
			tools: [],
			commands,
			events: [],
			views: [],
		},
		permissions: {
			host: [],
			network: { mode: "none", allow: [] },
			filesystem: { package: "readOnly", pluginData: "readWrite", workspace: "none" },
			process: { spawn: "none" },
		},
	} as ManifestInput;
}

/** Captures what crossed the RPC boundary. */
function recordingRuntime(result: unknown): PluginCommandRuntime & {
	calls: Array<{ method: string; params: unknown }>;
} {
	const calls: Array<{ method: string; params: unknown }> = [];
	return {
		calls,
		request: async (method, params) => {
			calls.push({ method, params });
			return result;
		},
	};
}

function registryWith(
	runtime: PluginCommandRuntime | undefined,
	manifest = manifestInput(),
): PluginCommandRegistry {
	const registry = new PluginCommandRegistry({
		resolveRuntime: () => runtime,
	});
	registry.registerManifest(manifest);
	return registry;
}

describe("plugin command registry: registration", () => {
	test("registers both server and ui commands from a manifest", () => {
		const registry = registryWith(undefined);
		expect(registry.list().map((item) => item.fullId)).toEqual([
			commandFullId(PLUGIN_ID, "open-panel"),
			commandFullId(PLUGIN_ID, "status"),
		]);
	});

	test("finds a command by bare id when the plugin is known", () => {
		const registry = registryWith(undefined);
		expect(registry.find("status", PLUGIN_ID)?.handler).toBe("server");
		// A bare id with no plugin context is ambiguous and must not resolve.
		expect(registry.find("status")).toBeUndefined();
	});

	test("re-registering a manifest replaces the previous generation", () => {
		const registry = registryWith(undefined);
		registry.registerManifest(
			manifestInput({ commands: [{ id: "renamed", title: "Renamed", handler: "server" }] }),
		);
		// A stale command pointing at a contribution the new package dropped would be
		// dispatchable but unhandled.
		expect(registry.has("status", PLUGIN_ID)).toBe(false);
		expect(registry.has("renamed", PLUGIN_ID)).toBe(true);
	});

	test("removePlugin drops only that plugin's commands", () => {
		const registry = registryWith(undefined);
		registry.registerManifest(manifestInput({ pluginId: OTHER_PLUGIN_ID }));
		expect(registry.removePlugin(PLUGIN_ID)).toBe(2);
		expect(registry.list().every((item) => item.pluginId === OTHER_PLUGIN_ID)).toBe(true);
	});

	test("rejects an invalid manifest", () => {
		const registry = new PluginCommandRegistry();
		expect(() => registry.registerManifest({ nope: true })).toThrow(PluginCommandRegistryError);
	});
});

describe("plugin command registry: dispatch", () => {
	test("forwards a server command over commands.invoke", async () => {
		const runtime = recordingRuntime({ output: { ok: true } });
		const registry = registryWith(runtime);

		const result = await registry.invoke(
			"status",
			PLUGIN_ID,
			{ detail: true },
			{
				requestId: "req-1",
				correlationId: "corr-1",
			},
		);

		expect(result.output).toEqual({ ok: true });
		expect(runtime.calls).toHaveLength(1);
		expect(runtime.calls[0].method).toBe(COMMANDS_INVOKE_METHOD);
		expect(runtime.calls[0].params).toMatchObject({
			contributionId: "status",
			input: { detail: true },
			context: { requestId: "req-1", correlationId: "corr-1" },
		});
	});

	test("returns secretWrites for the caller to validate", async () => {
		const runtime = recordingRuntime({
			output: { ok: true },
			secretWrites: [{ key: "provider.acme.bundle", value: "payload" }],
		});
		const registry = registryWith(runtime);

		const result = await registry.invoke("status", PLUGIN_ID, undefined, { requestId: "req-1" });

		// The registry passes them through; the key whitelist lives in
		// plugin-command-secret-writes so the policy has exactly one home.
		expect(result.secretWrites).toEqual([{ key: "provider.acme.bundle", value: "payload" }]);
	});

	test("defaults secretWrites to an empty array", async () => {
		const registry = registryWith(recordingRuntime({ output: null }));
		const result = await registry.invoke("status", PLUGIN_ID, undefined, { requestId: "req-1" });
		expect(result.secretWrites).toEqual([]);
	});

	test("accepts an empty result body", async () => {
		const registry = registryWith(recordingRuntime(undefined));
		const result = await registry.invoke("status", PLUGIN_ID, undefined, { requestId: "req-1" });
		expect(result.output).toBeUndefined();
	});

	test("refuses a ui command with an explanatory error", async () => {
		const registry = registryWith(recordingRuntime({}));
		// "Handled in the UI" is a materially different situation from "does not exist".
		await expect(
			registry.invoke("open-panel", PLUGIN_ID, undefined, { requestId: "req-1" }),
		).rejects.toThrow(/handled in the plugin UI/);
	});

	test("refuses an unknown command", async () => {
		const registry = registryWith(recordingRuntime({}));
		await expect(
			registry.invoke("nope", PLUGIN_ID, undefined, { requestId: "req-1" }),
		).rejects.toThrow(/not registered/);
	});

	test("refuses a command belonging to another plugin addressed by full id", async () => {
		const registry = registryWith(recordingRuntime({}));
		registry.registerManifest(manifestInput({ pluginId: OTHER_PLUGIN_ID }));
		// A UI session must not be able to reach across plugins by spelling out the full id.
		await expect(
			registry.invoke(commandFullId(OTHER_PLUGIN_ID, "status"), PLUGIN_ID, undefined, {
				requestId: "req-1",
			}),
		).rejects.toThrow(/another plugin/);
	});

	test("reports an unavailable runtime as retryable", async () => {
		const registry = registryWith(undefined);
		try {
			await registry.invoke("status", PLUGIN_ID, undefined, { requestId: "req-1" });
			throw new Error("expected a rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(PluginCommandRegistryError);
			// A plugin that has not started yet is a transient condition, not a bad request.
			expect((error as PluginCommandRegistryError).retryable).toBe(true);
		}
	});

	test("rejects a result that does not match the contract", async () => {
		const registry = registryWith(recordingRuntime({ unexpected: "field" }));
		await expect(
			registry.invoke("status", PLUGIN_ID, undefined, { requestId: "req-1" }),
		).rejects.toThrow(/does not match the contract/);
	});
});

describe("plugin command registry: limits", () => {
	test("rejects oversized input before contacting the plugin", async () => {
		const runtime = recordingRuntime({ output: null });
		const registry = new PluginCommandRegistry({
			resolveRuntime: () => runtime,
			maxInputBytes: 32,
		});
		registry.registerManifest(manifestInput());

		await expect(
			registry.invoke("status", PLUGIN_ID, { blob: "x".repeat(64) }, { requestId: "req-1" }),
		).rejects.toThrow(/input exceeds/);
		// Spawning or waking a plugin to hand it something already known to be too big is waste.
		expect(runtime.calls).toEqual([]);
	});

	test("rejects oversized output", async () => {
		const registry = new PluginCommandRegistry({
			resolveRuntime: () => recordingRuntime({ output: { blob: "x".repeat(256) } }),
			maxOutputBytes: 32,
		});
		registry.registerManifest(manifestInput());

		await expect(
			registry.invoke("status", PLUGIN_ID, undefined, { requestId: "req-1" }),
		).rejects.toThrow(/output exceeds/);
	});

	test("clamps the timeout to the configured maximum", async () => {
		let seenTimeout: number | undefined;
		const registry = new PluginCommandRegistry({
			resolveRuntime: () => ({
				request: async (_method, _params, options) => {
					seenTimeout = options?.timeoutMs;
					return { output: null };
				},
			}),
			maxTimeoutMs: 5_000,
		});
		registry.registerManifest(manifestInput());

		await registry.invoke("status", PLUGIN_ID, undefined, {
			requestId: "req-1",
			timeoutMs: 900_000,
		});
		expect(seenTimeout).toBe(5_000);
	});

	test("forwards an abort signal so a hung command can be cancelled", async () => {
		let seenSignal: AbortSignal | undefined;
		const registry = new PluginCommandRegistry({
			resolveRuntime: () => ({
				request: async (_method, _params, options) => {
					seenSignal = options?.signal;
					return { output: null };
				},
			}),
		});
		registry.registerManifest(manifestInput());
		const controller = new AbortController();

		await registry.invoke("status", PLUGIN_ID, undefined, {
			requestId: "req-1",
			signal: controller.signal,
		});
		expect(seenSignal).toBe(controller.signal);
	});
});
