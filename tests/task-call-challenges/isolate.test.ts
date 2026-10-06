import { describe, expect, spyOn, test } from "bun:test";
import { challenges } from "./fixtures";
import { assertPodmanReady, executeEval, podmanEnvironment, podmanTestsEnabled } from "./isolate";

describe("opt-in container validation", () => {
	test("container tests are off unless explicitly enabled", () => {
		expect(podmanTestsEnabled({})).toBe(false);
		expect(podmanTestsEnabled({ NF_TASK_CHALLENGES_PODMAN: "0" })).toBe(false);
		expect(podmanTestsEnabled({ NF_TASK_CHALLENGES_PODMAN: "true" })).toBe(false);
		expect(podmanTestsEnabled({ NF_TASK_CHALLENGES_PODMAN: "1" })).toBe(true);
	});

	test("the CLI home is isolated from app HOME while explicit storage settings survive", () => {
		const original = {
			HOME: "/isolated/test-home",
			NARRAFORK_HOME: "/isolated/app-data",
			NARRAFORK_ORIGINAL_HOME: "/host/home",
			CONTAINERS_STORAGE_CONF: "/configured/storage.conf",
			XDG_DATA_HOME: "/configured/data",
			XDG_RUNTIME_DIR: "/configured/runtime",
		};
		const child = podmanEnvironment(original);
		expect(child.HOME).toBe("/host/home");
		expect(child.NARRAFORK_HOME).toBe(original.NARRAFORK_HOME);
		expect(child.CONTAINERS_STORAGE_CONF).toBe(original.CONTAINERS_STORAGE_CONF);
		expect(child.XDG_DATA_HOME).toBe(original.XDG_DATA_HOME);
		expect(child.XDG_RUNTIME_DIR).toBe(original.XDG_RUNTIME_DIR);
		expect(original.HOME).toBe("/isolated/test-home");
		expect(
			podmanEnvironment({ ...original, NF_TASK_CHALLENGES_PODMAN_HOME: "/explicit" }).HOME,
		).toBe("/explicit");
		expect(podmanEnvironment({ HOME: "/cli/home" }).HOME).toBe("/cli/home");
	});

	test("preflight, execution and cleanup use the same host storage environment", async () => {
		const calls: Array<{ args: string[]; env: unknown }> = [];
		const state = challenges[0].makeState();
		const spawn = spyOn(Bun, "spawn").mockImplementation(
			(args: unknown, options?: { env?: Record<string, string | undefined> }) => {
				if (!Array.isArray(args)) throw new Error("Expected command arguments");
				calls.push({ args, env: options?.env });
				return {
					exited: Promise.resolve(0),
					stdin: { write() {}, end() {} },
					stdout: new Response(JSON.stringify({ ok: true, state, logs: [], value: 1 })).body,
					stderr: new Response("").body,
					kill() {},
				} as never;
			},
		);
		try {
			expect((await executeEval(state, "return 1;")).ok).toBe(true);
			expect(calls.map((call) => call.args[1])).toEqual(["image", "run", "rm"]);
			expect(calls[1].env).toBe(calls[0].env);
			expect(calls[2].env).toBe(calls[0].env);
			expect(calls[1].args).toContain("--pull=never");
			expect(calls[1].args).toContain("--env=HOME=/tmp");
			expect(calls[2].args).toContain("--ignore");
		} finally {
			spawn.mockRestore();
		}
	});

	test("missing dependencies fail clearly and never trigger a pull or host fallback", async () => {
		const spawn = spyOn(Bun, "spawn").mockImplementation(
			() => ({ exited: Promise.resolve(125) }) as never,
		);
		try {
			await expect(assertPodmanReady({ HOME: "/fixed-host" })).rejects.toThrow(
				"No image was pulled",
			);
			expect(spawn).toHaveBeenCalledTimes(1);
		} finally {
			spawn.mockRestore();
		}
	});

	test("invalid async scripts are rejected without invoking a subprocess", async () => {
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("Unexpected subprocess");
		});
		try {
			const result = await executeEval(challenges[0].makeState(), "await task.read();");
			expect(result.error?.code).toBe("SCRIPT_CONTRACT");
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
		}
	});
});
