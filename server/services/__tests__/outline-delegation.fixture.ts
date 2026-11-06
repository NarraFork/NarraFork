/**
 * Harness of the outline delegation tests (outline P2 PR 9a): outline root sessions, durable
 * Agent call receipts, the real Agent tool, and a scripted model pass that may wait on a gate.
 * `installDelegationHarness()` registers the per-test setup and cleanup.
 */
import { afterEach, beforeEach, spyOn } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import {
	backgroundTasks,
	fileChangeExecutionSegments,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	outlineTaskClaims,
	users,
} from "../../db/schema";
import { agentTool } from "../../lib/agent/tools/task";
import type { ToolContext } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { readRuntimeRegistrationColumn } from "../../lib/validators/runtime-registration";
import * as websocket from "../../websocket/narrator-ws";
import { getExecutionOwner, getRunControl, setRunHold } from "../agent-runtime/ownership";
import * as completionQueue from "../bg-completion-queue";
import * as passExecutor from "../narrator-executor";
import { activeNarrators } from "../narrator-session-state";
import { ensureSessionSpace } from "../outline/spaces";
import { outlineStore } from "../outline/store";
import { type OutlineOp, writeOutline } from "../outline/write";
import { drainPendingInjections } from "../parent-injection-queue";
import { clearAliasRegistry } from "../subagent-alias";

export const MODEL = "anthropic:claude-sonnet-4-20250514";
export const NOW = "2026-11-06T00:00:00.000Z";
const originalProviders = settings.anthropicProviders;
const originalDefaultModel = settings.agent.defaultModel;
const originalAllowedModels = settings.agent.subagentAllowedModels;
const restores: Array<() => void> = [];
const narratorIds: string[] = [];

/** The scripted model: passes answer in order, each after its gate opens. */
export const model = {
	script: [] as Array<{ text: string; gate?: Promise<void> }>,
	/** Narrators whose model pass ran, in order. */
	passes: [] as string[],
};

export const REPORT = `# Findings
The race is in refresh():

- it reuses the token it read before the lock [[Kx81mPqa/Ab3dEf9Q]]
- [ ] a regression test is still missing @agent:w-auth

## Evidence
| case | result |
|---|---|
| two refreshes | second one rejected |

\`\`\`ts
await refresh(); // auth.ts:42
\`\`\`
`;

export const runEnded = (id: string) => !getExecutionOwner(id) && !getRunControl(id);

export async function until(
	predicate: () => boolean | Promise<boolean>,
	what = "condition",
): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

export function installDelegationHarness(): void {
	beforeEach(() => {
		settings.outline.enabled = true;
		model.script = [];
		model.passes = [];
		settings.anthropicProviders = [
			{
				id: "delegation-test",
				name: "Test provider (no network)",
				prefix: "anthropic",
				apiKey: "not-a-real-key",
				baseUrl: "https://delegation-test.invalid",
				defaultModel: "claude-sonnet-4-20250514",
			},
		];
		settings.agent.defaultModel = MODEL;
		settings.agent.subagentAllowedModels = { general: [MODEL], explore: [], plan: [] };
		const broadcast = spyOn(websocket, "broadcastToNarrator").mockImplementation(() => {});
		const wake = spyOn(completionQueue, "pushBgCompletionNotification").mockImplementation(
			() => {},
		);
		const network = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				() => {
					throw new Error("Real model/network access is forbidden here");
				},
				{ preconnect: () => {} },
			),
		);
		const execute = spyOn(passExecutor, "executeAgentLoop").mockImplementation(async (options) => {
			const id = options.config.narratorId as string;
			if (!narratorIds.includes(id)) narratorIds.push(id);
			model.passes.push(id);
			const step = model.script.shift();
			await step?.gate;
			return {
				finalText: step?.text ?? "done",
				hasError: false,
				shouldUpdateTitle: false,
				completedNaturally: true,
				completedAssistantTurn: true,
			};
		});
		restores.push(
			() => broadcast.mockRestore(),
			() => wake.mockRestore(),
			() => network.mockRestore(),
			() => execute.mockRestore(),
		);
	});

	afterEach(async () => {
		for (const id of narratorIds)
			if (!runEnded(id)) await until(() => runEnded(id), "runs to end").catch(() => {});
		for (const restore of restores.splice(0).reverse()) restore();
		settings.anthropicProviders = originalProviders;
		settings.agent.defaultModel = originalDefaultModel;
		settings.agent.subagentAllowedModels = originalAllowedModels;
		for (const id of narratorIds) {
			setRunHold(id, undefined);
			drainPendingInjections(id);
			clearAliasRegistry(id);
			activeNarrators.delete(id);
		}
		narratorIds.length = 0;
	});
}

export async function user(name = "alice"): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${name}-${id}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	return id;
}

