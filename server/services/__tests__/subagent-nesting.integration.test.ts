/**
 * Two-level subagent nesting (Project Teams S1) through the real services: a primary's
 * `worker` subagent may launch and await helpers; a helper never launches anything.
 *
 * What has to hold:
 *  1. each backstop (visibility, creation, control) refuses a third level, also when the
 *     helper's stored ceiling lost its level stamp (the parent chain decides too);
 *  2. a read-only subagent cannot create a writable helper;
 *  3. reach: a worker reaches its parent, siblings and own helpers; a helper reaches its
 *     parent and siblings; the primary does not reach its grandchildren; Await only
 *     targets agents the caller launched;
 *  4. a helper's permission request reaches the primary's page and panel state, and is
 *     approvable by someone with write access on the root, not by others;
 *  5. stopping a worker stops its helpers (not a taken-over one; never a primary's);
 *  6. after a restart a helper's background run fails explicitly and its parent is told;
 *  7. TeamStatus prints the tree, and a worker's card snapshot lists its helpers.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
	aclGrants,
	backgroundTasks,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import { teamStatusTool } from "../../lib/agent/tools/team-status";
import type { ToolContext } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import { parseRuntimePolicyTraits, withRuntimePolicyTrait } from "../../lib/runtime-policy-trait";
import * as ws from "../../websocket/narrator-ws";
import {
	awaitAgentResultDetailed,
	resolveSubagentTargets,
	sendSubagentMessageDetailed,
} from "../agent-communication";
import { setRunHold } from "../agent-runtime/ownership";
import {
	compileDelegationPolicy,
	isRuntimeToolAllowed,
	MAX_DELEGATION_DEPTH,
	resolveRuntimePolicy,
	withDelegationDepth,
} from "../agent-runtime/policy";
import { runStopsHelpers, stopSubagentHelpers } from "../agent-runtime/run";
import { backgroundTaskService } from "../background-task-service";
import { DELEGATION_DEPTH_LIMIT_MESSAGE, delegationDepthOf } from "../delegation-depth";
import { canWriteNarrator } from "../narrator-acl";
import { authorizeAgentControl } from "../narrator-control";
import { getNarratorPanelState } from "../narrator-panel-state";
import { narratorService } from "../narrator-service";
import {
	broadcastPermissionFrame,
	nestedSubagentRootOf,
	resetNestedSubagentRoots,
} from "../nested-subagent-routing";
import { listNestedSubagents, loadNestedSubagentSummaries } from "../subagent-nested";
import { resetTraitLayerCaches, resolveNarratorRuntimePolicy } from "../trait-layer-service";

const created: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
	// Terminal delivery is observed through the task rows; the async publication
	// scheduler would otherwise race this file's cleanup.
	(await import("../agent-runtime/publication")).runtimePublication.stop();
});

afterEach(async () => {
	resetTraitLayerCaches();
	resetNestedSubagentRoots();
	for (const id of created) {
		setRunHold(id, undefined);
		backgroundTaskService.unregisterAbortController(id);
	}
	const ids = created.splice(0);
	if (ids.length) {
		await db.delete(backgroundTasks).where(inArray(backgroundTasks.parentNarratorId, ids));
		await db
			.delete(narratorBufferedMessages)
			.where(inArray(narratorBufferedMessages.narratorId, ids));
		await db.delete(narratorToolCalls).where(inArray(narratorToolCalls.narratorId, ids));
		await db.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.narratorId, ids));
		await db.delete(narratorMessages).where(inArray(narratorMessages.narratorId, ids));
		await db.delete(aclGrants).where(inArray(aclGrants.scopeId, ids));
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
	}
	const users_ = userIds.splice(0);
	if (users_.length) await db.delete(users).where(inArray(users.id, users_));
});

async function makeUser(label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${id}`,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	userIds.push(id);
	return id;
}

async function subagent(parentNarratorId: string, subagentType: string, title?: string) {
	const row = await narratorService.createSubagent({
		subagentOriginKind: "standalone",
		parentNarratorId,
		subagentType,
		title,
		cwd: ".",
	});
	created.push(row.id);
	return row.id;
}

/** primary → worker (level 1) → helper (level 2), plus a level-1 sibling and a level-2 sibling. */
async function tree(ownerUserId?: string) {
	const primary = (await narratorService.create({ locale: "en", ownerUserId })).id;
	created.push(primary);
	const worker = await subagent(primary, "worker", "worker");
	const sibling = await subagent(primary, "general", "sibling");
	const helper = await subagent(worker, "general", "helper");
	const helperSibling = await subagent(worker, "explore", "helper-sibling");
	return { primary, worker, sibling, helper, helperSibling };
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

/** A Send call row on `caller`, so a delivery has an exact tool receipt. */
function sendInput(caller: string, ids: string[]) {
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
		ids,
		toolUseId: `${messageId}-use`,
		toolCallBinding: { toolCallId: `${messageId}-tool`, attempt: 1 },
		message: "hello",
		signal: new AbortController().signal,
		locale: "en",
	} satisfies Parameters<typeof sendSubagentMessageDetailed>[0];
}

