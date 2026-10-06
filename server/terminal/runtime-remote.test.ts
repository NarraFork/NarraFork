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
		if (method !== "pty.open") return Promise.resolve({ ok: true });
		if (openMode === "resolve") return Promise.resolve({ exitCode: 0 });
		return new Promise((resolve, reject) => {
			resolveOpen = resolve;
			rejectOpen = reject;
			options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
				once: true,
			});
		});
	};
	return { calls, sendRpc, resolveOpen, rejectOpen };
}

const spawnOptions = (onData: (data: string) => void = () => {}) => ({
	cmd: ["/bin/sh", "-l"],
	cwd: "/remote/home",
	env: { TERM: "xterm-256color" },
	cols: 80,
	rows: 24,
	onData,
});

describe("spawnRemotePty", () => {
	test("queues input and the latest resize until ready while decoding split UTF-8", async () => {
		const harness = createRpcHarness();
		const output: string[] = [];
		const runtime = spawnRemotePty(
			"device-1",
			spawnOptions((data) => output.push(data)),
			{
				sendRpc: harness.sendRpc,
				readyTimeoutMs: 1_000,
			},
		);

		runtime.write("whoami\n");
		runtime.resize(100, 30);
		runtime.resize(120, 40);
		expect(harness.calls.map((call) => call.method)).toEqual(["pty.open"]);
		const onStream = harness.calls[0].options?.onStream;
		onStream?.("pty_ready", new Uint8Array());
		await runtime.ready;
		await Promise.resolve();

		const writeCall = harness.calls.find((call) => call.method === "pty.write");
		expect(Buffer.from(String(writeCall?.params.dataB64), "base64").toString()).toBe("whoami\n");
		expect(harness.calls.find((call) => call.method === "pty.resize")?.params).toMatchObject({
			cols: 120,
			rows: 40,
		});

		const encoded = new TextEncoder().encode("你");
		onStream?.("stdout", encoded);
		expect(output).toEqual([]);
		onStream?.("pty", encoded.subarray(0, 2));
		expect(output).toEqual([]);
		onStream?.("pty", encoded.subarray(2));
		expect(output).toEqual(["你"]);

		runtime.close();
		await expect(runtime.exited).resolves.toBeNull();
	});

	test("kills, aborts, and rejects when ready does not arrive before the deadline", async () => {
		const harness = createRpcHarness();
		const runtime = spawnRemotePty("device-timeout", spawnOptions(), {
			sendRpc: harness.sendRpc,
			readyTimeoutMs: 5,
		});

		await expect(runtime.ready).rejects.toThrow("did not become ready within 5ms");
		await expect(runtime.exited).resolves.toBeNull();
		expect(harness.calls.some((call) => call.method === "pty.kill")).toBe(true);
		expect(harness.calls[0].options?.signal?.aborted).toBe(true);
	});

	test("rejects ready when the open RPC exits before the ready stream", async () => {
		const harness = createRpcHarness("resolve");
		const runtime = spawnRemotePty("device-early-exit", spawnOptions(), {
			sendRpc: harness.sendRpc,
			readyTimeoutMs: 1_000,
		});

		await expect(runtime.ready).rejects.toThrow("exited before becoming ready");
		await expect(runtime.exited).resolves.toBe(0);
	});

	test("close and kill before ready settle once and clear startup work", async () => {
		for (const action of ["close", "kill"] as const) {
			const harness = createRpcHarness();
			const runtime = spawnRemotePty(`device-${action}`, spawnOptions(), {
				sendRpc: harness.sendRpc,
				readyTimeoutMs: 1_000,
			});
			runtime.write("queued");
			runtime.resize(90, 20);
			runtime[action]();

			const pastTense = action === "close" ? "closed" : "killed";
			await expect(runtime.ready).rejects.toThrow(`was ${pastTense} before becoming ready`);
			await expect(runtime.exited).resolves.toBeNull();
			expect(harness.calls[0].options?.signal?.aborted).toBe(true);
			expect(harness.calls.some((call) => call.method === "pty.write")).toBe(false);
			expect(harness.calls.some((call) => call.method === "pty.resize")).toBe(false);
			expect(harness.calls.some((call) => call.method === "pty.kill")).toBe(action === "kill");
		}
	});

	test("fails closed when the pre-ready input queue exceeds its byte limit", async () => {
		const harness = createRpcHarness();
		const runtime = spawnRemotePty("device-overflow", spawnOptions(), {
			sendRpc: harness.sendRpc,
			readyTimeoutMs: 1_000,
			maxQueuedWriteBytes: 4,
		});

		runtime.write("1234");
		runtime.write("5");
		await expect(runtime.ready).rejects.toThrow("input queue exceeded 4 bytes");
		await expect(runtime.exited).resolves.toBeNull();
		expect(harness.calls.some((call) => call.method === "pty.kill")).toBe(true);
		expect(harness.calls.some((call) => call.method === "pty.write")).toBe(false);
	});
});
