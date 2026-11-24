import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { terminals } from "../../db/schema";
import { logger } from "../../lib/logger";
import { BufferManager } from "../../terminal/buffer-manager";
import { resetRemoteSessionStateForTests } from "../../terminal/remote-session";
import type { SendRpcOptions } from "../device-connection-service";
import * as deviceConnections from "../device-connection-service";
import * as deviceService from "../device-service";
import { terminalService } from "../terminal-service";

const now = "2026-01-01T00:00:00.000Z";
const calls: { method: string; params: Record<string, unknown>; options?: SendRpcOptions }[] = [];

const sendRpc = spyOn(deviceConnections, "sendRpc").mockImplementation(
	(_deviceId, method, params, options) => {
		calls.push({ method, params, options });
		// attach stays open like a live session; everything else succeeds.
		if (method === "session.attach") return new Promise(() => {});
		return Promise.resolve({});
	},
);
const online = spyOn(deviceConnections, "isDeviceOnline").mockReturnValue(true);
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
	features = ["pty.ready-stream.v1", "session.durable.v1"];
});

afterEach(async () => {
	await terminalService.shutdownAll().catch(() => {});
	resetRemoteSessionStateForTests();
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
		});
		expect(row("t-durable")?.status).toBe("exited");
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
});
