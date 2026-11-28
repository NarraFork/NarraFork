import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { parseWatchCommand } from "@shared/watch-command";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import {
	backgroundTasks,
	narratorBufferedMessages,
	narrators,
	runtimePublicationOutbox,
	userPreferences,
	users,
} from "../../db/schema";
import { stopTool } from "../../lib/agent/tools/stop";
import { watchTool } from "../../lib/agent/tools/watch";
import type { ToolContext, ToolResult } from "../../lib/agent/types";
import * as workerPool from "../../lib/db-worker/pool";
import { eventBus } from "../../lib/event-bus";
import { upsertEncodedTrait } from "../../lib/narrator-custom-traits";
import { RUNTIME_POLICY_TRAIT_PREFIX } from "../../lib/runtime-policy-trait";
import { delegationRegistration } from "../../lib/validators/runtime-registration";
import { MAILBOX_LIMITS } from "../agent-runtime/limits";
import { createMailboxStore } from "../agent-runtime/mailbox";
import { setRunHold } from "../agent-runtime/ownership";
import {
	flushRuntimePublications,
	getRuntimePublicationService,
	runtimePublication,
} from "../agent-runtime/publication";
import { backgroundTaskService } from "../background-task-service";
import { projectPendingInjection } from "../parent-injection-queue";
import { clearAliasRegistry, resolveTaskAlias, restoreTaskAlias } from "../subagent-alias";
import { TERMINAL_WATCH_COMMAND_PREFIX, WATCH_COMMAND_PREFIX } from "../terminal-watch-constants";
import { invalidateUserTraitLayer } from "../trait-layer-service";
import {
	createWatchObservation,
	MAX_PUBLISH_RETRY_DELAY_MS,
	MAX_WATCHES_PER_NARRATOR,
	PUBLISH_RETRY_DELAYS_MS,
	resumeWatchObservationsForTests,
	suspendWatchObservationsForShutdown,
} from "../watch-observation";
import { restartResumableWatch } from "../watch-restart";
import { resumeWatchAfterRestart } from "../watch-service";
import { activeWatchSourceCount, subscribeWatchSource } from "../watch-source";
import { captureWorkerRejection, captureWorkerRejectionThrower } from "./narrator-worker-fixture";

const PARENT = "watch-task-parent";
const CHILD = "watch-task-child";
const BASH = "watch-task-bash";
const OTHER = "watch-task-other";
const AGENT_RUN = "watch-agent-run-1";
const wakes: string[] = [];

runtimePublication.stop();
backgroundTaskService.setBroadcastFnForTests(() => {});

const context = (narratorId = PARENT, userId?: string): ToolContext =>
	({ narratorId, userId, signal: new AbortController().signal }) as ToolContext;

function task(id: string) {
	return db.select().from(backgroundTasks).where(eq(backgroundTasks.id, id)).get();
}

function observations() {
	return db
		.select()
		.from(backgroundTasks)
		.all()
		.filter((row) => row.command?.startsWith("[watch]"));
}

function watchId(result: ToolResult): string {
	const id = (result.metadata as { watchId?: string } | undefined)?.watchId;
	if (!id) throw new Error(`No observation registered: ${result.output}`);
	return id;
}

async function settled(id: string) {
	const deadline = Date.now() + 3_000;
	for (;;) {
		const row = task(id);
		if (row?.status !== "running" || Date.now() > deadline) return row;
		await Bun.sleep(10);
	}
}

async function notices(narratorId = PARENT) {
	await flushRuntimePublications(narratorId);
	return db
		.select()
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, narratorId))
		.all();
}

async function bashTask(id = BASH, parentNarratorId = PARENT) {
	return backgroundTaskService.createBashTask({ id, parentNarratorId, command: "fixture-command" });
}

function completeAgent(output = "agent final result", logicalRunId = AGENT_RUN) {
	const run = { producerKind: "agent" as const, taskId: CHILD, recipientId: PARENT, logicalRunId };
	db.transaction((tx) => {
		runtimePublication.reserve(run, tx);
		runtimePublication.commit(
			{
				...run,
				eventKind: "completed",
				resultRef: runtimePublication.persistResult(run, output, tx),
				summary: "completed",
			},
			tx,
		);
		tx.update(narrators)
			.set({ status: "idle", substatus: '["unread"]' })
			.where(eq(narrators.id, CHILD))
			.run();
	});
	eventBus.emit({
		type: "narrator:status_changed",
		narratorId: CHILD,
		status: "idle",
		substatus: ["unread"],
	});
}

beforeEach(() => {
	resumeWatchObservationsForTests();
	wakes.length = 0;
	runtimePublication.setWake((id) => {
		wakes.push(id);
	});
	const now = new Date().toISOString();
	db.insert(narrators)
		.values([
			{ id: PARENT, variant: "primary", status: "idle", createdAt: now, updatedAt: now },
			{ id: OTHER, variant: "primary", status: "idle", createdAt: now, updatedAt: now },
			{
				id: CHILD,
				type: "subagent",
				variant: "subagent:general",
				title: "Watch child",
				parentNarratorId: PARENT,
				aclRootNarratorId: PARENT,
				policySourceNarratorId: PARENT,
				runtimeRegistrationJson: delegationRegistration(PARENT, "general"),
				status: "working",
				logicalRunId: AGENT_RUN,
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();
});

afterEach(async () => {
	mock.restore();
	setRunHold(CHILD, undefined);
	suspendWatchObservationsForShutdown();
	for (const row of db.select().from(backgroundTasks).all()) {
		if (row.status === "running") await backgroundTaskService.cancel(row.id);
	}
	clearAliasRegistry(PARENT);
	clearAliasRegistry(OTHER);
	runtimePublication.setWake(undefined);
	cleanDb(sqlite);
	resumeWatchObservationsForTests();
});

function acceleratePublicationRetries(): number[] {
	const schedule = globalThis.setTimeout;
	const delays: number[] = [];
	spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
		const [handler, delay, ...rest] = args;
		const caller = new Error().stack
			?.split("\n")
			.find((frame) => frame.includes("/server/") && !frame.includes("/__tests__/"));
		const retry =
			(caller?.includes("/watch-observation.ts:") ?? false) &&
			(delay === MAX_PUBLISH_RETRY_DELAY_MS || PUBLISH_RETRY_DELAYS_MS.some((ms) => ms === delay));
		if (retry && delay !== undefined) delays.push(delay);
		return schedule(handler, retry ? 5 : delay, ...rest);
	}) as typeof setTimeout);
	return delays;
}

test("publication retry acceleration leaves unrelated Worker deadlines unchanged", () => {
	const delays = acceleratePublicationRetries();
	const timer = setTimeout(() => {}, MAX_PUBLISH_RETRY_DELAY_MS);
	clearTimeout(timer);
	expect(delays).toEqual([]);
});

test("ordinary task cancellation still resolves its kill handler after abort side effects", async () => {
	await bashTask();
	const controller = new AbortController();
	const original = mock(() => {});
	const replacement = mock(() => {});
	backgroundTaskService.registerAbortController(BASH, controller);
	backgroundTaskService.registerKillHandler(BASH, original);
	controller.signal.addEventListener("abort", () =>
		backgroundTaskService.registerKillHandler(BASH, replacement),
	);
	expect(await backgroundTaskService.cancel(BASH)).toBe(true);
	expect(original).not.toHaveBeenCalled();
	expect(replacement).toHaveBeenCalledTimes(1);
	expect(task(BASH)?.status).toBe("cancelled");
});

