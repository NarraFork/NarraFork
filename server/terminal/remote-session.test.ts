import { describe, expect, test } from "bun:test";
import { eventBus } from "../lib/event-bus";
import { DeviceOfflineError, type SendRpcOptions } from "../services/device-connection-service";
import {
	LOST_REASON,
	RemoteSessionOpenUnknownError,
	spawnRemoteSession,
	terminalSessionId,
	utf8IncompleteTail,
} from "./remote-session";

const DEVICE = "device-1";

/**
 * A fake executor with the Go session semantics: byte-sequenced output with a
 * retention window, attach from `since`, writeId dedupe, and a connection that
 * can drop (pending and new RPCs fail with DeviceOfflineError) and return.
 */
function fakeExecutor(retain = 1 << 20) {
	interface Attacher {
		pos: number;
		onStream: NonNullable<SendRpcOptions["onStream"]>;
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
	}
	const state = {
		online: true,
		output: new Uint8Array(0),
		firstSeq: 0,
		endSeq: 0,
		exitCode: undefined as number | undefined,
		opened: false,
		input: [] as string[],
		seen: new Set<string>(),
		calls: [] as { method: string; params: Record<string, unknown> }[],
		attachers: new Set<Attacher>(),
		/** Apply the next write but lose its acknowledgement (connection drops). */
		loseNextWriteAck: false,
		/** Start the session but lose the open's reply (connection drops). */
		loseNextOpenAck: false,
	};
	const pump = (a: Attacher) => {
		if (a.pos < state.firstSeq) {
			a.onStream(
				"session.gap",
				new TextEncoder().encode(JSON.stringify({ from: a.pos, to: state.firstSeq })),
			);
			a.pos = state.firstSeq;
		}
		if (a.pos < state.endSeq) {
			a.onStream("session.data", state.output.slice(a.pos - state.firstSeq));
			a.pos = state.endSeq;
		}
		if (state.exitCode !== undefined) {
			state.attachers.delete(a);
			a.resolve({ exitCode: state.exitCode, endSeq: state.endSeq });
		}
	};
	const exec = {
		state,
		emit(bytes: Uint8Array | string) {
			const chunk = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
			const joined = new Uint8Array(state.output.length + chunk.length);
			joined.set(state.output);
			joined.set(chunk, state.output.length);
			state.endSeq += chunk.length;
			const drop = Math.max(0, joined.length - retain);
			state.output = joined.slice(drop);
			state.firstSeq += drop;
			if (state.online) for (const a of [...state.attachers]) pump(a);
		},
		exit(code: number) {
			state.exitCode = code;
			if (state.online) for (const a of [...state.attachers]) pump(a);
		},
		disconnect() {
			state.online = false;
			for (const a of [...state.attachers]) a.reject(new DeviceOfflineError(DEVICE));
			state.attachers.clear();
			eventBus.emit({ type: "device:status", deviceId: DEVICE, status: "offline" });
		},
		reconnect() {
			state.online = true;
			eventBus.emit({ type: "device:status", deviceId: DEVICE, status: "online" });
		},
		isDeviceOnline: () => state.online,
		sendRpc: (
			_deviceId: string,
			method: string,
			params: Record<string, unknown>,
			options?: SendRpcOptions,
		): Promise<unknown> => {
			state.calls.push({ method, params });
			if (!state.online) return Promise.reject(new DeviceOfflineError(DEVICE));
			switch (method) {
				case "session.open":
					if (state.opened) return Promise.reject(new Error("session already exists"));
					state.opened = true;
					if (state.loseNextOpenAck) {
						state.loseNextOpenAck = false;
						exec.disconnect();
						return Promise.reject(new DeviceOfflineError(DEVICE));
					}
					return Promise.resolve({ sessionId: params.sessionId });
				case "session.attach": {
					if (!state.opened) return Promise.reject(new Error("session not found"));
					const since = params.since as number;
					if (since > state.endSeq)
						return Promise.reject(new Error("sequence is beyond the end of output"));
					return new Promise((resolve, reject) => {
						const a: Attacher = {
							pos: since,
							onStream: options?.onStream ?? (() => {}),
							resolve,
							reject,
						};
						state.attachers.add(a);
						options?.signal?.addEventListener("abort", () => {
							state.attachers.delete(a);
							reject(new Error("aborted"));
						});
						pump(a);
					});
				}
				case "session.info":
					if (!state.opened) return Promise.reject(new Error("session not found"));
					return Promise.resolve({ sessionId: params.sessionId, state: "running" });
				case "session.write": {
					const id = params.writeId as string;
					if (!state.seen.has(id)) {
						state.seen.add(id);
						state.input.push(Buffer.from(params.dataB64 as string, "base64").toString());
					}
					if (state.loseNextWriteAck) {
						state.loseNextWriteAck = false;
						exec.disconnect();
						return Promise.reject(new DeviceOfflineError(DEVICE));
					}
					return Promise.resolve({ duplicate: false });
				}
				default:
					return Promise.resolve({});
			}
		},
	};
	return exec;
}

