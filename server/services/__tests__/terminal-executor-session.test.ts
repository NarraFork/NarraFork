import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { executorSessionCleanups, terminals } from "../../db/schema";
import { eventBus } from "../../lib/event-bus";
import { logger } from "../../lib/logger";
import { BufferManager } from "../../terminal/buffer-manager";
import type { SendRpcOptions } from "../device-connection-service";
import * as deviceConnections from "../device-connection-service";
import * as deviceService from "../device-service";
import { terminalService } from "../terminal-service";
import * as terminalWatches from "../terminal-watch-service";

const now = "2026-01-01T00:00:00.000Z";
const calls: { method: string; params: Record<string, unknown>; options?: SendRpcOptions }[] = [];

let endAttach: ((result: unknown) => void) | undefined;
let attachStream: SendRpcOptions["onStream"];
/** Terminal row status at the moment each session.kill was sent. */
const killSeenStatus: (string | undefined)[] = [];
const defaultRpc: typeof deviceConnections.sendRpc = (_deviceId, method, params, options) => {
	calls.push({ method, params, options });
	// attach stays open like a live session; everything else succeeds.
	if (method === "session.attach")
		return new Promise((resolve) => {
			attachStream = options?.onStream;
			endAttach = resolve;
		});
	if (method === "session.kill") {
		const id = String(params.sessionId).replace(/^nf-term-/, "");
		killSeenStatus.push(db.select().from(terminals).where(eq(terminals.id, id)).get()?.status);
	}
	return Promise.resolve({});
};
const sendRpc = spyOn(deviceConnections, "sendRpc").mockImplementation(defaultRpc);
let deviceOnline = true;
const online = spyOn(deviceConnections, "isDeviceOnline").mockImplementation(() => deviceOnline);
const info = spyOn(logger, "info").mockImplementation(() => {});
let features = ["pty.ready-stream.v1", "session.durable.v1"];
const hello = spyOn(deviceConnections, "getConnectedDeviceHello").mockImplementation(
	() =>
		({
			platform: { os: "linux", arch: "amd64", shellPath: "/bin/bash" },
			defaultCwd: "/home/dev",
			capabilities: { pty: true, features },
		}) as unknown as ReturnType<typeof deviceConnections.getConnectedDeviceHello>,
);
const authorize = spyOn(deviceService, "requireAuthorizedDeviceForProject").mockResolvedValue(
	{} as Awaited<ReturnType<typeof deviceService.requireAuthorizedDeviceForProject>>,
);

function insertTerminal(id: string, values: Partial<typeof terminals.$inferInsert>) {
	db.insert(terminals)
		.values({ id, name: "T", status: "running", createdAt: now, ...values })
		.run();
}

async function saveSnapshot(id: string, text: string, streamSeq?: number) {
	const buffer = new BufferManager(id);
	buffer.append(text, streamSeq);
	await buffer.saveToDisk();
	await buffer.dispose();
}

function row(id: string) {
	return db.select().from(terminals).where(eq(terminals.id, id)).get();
}

async function until(cond: () => boolean) {
	const deadline = Date.now() + 2_000;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await Bun.sleep(5);
	}
}

beforeEach(() => {
	calls.length = 0;
	killSeenStatus.length = 0;
	deviceOnline = true;
	endAttach = undefined;
	attachStream = undefined;
	features = ["pty.ready-stream.v1", "session.durable.v1"];
	sendRpc.mockImplementation(defaultRpc);
});

function cleanups() {
	return db.select().from(executorSessionCleanups).all();
}

function goOnline(deviceId = "dev-1") {
	deviceOnline = true;
	eventBus.emit({ type: "device:status", deviceId, status: "online" });
}

afterEach(async () => {
	// Going offline ends any cleanup retry a test left scheduled.
	deviceOnline = false;
	for (const deviceId of ["dev-1", "dev-2", "dev-3"])
		eventBus.emit({ type: "device:status", deviceId, status: "offline" });
	await terminalService.shutdownAll().catch(() => {});
	terminalWatches.resetRestoredWatchAnchorsForTests();
	for (const id of ["t-durable", "t-unnumbered", "t-legacy"])
		await new BufferManager(id).deleteFromDisk();
	cleanDb(sqlite);
});