/** A pending tool call of `owner`, placed under `parentToolUseId`. */
function pendingCall(owner: string, parentToolUseId: string | null) {
	const id = generateId();
	const now = new Date().toISOString();
	db.insert(narratorMessages)
		.values({
			id: `m-${id}`,
			narratorId: owner,
			role: "assistant",
			contentJson: [],
			parentToolUseId,
			createdAt: now,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id,
			narratorId: owner,
			messageId: `m-${id}`,
			toolUseId: `use-${id}`,
			toolName: "Bash",
			inputJson: { command: "ls" },
			status: "pending",
			createdAt: now,
		})
		.run();
	return id;
}

/** An Agent call in `owner`'s own transcript, i.e. the placement of a child it launched. */
async function agentCall(owner: string): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narratorMessages).values({
		id: `m-${id}`,
		narratorId: owner,
		role: "assistant",
		contentJson: [],
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({
		id: `r-${id}`,
		narratorId: owner,
		messageId: `m-${id}`,
		seq: 1,
	});
	await db.insert(narratorToolCalls).values({
		id,
		narratorId: owner,
		messageId: `m-${id}`,
		toolUseId: `agent-${id}`,
		toolName: "Agent",
		status: "running",
		createdAt: now,
	});
	return `agent-${id}`;
}

/** A running background task of `owner` whose run is `child` (as createAgentTask writes it). */
async function backgroundRun(owner: string, child: string) {
	const now = new Date().toISOString();
	const { runtimePublication } = await import("../agent-runtime/publication");
	const run = runtimePublication.startRun({
		narratorId: child,
		binding: { deliverTo: { narratorId: owner, toolUseId: "test-tool-use" } },
	}).publication;
	await db.insert(backgroundTasks).values({
		id: child,
		parentNarratorId: owner,
		type: "agent",
		status: "running",
		logicalRunId: run?.logicalRunId,
		subagentNarratorId: child,
		alias: `run-${child}`,
		startedAt: now,
		createdAt: now,
		updatedAt: now,
	});
	const abort = new AbortController();
	backgroundTaskService.registerAbortController(child, abort);
	return abort;
}

describe("depth backstops", () => {
	test("visibility: a worker sees Agent, its helper never does, whatever its template", () => {
		const worker = resolveRuntimePolicy([
			withDelegationDepth(compileDelegationPolicy({ template: "worker" }), 1),
		]);
		expect(worker.delegationDepth).toBe(1);
		expect(worker.capabilities.spawnAgent).toBe(true);
		expect(worker.capabilities.watchAgent).toBe(true);
		expect(isRuntimeToolAllowed(worker, "Agent")).toBe(true);
		expect(isRuntimeToolAllowed(worker, "Watch")).toBe(true);
		expect(isRuntimeToolAllowed(worker, "Await")).toBe(false);
		// A worker template at the deepest level, and an unrestricted declaration that only
		// says "level 2", both lose spawning and agent waits.
		for (const declarations of [
			[withDelegationDepth(compileDelegationPolicy({ template: "worker" }), 2)],
			[{ version: 1 as const, delegationDepth: MAX_DELEGATION_DEPTH }],
			[
				compileDelegationPolicy({ template: "worker" }),
				{ version: 1 as const, delegationDepth: 2 },
			],
		]) {
			const policy = resolveRuntimePolicy(declarations);
			expect(policy.capabilities.spawnAgent).toBe(false);
			expect(policy.capabilities.watchAgent).toBe(false);
			for (const name of ["Agent", "Task", "ContinueTask", "ForkNarrator"])
				expect(isRuntimeToolAllowed(policy, name)).toBe(false);
		}
		// Existing templates keep their behaviour: none of them spawns.
		for (const template of ["general", "review", "explore", "plan", "search"]) {
			const policy = resolveRuntimePolicy([compileDelegationPolicy({ template })]);
			expect(policy.capabilities.spawnAgent).toBe(false);
			expect(isRuntimeToolAllowed(policy, "Agent")).toBe(false);
		}
	});

	test("creation: a helper is stamped level 2 and cannot create a third level", async () => {
		const { primary, worker, helper } = await tree();
		expect(await delegationDepthOf(primary)).toBe(0);
		expect(await delegationDepthOf(worker)).toBe(1);
		expect(await delegationDepthOf(helper)).toBe(2);
		const helperRow = await narratorService.getById(helper);
		expect(parseRuntimePolicyTraits(helperRow.traits)[0]?.delegationDepth).toBe(2);
		expect((await resolveNarratorRuntimePolicy(helper)).capabilities.spawnAgent).toBe(false);
		await expect(subagent(helper, "general")).rejects.toThrow(DELEGATION_DEPTH_LIMIT_MESSAGE);
		// Even when the helper's ceiling lost its stamp and was made unrestricted, the parent
		// chain still places it at level 2.
		await db
			.update(narrators)
			.set({ traits: withRuntimePolicyTrait(["standalone"], { version: 1 }) })
			.where(eq(narrators.id, helper));
		resetTraitLayerCaches();
		await expect(subagent(helper, "worker")).rejects.toThrow(DELEGATION_DEPTH_LIMIT_MESSAGE);
	});

	test("creation: a general subagent still cannot spawn", async () => {
		const { sibling } = await tree();
		await expect(subagent(sibling, "general")).rejects.toThrow("capability ceiling");
	});

	test("control: the worker controls its helper; a level-2 narrator controls nobody", async () => {
		const { worker, helper } = await tree();
		await narratorService.updateStatus(helper, "working");
		const target = await authorizeAgentControl({
			callerNarratorId: worker,
			targetNarratorId: helper,
			action: "stop",
		});
		expect(target.id).toBe(helper);
		// A row registered as controlled by the helper (only possible by tampering).
		const { delegationRegistration } = await import("../../lib/validators/runtime-registration");
		const forged = await subagent(worker, "general");
		await db
			.update(narrators)
			.set({ runtimeRegistrationJson: delegationRegistration(helper, "general") })
			.where(eq(narrators.id, forged));
		// The helper's own stored ceiling is unrestricted here; the chain still refuses.
		await db
			.update(narrators)
			.set({ traits: withRuntimePolicyTrait(["standalone"], { version: 1 }) })
			.where(eq(narrators.id, helper));
		resetTraitLayerCaches();
		await expect(
			authorizeAgentControl({ callerNarratorId: helper, targetNarratorId: forged, action: "stop" }),
		).rejects.toThrow(DELEGATION_DEPTH_LIMIT_MESSAGE);
	});

	test("a read-only subagent cannot create a writable helper", async () => {
		const primary = (await narratorService.create({ locale: "en" })).id;
		created.push(primary);
		const readOnlyWorker = await subagent(primary, "worker");
		await db
			.update(narrators)
			.set({
				traits: withRuntimePolicyTrait(["standalone"], {
					...withDelegationDepth(compileDelegationPolicy({ template: "worker" }), 1),
					readOnly: true,
				}),
			})
			.where(eq(narrators.id, readOnlyWorker));
		resetTraitLayerCaches();
		expect((await resolveNarratorRuntimePolicy(readOnlyWorker)).capabilities.spawnAgent).toBe(true);
		const helper = await subagent(readOnlyWorker, "general");
		const policy = await resolveNarratorRuntimePolicy(helper);
		expect(policy.tools.readOnly).toBe(true);
		expect(isRuntimeToolAllowed(policy, "Write")).toBe(false);
		expect(isRuntimeToolAllowed(policy, "Edit")).toBe(false);
		// The stored ceiling says so too, not only the live source chain.
		const row = await narratorService.getById(helper);
		expect(parseRuntimePolicyTraits(row.traits)[0]?.readOnly).toBe(true);
	});
});

describe("reach", () => {
	test("Send: parent, child and sibling; never a grandchild or another tree", async () => {
		const { primary, worker, sibling, helper, helperSibling } = await tree();
		const ids = async (caller: string, selector: string) =>
			(await resolveSubagentTargets({ callerNarratorId: caller, id: selector })).map((n) => n.id);
		expect(await ids(worker, helper)).toEqual([helper]);
		expect(await ids(worker, sibling)).toEqual([sibling]);
		expect(await ids(helper, helperSibling)).toEqual([helperSibling]);
		expect(await ids(primary, worker)).toEqual([worker]);
		// The primary does not message its grandchildren; a helper does not reach its
		// parent's siblings; a first-level sibling does not reach the worker's helpers.
		await expect(ids(primary, helper)).rejects.toThrow("does not belong");
		await expect(ids(helper, sibling)).rejects.toThrow("does not belong");
		await expect(ids(sibling, helper)).rejects.toThrow("does not belong");
		const other = await tree();
		await expect(ids(worker, other.helper)).rejects.toThrow("does not belong");

		// A helper reports to its parent (a subagent itself) through "parent".
		const toParent = await sendSubagentMessageDetailed(sendInput(helper, ["parent"]));
		expect(toParent.targets.map((t) => [t.id, t.status === "failed"])).toEqual([[worker, false]]);
		// The worker writes to its helper as its parent.
		const toChild = await sendSubagentMessageDetailed(sendInput(worker, [helper]));
		expect(toChild.targets.map((t) => t.status)).not.toContain("failed");
		// The model-facing projection names the worker as the helper's parent, not a sibling.
		const queued = await db.query.narratorBufferedMessages.findMany({
			where: eq(narratorBufferedMessages.narratorId, helper),
		});
		expect(queued).toHaveLength(1);
		expect(JSON.stringify(queued[0])).toContain("[Message from the parent narrator]");
		expect(JSON.stringify(queued[0])).not.toContain("sibling subagent");
	});

	test("Watch: only agents the caller launched", async () => {
		const { primary, worker, sibling, helper } = await tree();
		const wait = (caller: string, id: string) =>
			awaitAgentResultDetailed({
				callerNarratorId: caller,
				id,
				signal: new AbortController().signal,
				timeoutMs: 1_000,
			});
		await narratorService.updateStatus(helper, "idle");
		const result = await wait(worker, helper);
		expect(result.id).toBe(helper);
		await expect(wait(worker, sibling)).rejects.toThrow("not a subagent this narrator launched");
		await expect(wait(primary, helper)).rejects.toThrow("not a subagent this narrator launched");
		// A helper and an ordinary subagent may not wait for agents at all.
		await expect(wait(helper, worker)).rejects.toThrow("Watch");
		await expect(wait(sibling, worker)).rejects.toThrow("Watch");
	});
});

test("Watch registers a worker's own helper without widening sibling or deepest-level access", async () => {
	const { worker, sibling, helper } = await tree();
	await backgroundRun(worker, helper);
	const projection = await backgroundTaskService.getById(helper);
	expect(projection?.logicalRunId).toBeString();
	await db
		.update(narrators)
		.set({ logicalRunId: projection?.logicalRunId })
		.where(eq(narrators.id, helper));
	await narratorService.updateStatus(helper, "working");
	const { watchTool } = await import("../../lib/agent/tools/watch");
	const workerContext = {
		...ctx(worker),
		runtimePolicy: await resolveNarratorRuntimePolicy(worker),
	};
	const result = await watchTool.execute({ type: "agent", id: helper }, workerContext);
	expect(result.isError).toBeFalsy();
	expect(result.metadata).toMatchObject({ status: "watching", id: helper });
	const observationId = result.metadata?.watchId as string | undefined;
	expect(observationId).toBeDefined();
	try {
		const foreign = await watchTool.execute({ type: "agent", id: sibling }, workerContext);
		expect(foreign.isError).toBe(true);
		const deepest = await watchTool.execute(
			{ type: "agent", id: worker },
			{
				...ctx(helper),
				runtimePolicy: await resolveNarratorRuntimePolicy(helper),
			},
		);
		expect(deepest.isError).toBe(true);
	} finally {
		if (observationId) await backgroundTaskService.cancel(observationId);
	}
});

describe("approvals reach the root", () => {
	test("a helper's request is forwarded to the root page and listed in its panel state", async () => {
		const { primary, worker, helper } = await tree();
		expect(nestedSubagentRootOf(helper)).toBe(primary);
		expect(nestedSubagentRootOf(worker)).toBeUndefined();

		const sent: Array<[string, unknown]> = [];
		const spy = spyOn(ws, "broadcastToNarrator").mockImplementation((id, frame) => {
			sent.push([id, frame]);
		});
		try {
			broadcastPermissionFrame(helper, worker, {
				type: "permission_resolved",
				narratorId: worker,
				requestId: "r1",
				toolUseId: "u1",
				ownerNarratorId: helper,
				subagentNarratorId: helper,
			});
		} finally {
			spy.mockRestore();
		}
		expect(sent.map(([id, frame]) => [id, (frame as { narratorId: string }).narratorId])).toEqual([
			[worker, worker],
			[primary, primary],
		]);

		const placement = await agentCall(worker);
		const request = pendingCall(helper, placement);
		const stray = pendingCall(helper, "not-a-worker-call");
		const rootPanel = await getNarratorPanelState(primary, "viewer");
		const listed = rootPanel.permissions.map((p: { id: string }) => p.id);
		expect(listed).toContain(request);
		expect(listed).not.toContain(stray);
		const item = rootPanel.permissions.find((p: { id: string }) => p.id === request);
		expect(item?.subagentNarratorId).toBe(helper);
	});

	test("write access on the root decides who may approve a helper's request", async () => {
		const owner = await makeUser("owner");
		const colleague = await makeUser("colleague");
		const stranger = await makeUser("stranger");
		const { primary, helper } = await tree(owner);
		const helperRow = await narratorService.getById(helper);
		expect(helperRow.aclRootNarratorId).toBe(primary);
		const as = (userId: string) => ({ userId, isAdmin: false });
		expect(await canWriteNarrator(helperRow, as(owner))).toBe(true);
		expect(await canWriteNarrator(helperRow, as(colleague))).toBe(false);
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "narrator",
			scopeId: primary,
			principalType: "user",
			principalId: colleague,
			capability: "write",
			createdAt: new Date().toISOString(),
		});
		expect(await canWriteNarrator(helperRow, as(colleague))).toBe(true);
		expect(await canWriteNarrator(helperRow, as(stranger))).toBe(false);
	});
});

