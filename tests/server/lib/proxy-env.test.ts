import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	ambientNoProxy,
	ambientSystemProxy,
	envWithAmbientProxy,
	neutralizeAmbientProxyEnv,
	proxyEnvForSubprocess,
	resetProxyEnvStateForTest,
} from "@server/lib/net/proxy-env";

const ENV_KEYS = [
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
] as const;

describe("net/proxy-env ambient neutralization", () => {
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		saved = {};
		for (const k of ENV_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		resetProxyEnvStateForTest();
	});

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		resetProxyEnvStateForTest();
	});

	test("blanks the ambient proxy vars so Bun fetch cannot pick them up", () => {
		process.env.HTTPS_PROXY = "http://ambient:7890";
		process.env.http_proxy = "http://ambient:7890";

		neutralizeAmbientProxyEnv();

		// Assignment to "" (not delete) is what actually reaches the native env
		// Bun's fetch reads, so assert the observable empty-string state.
		expect(process.env.HTTPS_PROXY).toBe("");
		expect(process.env.http_proxy).toBe("");
	});

	test("keeps the original value available for system proxy mode", () => {
		process.env.HTTPS_PROXY = "http://ambient:7890";
		neutralizeAmbientProxyEnv();
		expect(ambientSystemProxy()).toBe("http://ambient:7890");
	});

	test("system proxy precedence is HTTPS then HTTP then ALL", () => {
		process.env.ALL_PROXY = "http://all:1";
		process.env.HTTP_PROXY = "http://http:2";
		process.env.HTTPS_PROXY = "http://https:3";
		neutralizeAmbientProxyEnv();
		expect(ambientSystemProxy()).toBe("http://https:3");
	});

	test("no ambient proxy resolves to undefined rather than a stale value", () => {
		neutralizeAmbientProxyEnv();
		expect(ambientSystemProxy()).toBeUndefined();
		expect(ambientNoProxy()).toBe("");
	});

	test("snapshots NO_PROXY separately from the proxy URL", () => {
		process.env.NO_PROXY = "example.com,.internal.net";
		neutralizeAmbientProxyEnv();
		expect(process.env.NO_PROXY).toBe("");
		expect(ambientNoProxy()).toBe("example.com,.internal.net");
	});

	test("is idempotent so a second call cannot clobber the snapshot", () => {
		process.env.HTTPS_PROXY = "http://ambient:7890";
		neutralizeAmbientProxyEnv();
		neutralizeAmbientProxyEnv();
		expect(ambientSystemProxy()).toBe("http://ambient:7890");
	});

	test("ignores empty ambient values instead of snapshotting them", () => {
		process.env.HTTPS_PROXY = "";
		neutralizeAmbientProxyEnv();
		expect(ambientSystemProxy()).toBeUndefined();
	});

	test("subprocess env restores the user's ambient proxy", () => {
		process.env.HTTPS_PROXY = "http://ambient:7890";
		process.env.NO_PROXY = "localhost";
		neutralizeAmbientProxyEnv();

		expect(proxyEnvForSubprocess()).toEqual({
			HTTPS_PROXY: "http://ambient:7890",
			NO_PROXY: "localhost",
		});

		const env = envWithAmbientProxy({ TERM: "xterm-256color" });
		expect(env.HTTPS_PROXY).toBe("http://ambient:7890");
		expect(env.NO_PROXY).toBe("localhost");
		expect(env.TERM).toBe("xterm-256color");
	});

	test("subprocess env is proxy-free when the process had no ambient proxy", () => {
		neutralizeAmbientProxyEnv();
		expect(proxyEnvForSubprocess()).toEqual({});
		// The blanked entry stays blank rather than being resurrected.
		expect(envWithAmbientProxy().HTTPS_PROXY).toBeUndefined();
	});

	test("explicit overrides win over the restored ambient proxy", () => {
		process.env.HTTPS_PROXY = "http://ambient:7890";
		neutralizeAmbientProxyEnv();
		const env = envWithAmbientProxy({ HTTPS_PROXY: "http://explicit:1" });
		expect(env.HTTPS_PROXY).toBe("http://explicit:1");
	});

	/**
	 * A NarraFork process that spawns ANOTHER NarraFork process (self-update
	 * restart, integrity probe, watcher worker) must hand over the real ambient
	 * values. The child re-runs neutralization and only snapshots non-empty
	 * values, so passing the blanked ones would make it believe the user has no
	 * system proxy — permanently, until the whole process tree is restarted from
	 * a shell.
	 */
	test("a spawned NarraFork process re-snapshots the same ambient proxy", () => {
		process.env.HTTPS_PROXY = "http://ambient:7890";
		process.env.NO_PROXY = "localhost";
		neutralizeAmbientProxyEnv();
		const childEnv = envWithAmbientProxy();

		// Simulate the child: fresh module state, environment taken from childEnv.
		resetProxyEnvStateForTest();
		for (const k of ENV_KEYS) {
			const value = childEnv[k];
			if (value === undefined) delete process.env[k];
			else process.env[k] = value;
		}
		neutralizeAmbientProxyEnv();

		expect(ambientSystemProxy()).toBe("http://ambient:7890");
		expect(ambientNoProxy()).toBe("localhost");
	});

	test("the blanked environment would lose the proxy across a restart", () => {
		process.env.HTTPS_PROXY = "http://ambient:7890";
		neutralizeAmbientProxyEnv();
		// The regression this guards: `{ ...process.env }` after neutralization.
		const naiveChildEnv = { ...process.env };

		resetProxyEnvStateForTest();
		for (const k of ENV_KEYS) {
			const value = naiveChildEnv[k];
			if (value === undefined) delete process.env[k];
			else process.env[k] = value;
		}
		neutralizeAmbientProxyEnv();

		expect(ambientSystemProxy()).toBeUndefined();
	});
});