describe("Watch result delivery survives storage outages", () => {
	test("retains one frozen result beyond the fast retry budget and releases source resources immediately", async () => {
		const original = backgroundTaskService.markCompleted.bind(backgroundTaskService);
		let attempts = 0;
		spyOn(backgroundTaskService, "markCompleted").mockImplementation(async (...args) => {
			if (++attempts <= PUBLISH_RETRY_DELAYS_MS.length + 1) throw new Error("storage unavailable");
			return original(...args);
		});
		const delays = acceleratePublicationRetries();
		const onObservationEnd = mock(() => {});
		const observation = await createWatchObservation({
			narratorId: PARENT,
			title: "watch pending delivery",
			command: "bash fixture",
			onObservationEnd,
		});
		await observation.finish({ status: "completed", output: "the original frozen result" });
		expect(onObservationEnd).toHaveBeenCalledTimes(1);
		expect(task(observation.taskId)?.status).toBe("running");
		expect(observation.signal.aborted).toBe(false);
		await observation.finish({ status: "timeout", output: "late deadline must not replace it" });
		const done = await settled(observation.taskId);
		expect(done?.status).toBe("completed");
		expect(done?.output).toBe("the original frozen result");
		expect(attempts).toBe(PUBLISH_RETRY_DELAYS_MS.length + 2);
		expect(delays).toEqual([...PUBLISH_RETRY_DELAYS_MS, MAX_PUBLISH_RETRY_DELAY_MS]);
		expect(onObservationEnd).toHaveBeenCalledTimes(1);
		expect(observation.signal.aborted).toBe(true);
		expect(await notices()).toHaveLength(1);
		expect(await notices()).toHaveLength(1);
	});

	test("continued storage failure keeps capped retry work until explicitly cancelled", async () => {
		const delays = acceleratePublicationRetries();
		const published = spyOn(backgroundTaskService, "markCompleted").mockRejectedValue(
			new Error("storage remains unavailable"),
		);
		const onObservationEnd = mock(() => {});
		const observation = await createWatchObservation({
			narratorId: PARENT,
			title: "watch ongoing delivery",
			command: "bash fixture",
			onObservationEnd,
		});
		await observation.finish({ status: "completed", output: "retained result" });
		const deadline = Date.now() + 1_000;
		while (published.mock.calls.length < 6 && Date.now() < deadline) await Bun.sleep(5);
		expect(published.mock.calls.length).toBeGreaterThanOrEqual(6);
		expect(delays.slice(0, 3)).toEqual([...PUBLISH_RETRY_DELAYS_MS]);
		expect(delays.slice(3).every((delay) => delay === MAX_PUBLISH_RETRY_DELAY_MS)).toBe(true);
		expect(task(observation.taskId)?.status).toBe("running");
		expect(observation.signal.aborted).toBe(false);
		expect(onObservationEnd).toHaveBeenCalledTimes(1);
		expect(await backgroundTaskService.cancel(observation.taskId)).toBe(true);
		const attempts = published.mock.calls.length;
		await Bun.sleep(20);
		expect(published).toHaveBeenCalledTimes(attempts);
		expect(task(observation.taskId)?.status).toBe("cancelled");
		expect(onObservationEnd).toHaveBeenCalledTimes(1);
	});

	test.each([
		"bash",
		"agent",
	] as const)("cancelled %s admission preserves failed delivery when cancellation storage also fails", async (type) => {
		if (type === "bash") await bashTask();
		acceleratePublicationRetries();
		const controller = new AbortController();
		const create = backgroundTaskService.createBashTask.bind(backgroundTaskService);
		spyOn(backgroundTaskService, "createBashTask").mockImplementation(async (input) => {
			const row = await create(input);
			controller.abort();
			return row;
		});
		spyOn(backgroundTaskService, "markCancelled").mockRejectedValueOnce(
			new Error("cancellation write failed"),
		);
		const markFailed = backgroundTaskService.markFailed.bind(backgroundTaskService);
		let attempts = 0;
		spyOn(backgroundTaskService, "markFailed").mockImplementation(async (...args) => {
			if (++attempts === 1) throw new Error("failure receipt storage is temporarily unavailable");
			return markFailed(...args);
		});
		const result = await watchTool.execute(
			{ type, id: type === "bash" ? BASH : CHILD },
			{ ...context(), signal: controller.signal },
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("cancellation write failed");
		const pending = observations();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.status).toBe("running");
		const done = await settled(pending[0]?.id ?? "missing-observation");
		expect(done?.status).toBe("failed");
		expect(done?.output).toContain("registration was interrupted");
		expect(done?.output).toContain("cancellation could not be saved");
		expect(done?.output).toContain("No target was stopped");
		expect(attempts).toBe(2);
		if (type === "bash") expect(task(BASH)?.status).toBe("running");
		else
			expect(db.select().from(narrators).where(eq(narrators.id, CHILD)).get()?.status).toBe(
				"working",
			);
		expect(await notices()).toHaveLength(1);
	});

	test.each([
		"retry_cancel",
		"recover_delivery",
	] as const)("failed cancellation retains responsibility for %s", async (recovery) => {
		acceleratePublicationRetries();
		await bashTask();
		const targetKill = mock(() => {});
		backgroundTaskService.registerKillHandler(BASH, targetKill);
		const published = spyOn(backgroundTaskService, "markCompleted").mockRejectedValue(
			new Error("publication unavailable"),
		);
		const onObservationEnd = mock(() => {});
		const observation = await createWatchObservation({
			narratorId: PARENT,
			title: "watch failed cancellation",
			command: "bash fixture",
			onObservationEnd,
		});
		await observation.finish({
			status: "completed",
			output: "frozen result survives failed cancellation",
		});
		const cancellation = spyOn(backgroundTaskService, "markCancelled").mockRejectedValueOnce(
			new Error("cancellation write failed"),
		);
		const failed = await stopTool.execute({ type: "bash", id: observation.taskId }, context());
		expect(failed.isError).toBe(true);
		expect(failed.output).toContain("cancellation write failed");
		expect(observation.signal.aborted).toBe(false);
		expect(backgroundTaskService.isCancellationRequested(observation.taskId)).toBe(false);
		expect(task(observation.taskId)?.status).toBe("running");
		cancellation.mockRestore();
		if (recovery === "retry_cancel") {
			const stopped = await stopTool.execute({ type: "bash", id: observation.alias }, context());
			expect(stopped.isError).toBeFalsy();
			const attempts = published.mock.calls.length;
			await Bun.sleep(20);
			expect(published).toHaveBeenCalledTimes(attempts);
			expect(task(observation.taskId)?.status).toBe("cancelled");
		} else {
			published.mockRestore();
			expect((await settled(observation.taskId))?.status).toBe("completed");
			expect(task(observation.taskId)?.output).toBe("frozen result survives failed cancellation");
		}
		expect(observation.signal.aborted).toBe(true);
		expect(onObservationEnd).toHaveBeenCalledTimes(1);
		expect(targetKill).not.toHaveBeenCalled();
		expect(task(BASH)?.status).toBe("running");
		expect(await notices()).toHaveLength(1);
	});

	test.each([
		"stop",
		"owner_deleted",
		"shutdown",
	] as const)("%s cancels pending delivery without retrying or ending the target", async (reason) => {
		await bashTask();
		const targetKill = mock(() => {});
		backgroundTaskService.registerKillHandler(BASH, targetKill);
		const published = spyOn(backgroundTaskService, "markCompleted").mockRejectedValue(
			new Error("storage unavailable"),
		);
		const schedule = globalThis.setTimeout;
		let lateRetry: (() => void) | undefined;
		spyOn(globalThis, "setTimeout").mockImplementation(((
			...args: Parameters<typeof setTimeout>
		) => {
			const [handler, delay, ...rest] = args;
			if (PUBLISH_RETRY_DELAYS_MS.some((ms) => ms === delay)) {
				lateRetry = () => {
					if (typeof handler === "function") handler(...rest);
				};
			}
			return schedule(handler, delay, ...rest);
		}) as typeof setTimeout);
		const onObservationEnd = mock(() => {});
		const observation = await createWatchObservation({
			narratorId: PARENT,
			title: "watch cancellable delivery",
			command: "bash fixture",
			onObservationEnd,
		});
		await observation.finish({ status: "completed", output: "frozen result awaiting storage" });
		expect(lateRetry).toBeDefined();
		if (reason === "stop")
			expect(await backgroundTaskService.cancel(observation.taskId)).toBe(true);
		else if (reason === "owner_deleted")
			eventBus.emit({ type: "narrator:deleted", narratorId: PARENT, title: null });
		else suspendWatchObservationsForShutdown();
		lateRetry?.();
		expect(published).toHaveBeenCalledTimes(1);
		expect(observation.signal.aborted).toBe(true);
		expect(onObservationEnd).toHaveBeenCalledTimes(1);
		expect(targetKill).not.toHaveBeenCalled();
		expect(task(BASH)?.status).toBe("running");
		const delivered = await notices();
		if (reason === "stop") {
			expect(task(observation.taskId)?.status).toBe("cancelled");
			expect(delivered).toHaveLength(1);
			expect(delivered[0]?.text).toContain("cancelled");
			expect(delivered[0]?.text).not.toContain("frozen result awaiting storage");
		} else expect(delivered).toHaveLength(0);
	});
});