afterAll(() => {
	sendRpc.mockRestore();
	online.mockRestore();
	info.mockRestore();
	hello.mockRestore();
	authorize.mockRestore();
});

describe("remote terminals backed by executor sessions", () => {
	test("startup recovery resumes reading at the snapshot's position and keeps the row running", async () => {
		insertTerminal("t-durable", { deviceId: "dev-1", executorSessionId: "nf-term-t-durable" });
		await saveSnapshot("t-durable", "hello", 5);

		await terminalService.recoverOnStartup();

		expect(terminalService.isAttached("t-durable")).toBe(true);
		expect(row("t-durable")?.status).toBe("running");
		await until(() => calls.some((call) => call.method === "session.attach"));
		const attach = calls.find((call) => call.method === "session.attach");
		expect(attach?.params).toEqual({ sessionId: "nf-term-t-durable", since: 5 });
		expect(attach?.options?.longLived).toBe(true);
		expect(calls.some((call) => call.method === "session.open")).toBe(false);
	});

	test("a snapshot without a stream position is replaced by the device's retained output", async () => {
		insertTerminal("t-unnumbered", {
			deviceId: "dev-1",
			executorSessionId: "nf-term-t-unnumbered",
		});
		await saveSnapshot("t-unnumbered", "old text");

		await terminalService.recoverOnStartup();

		await until(() => calls.some((call) => call.method === "session.attach"));
		expect(calls.find((call) => call.method === "session.attach")?.params.since).toBe(0);
	});

	test("shutdown detaches without killing the remote shell and saves the position", async () => {
		insertTerminal("t-durable", { deviceId: "dev-1", executorSessionId: "nf-term-t-durable" });
		await saveSnapshot("t-durable", "hello", 5);
		await terminalService.recoverOnStartup();
		await until(() => calls.some((call) => call.method === "session.attach"));
		const attach = calls.find((call) => call.method === "session.attach");
		// Output arriving after the restart advances the saved position.
		attach?.options?.onStream?.("session.data", new TextEncoder().encode(" world"));

		await terminalService.shutdownAll();

		expect(calls.some((call) => call.method === "session.kill")).toBe(false);
		expect(row("t-durable")?.status).toBe("running");
		const reloaded = new BufferManager("t-durable");
		expect(await reloaded.loadFromDisk()).toBe(true);
		expect(reloaded.restoredStreamSeq).toBe(11);
		await reloaded.dispose();
	});

	test("killing a recovered terminal stops its executor session", async () => {
		insertTerminal("t-durable", { deviceId: "dev-1", executorSessionId: "nf-term-t-durable" });
		await terminalService.recoverOnStartup();
		await terminalService.kill("t-durable");
		await until(() => calls.some((call) => call.method === "session.kill"));
		expect(calls.find((call) => call.method === "session.kill")?.params).toEqual({
			sessionId: "nf-term-t-durable",
			release: true,
		});
		expect(row("t-durable")?.status).toBe("exited");
		await until(() => cleanups().length === 0);
	});

	test("a stop requested while the device is away is kept until the device confirms it", async () => {
		insertTerminal("t-durable", { deviceId: "dev-1", executorSessionId: "nf-term-t-durable" });
		await terminalService.recoverOnStartup();
		deviceOnline = false;
		await terminalService.kill("t-durable");
		expect(row("t-durable")?.status).toBe("exited");
		expect(cleanups()).toMatchObject([{ deviceId: "dev-1", sessionId: "nf-term-t-durable" }]);
		expect(calls.some((call) => call.method === "session.kill")).toBe(false);
		// Deleting the terminal row (narrator cleanup) must not drop the stop.
		db.delete(terminals).where(eq(terminals.id, "t-durable")).run();
		goOnline();
		await until(() => cleanups().length === 0);
		expect(calls.find((call) => call.method === "session.kill")?.params).toEqual({
			sessionId: "nf-term-t-durable",
			release: true,
		});
	});

	test("a pending stop left by a previous process is delivered when the device connects", async () => {
		db.insert(executorSessionCleanups)
			.values({ deviceId: "dev-2", sessionId: "nf-term-old", createdAt: now })
			.run();
		sendRpc.mockImplementation((_deviceId, method, params, options) => {
			calls.push({ method, params, options });
			// The executor restarted meanwhile: the session is gone, which settles it too.
			return Promise.reject(new Error("session not found"));
		});
		goOnline("dev-2");
		await until(() => cleanups().length === 0);
		expect(calls.map((call) => call.method)).toEqual(["session.kill"]);
	});

	test("a stop the device cannot confirm stays pending", async () => {
		db.insert(executorSessionCleanups)
			.values({ deviceId: "dev-3", sessionId: "nf-term-x", createdAt: now })
			.run();
		sendRpc.mockImplementation((_deviceId, method, params, options) => {
			calls.push({ method, params, options });
			return Promise.reject(new deviceConnections.DeviceOfflineError("dev-3"));
		});
		goOnline("dev-3");
		await until(() => calls.length === 1);
		await Bun.sleep(20);
		expect(cleanups()).toHaveLength(1);
	});

	test("a stop that fails while the device stays online is retried without a reconnect", async () => {
		db.insert(executorSessionCleanups)
			.values({ deviceId: "dev-3", sessionId: "nf-term-retry", createdAt: now })
			.run();
		let failures = 1;
		sendRpc.mockImplementation((_deviceId, method, params, options) => {
			calls.push({ method, params, options });
			// A transient failure: the executor is reachable but did not confirm in time.
			if (failures-- > 0) return Promise.reject(new Error("RPC timed out"));
			return Promise.resolve({});
		});
		goOnline("dev-3");
		await until(() => calls.length === 2);
		await until(() => cleanups().length === 0);
		expect(calls.map((call) => call.params)).toEqual([
			{ sessionId: "nf-term-retry", release: true },
			{ sessionId: "nf-term-retry", release: true },
		]);
	});

	test("a late offline event from a replaced connection keeps the retry", async () => {
		db.insert(executorSessionCleanups)
			.values({ deviceId: "dev-3", sessionId: "nf-term-late", createdAt: now })
			.run();
		let failures = 1;
		sendRpc.mockImplementation((_deviceId, method, params, options) => {
			calls.push({ method, params, options });
			if (failures-- > 0) return Promise.reject(new Error("RPC timed out"));
			return Promise.resolve({});
		});
		goOnline("dev-3");
		await until(() => calls.length === 1);
		// The old socket's offline status is published after the new one connected.
		eventBus.emit({ type: "device:status", deviceId: "dev-3", status: "offline" });
		await until(() => cleanups().length === 0);
		expect(calls).toHaveLength(2);
	});

	test("an exited shell is released only after its final state is persisted", async () => {
		insertTerminal("t-durable", { deviceId: "dev-1", executorSessionId: "nf-term-t-durable" });
		await terminalService.recoverOnStartup();
		await until(() => endAttach !== undefined);
		endAttach?.({ exitCode: 7, endSeq: 0 });
		await until(() => calls.some((call) => call.method === "session.kill"));
		expect(killSeenStatus).toEqual(["exited"]);
		expect(row("t-durable")?.exitCode).toBe(7);
		expect(calls.some((call) => call.method === "session.release")).toBe(false);
		await until(() => cleanups().length === 0);
	});

	test("output held behind a gap is persisted before the exit disposes the buffer", async () => {
		let resumeGap: (() => void) | undefined;
		const gapHandling = spyOn(terminalWatches, "interruptTextWatchesForGap").mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resumeGap = resolve;
				}),
		);
		try {
			insertTerminal("t-durable", { deviceId: "dev-1", executorSessionId: "nf-term-t-durable" });
			await terminalService.recoverOnStartup();
			await until(() => attachStream !== undefined);
			const encode = (text: string) => new TextEncoder().encode(text);
			attachStream?.("session.gap", encode(JSON.stringify({ from: 0, to: 40 })));
			attachStream?.("session.data", encode("AFTER_THE_GAP\r\n"));
			endAttach?.({ exitCode: 0, endSeq: 55 });
			// The exit waits for gap handling instead of dropping the held output.
			await Bun.sleep(30);
			expect(row("t-durable")?.status).toBe("running");
			resumeGap?.();
			await until(() => row("t-durable")?.status === "exited");
			const saved = new BufferManager("t-durable");
			expect(await saved.loadFromDisk()).toBe(true);
			expect(await saved.getContents()).toContain("AFTER_THE_GAP");
			expect(saved.restoredStreamSeq).toBe(55);
			await saved.dispose();
		} finally {
			gapHandling.mockRestore();
		}
	});

	test("an executor restart settles text watches before its notice reaches the buffer", async () => {
		const settled: Array<{ outcome: string; content: string }> = [];
		const restartHandling = spyOn(
			terminalWatches,
			"interruptTextWatchesForRestart",
		).mockImplementation(async (_id, buffer, outcome) => {
			settled.push({ outcome, content: await buffer.getContents() });
		});
		try {
			insertTerminal("t-durable", { deviceId: "dev-1", executorSessionId: "nf-term-t-durable" });
			await terminalService.recoverOnStartup();
			await until(() => attachStream !== undefined);
			attachStream?.("session.data", new TextEncoder().encode("REPLAYED\r\n"));
			endAttach?.({ exitCode: 0, endSeq: 10, outputIncomplete: true });
			await until(() => row("t-durable")?.status === "exited");
			// Watches saw the replayed output, not the notice that followed it.
			expect(settled).toHaveLength(1);
			expect(settled[0].outcome).toBe("incomplete");
			expect(settled[0].content).toContain("REPLAYED");
			expect(settled[0].content).not.toContain("part of it is missing");
			const saved = new BufferManager("t-durable");
			expect(await saved.loadFromDisk()).toBe(true);
			expect(await saved.getContents()).toContain("part of it is missing");
			await saved.dispose();
		} finally {
			restartHandling.mockRestore();
		}
	});

	test("replayed output waits until the snapshot's text watches are resumed", async () => {
		insertTerminal("t-durable", { deviceId: "dev-1", executorSessionId: "nf-term-t-durable" });
		const source = new BufferManager("t-durable");
		source.append("$ ", 2);
		const cursor = await source.markReadCursor();
		if (!cursor) throw new Error("no cursor");
		const start = { kind: "offset", offset: cursor.offset, textBefore: cursor.textBefore };
		expect(
			source.setDurableAnchor("bash_w1", cursor, { version: 1, pattern: "READY", start }),
		).toBe(true);
		await source.saveToDisk();
		await source.dispose();

		await terminalService.recoverOnStartup();
		await until(() => attachStream !== undefined);
		attachStream?.("session.data", new TextEncoder().encode("READY\r\n"));
		await Bun.sleep(30);
		const buffer = terminalService.getActiveBuffer("t-durable");
		if (!buffer) throw new Error("no buffer");
		expect(await buffer.getContents()).not.toContain("READY");
		// Recovery gives up the watch nobody resumed; the output then reaches the buffer.
		terminalWatches.closeRestoredWatchAnchors();
		await Bun.sleep(10);
		expect(await buffer.getContents()).toContain("READY");
	});

	test("a gap reported while output is held is handled after the output before it", async () => {
		const seen: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const gapHandling = spyOn(terminalWatches, "interruptTextWatchesForGap").mockImplementation(
			async (_id, buffer) => {
				seen.push(await buffer.getContents());
				if (seen.length === 1)
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
			},
		);
		try {
			insertTerminal("t-durable", { deviceId: "dev-1", executorSessionId: "nf-term-t-durable" });
			await terminalService.recoverOnStartup();
			await until(() => attachStream !== undefined);
			const encode = (text: string) => new TextEncoder().encode(text);
			attachStream?.("session.gap", encode(JSON.stringify({ from: 0, to: 10 })));
			attachStream?.("session.data", encode("MIDDLE\r\n"));
			attachStream?.("session.gap", encode(JSON.stringify({ from: 30, to: 40 })));
			attachStream?.("session.data", encode("AFTER\r\n"));
			await until(() => releaseFirst !== undefined);
			releaseFirst?.();
			await until(() => seen.length === 2);
			// The second gap's watches saw the output before it, never the output after it.
			expect(seen[1]).toContain("MIDDLE");
			expect(seen[1]).not.toContain("AFTER");
			const buffer = terminalService.getActiveBuffer("t-durable");
			await Bun.sleep(10);
			expect(await buffer?.getContents()).toContain("AFTER");
		} finally {
			gapHandling.mockRestore();
		}
	});

	test("a closing terminal records its stop before the row is marked exited", async () => {
		insertTerminal("t-durable", { deviceId: "dev-1", executorSessionId: "nf-term-t-durable" });
		await terminalService.recoverOnStartup();
		deviceOnline = false;
		const pendingAtExit: number[] = [];
		const onExited = () => {
			pendingAtExit.push(cleanups().length);
		};
		eventBus.on("terminal:exited", onExited);
		try {
			await terminalService.kill("t-durable");
		} finally {
			eventBus.off("terminal:exited", onExited);
		}
		// An interruption right after the row turned exited still leaves the stop behind.
		expect(pendingAtExit).toEqual([1]);
	});

	test("a legacy remote terminal (pty.open) is still marked exited on startup", async () => {
		insertTerminal("t-legacy", { deviceId: "dev-1" });
		await terminalService.recoverOnStartup();
		expect(terminalService.isAttached("t-legacy")).toBe(false);
		expect(row("t-legacy")?.status).toBe("exited");
		expect(calls).toEqual([]);
	});

	test("a new remote terminal on a capable device runs in a durable executor session", async () => {
		const terminal = await terminalService.create({ deviceId: "dev-1" });
		const sessionId = `nf-term-${terminal.id}`;
		expect(terminal.executorSessionId).toBe(sessionId);
		const open = calls.find((call) => call.method === "session.open");
		expect(open?.params).toMatchObject({
			sessionId,
			kind: "pty",
			cmd: ["/bin/bash", "-l"],
			cwd: "/home/dev",
		});
		await until(() => calls.some((call) => call.method === "session.attach"));
		expect(calls.find((call) => call.method === "session.attach")?.params.since).toBe(0);
		expect(calls.some((call) => call.method === "pty.open")).toBe(false);
		await terminalService.kill(terminal.id);
		await new BufferManager(terminal.id).deleteFromDisk();
	});

	test("an executor without durable sessions keeps the legacy pty.open terminal", async () => {
		features = ["pty.ready-stream.v1"];
		sendRpc.mockImplementation((_deviceId, method, params, options) => {
			calls.push({ method, params, options });
			if (method === "pty.open") {
				options?.onStream?.("pty_ready", new Uint8Array());
				return new Promise(() => {});
			}
			return Promise.resolve({});
		});
		try {
			const terminal = await terminalService.create({ deviceId: "dev-1" });
			expect(terminal.executorSessionId).toBeNull();
			expect(calls.some((call) => call.method === "pty.open")).toBe(true);
			expect(calls.some((call) => call.method.startsWith("session."))).toBe(false);
			await terminalService.kill(terminal.id);
			await new BufferManager(terminal.id).deleteFromDisk();
		} finally {
			sendRpc.mockImplementation((_deviceId, method, params, options) => {
				calls.push({ method, params, options });
				if (method === "session.attach") return new Promise(() => {});
				return Promise.resolve({});
			});
		}
	});

	test("an open whose reply was lost is adopted when the device returns", async () => {
		let opens = 0;
		sendRpc.mockImplementation((_deviceId, method, params, options) => {
			calls.push({ method, params, options });
			if (method === "session.open") {
				opens++;
				if (opens === 1) {
					deviceOnline = false;
					setTimeout(() => goOnline(), 20);
					return Promise.reject(new deviceConnections.DeviceOfflineError("dev-1"));
				}
				return Promise.reject(new Error("session already exists"));
			}
			if (method === "session.attach") return new Promise(() => {});
			return Promise.resolve({});
		});
		const terminal = await terminalService.create({ deviceId: "dev-1" });
		expect(terminal.status).toBe("running");
		expect(opens).toBe(2);
		expect(cleanups()).toEqual([]);
		await terminalService.kill(terminal.id);
		await new BufferManager(terminal.id).deleteFromDisk();
	});
});
