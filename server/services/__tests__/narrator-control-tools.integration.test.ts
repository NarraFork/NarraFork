/**
 * Stop, Send(doInterrupt) and Agent(archive) through the real tools and the real control
 * authorization (registered controller, real capability ceilings, takeover state).
 * Only the effect sinks are observed (abort controllers, the archive mechanism); no
 * authorization dependency is mocked.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
	backgroundTasks,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import { stopTool } from "../../lib/agent/tools/stop";
import { agentTool } from "../../lib/agent/tools/task";
import type { ToolContext } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import * as communication from "../agent-communication";
import { sendSubagentMessageDetailed } from "../agent-communication";
import { setRunHold } from "../agent-runtime/ownership";
import { backgroundTaskService } from "../background-task-service";
import { narratorService } from "../narrator-service";
import { type ActiveNarrator, activeNarrators } from "../narrator-session-state";
import * as lifecycle from "../subagent-lifecycle";
import { resetTraitLayerCaches } from "../trait-layer-service";
import { captureWorkerRejectionThrower } from "./narrator-worker-fixture";

const created: string[] = [];
const markTakenOver = (id: string) => setRunHold(id, { released: false });
const clearTakenOver = (id: string) => setRunHold(id, undefined);
/** A turn in flight on `id`: the session's live controller, as for any session. */
function liveTurn(id: string): AbortController {
	const turn = new AbortController();
	activeNarrators.set(id, { narratorId: id, alive: true, abortController: turn } as ActiveNarrator);
	return turn;
}
const archived: string[] = [];

beforeAll(async () => {
	// Terminal delivery is observed through the task row; the async publication
	// scheduler would otherwise race this file's narrator cleanup.
	(await import("../agent-runtime/publication")).runtimePublication.stop();
	// Observe the archive mechanism (its own behaviour is covered by subagent-lifecycle tests).
	spyOn(lifecycle, "interruptAndArchiveSubagent").mockImplementation(async (id: string) => {
		archived.push(id);
		return { ok: true, alreadyArchived: false, archived: true, interrupted: false, id };
	});
});

afterEach(async () => {
	resetTraitLayerCaches();
	archived.length = 0;
	for (const id of created) {
		clearTakenOver(id);
		activeNarrators.delete(id);
		backgroundTaskService.unregisterAbortController(id);
	}
	const ids = created.splice(0);
	if (!ids.length) return;
	await db.delete(backgroundTasks).where(inArray(backgroundTasks.parentNarratorId, ids));
	await db
		.delete(narratorBufferedMessages)
		.where(inArray(narratorBufferedMessages.narratorId, ids));
	await db.delete(narratorToolCalls).where(inArray(narratorToolCalls.narratorId, ids));
	// A stopped run's terminal notice lands in its caller's transcript.
	await db.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.narratorId, ids));
	await db.delete(narratorMessages).where(inArray(narratorMessages.narratorId, ids));
	await db
		.update(narrators)
		.set({
			parentNarratorId: null,
			aclRootNarratorId: null,
			policySourceNarratorId: null,
			runtimeRegistrationJson: null,
		})
		.where(inArray(narrators.id, ids));
	await db.delete(narrators).where(inArray(narrators.id, ids));
});

async function team() {
	const parent = (await narratorService.create({ locale: "en" })).id;
	created.push(parent);
	const child = async () => {
		const row = await narratorService.createSubagent({
			subagentOriginKind: "standalone",
			parentNarratorId: parent,
			subagentType: "general",
			cwd: ".",
		});
		created.push(row.id);
		await narratorService.updateStatus(row.id, "working");
		return row.id;
	};
	return { parent, child: await child(), sibling: await child() };
}

function ctx(narratorId: string): ToolContext {
	return {
		narratorId,
		cwd: ".",
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" as const }),
	};
}

/**
 * A running background agent task owned by `owner` whose run is `child`. A registered
 * task is keyed by its run's session (as createAgentTask writes it); a foreign row
 * that registered no run gets its own id.
 */
async function backgroundRun(owner: string, child: string, registered = true) {
	const now = new Date().toISOString();
	const { runtimePublication } = await import("../agent-runtime/publication");
	const run = registered
		? runtimePublication.startRun({
				narratorId: child,
				binding: { deliverTo: { narratorId: owner, toolUseId: "test-tool-use" } },
			}).publication!
		: undefined;
	const id = registered ? child : generateId();
	await db.insert(backgroundTasks).values({
		id,
		parentNarratorId: owner,
		type: "agent",
		status: "running",
		logicalRunId: run?.logicalRunId,
		subagentNarratorId: child,
		alias: `run-${id}`,
		startedAt: now,
		createdAt: now,
		updatedAt: now,
	});
	// The task's cancellation reaches the run it projects (registered by the run service).
	const abort = new AbortController();
	backgroundTaskService.registerAbortController(id, abort);
	return { id, abort };
}