describe("Watch observes Bash without owning its execution", () => {
	test.each([
		WATCH_COMMAND_PREFIX,
		TERMINAL_WATCH_COMMAND_PREFIX,
	])("%s handles cannot create a recursive watch, whether running or completed", async (prefix) => {
		const id = `observation-${prefix === WATCH_COMMAND_PREFIX ? "current" : "legacy"}`;
		const alias = `${id}-alias`;
		await backgroundTaskService.createBashTask({
			id,
			alias,
			parentNarratorId: PARENT,
			command: `${prefix} fixture`,
		});
		for (const state of ["running", "completed"] as const) {
			if (state === "completed")
				await backgroundTaskService.markCompleted(id, "saved observation receipt");
			for (const selector of [id, alias]) {
				const result = await watchTool.execute({ type: "bash", id: selector }, context());
				expect(result.isError).toBeFalsy();
				expect(result.output).toContain("No watch was registered");
				expect(result.output).toContain("original");
				expect(result.output).toContain("TeamStatus");
				expect(result.metadata).toMatchObject({ status: "unsupported_target", id });
				expect(result.metadata?.watchId).toBeUndefined();
				expect(db.select().from(backgroundTasks).all()).toHaveLength(1);
				expect(task(id)?.status).toBe(state);
			}
		}
	});

	test("returns a handle without waiting for the running target", async () => {
		await bashTask();
		const started = Date.now();
		const result = await watchTool.execute({ type: "bash", id: BASH }, context());
		expect(result.isError).toBeFalsy();
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(result.output).toContain("600000ms");
		expect(task(watchId(result))?.status).toBe("running");
		expect(task(BASH)?.status).toBe("running");
		expect(await notices()).toHaveLength(0);
	});

	test("already completed output is immediately readable repeatedly without an observation", async () => {
		await bashTask();
		await backgroundTaskService.markCompleted(BASH, "saved result");
		for (let count = 0; count < 2; count++) {
			const result = await watchTool.execute({ type: "bash", id: BASH }, context());
			expect(result.isError).toBeFalsy();
			expect(result.output).toContain("saved result");
			expect(result.metadata).toMatchObject({ status: "completed" });
		}
		expect(observations()).toEqual([]);
		expect(await notices()).toHaveLength(1);
	});

	test("completion during registration is rechecked without losing its ordinary notice", async () => {
		await bashTask();
		const create = backgroundTaskService.createBashTask.bind(backgroundTaskService);
		const registration = spyOn(backgroundTaskService, "createBashTask").mockImplementationOnce(
			async (input) => {
				const created = await create(input);
				await backgroundTaskService.markCompleted(BASH, "completed in registration gap");
				expect(await notices()).toHaveLength(1);
				return created;
			},
		);
		const result = await watchTool.execute({ type: "bash", id: BASH }, context());
		expect(registration).toHaveBeenCalledTimes(1);
		expect((await settled(watchId(result)))?.status).toBe("completed");
		expect(await notices()).toHaveLength(1);
	});

	test("a Unicode literal split across chunks completes before the source exits", async () => {
		await bashTask();
		const result = await watchTool.execute(
			{ type: "bash", id: BASH, pattern: "发布成功" },
			context(),
		);
		backgroundTaskService.appendOutput(BASH, "进度：发布");
		await Bun.sleep(20);
		expect(task(watchId(result))?.status).toBe("running");
		backgroundTaskService.appendOutput(BASH, "成功\n");
		const done = await settled(watchId(result));
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("发布成功");
		expect(task(BASH)?.status).toBe("running");
		expect(await notices()).toHaveLength(1);
	});

	test("a literal already buffered completes without waiting for another output event", async () => {
		await bashTask();
		backgroundTaskService.appendOutput(BASH, "READY before registration");
		const result = await watchTool.execute({ type: "bash", id: BASH, pattern: "READY" }, context());
		const done = await settled(watchId(result));
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("READY before registration");
		expect(task(BASH)?.status).toBe("running");
		expect(await notices()).toHaveLength(1);
	});

	test("a deadline completes only its observation and never calls the source killer", async () => {
		await bashTask();
		const killed = mock(() => {});
		backgroundTaskService.registerKillHandler(BASH, killed);
		const result = await watchTool.execute({ type: "bash", id: BASH, timeout: 1_000 }, context());
		const done = await settled(watchId(result));
		expect(done?.status).toBe("completed");
		expect(done?.output).toMatch(/deadline|timed out/i);
		expect(done?.output).toContain("target was not stopped");
		expect(task(BASH)?.status).toBe("running");
		expect(killed).not.toHaveBeenCalled();
		expect(await notices()).toHaveLength(1);
	});

	test("Stop with the observation alias cancels only the observation", async () => {
		await bashTask();
		const killed = mock(() => {});
		backgroundTaskService.registerKillHandler(BASH, killed);
		const result = await watchTool.execute({ type: "bash", id: BASH }, context());
		const alias = (result.metadata as { watchAlias: string }).watchAlias;
		const stopped = await stopTool.execute({ type: "bash", id: alias }, context());
		expect(stopped.isError).toBeFalsy();
		expect(task(watchId(result))?.status).toBe("cancelled");
		expect(task(BASH)?.status).toBe("running");
		expect(killed).not.toHaveBeenCalled();
		backgroundTaskService.appendOutput(BASH, "more output after cancelling watch");
		await Bun.sleep(20);
		expect(task(watchId(result))?.status).toBe("cancelled");
		expect(wakes).toEqual([]);
	});

	test("two observations are fulfilled by one ordinary completion and repeated events do not duplicate it", async () => {
		const source = await bashTask();
		if (!source.logicalRunId) throw new Error("Bash source has no registered run");
		const results = await Promise.all([
			watchTool.execute({ type: "bash", id: BASH }, context()),
			watchTool.execute({ type: "bash", id: BASH, pattern: "absent" }, context()),
		]);
		await backgroundTaskService.markCompleted(BASH, "only ordinary completion");
		for (const result of results)
			expect((await settled(watchId(result)))?.status).toBe("completed");
		expect(await notices()).toHaveLength(1);
		eventBus.emit({
			type: "background_task:completed",
			taskId: BASH,
			parentNarratorId: PARENT,
			taskType: "bash",
			output: "only ordinary completion",
			publicationRun: {
				producerKind: "bash",
				taskId: BASH,
				recipientId: PARENT,
				logicalRunId: source.logicalRunId,
			},
		});
		await Bun.sleep(20);
		expect(await notices()).toHaveLength(1);
		expect(wakes).toEqual([PARENT]);
	});

	test("a final output literal fulfils two pattern observations with only the ordinary notice", async () => {
		await bashTask();
		const results = await Promise.all([
			watchTool.execute({ type: "bash", id: BASH, pattern: "READY" }, context()),
			watchTool.execute({ type: "bash", id: BASH, pattern: "READY" }, context()),
		]);
		// No output event precedes completion: waitForText returns found with a terminal receipt.
		await backgroundTaskService.markCompleted(BASH, "READY in final output");
		for (const result of results) {
			const done = await settled(watchId(result));
			expect(done?.status).toBe("completed");
			expect(done?.output).toContain("ordinary bash completion notice");
		}
		expect(await notices()).toHaveLength(1);
		expect(wakes).toEqual([PARENT]);
	});

	test("observations of different conditions have independent deadlines and a later completion remains ordinary", async () => {
		await bashTask();
		const first = await watchTool.execute(
			{ type: "bash", id: BASH, pattern: "NEVER", timeout: 1_000 },
			context(),
		);
		const second = await watchTool.execute({ type: "bash", id: BASH, timeout: 5_000 }, context());
		expect((await settled(watchId(first)))?.output).toMatch(/deadline/i);
		expect(task(watchId(second))?.status).toBe("running");
		await backgroundTaskService.markCompleted(BASH, "later source completion");
		expect((await settled(watchId(second)))?.status).toBe("completed");
		expect(await notices()).toHaveLength(2);
	});

	test("explicitly cancelling a service source publishes the observation's own receipt", async () => {
		await backgroundTaskService.createBashTask({
			id: BASH,
			parentNarratorId: PARENT,
			command: "fixture-service",
			backgroundKind: "service",
		});
		const result = await watchTool.execute({ type: "bash", id: BASH }, context());
		expect(await backgroundTaskService.cancel(BASH)).toBe(true);
		const done = await settled(watchId(result));
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("cancelled");
		expect(task(BASH)?.status).toBe("cancelled");
		const delivered = await notices();
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.sourceKey).toContain(watchId(result));
	});

	test("the registration turn ending does not abort the independent observation", async () => {
		await bashTask();
		const controller = new AbortController();
		const result = await watchTool.execute(
			{ type: "bash", id: BASH },
			{ ...context(), signal: controller.signal },
		);
		controller.abort();
		expect(task(watchId(result))?.status).toBe("running");
		await backgroundTaskService.markCompleted(BASH, "source finished after caller turn ended");
		expect((await settled(watchId(result)))?.status).toBe("completed");
		expect(await notices()).toHaveLength(1);
	});

	test("a rolled-back observation publication is retried before delivering exactly once", async () => {
		await bashTask();
		const result = await watchTool.execute({ type: "bash", id: BASH, pattern: "READY" }, context());
		const id = watchId(result);
		const publish = backgroundTaskService.markCompleted.bind(backgroundTaskService);
		let attempts = 0;
		const published = spyOn(backgroundTaskService, "markCompleted").mockImplementation(
			async (...args) => {
				if (args[0] !== id || ++attempts !== 1) return publish(...args);
				sqlite.exec(
					"CREATE TRIGGER watch_task_publication_fault BEFORE UPDATE ON runtime_publication_outbox WHEN NEW.state = 'pending' BEGIN SELECT RAISE(ABORT, 'watch task publication fault'); END;",
				);
				try {
					return await publish(...args);
				} finally {
					sqlite.exec("DROP TRIGGER watch_task_publication_fault");
				}
			},
		);
		backgroundTaskService.appendOutput(BASH, "READY");
		expect((await settled(id))?.status).toBe("completed");
		expect(published).toHaveBeenCalledTimes(2);
		expect(attempts).toBe(2);
		expect(await notices()).toHaveLength(1);
		expect(task(BASH)?.status).toBe("running");
	});

	test("a full mailbox retains the result in the outbox until capacity is released", async () => {
		const mailbox = createMailboxStore(db);
		let releasable: string | undefined;
		for (let index = 0; index < MAILBOX_LIMITS.noticePending; index++) {
			const result = mailbox.enqueue({
				kind: "task_notice",
				noticeKind: "bash",
				narratorId: PARENT,
				sourceKey: `existing-notice-${index}`,
				text: "existing notice",
				projectedByteSize: 15,
			});
			expect(result.status).toBe("accepted");
			if (result.status === "accepted") releasable = result.delivery.deliveryId ?? undefined;
		}
		await bashTask();
		const result = await watchTool.execute({ type: "bash", id: BASH, pattern: "READY" }, context());
		const id = watchId(result);
		backgroundTaskService.appendOutput(BASH, "READY while mailbox is full");
		expect((await settled(id))?.status).toBe("completed");
		expect(await notices()).toHaveLength(MAILBOX_LIMITS.noticePending);
		const pending = () =>
			db
				.select()
				.from(runtimePublicationOutbox)
				.where(eq(runtimePublicationOutbox.taskId, id))
				.all();
		expect(pending().some((row) => row.state === "pending")).toBe(true);
		if (!releasable) throw new Error("No queued mailbox delivery");
		expect(mailbox.cancel(releasable, "fixture consumer released capacity")).toBe(true);
		await flushRuntimePublications(PARENT);
		expect(pending().some((row) => row.state === "pending")).toBe(false);
		expect((await notices()).filter((row) => row.sourceKey?.includes(id))).toHaveLength(1);
		await flushRuntimePublications(PARENT);
		expect((await notices()).filter((row) => row.sourceKey?.includes(id))).toHaveLength(1);
	});

	test("a transient mailbox write failure preserves the completed observation for retry", async () => {
		await bashTask();
		const result = await watchTool.execute({ type: "bash", id: BASH, pattern: "READY" }, context());
		const id = watchId(result);
		backgroundTaskService.appendOutput(BASH, "READY before transient mailbox failure");
		expect((await settled(id))?.status).toBe("completed");
		sqlite.exec(
			"CREATE TRIGGER watch_mailbox_write_fault BEFORE INSERT ON narrator_buffered_messages WHEN NEW.notice_kind = 'bash' BEGIN SELECT RAISE(ABORT, 'transient watch mailbox fault'); END;",
		);
		try {
			await expect(await captureWorkerRejectionThrower(flushRuntimePublications(PARENT))).toThrow(
				"transient watch mailbox fault",
			);
			expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(0);
			expect(
				db
					.select()
					.from(runtimePublicationOutbox)
					.where(eq(runtimePublicationOutbox.taskId, id))
					.all()
					.some((row) => row.state === "pending"),
			).toBe(true);
		} finally {
			sqlite.exec("DROP TRIGGER watch_mailbox_write_fault");
		}
		expect(await notices()).toHaveLength(1);
		expect(await notices()).toHaveLength(1);
		expect(wakes).toEqual([PARENT]);
	});

	for (const first of ["completed", "timeout"] as const) {
		test(`${first} wins a concurrent completion/deadline race and freezes exactly one receipt`, async () => {
			const observation = await createWatchObservation({
				narratorId: PARENT,
				title: "deadline race",
				command: `bash ${BASH}`,
			});
			const second = first === "completed" ? "timeout" : "completed";
			await Promise.all([
				observation.finish({ status: first, output: `${first} won the race` }),
				observation.finish({ status: second, output: `${second} must not overwrite the winner` }),
			]);
			expect(task(observation.taskId)?.status).toBe("completed");
			expect(task(observation.taskId)?.output).toBe(`${first} won the race`);
			expect(observation.signal.aborted).toBe(true);
			expect(await notices()).toHaveLength(1);
			await observation.finish({ status: "completed", output: "late duplicate" });
			expect(task(observation.taskId)?.output).toBe(`${first} won the race`);
			expect(await notices()).toHaveLength(1);
		});
	}

	test("the observation budget is reserved across parallel registrations", async () => {
		await bashTask();
		const results = await Promise.all(
			Array.from({ length: 21 }, (_, i) =>
				watchTool.execute({ type: "bash", id: BASH, pattern: `never-${i}` }, context()),
			),
		);
		expect(results.filter((result) => !result.isError)).toHaveLength(20);
		expect(results.filter((result) => result.isError)).toHaveLength(1);
		expect(results.find((result) => result.isError)?.output).toContain("active watches");
		expect(observations()).toHaveLength(20);
	});

	test("an unrelated narrator cannot read or observe another session's Bash task", async () => {
		await bashTask(BASH, OTHER);
		const result = await watchTool.execute({ type: "bash", id: BASH }, context());
		expect(result.isError).toBe(true);
		expect(observations()).toEqual([]);
		expect(task(BASH)?.status).toBe("running");
	});

	test("large completed Unicode output is bounded and does not split a UTF-8 character", async () => {
		await bashTask();
		await backgroundTaskService.markCompleted(BASH, `${"测试文字".repeat(20_000)}\n终点`);
		const result = await watchTool.execute({ type: "bash", id: BASH }, context());
		expect(result.output).toContain("Captured output saved to:");
		expect(result.output).toContain("终点");
		expect(result.output).not.toContain("\uFFFD");
		expect(Buffer.byteLength(result.output)).toBeLessThan(4_096);
		expect(observations()).toEqual([]);
	});
});

