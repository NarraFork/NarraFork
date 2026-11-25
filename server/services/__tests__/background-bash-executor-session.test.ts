import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { backgroundTasks, executorSessionCleanups, narrators } from "../../db/schema";
import { eventBus } from "../../lib/event-bus";
import { backgroundTaskService } from "../background-task-service";
import type { SendRpcOptions } from "../device-connection-service";
import * as deviceConnections from "../device-connection-service";
import { RemoteBackend } from "../device-remote-backend";
import { backgroundSessionId } from "../remote-session-exec";

const PARENT = "parent-bg-session";
const DEVICE = "dev-bg";
const now = "2026-01-01T00:00:00.000Z";

interface Call {
	method: string;
	params: Record<string, unknown>;
	options?: SendRpcOptions;
}
const calls: Call[] = [];
const order: string[] = [];
let attach:
	| {
			stream: NonNullable<SendRpcOptions["onStream"]>;
			end: (result: unknown) => void;
			fail: (e: Error) => void;
	  }
	| undefined;
let attachFailure: Error | undefined;

const defaultRpc: typeof deviceConnections.sendRpc = (_deviceId, method, params, options) => {
	calls.push({ method, params, options });
	order.push(method);
	if (method === "session.attach") {
		if (attachFailure) return Promise.reject(attachFailure);
		return new Promise((resolve, reject) => {
			attach = { stream: options?.onStream ?? (() => {}), end: resolve, fail: reject };
		});
	}
	return Promise.resolve({});
};
const sendRpc = spyOn(deviceConnections, "sendRpc").mockImplementation(defaultRpc);
let online = true;
const isOnline = spyOn(deviceConnections, "isDeviceOnline").mockImplementation(() => online);
let features = ["session.durable.v1", "session.exec.v1"];
const hasFeature = spyOn(deviceConnections, "hasDeviceProtocolFeature").mockImplementation(
	(_deviceId, feature) => features.includes(feature),
);
const generation = spyOn(deviceConnections, "getDeviceConnectionGeneration").mockImplementation(
	() => 1,
);

const encode = (text: string) => new TextEncoder().encode(text);

async function until(cond: () => boolean) {
	const deadline = Date.now() + 3_000;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await Bun.sleep(5);
	}
}

function row(id: string) {
	return db.select().from(backgroundTasks).where(eq(backgroundTasks.id, id)).get();
}
function cleanups() {
	return db.select().from(executorSessionCleanups).all();
}

async function runningTask(id: string, backgroundKind: "task" | "service" = "task") {
	await backgroundTaskService.createBashTask({
		id,
		parentNarratorId: PARENT,
		command: "make build",
		backgroundKind,
	});
	await backgroundTaskService.bindExecutorSession(id, {
		deviceId: DEVICE,
		sessionId: backgroundSessionId(id),
		timeoutMs: 600_000,
		startedAt: new Date().toISOString(),
	});
}

beforeEach(() => {
	calls.length = 0;
	order.length = 0;
	attach = undefined;
	attachFailure = undefined;
	online = true;
	features = ["session.durable.v1", "session.exec.v1"];
	sendRpc.mockImplementation(defaultRpc);
	db.insert(narrators)
		.values({ id: PARENT, variant: "primary", status: "idle", createdAt: now, updatedAt: now })
		.run();
});

afterEach(() => {
	// Going offline ends any cleanup retry a test left scheduled.
	eventBus.emit({ type: "device:status", deviceId: DEVICE, status: "offline" });
	cleanDb(sqlite);
});

afterAll(() => {
	sendRpc.mockRestore();
	isOnline.mockRestore();
	hasFeature.mockRestore();
	generation.mockRestore();
});