async function until(cond: () => boolean) {
	const deadline = Date.now() + 2_000;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await Bun.sleep(5);
	}
}

function capture() {
	const chunks: { text: string; seq: number }[] = [];
	return {
		chunks,
		onData: (text: string, seq: number) => chunks.push({ text, seq }),
		text: () => chunks.map((c) => c.text).join(""),
		lastSeq: () => chunks.at(-1)?.seq,
	};
}

const openOpts = { cmd: ["/bin/sh", "-l"], cwd: "/home", env: {}, cols: 80, rows: 24 };

describe("utf8IncompleteTail", () => {
	test("counts only an unfinished trailing sequence", () => {
		const euro = new TextEncoder().encode("€"); // 3 bytes
		expect(utf8IncompleteTail(new TextEncoder().encode("ab"))).toBe(0);
		expect(utf8IncompleteTail(euro)).toBe(0);
		expect(utf8IncompleteTail(euro.slice(0, 1))).toBe(1);
		expect(utf8IncompleteTail(euro.slice(0, 2))).toBe(2);
		expect(utf8IncompleteTail(new Uint8Array([0x61, 0xf0, 0x9f, 0x98]))).toBe(3);
	});
});

describe("spawnRemoteSession", () => {
	test("opens, streams with byte positions, and keeps split characters whole", async () => {
		const exec = fakeExecutor();
		const out = capture();
		const runtime = spawnRemoteSession(
			DEVICE,
			"s1",
			{ open: openOpts, since: 0, onData: out.onData },
			exec,
		);
		await runtime.ready;
		const euro = new TextEncoder().encode("€");
		exec.emit("a");
		exec.emit(euro.slice(0, 2));
		await until(() => out.text() === "a");
		// The incomplete character is held back and not counted as delivered.
		expect(out.lastSeq()).toBe(1);
		exec.emit(euro.slice(2));
		await until(() => out.text() === "a€");
		expect(out.lastSeq()).toBe(4);
		expect(exec.state.calls[0]).toMatchObject({
			method: "session.open",
			params: { sessionId: "s1", kind: "pty", cwd: "/home" },
		});
		runtime.detach();
	});

	test("survives a dropped connection and resumes with exactly the unseen bytes", async () => {
		const exec = fakeExecutor();
		const out = capture();
		const runtime = spawnRemoteSession(
			DEVICE,
			"s1",
			{ open: openOpts, since: 0, onData: out.onData },
			exec,
		);
		await runtime.ready;
		exec.emit("one ");
		await until(() => out.text() === "one ");
		exec.disconnect();
		exec.emit("two "); // produced while NarraFork could not read
		exec.emit("three");
		let settled = false;
		void runtime.exited.then(() => {
			settled = true;
		});
		await Bun.sleep(30);
		expect(settled).toBe(false);
		exec.reconnect();
		await until(() => out.text() === "one two three");
		const attaches = exec.state.calls.filter((c) => c.method === "session.attach");
		expect(attaches.at(-1)?.params.since).toBe(4);
		exec.exit(0);
		expect(await runtime.exited).toBe(0);
		// The terminal service releases only after persisting the final state.
		expect(exec.state.calls.some((c) => c.method.match(/session\.(release|kill)/))).toBe(false);
	});

	test("input is ordered and applied once across a lost acknowledgement", async () => {
		const exec = fakeExecutor();
		const runtime = spawnRemoteSession(
			DEVICE,
			"s1",
			{ open: openOpts, since: 0, onData: () => {} },
			exec,
		);
		await runtime.ready;
		exec.state.loseNextWriteAck = true;
		runtime.write("rm -rf build\n");
		runtime.write("make\n");
		await until(() => !exec.state.online);
		// Typed while the device is away: queued, not dropped.
		runtime.write("ls\n");
		exec.reconnect();
		await until(() => exec.state.input.length === 3);
		await Bun.sleep(20);
		expect(exec.state.input).toEqual(["rm -rf build\n", "make\n", "ls\n"]);
		const writes = exec.state.calls.filter((c) => c.method === "session.write");
		// The first write was retried with its original id.
		expect(writes[0].params.writeId).toBe(writes[1].params.writeId);
		runtime.detach();
	});

	test("reports output the device no longer retains instead of skipping it", async () => {
		const exec = fakeExecutor(4);
		const out = capture();
		const runtime = spawnRemoteSession(
			DEVICE,
			"s1",
			{ open: openOpts, since: 0, onData: out.onData },
			exec,
		);
		await runtime.ready;
		exec.disconnect();
		exec.emit("0123456789");
		exec.reconnect();
		await until(() => out.text().includes("6789"));
		expect(out.text()).toContain("6 bytes of output were not retained");
		expect(out.lastSeq()).toBe(10);
		runtime.detach();
	});

	test("resuming after a NarraFork restart starts at the saved position", async () => {
		const exec = fakeExecutor();
		exec.state.opened = true;
		exec.emit("before restart|after restart");
		const out = capture();
		const runtime = spawnRemoteSession(DEVICE, "s1", { since: 15, onData: out.onData }, exec);
		await until(() => out.text() === "after restart");
		expect(exec.state.calls.some((c) => c.method === "session.open")).toBe(false);
		runtime.detach();
	});

	test("a lost session (executor restarted) ends the terminal", async () => {
		const exec = fakeExecutor();
		const runtime = spawnRemoteSession(DEVICE, "s1", { since: 0, onData: () => {} }, exec);
		expect(await runtime.exited).toBeNull();
	});

	test("detach stops reading but never stops the shell", async () => {
		const exec = fakeExecutor();
		const out = capture();
		const runtime = spawnRemoteSession(
			DEVICE,
			"s1",
			{ open: openOpts, since: 0, onData: out.onData },
			exec,
		);
		await runtime.ready;
		runtime.detach();
		exec.emit("ignored");
		await Bun.sleep(20);
		expect(out.text()).toBe("");
		expect(exec.state.calls.some((c) => c.method === "session.kill")).toBe(false);
	});

	test("kill stops reading and leaves stopping the session to the terminal service", async () => {
		const exec = fakeExecutor();
		const runtime = spawnRemoteSession(
			DEVICE,
			"s1",
			{ open: openOpts, since: 0, onData: () => {} },
			exec,
		);
		await runtime.ready;
		runtime.kill();
		expect(await runtime.exited).toBe(-1);
		await Bun.sleep(20);
		expect(exec.state.calls.some((c) => c.method === "session.kill")).toBe(false);
	});

	test("an open whose reply was lost is adopted once the device returns", async () => {
		const exec = fakeExecutor();
		exec.state.loseNextOpenAck = true;
		const out = capture();
		const runtime = spawnRemoteSession(
			DEVICE,
			"s1",
			{ open: openOpts, since: 0, onData: out.onData },
			exec,
		);
		await until(() => !exec.state.online);
		exec.reconnect();
		await runtime.ready;
		expect(exec.state.calls.filter((c) => c.method === "session.open")).toHaveLength(2);
		exec.emit("adopted");
		await until(() => out.text() === "adopted");
		runtime.detach();
	});

	test("an open that stays unconfirmed is reported as possibly started", async () => {
		const exec = fakeExecutor();
		exec.state.loseNextOpenAck = true;
		const runtime = spawnRemoteSession(
			DEVICE,
			"s1",
			{ open: openOpts, since: 0, onData: () => {} },
			{ ...exec, openTimeoutMs: 50 },
		);
		await expect(runtime.ready).rejects.toBeInstanceOf(RemoteSessionOpenUnknownError);
		expect(await runtime.exited).toBeNull();
	});

	test("a gap is reported before its notice and later output", async () => {
		const exec = fakeExecutor(4);
		const events: string[] = [];
		const runtime = spawnRemoteSession(
			DEVICE,
			"s1",
			{
				open: openOpts,
				since: 0,
				onData: (text) => events.push(`data:${text.includes("not retained") ? "notice" : text}`),
				onGap: (missing, seq) => events.push(`gap:${missing}@${seq}`),
			},
			exec,
		);
		await runtime.ready;
		exec.disconnect();
		exec.emit("0123456789");
		exec.reconnect();
		await until(() => events.includes("data:6789"));
		expect(events).toEqual(["gap:6@6", "data:notice", "data:6789"]);
		runtime.detach();
	});

	test("an exec session opens with its command and delivers raw bytes with positions", async () => {
		const exec = fakeExecutor(4);
		const chunks: { bytes: Uint8Array; seq: number }[] = [];
		const lost: string[] = [];
		const runtime = spawnRemoteSession(
			DEVICE,
			"nf-bash-1",
			{
				open: { kind: "exec", command: "make", cwd: "/w", timeoutMs: 5_000 },
				since: 0,
				onBytes: (bytes, seq) => chunks.push({ bytes, seq }),
				onLost: (reason) => lost.push(reason),
			},
			exec,
		);
		await runtime.ready;
		expect(exec.state.calls[0]).toEqual({
			method: "session.open",
			params: {
				sessionId: "nf-bash-1",
				kind: "exec",
				command: "make",
				cwd: "/w",
				timeoutMs: 5_000,
			},
		});
		// A split character is passed through untouched: bytes are not decoded here.
		exec.emit(new Uint8Array([0xe4, 0xb8]));
		await until(() => chunks.length === 1);
		expect([...chunks[0].bytes]).toEqual([0xe4, 0xb8]);
		expect(chunks[0].seq).toBe(2);
		exec.disconnect();
		exec.emit("0123456789");
		exec.reconnect();
		exec.exit(3);
		expect(await runtime.exited).toBe(3);
		const text = new TextDecoder().decode(
			Buffer.concat(chunks.slice(1).map((chunk) => Buffer.from(chunk.bytes))),
		);
		expect(text).toBe("\n[NarraFork: 6 bytes of output were not retained by the device]\n6789");
		expect(chunks.at(-1)?.seq).toBe(12);
		expect(lost).toEqual([]);
	});

	test("a command whose open reply was lost is confirmed, never sent twice", async () => {
		const exec = fakeExecutor();
		exec.state.loseNextOpenAck = true;
		const runtime = spawnRemoteSession(
			DEVICE,
			"nf-bash-2",
			{ open: { kind: "exec", command: "deploy", cwd: "/w" }, since: 0, onBytes: () => {} },
			{ ...exec, openTimeoutMs: 2_000 },
		);
		await Bun.sleep(20);
		exec.reconnect();
		await runtime.ready;
		const methods = exec.state.calls.map((call) => call.method);
		expect(methods.filter((method) => method === "session.open")).toHaveLength(1);
		expect(methods).toContain("session.info");
		runtime.detach();
	});

	test("an executor that lost the command after a lost open reply leaves the start unknown", async () => {
		const exec = fakeExecutor();
		exec.state.loseNextOpenAck = true;
		const runtime = spawnRemoteSession(
			DEVICE,
			"nf-bash-3",
			{ open: { kind: "exec", command: "deploy", cwd: "/w" }, since: 0, onBytes: () => {} },
			{ ...exec, openTimeoutMs: 2_000 },
		);
		await Bun.sleep(20);
		// The executor restarted: it no longer knows the session.
		exec.state.opened = false;
		exec.reconnect();
		const error = await (runtime.ready ?? Promise.resolve()).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(RemoteSessionOpenUnknownError);
		expect(exec.state.calls.filter((call) => call.method === "session.open")).toHaveLength(1);
	});

	test("the executor's own deadline is reported with the exit", async () => {
		const exec = fakeExecutor();
		const exits: unknown[] = [];
		const runtime = spawnRemoteSession(
			DEVICE,
			"nf-bash-4",
			{
				open: { kind: "exec", command: "sleep 9", cwd: "/w", timeoutMs: 10 },
				since: 0,
				onBytes: () => {},
				onExit: (exit) => exits.push(exit),
			},
			{
				...exec,
				sendRpc: (deviceId, method, params, options) =>
					method === "session.attach"
						? Promise.resolve({ exitCode: 137, endSeq: 0, timedOut: true })
						: exec.sendRpc(deviceId, method, params, options),
			},
		);
		expect(await runtime.exited).toBe(137);
		expect(exits).toEqual([{ exitCode: 137, timedOut: true, outputIncomplete: false }]);
	});

	test("a session lost to an executor restart delivers its recorded output, then ends", async () => {
		const exec = fakeExecutor();
		exec.state.opened = true;
		const out = capture();
		const runtime = spawnRemoteSession(
			DEVICE,
			"s1",
			{ since: 0, onData: out.onData },
			{
				...exec,
				sendRpc: (deviceId, method, params, options) => {
					if (method !== "session.attach") return exec.sendRpc(deviceId, method, params, options);
					options?.onStream?.("session.data", new TextEncoder().encode("recorded output\r\n"));
					return Promise.resolve({ exitCode: -1, endSeq: 17, lost: true });
				},
			},
		);
		expect(await runtime.exited).toBeNull();
		expect(out.text()).toStartWith("recorded output\r\n");
		expect(out.text()).toContain("executor restarted while this was running");
	});

	test("a lost command reports the restart to its owner instead of a terminal notice", async () => {
		const exec = fakeExecutor();
		exec.state.opened = true;
		const chunks: string[] = [];
		const lost: string[] = [];
		const runtime = spawnRemoteSession(
			DEVICE,
			"nf-bash-5",
			{
				since: 0,
				onBytes: (bytes) => chunks.push(new TextDecoder().decode(bytes)),
				onLost: (reason) => lost.push(reason),
			},
			{
				...exec,
				sendRpc: (deviceId, method, params, options) => {
					if (method !== "session.attach") return exec.sendRpc(deviceId, method, params, options);
					options?.onStream?.("session.data", new TextEncoder().encode("step 1\n"));
					return Promise.resolve({ exitCode: -1, endSeq: 7, lost: true });
				},
			},
		);
		expect(await runtime.exited).toBeNull();
		expect(chunks.join("")).toBe("step 1\n");
		expect(lost).toEqual([LOST_REASON]);
	});

	test("a session the executor no longer has is reported as lost", async () => {
		const exec = fakeExecutor();
		const lost: string[] = [];
		const runtime = spawnRemoteSession(
			DEVICE,
			"s1",
			{ since: 0, onBytes: () => {}, onLost: (reason) => lost.push(reason) },
			exec,
		);
		expect(await runtime.exited).toBeNull();
		expect(lost).toEqual(["session not found"]);
	});

	test("terminal session ids are stable and valid executor ids", () => {
		expect(terminalSessionId("abc_DEF-123")).toBe("nf-term-abc_DEF-123");
		expect(terminalSessionId("abc_DEF-123")).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
	});
});
