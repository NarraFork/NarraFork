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
let heldOpen: ((value: unknown) => void) | undefined;
let holdOpen = false;

const defaultRpc: typeof deviceConnections.sendRpc = (_deviceId, method, params, options) => {
	calls.push({ method, params, options });
	order.push(method);
	if (method === "session.open" && holdOpen)
		return new Promise((resolve) => {
			heldOpen = resolve;
		});
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

async function runningTask(
	id: string,
	backgroundKind: "task" | "service" = "task",
	timing: { timeoutMs: number; startedAt: string } = {
		timeoutMs: 600_000,
		startedAt: new Date().toISOString(),
	},
) {
	await backgroundTaskService.createBashTask({
		id,
		parentNarratorId: PARENT,
		command: "make build",
		backgroundKind,
	});
	await backgroundTaskService.bindExecutorSession(id, {
		deviceId: DEVICE,
		sessionId: backgroundSessionId(id),
		...timing,
	});
}

beforeEach(() => {
	calls.length = 0;
	order.length = 0;
	attach = undefined;
	attachFailure = undefined;
	heldOpen = undefined;
	holdOpen = false;
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

	test("a held narrator's protected command is still re-attached", async () => {
		await runningTask("bash_held");
		expect(await backgroundTaskService.recoverStaleTasksAfterRestart(new Set(["bash_held"]))).toBe(
			1,
		);
		await until(() => attach !== undefined);
		expect(row("bash_held")?.status).toBe("running");
		attach?.end({ exitCode: 0, endSeq: 0 });
		await until(() => row("bash_held")?.status === "completed");
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

	test("a command that finished on time is completed even when the restart comes after its deadline", async () => {
		await runningTask("bash_late", "task", {
			timeoutMs: 60_000,
			startedAt: new Date(Date.now() - 90_000).toISOString(),
		});
		await backgroundTaskService.recoverStaleTasksAfterRestart();
		await until(() => attach !== undefined);
		attach?.stream("session.data", encode("build ok\n"));
		attach?.end({ exitCode: 0, endSeq: 9 });
		await until(() => row("bash_late")?.status === "completed");
		expect(row("bash_late")?.output).toContain("build ok");
		expect(calls.filter((call) => call.method === "session.kill")).toEqual([
			expect.objectContaining({ params: { sessionId: "nf-bash-bash_late", release: true } }),
		]);
	});

	test("the executor's deadline verdict times the task out with its output", async () => {
		await runningTask("bash_deadline");
		await backgroundTaskService.recoverStaleTasksAfterRestart();
		await until(() => attach !== undefined);
		attach?.stream("session.data", encode("still going\n"));
		attach?.end({ exitCode: 137, endSeq: 12, timedOut: true });
		await until(() => row("bash_deadline")?.status === "timeout");
		expect(row("bash_deadline")?.output).toContain("still going");
		expect(row("bash_deadline")?.output).toContain("Background command timed out");
	});

	test("a stop is sent only once the open has an answer", async () => {
		holdOpen = true;
		const { RemoteSessionExecHandle } = await import("../remote-session-exec");
		const handle = new RemoteSessionExecHandle(
			{ deviceId: DEVICE, sessionId: "nf-bash-bash_race", startedAt: now },
			{ open: { kind: "exec", command: "make build", cwd: "/work" } },
		);
		await until(() => heldOpen !== undefined);
		const killed = handle.kill();
		await until(() => cleanups().length === 1);
		// The open is still in flight: an executor that has not seen it would answer
		// "not found" and the stop would be dropped.
		await Bun.sleep(20);
		expect(calls.some((call) => call.method === "session.kill")).toBe(false);
		heldOpen?.({});
		await killed;
		await until(() => calls.some((call) => call.method === "session.kill"));
		await until(() => cleanups().length === 0);
	});

	// Last: shutting down stops Bash admission for the rest of this process.
	test("shutting this server down detaches the command instead of stopping it", async () => {
		await runningTask("bash_shutdown", "service");
		await backgroundTaskService.recoverStaleTasksAfterRestart();
		await until(() => attach !== undefined);
		backgroundTaskService.stopBashCollectors();
		await Bun.sleep(30);
		expect(calls.some((call) => call.method === "session.kill")).toBe(false);
		expect(cleanups()).toEqual([]);
		expect(row("bash_shutdown")?.status).toBe("running");
		await backgroundTaskService.drainBashCollectors({ deadlineAt: Date.now() + 1_000 });
	});
});