describe("Watch follows an agent's registered current run", () => {
	test("returns immediately while the agent is working", async () => {
		const result = await watchTool.execute({ type: "agent", id: CHILD }, context());
		expect(result.isError).toBeFalsy();
		expect(task(watchId(result))?.status).toBe("running");
		expect(result.metadata).toMatchObject({ subagentId: CHILD, status: "watching" });
	});

	test("already completed agent results remain readable without registering or consuming notices", async () => {
		completeAgent("saved agent output");
		const dispatch = spyOn(workerPool, "runReadTask");
		const result = await watchTool.execute({ type: "agent", id: CHILD }, context());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("saved agent output");
		expect(dispatch).toHaveBeenCalledWith(
			sqlite.filename,
			expect.objectContaining({
				kind: "publicationTerminalResult",
				run: { producerKind: "agent", taskId: CHILD, logicalRunId: AGENT_RUN, recipientId: PARENT },
			}),
			{ signal: expect.any(AbortSignal), timeoutMs: 5_000 },
		);
		expect(observations()).toHaveLength(0);
		expect(await notices()).toHaveLength(1);
	});

	test("terminal read failures never fall back to a main-thread result", async () => {
		completeAgent("not an inline result");
		const publication = getRuntimePublicationService();
		const run = {
			producerKind: "agent" as const,
			taskId: CHILD,
			recipientId: PARENT,
			logicalRunId: AGENT_RUN,
		};
		const inline = spyOn(runtimePublication, "readAgentTerminalResult");
		const dispatch = spyOn(workerPool, "runReadTask");
		const setting = process.env.NARRAFORK_DB_WORKER;
		try {
			process.env.NARRAFORK_DB_WORKER = "off";
			await expect(
				await captureWorkerRejection(publication.readAgentTerminalResult(run, {}, {})),
			).toBeInstanceOf(workerPool.WorkersUnavailableError);
		} finally {
			if (setting === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = setting;
		}
		for (const error of [
			new workerPool.WorkersUnavailableError("worker_create_failed"),
			new workerPool.DbReadTaskExecutionError("worker exited"),
			new workerPool.DbReadTaskTimeoutError("timed out"),
		]) {
			dispatch.mockRejectedValueOnce(error);
			await expect(
				await captureWorkerRejection(publication.readAgentTerminalResult(run, {}, {})),
			).toBe(error);
		}
		const interrupted = AbortSignal.abort();
		await expect(
			await captureWorkerRejection(
				publication.readAgentTerminalResult(run, {}, { signal: interrupted }),
			),
		).toBe(interrupted.reason);
		await expect(
			await captureWorkerRejection(
				sqlite.transaction(() => publication.readAgentTerminalResult(run, {}, {}))(),
			),
		).toBeInstanceOf(workerPool.WorkersUnavailableError);
		expect(inline).not.toHaveBeenCalled();

		dispatch.mockRejectedValueOnce(new workerPool.DbReadTaskExecutionError("worker exited"));
		const watch = await watchTool.execute({ type: "agent", id: CHILD }, context());
		expect(watch.isError).toBe(true);
		expect(watch.output).toContain("worker exited");
		expect(watch.output).not.toContain("not an inline result");
		expect(inline).not.toHaveBeenCalled();
	});

	test("an observation failing its terminal read does not replace the source completion notice", async () => {
		const read = workerPool.runReadTask;
		const dispatch = spyOn(workerPool, "runReadTask").mockImplementation(
			async <T>(...args: Parameters<typeof read>) => {
				if (args[1].kind === "publicationTerminalResult")
					throw new workerPool.DbReadTaskExecutionError("worker exited");
				return read<T>(...args);
			},
		);
		const result = await watchTool.execute({ type: "agent", id: CHILD }, context());
		completeAgent("source output");
		const done = await settled(watchId(result));
		expect(dispatch.mock.calls.some(([, task]) => task.kind === "publicationTerminalResult")).toBe(
			true,
		);
		expect(done?.status).toBe("failed");
		expect(done?.output).toContain("worker exited");
		expect(done?.output).not.toContain("source output");
		expect((await notices()).some((notice) => notice.noticeKind === "agent")).toBe(true);
	});

	test("a running background agent cannot be watched with required authority Workers disabled", async () => {
		await backgroundTaskService.createAgentTask({
			id: CHILD,
			subagentNarratorId: CHILD,
			subagentType: "general",
			binding: { deliverTo: { narratorId: PARENT, toolUseId: "background-agent" } },
		});
		await backgroundTaskService.markNarratorRunning(CHILD);
		const setting = process.env.NARRAFORK_DB_WORKER;
		const dispatch = spyOn(workerPool, "runReadTask");
		try {
			process.env.NARRAFORK_DB_WORKER = "off";
			const result = await watchTool.execute({ type: "agent", id: CHILD }, context());
			expect(result.isError).toBe(true);
			expect(result.metadata).toMatchObject({ kind: "watch", status: "failed" });
			expect(result.output).toContain("workers unavailable");
			expect(result.output).not.toContain("Watching");
			expect(observations()).toHaveLength(0);
			expect(task(CHILD)?.status).toBe("running");
			expect(
				dispatch.mock.calls.some(([, task]) => task.kind === "publicationTerminalResult"),
			).toBe(false);
			expect((await notices()).filter((notice) => notice.noticeKind === "agent")).toHaveLength(0);
		} finally {
			if (setting === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = setting;
		}
	});

	test("an already settled Watch rechecks team ownership after the Worker responds", async () => {
		completeAgent("must stay private after reassignment");
		const read = workerPool.runReadTask;
		let reassigned = false;
		spyOn(workerPool, "runReadTask").mockImplementation(
			async <T>(...args: Parameters<typeof read>) => {
				const result = await read<T>(...args);
				if (args[1].kind === "publicationTerminalResult" && !reassigned) {
					reassigned = true;
					db.update(narrators)
						.set({ runtimeRegistrationJson: delegationRegistration(OTHER, "general") })
						.where(eq(narrators.id, CHILD))
						.run();
				}
				return result;
			},
		);
		const result = await watchTool.execute({ type: "agent", id: CHILD }, context());
		expect(reassigned).toBe(true);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("access was revoked");
		expect(result.output).not.toContain("must stay private after reassignment");
	});

	test("agent completion during registration is not missed", async () => {
		const create = backgroundTaskService.createBashTask.bind(backgroundTaskService);
		const registration = spyOn(backgroundTaskService, "createBashTask").mockImplementationOnce(
			async (input) => {
				const row = await create(input);
				completeAgent("agent registration gap result");
				return row;
			},
		);
		const result = await watchTool.execute({ type: "agent", id: CHILD }, context());
		expect(registration).toHaveBeenCalledTimes(1);
		expect((await settled(watchId(result)))?.status).toBe("completed");
		expect(await notices()).toHaveLength(1);
	});

	test("two agent observations preserve the ordinary notice exactly once", async () => {
		const results = await Promise.all([
			watchTool.execute({ type: "agent", id: CHILD }, context()),
			watchTool.execute({ type: "agent", id: CHILD }, context()),
		]);
		completeAgent("ordinary agent final");
		for (const result of results)
			expect((await settled(watchId(result)))?.status).toBe("completed");
		expect(await notices()).toHaveLength(1);
		expect(wakes).toEqual([PARENT]);
	});

	test("an agent deadline does not stop its working run", async () => {
		const result = await watchTool.execute({ type: "agent", id: CHILD, timeout: 1_000 }, context());
		const done = await settled(watchId(result));
		expect(done?.status).toBe("completed");
		expect(done?.output).toMatch(/deadline|timed out/i);
		expect(done?.output).toContain("target was not stopped");
		expect(db.select().from(narrators).where(eq(narrators.id, CHILD)).get()?.status).toBe(
			"working",
		);
	});

	test("a takeover is reported as human control rather than a successful agent result", async () => {
		setRunHold(CHILD, { released: false });
		const result = await watchTool.execute({ type: "agent", id: CHILD }, context());
		expect(result.metadata).toMatchObject({ status: "taken_over" });
		expect(result.output).toContain("not a completed result");
		expect(observations()).toHaveLength(0);
	});

	for (const change of ["superseded", "taken_over"] as const) {
		test(`an agent becoming ${change} during terminal-result reading never publishes the old body`, async () => {
			const publication = getRuntimePublicationService();
			const read = publication.readAgentTerminalResult.bind(publication);
			const interrupted = spyOn(publication, "readAgentTerminalResult").mockImplementationOnce(
				async (...args) => {
					const old = await read(...args);
					expect(old?.output).toBe("stale terminal body must not be republished");
					if (change === "superseded") {
						db.update(narrators)
							.set({ logicalRunId: "replacement-during-read", status: "working" })
							.where(eq(narrators.id, CHILD))
							.run();
					} else setRunHold(CHILD, { released: false });
					return old;
				},
			);
			const result = await watchTool.execute({ type: "agent", id: CHILD }, context());
			completeAgent("stale terminal body must not be republished");
			const done = await settled(watchId(result));
			expect(interrupted).toHaveBeenCalledTimes(1);
			expect(done?.status).toBe("completed");
			expect(done?.output).toContain(change);
			expect(done?.output).not.toContain("stale terminal body must not be republished");
		});
	}

	test("a replaced agent run cannot fulfil an observation of its old run", async () => {
		const result = await watchTool.execute({ type: "agent", id: CHILD }, context());
		db.update(narrators)
			.set({ logicalRunId: "watch-agent-run-2" })
			.where(eq(narrators.id, CHILD))
			.run();
		eventBus.emit({
			type: "narrator:status_changed",
			narratorId: CHILD,
			status: "working",
			substatus: [],
		});
		const done = await settled(watchId(result));
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("superseded");
		expect(done?.output).not.toContain("agent final result");
	});

	test("deleting the observed agent ends the observation and detaches its listeners", async () => {
		const subscribe = spyOn(eventBus, "on");
		const unsubscribe = spyOn(eventBus, "off");
		const result = await watchTool.execute(
			{ type: "agent", id: CHILD, timeout: 86_400_000 },
			context(),
		);
		const deadline = Date.now() + 1_500;
		while (
			!subscribe.mock.calls.some(([type]) => type === "narrator:deleted") &&
			Date.now() < deadline
		)
			await Bun.sleep(5);
		expect(subscribe.mock.calls.some(([type]) => type === "narrator:deleted")).toBe(true);
		db.delete(narrators).where(eq(narrators.id, CHILD)).run();
		eventBus.emit({ type: "narrator:deleted", narratorId: CHILD, title: "Watch child" });
		const done = await settled(watchId(result));
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("unavailable");
		for (const [type, listener] of subscribe.mock.calls)
			expect(unsubscribe).toHaveBeenCalledWith(type, listener);
	});

	test("deleting the observing owner releases its observation exactly once without a target kill", async () => {
		// This case owns no child session; remove the unrelated fixture's restrictive parent FK.
		db.delete(narrators).where(eq(narrators.id, CHILD)).run();
		await bashTask();
		const killed = mock(() => {});
		const disposed = mock(() => {});
		backgroundTaskService.registerKillHandler(BASH, killed);
		const observation = await createWatchObservation({
			narratorId: PARENT,
			title: "owner deletion",
			command: `bash ${BASH}`,
			onObservationEnd: disposed,
		});
		db.delete(narrators).where(eq(narrators.id, PARENT)).run();
		eventBus.emit({ type: "narrator:deleted", narratorId: PARENT, title: null });
		expect(observation.signal.aborted).toBe(true);
		expect(disposed).toHaveBeenCalledTimes(1);
		expect(killed).not.toHaveBeenCalled();
		observation.release();
		await observation.finish({ status: "completed", output: "late result after owner deletion" });
		expect(disposed).toHaveBeenCalledTimes(1);
		expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(0);
	});

	test("shutdown releases an observation and restart reports interruption when no process can re-attach it", async () => {
		const result = await watchTool.execute({ type: "agent", id: CHILD }, context());
		const id = watchId(result);
		// Still suspended: this process is shutting down, so re-attachment is refused and
		// the row ends exactly as before re-attachment existed.
		suspendWatchObservationsForShutdown();
		await backgroundTaskService.killAll();
		expect(task(id)?.status).toBe("running");
		await backgroundTaskService.recoverStaleTasksAfterRestart();
		expect(task(id)?.status).toBe("failed");
		expect(task(id)?.output).toMatch(/interrupted.*server restart/i);
		expect(task(id)?.output).toContain("The watch did not stop the target");
		expect(db.select().from(narrators).where(eq(narrators.id, CHILD)).get()?.status).toBe(
			"working",
		);
	});
});

const OWNER = "watch-task-owner";

/** Give the watcher a known execution identity: re-attachment authorizes as it. */
function ownWatcher(traits: string[] = []) {
	const now = new Date().toISOString();
	db.insert(users).values({ id: OWNER, username: OWNER, passwordHash: "x", createdAt: now }).run();
	if (traits.length)
		db.insert(userPreferences)
			.values({ id: `${OWNER}-prefs`, userId: OWNER, traits, createdAt: now, updatedAt: now })
			.run();
	db.update(narrators).set({ ownerUserId: OWNER }).where(eq(narrators.id, PARENT)).run();
	// Preference writes invalidate the cached user layer; this direct insert must too.
	invalidateUserTraitLayer(OWNER);
}

/** Shut down, then recover as a fresh process would: observation state starts empty. */
async function restart(): Promise<void> {
	suspendWatchObservationsForShutdown();
	await backgroundTaskService.killAll();
	resumeWatchObservationsForTests();
	clearAliasRegistry(PARENT);
	await backgroundTaskService.recoverStaleTasksAfterRestart();
}

describe("lifecycle watches are re-attached after a restart", () => {
	beforeEach(() => ownWatcher());

	test("an agent watch keeps its row and reports the agent's later completion", async () => {
		const id = watchId(await watchTool.execute({ type: "agent", id: CHILD }, context()));
		await restart();
		expect(task(id)?.status).toBe("running");
		expect(observations().filter((row) => row.status === "running")).toHaveLength(1);
		completeAgent("finished after the restart");
		const row = await settled(id);
		// The agent's own completion notice fulfils the observation: one notice, no duplicate.
		expect(row?.status).toBe("completed");
		expect(row?.output).toContain("Observation fulfilled by the ordinary agent completion notice");
		expect(await notices()).toHaveLength(1);
	});

	test("an agent watch keeps its original deadline instead of restarting the clock", async () => {
		const id = watchId(
			await watchTool.execute({ type: "agent", id: CHILD, timeout: 60_000 }, context()),
		);
		// The row was registered 59.7s ago: only ~300ms of its 60s deadline remain.
		db.update(backgroundTasks)
			.set({ createdAt: new Date(Date.now() - 59_700).toISOString() })
			.where(eq(backgroundTasks.id, id))
			.run();
		await restart();
		expect(task(id)?.status).toBe("running");
		const row = await settled(id);
		expect(row?.status).toBe("completed");
		expect(row?.output).toMatch(/deadline/i);
		expect(db.select().from(narrators).where(eq(narrators.id, CHILD)).get()?.status).toBe(
			"working",
		);
	});

	test("a watch whose deadline passed while the server was down ends as interrupted", async () => {
		const id = watchId(
			await watchTool.execute({ type: "agent", id: CHILD, timeout: 1_000 }, context()),
		);
		db.update(backgroundTasks)
			.set({ createdAt: new Date(Date.now() - 5_000).toISOString() })
			.where(eq(backgroundTasks.id, id))
			.run();
		await restart();
		expect(task(id)?.status).toBe("failed");
		expect(task(id)?.output).toMatch(/interrupted.*server restart/i);
	});

	test("an agent watch is not moved onto a different run of the same agent", async () => {
		const id = watchId(await watchTool.execute({ type: "agent", id: CHILD }, context()));
		db.update(narrators).set({ logicalRunId: "a-later-run" }).where(eq(narrators.id, CHILD)).run();
		await restart();
		expect(task(id)?.status).toBe("failed");
		expect(task(id)?.output).toMatch(/interrupted.*server restart/i);
	});

	test("a Bash watch whose target did not survive the restart ends with a waking interruption", async () => {
		await bashTask();
		const id = watchId(await watchTool.execute({ type: "bash", id: BASH }, context()));
		await restart();
		// Shutdown cancelled the ordinary command; its cancelled notice never wakes the
		// watcher, so the watch must still report the interruption itself.
		expect(task(BASH)?.status).toBe("cancelled");
		expect(task(id)?.status).toBe("failed");
		expect(task(id)?.output).toMatch(/interrupted.*server restart/i);
		wakes.length = 0;
		const texts = (await notices()).map((notice) => notice.text ?? "");
		// The watch publishes its own failed notice, which wakes the watcher.
		const alias = task(id)?.alias ?? id;
		expect(texts.some((text) => text.includes(`(ID: ${alias}) failed`))).toBe(true);
		expect(wakes).toContain(PARENT);
	});

	test("an agent watch whose agent the restart cancelled ends with a waking interruption", async () => {
		const id = watchId(await watchTool.execute({ type: "agent", id: CHILD }, context()));
		db.update(narrators)
			.set({ status: "idle", backgroundStatus: "cancelled" })
			.where(eq(narrators.id, CHILD))
			.run();
		await restart();
		expect(task(id)?.status).toBe("failed");
		expect(task(id)?.output).toMatch(/interrupted.*server restart/i);
	});

	test("a Bash watch of a still-running target is re-attached and completes once", async () => {
		await bashTask();
		const id = watchId(await watchTool.execute({ type: "bash", id: BASH }, context()));
		// Drop in-memory observation state as a new process would, keeping both rows running
		// (as for a durable service that restart recovery re-attached).
		suspendWatchObservationsForShutdown();
		resumeWatchObservationsForTests();
		clearAliasRegistry(PARENT);
		const row = task(id);
		const target = parseWatchCommand(row?.command);
		if (!row || !restartResumableWatch(target, row.createdAt)) throw new Error("not resumable");
		expect(
			await resumeWatchAfterRestart(
				{
					id,
					parentNarratorId: PARENT,
					alias: row.alias,
					createdAt: row.createdAt,
					principal: { userId: null },
				},
				target,
			),
		).toBe(true);
		expect(observations().filter((watch) => watch.status === "running")).toHaveLength(1);
		await backgroundTaskService.markCompleted(BASH, "service output");
		const done = await settled(id);
		expect(done?.status).toBe("completed");
		expect(done?.output).toContain("Observation fulfilled by the ordinary bash completion notice");
		expect(await notices()).toHaveLength(1);
	});

	test("a Bash text watch still ends as interrupted: missed output cannot be replayed", async () => {
		await bashTask();
		const id = watchId(
			await watchTool.execute({ type: "bash", id: BASH, pattern: "READY" }, context()),
		);
		await restart();
		expect(task(id)?.status).toBe("failed");
		expect(task(id)?.output).toMatch(/interrupted.*server restart/i);
	});

	test("a re-attached watch can still be cancelled with Stop", async () => {
		const id = watchId(await watchTool.execute({ type: "agent", id: CHILD }, context()));
		await restart();
		expect(task(id)?.status).toBe("running");
		expect(await backgroundTaskService.cancel(id)).toBe(true);
		expect(task(id)?.status).toBe("cancelled");
		expect(observations().filter((row) => row.status === "running")).toHaveLength(0);
		expect(db.select().from(narrators).where(eq(narrators.id, CHILD)).get()?.status).toBe(
			"working",
		);
	});
});

describe("re-attachment keeps identity, authority and extended deadlines", () => {
	test("a watch row that does not record its registrant is not re-attached", async () => {
		const id = watchId(await watchTool.execute({ type: "agent", id: CHILD }, context()));
		expect(task(id)?.principalJson).toEqual({ userId: null });
		db.update(backgroundTasks).set({ principalJson: null }).where(eq(backgroundTasks.id, id)).run();
		await restart();
		expect(task(id)?.status).toBe("failed");
		expect(task(id)?.output).toMatch(/interrupted.*server restart/i);
	});

	test("the registrant's user-level revocation applies to re-attachment", async () => {
		ownWatcher();
		const id = watchId(
			await watchTool.execute({ type: "agent", id: CHILD }, context(PARENT, OWNER)),
		);
		expect(task(id)?.principalJson).toEqual({ userId: OWNER });
		db.insert(userPreferences)
			.values({
				id: `${OWNER}-prefs`,
				userId: OWNER,
				traits: upsertEncodedTrait([], RUNTIME_POLICY_TRAIT_PREFIX, {
					version: 1,
					deny: ["watchAgent"],
				}),
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.run();
		invalidateUserTraitLayer(OWNER);
		await restart();
		expect(task(id)?.status).toBe("failed");
		expect(task(id)?.output).toMatch(/interrupted.*server restart/i);
	});

	test("a later collaborator's policy is never borrowed for another user's watch", async () => {
		ownWatcher();
		const id = watchId(
			await watchTool.execute({ type: "agent", id: CHILD }, context(PARENT, OWNER)),
		);
		// A collaborator whose own policy denies agent watches now drives the session.
		const now = new Date().toISOString();
		db.insert(users)
			.values({ id: "collab", username: "collab", passwordHash: "x", createdAt: now })
			.run();
		db.insert(userPreferences)
			.values({
				id: "collab-prefs",
				userId: "collab",
				traits: upsertEncodedTrait([], RUNTIME_POLICY_TRAIT_PREFIX, {
					version: 1,
					deny: ["watchAgent"],
				}),
				createdAt: now,
				updatedAt: now,
			})
			.run();
		invalidateUserTraitLayer("collab");
		db.update(narrators).set({ ownerUserId: "collab" }).where(eq(narrators.id, PARENT)).run();
		await restart();
		// Re-authorized as the registrant, whose policy still allows it.
		expect(task(id)?.status).toBe("running");
	});

	test("a repeated watch's extended deadline survives a restart", async () => {
		ownWatcher();
		const first = await watchTool.execute({ type: "agent", id: CHILD, timeout: 1_000 }, context());
		const id = watchId(first);
		await watchTool.execute({ type: "agent", id: CHILD, timeout: 60_000 }, context());
		expect(parseWatchCommand(task(id)?.command)?.timeoutMs).toBeGreaterThanOrEqual(60_000);
		// Restart after the first deadline but well before the extended one.
		const createdAt = Date.parse(task(id)?.createdAt ?? "");
		db.update(backgroundTasks)
			.set({ createdAt: new Date(createdAt - 5_000).toISOString() })
			.where(eq(backgroundTasks.id, id))
			.run();
		await restart();
		expect(task(id)?.status).toBe("running");
	});

	test("persisted handles are restored exactly, whatever order rows are recovered in", () => {
		const long = "w".repeat(40);
		// Registered first: `long`; registered second: `long-2`. Recovered in reverse order.
		expect(restoreTaskAlias(PARENT, "second", `${long}-2`).alias).toBe(`${long}-2`);
		expect(restoreTaskAlias(PARENT, "first", long).alias).toBe(long);
		expect(resolveTaskAlias(PARENT, long)).toBe("first");
		expect(resolveTaskAlias(PARENT, `${long}-2`)).toBe("second");
	});
});

describe("repeated watches by one watcher are deduplicated", () => {
	test("a repeated Bash watch reuses its observation and extends the deadline to the later one", async () => {
		await bashTask();
		const first = await watchTool.execute({ type: "bash", id: BASH, timeout: 1_000 }, context());
		const repeat = await watchTool.execute({ type: "bash", id: BASH, timeout: 1_500 }, context());
		expect(watchId(repeat)).toBe(watchId(first));
		expect(repeat.metadata).toMatchObject({ status: "watching", reused: true });
		expect(repeat.output).toContain("no second watch was added");
		expect(observations()).toHaveLength(1);
		await Bun.sleep(1_200);
		expect(task(watchId(first))?.status).toBe("running");
		expect((await settled(watchId(first)))?.output).toMatch(/deadline/i);
		expect(await notices()).toHaveLength(1);
		expect(task(BASH)?.status).toBe("running");
	});

	test("a repeated Bash watch never shortens the existing deadline", async () => {
		await bashTask();
		const first = await watchTool.execute({ type: "bash", id: BASH, timeout: 1_500 }, context());
		await watchTool.execute({ type: "bash", id: BASH, timeout: 1_000 }, context());
		await Bun.sleep(1_200);
		expect(task(watchId(first))?.status).toBe("running");
		expect((await settled(watchId(first)))?.output).toMatch(/deadline/i);
		expect(await notices()).toHaveLength(1);
	});

	test("concurrent identical registrations create one observation and one source waiter", async () => {
		await bashTask();
		const results = await Promise.all(
			Array.from({ length: MAX_WATCHES_PER_NARRATOR + 5 }, () =>
				watchTool.execute({ type: "bash", id: BASH }, context()),
			),
		);
		expect(results.every((result) => !result.isError)).toBe(true);
		expect(new Set(results.map(watchId)).size).toBe(1);
		expect(results.filter((result) => result.metadata?.reused)).toHaveLength(
			MAX_WATCHES_PER_NARRATOR + 4,
		);
		expect(observations()).toHaveLength(1);
		expect(activeWatchSourceCount()).toBe(1);
		await backgroundTaskService.markCompleted(BASH, "done once");
		expect((await settled(watchId(results[0] as ToolResult)))?.status).toBe("completed");
		expect(await notices()).toHaveLength(1);
		expect(activeWatchSourceCount()).toBe(0);
	});

	test("different patterns stay separate observations and the completion notifies once", async () => {
		await bashTask();
		const ready = await watchTool.execute({ type: "bash", id: BASH, pattern: "READY" }, context());
		const done = await watchTool.execute({ type: "bash", id: BASH, pattern: "DONE" }, context());
		const end = await watchTool.execute({ type: "bash", id: BASH }, context());
		expect(new Set([ready, done, end].map(watchId)).size).toBe(3);
		expect(activeWatchSourceCount()).toBe(3);
		await backgroundTaskService.markCompleted(BASH, "finished without either marker");
		for (const result of [ready, done, end])
			expect((await settled(watchId(result)))?.status).toBe("completed");
		expect(await notices()).toHaveLength(1);
	});

	test("a repeated agent watch reuses its observation and one completion notifies once", async () => {
		const first = await watchTool.execute({ type: "agent", id: CHILD }, context());
		const repeat = await watchTool.execute({ type: "agent", id: CHILD }, context());
		expect(watchId(repeat)).toBe(watchId(first));
		expect(observations()).toHaveLength(1);
		completeAgent("agent final once");
		expect((await settled(watchId(first)))?.status).toBe("completed");
		expect(await notices()).toHaveLength(1);
		expect(wakes).toEqual([PARENT]);
	});

	test("a repeated agent watch times out once", async () => {
		const first = await watchTool.execute({ type: "agent", id: CHILD, timeout: 1_000 }, context());
		await watchTool.execute({ type: "agent", id: CHILD, timeout: 1_000 }, context());
		expect((await settled(watchId(first)))?.output).toMatch(/deadline/i);
		expect(await notices()).toHaveLength(1);
	});

	test("a new watch after the first one settled is registered afresh", async () => {
		await bashTask();
		const first = await watchTool.execute(
			{ type: "bash", id: BASH, pattern: "NEVER", timeout: 1_000 },
			context(),
		);
		expect((await settled(watchId(first)))?.output).toMatch(/deadline/i);
		const again = await watchTool.execute(
			{ type: "bash", id: BASH, pattern: "NEVER", timeout: 1_000 },
			context(),
		);
		expect(watchId(again)).not.toBe(watchId(first));
		expect(again.metadata?.reused).toBeUndefined();
	});
});

describe("watch results coalesce per watcher", () => {
	const observe = (narratorId = PARENT) =>
		createWatchObservation({ narratorId, title: "coalesce", command: "bash fixture" });

	test("one watcher's observations of the same outcome publish one notice", async () => {
		const [first, second] = await Promise.all([observe(), observe()]);
		await first.finish({ status: "completed", output: "ended", coalesceKey: "run-1 end" });
		await second.finish({ status: "completed", output: "ended", coalesceKey: "run-1 end" });
		expect((await settled(first.taskId))?.status).toBe("completed");
		const silent = await settled(second.taskId);
		expect(silent?.status).toBe("completed");
		expect(silent?.output).toContain("fulfilled by an earlier notice");
		expect(await notices()).toHaveLength(1);
	});

	test("repeated timeout notices of one key publish once", async () => {
		const [first, second] = await Promise.all([observe(), observe()]);
		await Promise.all([
			first.finish({ status: "timeout", output: "deadline", coalesceKey: "run-2 deadline" }),
			second.finish({ status: "timeout", output: "deadline", coalesceKey: "run-2 deadline" }),
		]);
		expect((await settled(second.taskId))?.status).toBe("completed");
		expect(await notices()).toHaveLength(1);
	});

	test("different watchers of one target each receive their own notice", async () => {
		const [mine, theirs] = await Promise.all([observe(PARENT), observe(OTHER)]);
		await mine.finish({ status: "completed", output: "ended", coalesceKey: "run-3 end" });
		await theirs.finish({ status: "completed", output: "ended", coalesceKey: "run-3 end" });
		expect(await notices(PARENT)).toHaveLength(1);
		expect(await notices(OTHER)).toHaveLength(1);
	});

	test("different outcome keys are not merged", async () => {
		const [first, second] = await Promise.all([observe(), observe()]);
		await first.finish({ status: "completed", output: "READY", coalesceKey: "run-4 READY" });
		await second.finish({ status: "completed", output: "DONE", coalesceKey: "run-4 DONE" });
		expect(await notices()).toHaveLength(2);
	});

	test("a duplicate waiting on a holder that is cancelled before delivery publishes instead", async () => {
		const original = backgroundTaskService.markCompleted.bind(backgroundTaskService);
		const [holder, follower] = await Promise.all([observe(), observe()]);
		const blocked = spyOn(backgroundTaskService, "markCompleted").mockImplementation(
			async (id, ...rest) => {
				if (id === holder.taskId) throw new Error("storage unavailable");
				return original(id, ...rest);
			},
		);
		acceleratePublicationRetries();
		await holder.finish({ status: "completed", output: "holder", coalesceKey: "run-5 end" });
		await follower.finish({ status: "completed", output: "follower", coalesceKey: "run-5 end" });
		expect(task(follower.taskId)?.status).toBe("running");
		expect(await backgroundTaskService.cancel(holder.taskId)).toBe(true);
		const done = await settled(follower.taskId);
		expect(done?.status).toBe("completed");
		expect(done?.output).toBe("follower");
		const delivered = (await notices()).map((row) => projectPendingInjection(row));
		expect(
			delivered.filter(
				(notice) => notice?.kind === "bg_bash" && notice.task.id === follower.taskId,
			),
		).toHaveLength(1);
		blocked.mockRestore();
	});
});

describe("shared watch sources", () => {
	test("subscribers share one waiter, which stops only when the last one leaves", async () => {
		let starts = 0;
		let sourceSignal: AbortSignal | undefined;
		const start = (signal: AbortSignal) => {
			starts++;
			sourceSignal = signal;
			return new Promise<string>(() => {});
		};
		const first = new AbortController();
		const second = new AbortController();
		const a = subscribeWatchSource("shared-test", start, first.signal);
		const b = subscribeWatchSource("shared-test", start, second.signal);
		await Bun.sleep(0);
		expect(starts).toBe(1);
		first.abort();
		expect(await a).toBeUndefined();
		expect(sourceSignal?.aborted).toBe(false);
		second.abort();
		expect(await b).toBeUndefined();
		expect(sourceSignal?.aborted).toBe(true);
		expect(activeWatchSourceCount()).toBe(0);
	});

	test("every subscriber receives the shared result and a later one starts afresh", async () => {
		let starts = 0;
		const start = async () => `result ${++starts}`;
		const results = await Promise.all([
			subscribeWatchSource("shared-result", start, new AbortController().signal),
			subscribeWatchSource("shared-result", start, new AbortController().signal),
		]);
		expect(results).toEqual(["result 1", "result 1"]);
		expect(await subscribeWatchSource("shared-result", start, new AbortController().signal)).toBe(
			"result 2",
		);
	});
});