describe("stop and restart", () => {
	test("stopping a worker stops its helpers, except one a person has taken over", async () => {
		const { primary, worker, sibling, helper, helperSibling } = await tree();
		for (const id of [sibling, helper, helperSibling])
			await narratorService.updateStatus(id, "working");
		const helperRun = await backgroundRun(worker, helper);
		const heldRun = await backgroundRun(worker, helperSibling);
		setRunHold(helperSibling, { released: false });
		const siblingRun = await backgroundRun(primary, sibling);

		expect(await stopSubagentHelpers(worker, "test")).toBe(1);
		expect(helperRun.signal.aborted).toBe(true);
		expect(heldRun.signal.aborted).toBe(false);
		// A primary's background agents are never stopped this way.
		expect(await stopSubagentHelpers(primary, "test")).toBe(0);
		expect(siblingRun.signal.aborted).toBe(false);
	});

	test("after a restart a helper's background run ends explicitly, delivered to its parent", async () => {
		const { worker, helper } = await tree();
		await narratorService.updateStatus(helper, "working");
		await backgroundRun(worker, helper);
		await backgroundTaskService.recoverStaleTasksAfterRestart();
		const task = await db.query.backgroundTasks.findFirst({
			where: eq(backgroundTasks.id, helper),
		});
		expect(task?.status).toBe("cancelled");
		expect(task?.parentNarratorId).toBe(worker);
		expect(task?.output).toContain("server restart");
	});
});

