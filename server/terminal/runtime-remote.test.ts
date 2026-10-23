import { describe, expect, test } from "bun:test";
import type { SendRpcOptions } from "../services/device-connection-service";
import { spawnRemotePty } from "./runtime-remote";

interface RpcCall {
	method: string;
	params: Record<string, unknown>;
	options?: SendRpcOptions;
}
function createRpcHarness(openMode: "pending" | "resolve" = "pending") {
	const calls: RpcCall[] = [];
	let resolveOpen: (value: unknown) => void = () => {};
	let rejectOpen: (error: Error) => void = () => {};
	const sendRpc = (
		_deviceId: string,
		method: string,
		params: Record<string, unknown>,
		options?: SendRpcOptions,
	): Promise<unknown> => {
		calls.push({ method, params, options });
		if (method !== "pty.open") return Promise.resolve({ accepted: true, state: "closing" });
		if (openMode === "resolve") return Promise.resolve({ exitCode: 0 });
		return new Promise((resolve, reject) => {
			resolveOpen = resolve;
			rejectOpen = reject;
			options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
				once: true,
			});
		});
	};
	return {
		calls,
		sendRpc,
		resolveOpen: (value: unknown) => resolveOpen(value),
		rejectOpen: (error: Error) => rejectOpen(error),
	};
}
const spawnOptions = (onData: (data: string) => void = () => {}) => ({
	cmd: ["/bin/sh", "-l"],
	cwd: "/remote/home",
	env: { TERM: "xterm-256color" },
	cols: 80,
	rows: 24,
	onData,
});
const provenExit = (exitCode: number) => ({
	exitCode,
	processExitObserved: true,
	treeStopped: true,
	cleanupComplete: true,
	reason: "exited",
});
async function tick() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("spawnRemotePty", () => {
	for (const operation of ["write", "resize"] as const) {
		test(`linked ${operation} requires a final proof, not an accepted legacy callback`, async () => {
			const harness = createRpcHarness();
			const runtime = spawnRemotePty("device-proof", spawnOptions(), {
				sendRpc: harness.sendRpc,
				requireInputAuthorityProof: true,
				beforeInput: async () => undefined,
			});
			harness.calls[0].options?.onStream?.("pty_ready", new Uint8Array());
			await runtime.ready;
			if (operation === "write") runtime.write("forbidden");
			else runtime.resize(100, 30);
			await tick();
			expect(harness.calls.some((call) => call.method === `pty.${operation}`)).toBe(false);
			harness.resolveOpen(provenExit(0));
			await runtime.exited;
		});
		test(`linked ${operation} rechecks proof after authorization await, before RPC`, async () => {
			const harness = createRpcHarness();
			let revoked = false;
			const proof = {
				assertStillCurrent() {
					if (revoked) throw new Error("actor revoked at final dispatch");
				},
			};
			const authority = () =>
				new Promise<typeof proof>((resolve) => {
					queueMicrotask(() => {
						revoked = true;
					});
					resolve(proof);
				});
			const runtime = spawnRemotePty("device-proof", spawnOptions(), {
				sendRpc: harness.sendRpc,
				requireInputAuthorityProof: true,
			});
			harness.calls[0].options?.onStream?.("pty_ready", new Uint8Array());
			await runtime.ready;
			if (operation === "write") runtime.writeAuthorized("forbidden", authority);
			else runtime.resizeAuthorized(100, 30, authority);
			await tick();
			expect(revoked).toBe(true);
			expect(harness.calls.some((call) => call.method === `pty.${operation}`)).toBe(false);
			harness.resolveOpen(provenExit(0));
			await runtime.exited;
		});
	}
	test("linked queued input and resize carry their own final proofs", async () => {
		const harness = createRpcHarness();
		let checks = 0;
		const authority = async () => ({
			assertStillCurrent() {
				checks++;
			},
		});
		const runtime = spawnRemotePty("device-proof", spawnOptions(), {
			sendRpc: harness.sendRpc,
			requireInputAuthorityProof: true,
		});
		runtime.writeAuthorized("allowed", authority);
		runtime.resizeAuthorized(100, 30, authority);
		expect(checks).toBe(0);
		harness.calls[0].options?.onStream?.("pty_ready", new Uint8Array());
		await runtime.ready;
		await tick();
		expect(checks).toBe(2);
		expect(harness.calls.map((call) => call.method)).toEqual([
			"pty.open",
			"pty.write",
			"pty.resize",
		]);
		harness.resolveOpen(provenExit(0));
		await runtime.exited;
	});
	test("queues input/latest resize until real ready and decodes split UTF-8 without CRLF rewriting", async () => {
		const harness = createRpcHarness();
		const output: string[] = [];
		const runtime = spawnRemotePty(
			"device-1",
			spawnOptions((data) => output.push(data)),
			{ sendRpc: harness.sendRpc },
		);
		runtime.write("whoami\r");
		runtime.resize(100, 30);
		runtime.resize(120, 40);
		expect(harness.calls.map((call) => call.method)).toEqual(["pty.open"]);
		const onStream = harness.calls[0].options?.onStream;
		onStream?.("pty_ready", new Uint8Array());
		await runtime.ready;
		await tick();
		const writeCall = harness.calls.find((call) => call.method === "pty.write");
		expect(Buffer.from(String(writeCall?.params.dataB64), "base64").toString()).toBe("whoami\r");
		expect(harness.calls.find((call) => call.method === "pty.resize")?.params).toMatchObject({
			cols: 120,
			rows: 40,
		});
		const encoded = new TextEncoder().encode("你\r\n");
		onStream?.("stdout", encoded);
		expect(output).toEqual([]);
		onStream?.("pty", encoded.subarray(0, 2));
		expect(output).toEqual([]);
		onStream?.("pty", encoded.subarray(2));
		expect(output).toEqual(["你\r\n"]);
		runtime.close();
		expect(harness.calls[0].options?.signal?.aborted).toBe(false);
		harness.resolveOpen(provenExit(7));
		await expect(runtime.exited).resolves.toBe(7);
	});

	test("ready deadline requests kill but retains original open until the bounded unknown deadline", async () => {
		const harness = createRpcHarness();
		const runtime = spawnRemotePty("device-timeout", spawnOptions(), {
			sendRpc: harness.sendRpc,
			readyTimeoutMs: 5,
			closeTimeoutMs: 10,
		});
		await expect(runtime.ready).rejects.toThrow("did not become ready within 5ms");
		expect(harness.calls.some((call) => call.method === "pty.kill")).toBe(true);
		expect(harness.calls[0].options?.signal?.aborted).toBe(false);
		await expect(runtime.exited).resolves.toBeNull();
		expect(harness.calls[0].options?.signal?.aborted).toBe(true);
	});

	test("verified legacy Unix exit remains compatible, but cannot create a false ready", async () => {
		const harness = createRpcHarness("resolve");
		const runtime = spawnRemotePty("legacy", spawnOptions(), { sendRpc: harness.sendRpc });
		await expect(runtime.ready).rejects.toThrow("exited before becoming ready");
		await expect(runtime.exited).resolves.toBe(0);
	});

	test("close/kill before ready reject startup, discard queued work, and preserve real process wait", async () => {
		for (const action of ["close", "kill"] as const) {
			const harness = createRpcHarness();
			const runtime = spawnRemotePty(`device-${action}`, spawnOptions(), {
				sendRpc: harness.sendRpc,
				requireLifecycleEvidence: true,
			});
			runtime.write("queued");
			runtime.resize(90, 20);
			runtime[action]();
			await expect(runtime.ready).rejects.toThrow(action === "close" ? "was closed" : "was killed");
			expect(harness.calls[0].options?.signal?.aborted).toBe(false);
			expect(harness.calls.map((call) => call.method)).toEqual(["pty.open", "pty.kill"]);
			harness.calls[0].options?.onStream?.("pty_ready", new Uint8Array());
			await tick();
			expect(harness.calls.some((call) => call.method === "pty.write")).toBe(false);
			harness.resolveOpen(provenExit(1));
			await expect(runtime.exited).resolves.toBe(1);
		}
	});

	test("ready kill ACK never settles exit; original native result supplies exit code", async () => {
		const harness = createRpcHarness();
		const runtime = spawnRemotePty("native", spawnOptions(), {
			sendRpc: harness.sendRpc,
			requireLifecycleEvidence: true,
		});
		harness.calls[0].options?.onStream?.("pty_ready", new Uint8Array());
		await runtime.ready;
		let settled = false;
		void runtime.exited.then(() => {
			settled = true;
		});
		runtime.kill();
		await tick();
		expect(settled).toBe(false);
		expect(harness.calls[0].options?.signal?.aborted).toBe(false);
		harness.resolveOpen(provenExit(13));
		await expect(runtime.exited).resolves.toBe(13);
	});

	test("native exit requires actual process AND complete tree AND cleanup evidence", async () => {
		for (const result of [
			{ exitCode: 0 },
			{ ...provenExit(0), treeStopped: false },
			{ ...provenExit(0), processExitObserved: false },
			{ ...provenExit(0), cleanupComplete: false },
			{ ...provenExit(0), exitCode: null },
			{ ...provenExit(0), exitCode: -1 },
		]) {
			const harness = createRpcHarness();
			const runtime = spawnRemotePty("unproven", spawnOptions(), {
				sendRpc: harness.sendRpc,
				requireLifecycleEvidence: true,
			});
			harness.calls[0].options?.onStream?.("pty_ready", new Uint8Array());
			await runtime.ready;
			harness.resolveOpen(result);
			await expect(runtime.exited).resolves.toBeNull();
		}
	});

	test("split input is <=64KiB and authorization belongs to each queued actor", async () => {
		const harness = createRpcHarness();
		const actors: string[] = [];
		const runtime = spawnRemotePty("actor-bound", spawnOptions(), { sendRpc: harness.sendRpc });
		runtime.writeAuthorized("A".repeat(65_537), async () => {
			actors.push("actor-A");
		});
		runtime.writeAuthorized("B", async () => {
			actors.push("actor-B");
		});
		harness.calls[0].options?.onStream?.("pty_ready", new Uint8Array());
		await runtime.ready;
		await tick();
		expect(actors).toEqual(["actor-A", "actor-A", "actor-B"]);
		const writes = harness.calls.filter((call) => call.method === "pty.write");
		expect(
			writes.map((call) => Buffer.from(String(call.params.dataB64), "base64").byteLength),
		).toEqual([65_536, 1, 1]);
		harness.resolveOpen(provenExit(0));
		await runtime.exited;
	});

	test("revocation before queued dispatch cannot borrow the newest actor or creator", async () => {
		const harness = createRpcHarness();
		const runtime = spawnRemotePty("revoked", spawnOptions(), {
			sendRpc: harness.sendRpc,
			closeTimeoutMs: 5,
		});
		let authorized = true;
		runtime.writeAuthorized("secret", async () => {
			if (!authorized) throw new Error("actor revoked");
		});
		authorized = false;
		harness.calls[0].options?.onStream?.("pty_ready", new Uint8Array());
		await runtime.ready;
		await tick();
		expect(harness.calls.some((call) => call.method === "pty.write")).toBe(false);
		expect(harness.calls.some((call) => call.method === "pty.kill")).toBe(true);
		harness.resolveOpen(provenExit(1));
		await runtime.exited;
	});

	test("pre-ready input overflow fails closed and is explicitly reported", async () => {
		const harness = createRpcHarness();
		const failures: string[] = [];
		const runtime = spawnRemotePty("overflow", spawnOptions(), {
			sendRpc: harness.sendRpc,
			maxQueuedWriteBytes: 4,
			closeTimeoutMs: 5,
			onFailure: (error) => failures.push(error.message),
		});
		runtime.write("1234");
		runtime.write("5");
		await expect(runtime.ready).rejects.toThrow("input queue exceeded 4 bytes");
		await expect(runtime.exited).resolves.toBeNull();
		expect(failures).toHaveLength(1);
		expect(harness.calls.some((call) => call.method === "pty.write")).toBe(false);
	});

	test("output overrun/control error terminate explicitly rather than silently dropping", async () => {
		const harness = createRpcHarness();
		const failures: string[] = [];
		const runtime = spawnRemotePty("output-overrun", spawnOptions(), {
			sendRpc: harness.sendRpc,
			closeTimeoutMs: 5,
			onFailure: (error) => failures.push(error.message),
		});
		harness.calls[0].options?.onStream?.("pty_ready", new Uint8Array());
		await runtime.ready;
		harness.calls[0].options?.onStream?.("pty", new Uint8Array(32 * 1024 + 1));
		expect(failures[0]).toContain("output chunk exceeded 32KiB");
		await expect(runtime.exited).resolves.toBeNull();
	});

	test("lost transport remains unknown, never synthetic success", async () => {
		const harness = createRpcHarness();
		const runtime = spawnRemotePty("disconnected", spawnOptions(), {
			sendRpc: harness.sendRpc,
			requireLifecycleEvidence: true,
		});
		harness.calls[0].options?.onStream?.("pty_ready", new Uint8Array());
		await runtime.ready;
		harness.rejectOpen(new Error("peer disconnected"));
		await expect(runtime.exited).resolves.toBeNull();
	});
});
