import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CustomApiProviderConfig } from "@server/lib/settings";
import { createApikeyQuotaEngine } from "@server/services/apikey-quota-plugin-engine";
import { LocalProcessRunner, PluginRuntime } from "@server/services/plugin-runtime";
import { APIKEY_QUOTA_PLUGIN_ID } from "@shared/apikey-quota-plugin";

/**
 * The plugin process is reaped after an idle period, and that is the normal steady state of a
 * quota probe: probes are minutes apart, so the first call after any quiet stretch finds no
 * process. The engine must start a fresh one and answer through the plugin, not treat the
 * reaped process as a permanent failure and silently fall back for the rest of the host's life.
 *
 * A short idle timeout is used so the real reaping path runs in a test rather than being
 * simulated by a fake.
 */
const PLUGIN_DIR = join(import.meta.dir, "../../../server/builtin-plugins/apikey-quota");
const entry = join(PLUGIN_DIR, "server/index.js");

const config = (baseUrl: string): CustomApiProviderConfig => ({
	id: "relay-idle",
	name: "relay-idle",
	prefix: "relay-idle",
	baseUrl,
	protocol: "completions-compatible",
	apiKey: "sk-idle",
	defaultModel: "m",
});

const idleRuntime = () => {
	const runner = new LocalProcessRunner({
		allowedCwds: [PLUGIN_DIR],
		allowUnboundedResourceUsage: process.platform === "win32",
		spawnTimeoutMs: 15_000,
		idleTimeoutMs: 15_000,
	});
	const runtime = new PluginRuntime({
		pluginId: APIKEY_QUOTA_PLUGIN_ID,
		pluginVersion: "1.0.0",
		command: [process.execPath, entry],
		cwd: PLUGIN_DIR,
		runner,
		rpcProtocol: "narrafork.rpc/1",
		hostApiVersion: "1.0",
		grantedCapabilities: ["provider.use"],
		activationReason: "test:idle-reap",
		timeouts: {
			handshakeMs: 15_000,
			activationMs: 15_000,
			rpcMs: 15_000,
			drainMs: 500,
			shutdownMs: 500,
			cancelGraceMs: 100,
		},
		// Reap quickly so the "process is gone" state is reached inside the test.
		idleTimeoutMs: 400,
	});
	return runtime;
};

describe("apikey-quota engine survives the plugin being reaped while idle", () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);

	afterAll(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	test("a probe after the idle reap still answers through the plugin", async () => {
		const relay = Bun.serve({
			port: 0,
			fetch: () => Response.json({ mode: "unrestricted", isValid: true, balance: 7, unit: "USD" }),
		});
		const engine = createApikeyQuotaEngine({ createRuntime: idleRuntime, isEnabled: () => true });
		const input = {
			config: config(`http://127.0.0.1:${relay.port}/v1`),
			signal: AbortSignal.timeout(20_000),
		};
		try {
			const first = await engine.probe(input);
			expect(first?.balance).toMatchObject({ scope: "wallet" });

			// Let the runtime's own idle timer reap the process.
			await Bun.sleep(1_200);

			const second = await engine.probe(input);
			// The second probe must still be answered, and by a freshly started plugin.
			expect(second?.balance).toMatchObject({ scope: "wallet" });
			expect(second).toEqual(first);
		} finally {
			await engine.dispose();
			relay.stop(true);
		}
	}, 40_000);

	test("reaping the idle process does not raise an unhandled rejection", async () => {
		unhandled.length = 0;
		const relay = Bun.serve({
			port: 0,
			fetch: () => Response.json({ mode: "unrestricted", isValid: true, balance: 3, unit: "USD" }),
		});
		const engine = createApikeyQuotaEngine({ createRuntime: idleRuntime, isEnabled: () => true });
		try {
			await engine.probe({
				config: config(`http://127.0.0.1:${relay.port}/v1`),
				signal: AbortSignal.timeout(20_000),
			});
			await Bun.sleep(1_200);
			// Touch the engine again so any deferred rejection has a chance to surface.
			await engine.probe({
				config: config(`http://127.0.0.1:${relay.port}/v1`),
				signal: AbortSignal.timeout(20_000),
			});
			await Bun.sleep(200);
			expect(unhandled).toEqual([]);
		} finally {
			await engine.dispose();
			relay.stop(true);
		}
	}, 40_000);
});