describe("tree views", () => {
	test("TeamStatus shows the primary each agent's helpers; card snapshots list them", async () => {
		const { primary, worker, helper, helperSibling } = await tree();
		await narratorService.updateStatus(helperSibling, "idle");
		const out = (await teamStatusTool.execute({ action: "list_agents" }, ctx(primary))).output;
		const lines = out.split("\n");
		const workerLine = lines.findIndex((line) => line.includes(`id=${worker}`));
		expect(workerLine).toBeGreaterThan(-1);
		const nested = lines.filter((line) => line.startsWith("  - kind=agent"));
		expect(nested.some((line) => line.includes(`id=${helper}`))).toBe(true);
		expect(nested.some((line) => line.includes(`id=${helperSibling}`))).toBe(true);
		expect(out).toContain("Sibling subagents (2):");

		pendingCall(helper, null);
		const summaries = await loadNestedSubagentSummaries([worker, helper]);
		expect(summaries.has(helper)).toBe(false);
		const summary = summaries.get(worker);
		expect(summary?.total).toBe(2);
		// Active first.
		expect(summary?.agents[0]).toMatchObject({
			subagentNarratorId: helper,
			status: "working",
			subagentType: "general",
			awaitingPermission: true,
		});
		expect(summary?.agents[1]?.awaitingPermission).toBeUndefined();
	});
});