describe("remote background Bash on durable executor sessions", () => {
	test("the session is bound to the task before it is opened, with the task's deadline", async () => {
		const backend = new RemoteBackend(DEVICE, { connectionGeneration: 1 });
		const bound: unknown[] = [];
		const handle = await backend.execCommand({
			command: "make build",
			cwd: "/work",
			env: { CI: "1" },
			backgroundSession: {
				taskId: "bash_1",
				timeoutMs: 600_000,
				bind: async (binding) => {
					order.push("bind");
					bound.push(binding);
				},
			},
		});
		expect(order.slice(0, 2)).toEqual(["bind", "session.open"]);
		expect(bound).toMatchObject([
			{ deviceId: DEVICE, sessionId: "nf-bash-bash_1", timeoutMs: 600_000 },
		]);
		const open = calls.find((call) => call.method === "session.open");
		expect(open?.params).toEqual({
			sessionId: "nf-bash-bash_1",
			kind: "exec",
			command: "make build",
			cwd: "/work",
			env: { CI: "1" },
			timeoutMs: 600_000,
		});
		expect(open?.options?.requiredFeatures).toEqual(["session.durable.v1", "session.exec.v1"]);

		const chunks: string[] = [];
		handle.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
		await until(() => attach !== undefined);
		attach?.stream("session.data", encode("compiling\n"));
		attach?.end({ exitCode: 0, endSeq: 10 });
		expect(await handle.exited).toBe(0);
		expect(chunks.join("")).toBe("compiling\n");
		expect(handle.outputIncomplete?.()).toBe(false);
	});

	test("an executor without exec sessions keeps the request-bound exec.start", async () => {
		features = ["session.durable.v1"];
		const backend = new RemoteBackend(DEVICE, { connectionGeneration: 1 });
		const handle = await backend.execCommand({
			command: "true",
			cwd: "/work",
			backgroundSession: {
				taskId: "bash_2",
				bind: async () => {
					throw new Error("must not bind");
				},
			},
		});
		await handle.exited;
		expect(calls.map((call) => call.method)).toEqual(["exec.start"]);
	});

	test("after a restart the command is re-attached, completed from the executor, then released", async () => {
		await runningTask("bash_live");
		expect(await backgroundTaskService.recoverStaleTasksAfterRestart()).toBe(1);
		await until(() => attach !== undefined);
		expect(calls.find((call) => call.method === "session.attach")?.params).toEqual({
			sessionId: "nf-bash-bash_live",
			since: 0,
		});
		expect(row("bash_live")?.status).toBe("running");
		// Everything the executor retained is replayed, including output from before the restart.
		attach?.stream("session.data", encode("step 1\nstep 2\n"));
		attach?.end({ exitCode: 0, endSeq: 14 });
		await until(() => row("bash_live")?.status === "completed");
		expect(row("bash_live")?.output).toContain("step 1\nstep 2");
		// Released only once the result is persisted.
		await until(() => calls.some((call) => call.method === "session.kill"));
		expect(calls.find((call) => call.method === "session.kill")?.params).toEqual({
			sessionId: "nf-bash-bash_live",
			release: true,
		});
		await until(() => cleanups().length === 0);
	});

	test("a session the executor no longer has fails the task with the reason", async () => {
		await runningTask("bash_lost", "service");
		attachFailure = new Error("session not found");
		await backgroundTaskService.recoverStaleTasksAfterRestart();
		await until(() => row("bash_lost")?.status === "failed");
		expect(row("bash_lost")?.output).toContain(
			"the device no longer has this command's session: session not found",
		);
	});

	test("cancelling while the device is away keeps a durable stop until the device confirms it", async () => {
		await runningTask("bash_away");
		online = false;
		await backgroundTaskService.recoverStaleTasksAfterRestart();
		expect(calls).toEqual([]);
		expect(await backgroundTaskService.cancel("bash_away")).toBe(true);
		await until(() => row("bash_away")?.status === "cancelled");
		expect(cleanups()).toMatchObject([{ deviceId: DEVICE, sessionId: "nf-bash-bash_away" }]);
		online = true;
		eventBus.emit({ type: "device:status", deviceId: DEVICE, status: "online" });
		await until(() => cleanups().length === 0);
		expect(
			calls.filter((call) => call.method === "session.kill").map((call) => call.params),
		).toEqual([{ sessionId: "nf-bash-bash_away", release: true }]);
	});
});