function sendInput(caller: string, target: string) {
	const messageId = generateId();
	const now = new Date().toISOString();
	db.insert(narratorMessages)
		.values({
			id: messageId,
			narratorId: caller,
			role: "assistant",
			contentJson: [],
			createdAt: now,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: `${messageId}-tool`,
			narratorId: caller,
			messageId,
			toolUseId: `${messageId}-use`,
			toolName: "Send",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			status: "running",
			createdAt: now,
		})
		.run();
	return {
		callerNarratorId: caller,
		ids: [target],
		toolUseId: `${messageId}-use`,
		toolCallBinding: { toolCallId: `${messageId}-tool`, attempt: 1 },
		message: "change course",
		signal: new AbortController().signal,
		locale: "en",
		doInterrupt: true,
	} satisfies Parameters<typeof sendSubagentMessageDetailed>[0];
}

describe("Stop(agent)", () => {
	test("the controller stops its run; a sibling and a taken-over target are refused", async () => {
		const { parent, child, sibling } = await team();
		// A sibling holding a task row for the child still has no control grant over it.
		const foreign = await backgroundRun(sibling, child, false);
		const denied = await stopTool.execute({ type: "agent", id: foreign.id }, ctx(sibling));
		expect(denied.isError).toBe(true);
		expect(denied.output).toContain("not a direct child");
		expect(foreign.abort.signal.aborted).toBe(false);

		const run = await backgroundRun(parent, child);
		markTakenOver(child);
		const held = await stopTool.execute({ type: "agent", id: run.id }, ctx(parent));
		expect(held.isError).toBe(true);
		expect(held.output).toContain("taken over");
		expect(run.abort.signal.aborted).toBe(false);

		clearTakenOver(child);
		const stopped = await stopTool.execute({ type: "agent", id: run.id }, ctx(parent));
		expect(stopped.isError).toBeFalsy();
		expect(run.abort.signal.aborted).toBe(true);
	});
});

describe("Send(doInterrupt)", () => {
	test("the controller interrupts; a sibling is refused before delivery", async () => {
		const { parent, child, sibling } = await team();
		const turn = liveTurn(child);
		expect(
			await captureWorkerRejectionThrower(sendSubagentMessageDetailed(sendInput(sibling, child))),
		).toThrow();
		expect(turn.signal.aborted).toBe(false);
		const result = await sendSubagentMessageDetailed(sendInput(parent, child));
		expect(result.targets.map((target) => target.status)).toEqual(["queued"]);
		expect(turn.signal.aborted).toBe(true);
	});

	test("during takeover the message is delivered but the user's turn is not interrupted", async () => {
		const { parent, child } = await team();
		const turn = liveTurn(child);
		markTakenOver(child);
		const result = await sendSubagentMessageDetailed(sendInput(parent, child));
		expect(result.targets.map((target) => target.status)).toEqual(["queued"]);
		expect(result.output).toContain("doInterrupt was ignored");
		expect(turn.signal.aborted).toBe(false);
		const queued = await db.query.narratorBufferedMessages.findMany({
			where: eq(narratorBufferedMessages.narratorId, child),
			columns: { id: true },
		});
		expect(queued).toHaveLength(1);
	});
});

describe("Agent(archive)", () => {
	test("the controller archives; a sibling and a taken-over target are refused", async () => {
		const { parent, child, sibling } = await team();
		// Address the target by id so selector resolution is not what decides.
		spyOn(communication, "resolveSubagentTargets").mockResolvedValue([]);
		const foreign = await agentTool.execute({ archive: child }, ctx(sibling));
		expect(foreign.isError).toBe(true);
		expect(foreign.output).toContain("not a direct child");

		markTakenOver(child);
		const held = await agentTool.execute({ archive: child }, ctx(parent));
		expect(held.isError).toBe(true);
		expect(archived).toEqual([]);

		clearTakenOver(child);
		const done = await agentTool.execute({ archive: child }, ctx(parent));
		expect(done.isError).toBeFalsy();
		expect(archived).toEqual([child]);
	});
});