describe("review round 1", () => {
	test("Stop on an idle worker stops the helpers it left running", async () => {
		const { primary, worker, helper } = await tree();
		await narratorService.updateStatus(worker, "idle");
		await narratorService.updateStatus(helper, "working");
		const helperRun = await backgroundRun(worker, helper);
		// The worker's own background task already finished: it has no live run.
		const now = new Date().toISOString();
		await db.insert(backgroundTasks).values({
			id: worker,
			parentNarratorId: primary,
			type: "agent",
			status: "completed",
			subagentNarratorId: worker,
			alias: `run-${worker}`,
			startedAt: now,
			createdAt: now,
			updatedAt: now,
			completedAt: now,
		});
		const { stopTool } = await import("../../lib/agent/tools/stop");
		const out = await stopTool.execute({ type: "agent", id: worker }, ctx(primary));
		expect(out.isError).toBeFalsy();
		expect(out.output).toContain("1 running helper agent(s) were stopped");
		expect(helperRun.signal.aborted).toBe(true);
		// A worker with nothing running reports as before.
		const again = await stopTool.execute({ type: "agent", id: worker }, ctx(primary));
		expect(again.isError).toBe(true);
		expect(again.output).toContain("is not running");
	});

	test("an explicit stop checks its authorization before each helper, never after", async () => {
		const { worker, helper } = await tree();
		await narratorService.updateStatus(helper, "working");
		const helperRun = await backgroundRun(worker, helper);
		await expect(
			stopSubagentHelpers(worker, "test", {
				assertAuthorized: () => {
					throw new Error("revoked");
				},
			}),
		).rejects.toThrow("revoked");
		expect(helperRun.signal.aborted).toBe(false);
	});

	test("a run takes its helpers with it only when cancelled or timed out", () => {
		expect(runStopsHelpers({ cancelled: true, timedOut: false })).toBe(true);
		expect(runStopsHelpers({ cancelled: false, timedOut: true })).toBe(true);
		// An error, or the loop merely breaking for queued input / a planned-update pause
		// (reported as "interrupted" without cancelling the run), leaves helpers running.
		expect(runStopsHelpers({ cancelled: false, timedOut: false })).toBe(false);
	});

	test("a helper that failed or was stopped says so in its card row", async () => {
		const { worker, helper, helperSibling } = await tree();
		const third = await subagent(worker, "general", "third");
		await narratorService.updateStatus(helper, "idle", { substatus: ["error"] });
		await narratorService.updateStatus(helperSibling, "idle", { substatus: ["interrupted"] });
		await narratorService.updateStatus(third, "idle", { substatus: ["unread"] });
		const agents = (await loadNestedSubagentSummaries([worker])).get(worker)?.agents ?? [];
		const ended = Object.fromEntries(agents.map((a) => [a.subagentNarratorId, a.ended]));
		expect(ended[helper]).toBe("failed");
		expect(ended[helperSibling]).toBe("stopped");
		expect(ended[third]).toBeUndefined();
	});

	test("archived and deleted helpers are forgotten by the root routing", async () => {
		const { primary, worker, helper, helperSibling } = await tree();
		expect(nestedSubagentRootOf(helper)).toBe(primary);
		await narratorService.updateStatus(helper, "archived");
		expect(nestedSubagentRootOf(helper)).toBeUndefined();
		expect(nestedSubagentRootOf(helperSibling)).toBe(primary);
		const { eventBus } = await import("../../lib/event-bus");
		eventBus.emit({ type: "narrator:deleted", narratorId: helperSibling, title: null });
		expect(nestedSubagentRootOf(helperSibling)).toBeUndefined();
		expect(nestedSubagentRootOf(worker)).toBeUndefined();
	});

	test("helper listings for many cards are paged, never cut", async () => {
		const { worker, helper } = await tree();
		const ids = [...Array.from({ length: 150 }, (_, i) => `missing-${i}`), worker];
		const listed = await listNestedSubagents(ids, 5);
		expect(listed.get(worker)?.subagents.map((row) => row.id)).toContain(helper);
	});

	test("no user template can take a built-in's name, in any spelling", async () => {
		const { rm } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { narraforkDir } = await import("../../lib/settings");
		const service = await import("../custom-subagent-service");
		const def = {
			description: "mine",
			toolAccess: "readOnly" as const,
			customTools: [],
			defaultModel: "",
			prompt: "Injected prompt.",
		};
		const mine = join(narraforkDir, "subagents", "my-helper");
		try {
			for (const name of ["Worker", "WORKER", " worker ", "General", "search"])
				await expect(service.create({ ...def, name })).rejects.toThrow("built-in");
			await service.create({ ...def, name: "my-helper" });
			await expect(service.update("my-helper", { ...def, name: "Worker" })).rejects.toThrow(
				"built-in",
			);
			// Any spelling of a built-in name means the built-in, never a user's file.
			for (const name of ["worker", "Worker", "WORKER"])
				expect(await service.resolveTemplateDefinition(name)).toBeNull();
			const builtin = resolveRuntimePolicy([await service.compileDelegationCeiling("worker")]);
			expect(builtin.capabilities.spawnAgent).toBe(true);
			expect(await service.resolveTemplateDefinition("my-helper")).not.toBeNull();
		} finally {
			await rm(mine, { recursive: true, force: true });
			await rm(join(narraforkDir, "subagents", "worker"), { recursive: true, force: true });
		}
	});

	test("a built-in name in any capitalisation means that built-in", async () => {
		const service = await import("../custom-subagent-service");
		expect(service.canonicalTemplateName("Worker")).toBe("worker");
		expect(service.canonicalTemplateName("GENERAL")).toBe("general");
		expect(service.canonicalTemplateName("my-helper")).toBe("my-helper");
		const worker = resolveRuntimePolicy([await service.compileDelegationCeiling("Worker")]);
		expect(worker.capabilities.spawnAgent).toBe(true);
		expect(worker.tools.readOnly).toBe(false);
		const general = resolveRuntimePolicy([await service.compileDelegationCeiling("General")]);
		expect(general.tools.readOnly).toBe(false);
	});

	test("every built-in directory is moved aside; a symlink is left alone; a failed write moves nothing", async () => {
		const { mkdir, readFile, rm, stat, symlink, writeFile, lstat } = await import(
			"node:fs/promises"
		);
		const { join } = await import("node:path");
		const { narraforkDir } = await import("../../lib/settings");
		const service = await import("../custom-subagent-service");
		const root = join(narraforkDir, "subagents");
		const outside = join(narraforkDir, "outside-template");
		const file = (name: string) =>
			`---\nname: ${name}\ndescription: mine\ntoolAccess: general\n---\n\nMy ${name} prompt.\n`;
		const cleanup = async () => {
			for (const dir of ["general", "general-custom", "explore", "explore-custom"])
				await rm(join(root, dir), { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		};
		try {
			await mkdir(join(root, "general"), { recursive: true });
			await writeFile(join(root, "general", "SUBAGENT.md"), file("General"));
			await mkdir(outside, { recursive: true });
			await writeFile(join(outside, "SUBAGENT.md"), file("explore"));
			await symlink(outside, join(root, "explore"));

			// A failing write moves nothing and leaves the original untouched.
			const failing = await service.moveAsideReservedTemplates({
				writeFile: async () => {
					throw new Error("disk full");
				},
				rename: async () => {},
			});
			expect(failing).toEqual([]);
			expect(await readFile(join(root, "general", "SUBAGENT.md"), "utf-8")).toBe(file("General"));
			await expect(stat(join(root, "general-custom"))).rejects.toThrow();

			// A failing directory rename leaves the old directory, with its file already
			// renamed: never a `-custom` directory whose file claims the reserved name.
			const fs = await import("node:fs/promises");
			const halfway = await service.moveAsideReservedTemplates({
				writeFile: (path, data) => fs.writeFile(path, data, "utf-8"),
				rename: async (from, to) => {
					if (to.endsWith("-custom")) throw new Error("rename refused");
					await fs.rename(from, to);
				},
			});
			expect(halfway).toEqual([]);
			await expect(stat(join(root, "general-custom"))).rejects.toThrow();

			expect(await service.moveAsideReservedTemplates()).toEqual(["general-custom"]);
			const moved = await service.resolveTemplateDefinition("general-custom");
			expect(moved?.name).toBe("general-custom");
			expect(moved?.prompt).toBe("My General prompt.");
			await expect(stat(join(root, "general"))).rejects.toThrow();
			// The symlinked directory is neither followed for the write nor moved.
			expect((await lstat(join(root, "explore"))).isSymbolicLink()).toBe(true);
			expect(await readFile(join(outside, "SUBAGENT.md"), "utf-8")).toBe(file("explore"));
			await expect(stat(join(root, "explore-custom"))).rejects.toThrow();
		} finally {
			await cleanup();
		}
	});

	test("a template that already used the name worker is moved aside, not lost", async () => {
		const { mkdir, readFile, rm, stat, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { narraforkDir } = await import("../../lib/settings");
		const service = await import("../custom-subagent-service");
		const root = join(narraforkDir, "subagents");
		const file =
			"---\nname: worker\ndescription: mine\ntoolAccess: readOnly\n---\n\nMy own worker prompt.\n";
		try {
			// `worker-custom` is taken, so the old template lands on `worker-custom-2`.
			await mkdir(join(root, "worker-custom"), { recursive: true });
			await writeFile(
				join(root, "worker-custom", "SUBAGENT.md"),
				file.replace("name: worker", "name: worker-custom"),
			);
			await mkdir(join(root, "worker"), { recursive: true });
			await writeFile(join(root, "worker", "SUBAGENT.md"), file);
			expect(await service.moveAsideReservedTemplates()).toEqual(["worker-custom-2"]);
			await expect(stat(join(root, "worker"))).rejects.toThrow();
			const moved = await service.resolveTemplateDefinition("worker-custom-2");
			expect(moved?.name).toBe("worker-custom-2");
			expect(moved?.prompt).toBe("My own worker prompt.");
			expect(await readFile(join(root, "worker-custom", "SUBAGENT.md"), "utf-8")).toContain(
				"name: worker-custom",
			);
			// The built-in now always wins; a second pass has nothing to move.
			expect(await service.resolveTemplateDefinition("worker")).toBeNull();
			expect(await service.moveAsideReservedTemplates()).toEqual([]);
		} finally {
			for (const dir of ["worker", "worker-custom", "worker-custom-2"])
				await rm(join(root, dir), { recursive: true, force: true });
		}
	});
});