export async function rootSession(
	owner: string,
	options: { backend?: "spec" | "outline"; title?: string; traits?: string[] } = {},
): Promise<string> {
	const id = generateId();
	narratorIds.push(id);
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		title: options.title ?? "Root",
		traits: options.traits ?? ["standalone"],
		model: MODEL,
		cwd: process.env.HOME,
		permissionMode: "default",
		status: "working",
		taskBackend: options.backend ?? "outline",
		ownerUserId: owner,
		autoContinuationOverride: "off",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

/** A durable receipt for an Agent call of `parent`, as the tool executor records it. */
export async function agentCall(parent: string) {
	const now = new Date().toISOString();
	const toolUseId = generateId();
	const callId = generateId();
	const segmentId = generateId();
	const messageId = generateId();
	await db.insert(fileChangeExecutionSegments).values({
		id: segmentId,
		narratorId: parent,
		sourceToolCallId: callId,
		sourceExecutionAttempt: 1,
		createdAt: now,
	});
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: parent,
		role: "assistant",
		contentJson: [],
		createdAt: now,
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId: parent, messageId, seq: Date.now() % 1_000_000 });
	await db.insert(narratorToolCalls).values({
		id: callId,
		messageId,
		narratorId: parent,
		toolUseId,
		toolName: "Agent",
		inputJson: {},
		status: "running",
		executionStartedAt: now,
		executionAttempt: 1,
		executionIdentityVersion: 1,
		executionSegmentId: segmentId,
		createdAt: now,
	});
	return {
		toolUseId,
		messageId,
		binding: { toolCallId: callId, attempt: 1, executionSegmentId: segmentId },
	};
}

/** Call the real Agent tool as `parent`'s turn for `owner`. */
export async function agent(parent: string, owner: string | null, args: Record<string, unknown>) {
	const call = await agentCall(parent);
	const ctx = {
		narratorId: parent,
		cwd: process.env.HOME as string,
		signal: new AbortController().signal,
		locale: "en",
		userId: owner,
		requestPermission: async () => ({ behavior: "allow" }),
		currentToolUseId: call.toolUseId,
		toolCallBinding: call.binding,
		updateExecutionLease: {
			kind: "resumable",
			setNarratorId() {},
			transfer: () => true,
			release() {},
		},
	} as unknown as ToolContext;
	const result = await agentTool.execute(args, ctx);
	const child = await db.query.narrators.findFirst({
		where: eq(narrators.originToolCallId, call.binding.toolCallId),
	});
	if (child && !narratorIds.includes(child.id)) narratorIds.push(child.id);
	return { result, call, childId: child?.id ?? null };
}

export async function children(parent: string): Promise<string[]> {
	const rows = await db.query.narrators.findMany({
		where: eq(narrators.parentNarratorId, parent),
		columns: { id: true },
	});
	return rows.map((r) => r.id);
}

/** Write in `space` as the agent `narratorId`. */
export async function write(spaceId: string, narratorId: string, owner: string, ops: OutlineOp[]) {
	return await writeOutline({
		spaceId,
		ops,
		actor: { kind: "agent", id: narratorId },
		responsibleUserId: owner,
		narratorId,
	});
}

/** A task with a note, a step and a second line under its title, in the root's session space. */
export async function seedTask(root: string, owner: string, title = "Fix the refresh race") {
	const space = await ensureSessionSpace(root);
	const r = await write(space.id, root, owner, [
		{ op: "insert", tempId: "page", parent: null, content: "Auth work" },
		{
			op: "insert",
			tempId: "t",
			parent: { tempId: "page" },
			content: `${title}\nAcceptance: two refreshes never both succeed`,
			task: { status: "todo" },
		},
		{
			op: "insert",
			parent: { tempId: "t" },
			content: "Plan: carry the version, reject older ones",
		},
		{
			op: "insert",
			tempId: "step",
			parent: { tempId: "t" },
			content: "Add a regression test",
			task: { status: "todo" },
		},
	]);
	const task = r.results[1];
	const step = r.results[3];
	if (!task || !step) throw new Error("seed failed");
	return { space, task, step };
}

export async function claimOf(blockId: string) {
	return (await outlineStore.getTaskClaims([blockId]))[0] ?? null;
}

export async function blockOf(blockId: string) {
	const block = await outlineStore.getBlock(blockId);
	if (!block) throw new Error(`no block ${blockId}`);
	return block;
}

/** What is under a block, in order, as `content` with children. */
export async function treeUnder(spaceId: string, blockId: string): Promise<unknown[]> {
	const rows = await outlineStore.listChildren(spaceId, blockId, 500);
	return await Promise.all(
		rows.map(async (row) => {
			const kids = await treeUnder(spaceId, row.id);
			return kids.length > 0 ? { content: row.content, children: kids } : row.content;
		}),
	);
}

export async function firstUserMessage(narratorId: string): Promise<string> {
	const row = await db.query.narratorMessages.findFirst({
		where: and(eq(narratorMessages.narratorId, narratorId), eq(narratorMessages.role, "user")),
		orderBy: asc(narratorMessages.createdAt),
	});
	return row?.contentText ?? JSON.stringify(row?.contentJson ?? "");
}

export async function taskResult(childId: string) {
	await until(
		async () =>
			(await db.query.backgroundTasks.findFirst({ where: eq(backgroundTasks.id, childId) }))
				?.status === "completed",
		"the background task to complete",
	);
	return (await db.query.backgroundTasks.findFirst({ where: eq(backgroundTasks.id, childId) }))
		?.output as string;
}

/** Let a held claim's lease run out, as a server stopped for a while would. */
export async function expireLease(blockId: string) {
	await db
		.update(outlineTaskClaims)
		.set({ expiresAt: "2000-01-01T00:00:00.000Z" })
		.where(eq(outlineTaskClaims.taskBlockId, blockId));
}

export function gate() {
	return Promise.withResolvers<void>();
}

/** The logical run a subagent's registration names now. */
export function registrationRun(childId: string): string {
	const row = db
		.select({ json: narrators.runtimeRegistrationJson })
		.from(narrators)
		.where(eq(narrators.id, childId))
		.get();
	const id = readRuntimeRegistrationColumn(row?.json)?.run?.logicalRunId;
	if (!id) throw new Error("no run");
	return id;
}
