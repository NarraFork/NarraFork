/**
 * Session import into a real isolated DB (temp NARRAFORK_HOME via the test preload).
 *
 * Covers what the pure parsers cannot: the rows land where the live path would put
 * them, a subagent attaches to its call, compaction limits what the model sees, and
 * the imported history builds a provider request without dangling tool calls.
 */
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { InterchangeSession } from "@shared/session-interchange/model";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import { AnthropicProvider } from "../../lib/agent/anthropic-provider";
import { OpenAIProvider } from "../../lib/agent/openai-provider";
import { eventBus } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import { parseRuntimePolicyTraits } from "../../lib/runtime-policy-trait";
import { sendSubagentMessageDetailed } from "../agent-communication";
import * as inbox from "../agent-runtime/inbox";
import { compileDelegationPolicy, withDelegationDepth } from "../agent-runtime/policy";
import { getCommunicationTopology } from "../narrator-communication/reader";
import { mutateCommunication } from "../narrator-communication/service";
import { narratorService } from "../narrator-service";
import { readSpecFile, writeSpecFile } from "../spec-vfs-service";
import { importInterchangeSession } from "./import";

const TAG = Date.now();
const USER = `import-user-${TAG}`;
const owner = { userId: USER, isAdmin: false };
const topologyOf = (narratorId: string) =>
	getCommunicationTopology({ kind: "narrator", narratorId }, owner);
// 1×1 transparent PNG.
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

beforeAll(async () => {
	await db.insert(users).values({
		id: USER,
		username: USER,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
});

function session(overrides: Partial<InterchangeSession> = {}): InterchangeSession {
	return {
		source: "claude-code",
		externalId: `ext-${TAG}`,
		title: "Imported title",
		cwd: "/tmp",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:10.000Z",
		messages: [
			{
				role: "user",
				timestamp: "2026-01-01T00:00:00.000Z",
				blocks: [
					{ type: "text", text: "look at this" },
					{ type: "image", mediaType: "image/png", data: PNG },
				],
			},
			{
				role: "assistant",
				timestamp: "2026-01-01T00:00:01.000Z",
				model: "claude-x",
				blocks: [
					{
						type: "reasoning",
						text: "thinking",
						signature: { provider: "anthropic", value: "SIG" },
					},
					{ type: "text", text: "checking" },
					{ type: "tool_use", id: `t1-${TAG}`, name: "Bash", input: { command: "ls" } },
					{ type: "tool_use", id: `t2-${TAG}`, name: "Read", input: { file_path: "x" } },
				],
			},
			{
				role: "tool_result",
				timestamp: "2026-01-01T00:00:02.000Z",
				toolUseId: `t1-${TAG}`,
				output: "a.txt",
				isError: false,
			},
			{
				role: "tool_result",
				timestamp: "2026-01-01T00:00:02.000Z",
				toolUseId: `t2-${TAG}`,
				output: "ENOENT",
				isError: true,
			},
			{
				role: "assistant",
				timestamp: "2026-01-01T00:00:03.000Z",
				blocks: [{ type: "text", text: "done" }],
			},
		],
		subagents: [],
		warnings: [],
		...overrides,
	};
}

async function refsOf(narratorId: string) {
	return db
		.select({
			seq: narratorMessageRefs.seq,
			isCompact: narratorMessageRefs.isCompact,
			role: narratorMessages.role,
			contentJson: narratorMessages.contentJson,
			parentToolUseId: narratorMessages.parentToolUseId,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId))
		.orderBy(asc(narratorMessageRefs.seq));
}

async function expectSendByTitleSlug(callerNarratorId: string, slug: string, recipientId: string) {
	const messageId = generateId();
	const toolCallId = generateId();
	const toolUseId = `send-${toolCallId}`;
	const message = `Message to ${slug}`;
	const now = new Date().toISOString();
	db.transaction((tx) => {
		tx.insert(narratorMessages)
			.values({
				id: messageId,
				narratorId: callerNarratorId,
				role: "assistant",
				contentJson: [],
				createdAt: now,
			})
			.run();
		tx.insert(narratorToolCalls)
			.values({
				id: toolCallId,
				narratorId: callerNarratorId,
				messageId,
				toolUseId,
				toolName: "Send",
				executionAttempt: 1,
				executionIdentityVersion: 1,
				status: "running",
				createdAt: now,
			})
			.run();
	});
	// Only suppress model wake-up. Name lookup, ACL, receipt validation and enqueue are real.
	const wake = spyOn(inbox, "wakeInboxIfEligible").mockResolvedValue(false);
	try {
		const result = await sendSubagentMessageDetailed({
			callerNarratorId,
			id: slug,
			message,
			toolUseId,
			toolCallBinding: { toolCallId, attempt: 1 },
			signal: new AbortController().signal,
			locale: "en",
		});
		expect(result.targets).toEqual([
			expect.objectContaining({
				id: recipientId,
				status: "queued",
				deliveryMessageId: expect.any(String),
			}),
		]);
		expect(
			db
				.select()
				.from(narratorBufferedMessages)
				.where(eq(narratorBufferedMessages.sourceToolCallId, toolCallId))
				.all(),
		).toEqual([
			expect.objectContaining({
				narratorId: recipientId,
				sourceNarratorId: callerNarratorId,
				recipientMessageId: result.targets[0]?.deliveryMessageId,
				kind: "agent_message",
				state: "queued",
				text: message,
				createdBy: USER,
			}),
		]);
	} finally {
		wake.mockRestore();
	}
}

describe("importInterchangeSession", () => {
	test("creates a standalone narrator with ordered messages, tool calls and images", async () => {
		const result = await importInterchangeSession(session(), {
			ownerUserId: USER,
			source: { format: "claude-code" },
		});
		const narrator = await narratorService.getById(result.narratorId);
		expect(narrator.title).toBe("Imported title");
		expect(narrator.ownerUserId).toBe(USER);
		expect(narrator.traits).toContain("standalone");
		expect(narrator.traits).toContain("imported");
		expect(narrator.contextProjectId).toBeNull();

		const refs = await refsOf(result.narratorId);
		expect(refs.map((r) => r.role)).toEqual(["user", "assistant", "assistant"]);
		expect(refs.map((r) => r.seq)).toEqual([...refs.map((r) => r.seq)].sort((a, b) => a - b));

		const userBlocks = refs[0]?.contentJson as Array<{ type: string; imageId?: string }>;
		expect(userBlocks.map((b) => b.type)).toEqual(["text", "image"]);
		expect(typeof userBlocks[1]?.imageId).toBe("string");

		const assistant = refs[1]?.contentJson as Array<{ type: string; providerMetadata?: unknown }>;
		expect(assistant.map((b) => b.type)).toEqual(["reasoning", "text", "tool_use", "tool_use"]);
		// No signatureSource: a strict upstream must not be handed a foreign signature.
		expect(assistant[0]?.providerMetadata).toEqual({ anthropic: { signature: "SIG" } });

		const calls = await db
			.select()
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.narratorId, result.narratorId));
		const byName = new Map(calls.map((c) => [c.toolName, c]));
		expect(byName.get("Bash")).toMatchObject({
			status: "success",
			outputJson: "a.txt",
			executionAttempt: 0,
			executionIdentityVersion: 0,
		});
		expect(byName.get("Read")).toMatchObject({ status: "fail", errorMessage: "ENOENT" });
		// Ids are NarraFork's own, and the stored tool_use blocks name the same ids as the rows.
		const blockIds = (assistant as Array<{ type: string; id?: string }>)
			.filter((b) => b.type === "tool_use")
			.map((b) => b.id);
		expect(blockIds).toEqual([byName.get("Bash")?.toolUseId, byName.get("Read")?.toolUseId]);
		for (const id of blockIds) expect(id).toMatch(/^toolu_nfimp_[A-Za-z0-9_-]+$/);
	});

	test("the imported history builds a provider request with every call answered", async () => {
		const result = await importInterchangeSession(session({ externalId: `hist-${TAG}` }), {
			ownerUserId: USER,
			source: { format: "claude-code" },
		});
		const rows = await narratorService.getModelHistorySinceLastCompact(result.narratorId);
		// Adapters are built directly: the test environment has no configured
		// provider, so `buildHistory`'s settings lookup would throw before the
		// adapter under test ever ran.
		const adapters = [
			[
				new AnthropicProvider({
					id: "test-anthropic",
					name: "Test Anthropic",
					prefix: "anthropic",
					apiKey: "test-key",
					baseUrl: "https://example.com/v1",
					defaultModel: "claude-sonnet-4",
					officialApi: false,
				} as unknown as ConstructorParameters<typeof AnthropicProvider>[0]),
				"anthropic:claude-sonnet-4",
			],
			[
				new OpenAIProvider({
					id: "test-openai",
					name: "Test OpenAI",
					prefix: "openai",
					apiKey: "test-key",
					baseUrl: "https://example.com/v1",
					defaultModel: "gpt-4o",
					apiMode: "completions",
				} as unknown as ConstructorParameters<typeof OpenAIProvider>[0]),
				"openai:gpt-4o",
			],
		] as const;
		for (const [adapter, model] of adapters) {
			const built = await adapter.buildHistory(rows, model, result.narratorId);
			const json = JSON.stringify(built.history);
			// Ids were rewritten on import; what matters is that each call still has its answer.
			const ids = (
				await db
					.select({ id: narratorToolCalls.toolUseId })
					.from(narratorToolCalls)
					.where(eq(narratorToolCalls.narratorId, result.narratorId))
			).map((r) => r.id);
			expect(ids).toHaveLength(2);
			for (const id of ids) expect(json.split(id).length - 1).toBeGreaterThanOrEqual(2);
			expect(json).not.toContain(`t1-${TAG}`);
			expect(json).toContain("ENOENT");
			// A signature without a matching source is never replayed to a strict model.
			expect(json).not.toContain('"signature":"SIG"');
		}
	});

	test("compaction becomes the model's starting point", async () => {
		const result = await importInterchangeSession(
			session({
				externalId: `compact-${TAG}`,
				messages: [
					{
						role: "user",
						timestamp: "2026-01-01T00:00:00.000Z",
						blocks: [{ type: "text", text: "old question" }],
					},
					{
						role: "assistant",
						timestamp: "2026-01-01T00:00:01.000Z",
						blocks: [{ type: "text", text: "old answer" }],
					},
					{
						role: "compact",
						timestamp: "2026-01-01T00:00:02.000Z",
						summary: "SUMMARY OF EARLIER WORK",
					},
					{
						role: "user",
						timestamp: "2026-01-01T00:00:03.000Z",
						blocks: [{ type: "text", text: "new question" }],
					},
					{
						role: "assistant",
						timestamp: "2026-01-01T00:00:04.000Z",
						blocks: [{ type: "text", text: "new answer" }],
					},
				],
			}),
			{ ownerUserId: USER, source: { format: "codex" } },
		);
		const refs = await refsOf(result.narratorId);
		expect(refs.map((r) => r.role)).toEqual(["user", "assistant", "system", "user", "assistant"]);
		expect(refs[2]?.isCompact).toBe(1);
		const narrator = await narratorService.getById(result.narratorId);
		expect(narrator.contextSummary).toBe("SUMMARY OF EARLIER WORK");

		const history = await narratorService.getModelHistorySinceLastCompact(result.narratorId);
		const text = JSON.stringify(history);
		expect(text).not.toContain("old question");
		expect(text).toContain("new question");
	});

	test("attaches a subagent narrator to its Agent call", async () => {
		const callId = `agent-call-${TAG}`;
		const changes: string[][] = [];
		const onDirty = ({ narratorIds }: { narratorIds: string[] }) => {
			changes.push(narratorIds);
		};
		eventBus.on("narrator:communication_changed", onDirty);
		const result = await importInterchangeSession(
			session({
				externalId: `sub-${TAG}`,
				messages: [
					{
						role: "user",
						timestamp: "2026-01-01T00:00:00.000Z",
						blocks: [{ type: "text", text: "delegate" }],
					},
					{
						role: "assistant",
						timestamp: "2026-01-01T00:00:01.000Z",
						blocks: [
							{
								type: "tool_use",
								id: callId,
								name: "Agent",
								input: { prompt: "look", subagent_type: "Explore" },
								subagentRef: "ext-sub",
							},
						],
					},
					{
						role: "tool_result",
						timestamp: "2026-01-01T00:00:05.000Z",
						toolUseId: callId,
						output: "found it",
						isError: false,
					},
					{
						role: "assistant",
						timestamp: "2026-01-01T00:00:06.000Z",
						blocks: [{ type: "text", text: "thanks" }],
					},
				],
				subagents: [
					{
						ref: "ext-sub",
						parentToolUseId: callId,
						subagentType: "Explore",
						title: "Review API",
						messages: [
							{
								role: "user",
								timestamp: "2026-01-01T00:00:01.100Z",
								blocks: [{ type: "text", text: "look" }],
							},
							{
								role: "assistant",
								timestamp: "2026-01-01T00:00:04.000Z",
								blocks: [{ type: "text", text: "found it" }],
							},
						],
					},
				],
			}),
			{ ownerUserId: USER, source: { format: "claude-code" } },
		).finally(() => eventBus.off("narrator:communication_changed", onDirty));
		expect(result.subagentIds).toHaveLength(1);
		const subId = result.subagentIds[0] ?? "";
		expect(changes.filter((ids) => ids.includes(subId))).toEqual([[result.narratorId, subId]]);
		const [sub] = await db.select().from(narrators).where(eq(narrators.id, subId));
		const [call] = await db
			.select()
			.from(narratorToolCalls)
			.where(
				and(
					eq(narratorToolCalls.narratorId, result.narratorId),
					eq(narratorToolCalls.toolName, "Agent"),
				),
			);
		expect(sub).toMatchObject({
			type: "subagent",
			subagentType: "explore",
			variant: "subagent:explore",
			parentNarratorId: result.narratorId,
			originToolCallId: call?.id,
			aclRootNarratorId: result.narratorId,
			ownerUserId: USER,
			status: "idle",
		});
		// The row itself carries the compiled template ceiling and its relationships, like a
		// live delegation — nothing relies on the legacy compile-on-read fallback.
		expect(parseRuntimePolicyTraits(sub?.traits)).toEqual([
			withDelegationDepth(compileDelegationPolicy({ template: "explore" }), 1),
		]);
		expect(sub?.policySourceNarratorId).toBe(result.narratorId);
		expect(sub?.runtimeRegistrationJson).toMatchObject({
			modelPool: "explore",
			controller: { narratorId: result.narratorId },
		});
		const subRefs = await refsOf(subId);
		expect(subRefs.map((r) => r.role)).toEqual(["user", "assistant"]);
		expect(call?.toolUseId).not.toBe(callId);
		expect(subRefs.every((r) => r.parentToolUseId === call?.toolUseId)).toBe(true);
		expect(result.messageCount).toBe(5);

		// The parent's document page resolves the child through the Agent call; an
		// import the UI cannot see would look like a lost subagent.
		const page = await narratorService.getPretextDocumentPage(result.narratorId);
		expect(JSON.stringify(page)).toContain(subId);

		const graph = await topologyOf(subId);
		expect(graph.nodes).toEqual([
			expect.objectContaining({
				id: subId,
				parentNarratorId: result.narratorId,
				restoreParentId: result.narratorId,
				groupId: result.narratorId,
				canManage: true,
			}),
			expect.objectContaining({ id: result.narratorId, parentNarratorId: null }),
		]);
		expect(graph.peers).toEqual([]);
		await expectSendByTitleSlug(result.narratorId, "review-api", subId);
		expect(sub).toMatchObject({ title: "Review API", titleSlug: "review-api" });
		const peer = await narratorService.create({ ownerUserId: USER });
		expect(
			await mutateCommunication(subId, owner, { kind: "connect", targetNarratorId: peer.id }),
		).toEqual({ changed: true });
	});

	test("does not grant communication inheritance to a historical non-Agent tool reference", async () => {
		const result = await importInterchangeSession(
			session({
				subagents: [{ ref: "not-an-agent", parentToolUseId: `t1-${TAG}`, messages: [] }],
			}),
			{ ownerUserId: USER, source: { format: "claude-code" } },
		);
		expect(result.subagentIds).toHaveLength(1);
		const subId = result.subagentIds[0] ?? "";
		expect(await narratorService.getById(subId)).toMatchObject({
			type: "subagent",
			parentNarratorId: result.narratorId,
			aclRootNarratorId: result.narratorId,
		});
		const graph = await topologyOf(subId);
		expect(graph.nodes).toEqual([
			expect.objectContaining({
				id: subId,
				groupId: subId,
				parentNarratorId: null,
				restoreParentId: null,
			}),
		]);
		expect(graph.peers).toEqual([]);
	});

	test("a primary extracted from a connected subagent immediately has its own communication root", async () => {
		const parent = await narratorService.create({
			ownerUserId: USER,
			cwd: "/tmp",
			model: "openai:parent-model",
			taskBackend: "spec",
		});
		const source = await narratorService.createSubagent({
			parentNarratorId: parent.id,
			subagentType: "general",
			title: "Original Research",
			subagentOriginKind: "standalone",
			cwd: "/tmp",
			runtimePolicy: { version: 1 },
		});
		const peer = await narratorService.create({ ownerUserId: USER });
		expect(
			await mutateCommunication(source.id, owner, { kind: "connect", targetNarratorId: peer.id }),
		).toEqual({ changed: true });
		const taskUri = "spec://tasks.json";
		const originalTasks = await writeSpecFile(
			source.id,
			taskUri,
			JSON.stringify({ tasks: [{ text: "Preserve this task", status: "todo" }] }),
		);
		const historyId = generateId();
		db.transaction((tx) => {
			tx.insert(narratorMessages)
				.values({
					id: historyId,
					narratorId: source.id,
					role: "assistant",
					contentJson: [{ type: "text", text: "Keep the original research history" }],
					createdAt: new Date().toISOString(),
				})
				.run();
			tx.insert(narratorMessageRefs)
				.values({ id: generateId(), narratorId: source.id, messageId: historyId, seq: 0 })
				.run();
		});
		const originalRefs = await refsOf(source.id);
		expect(originalRefs).toHaveLength(1);
		const originalGraph = await topologyOf(source.id);
		const extracted = await narratorService.extractSubagentToPrimary(source.id, {
			title: "Release Review Notes",
		});

		const graph = await topologyOf(extracted.id);
		expect(graph.nodes).toEqual([
			expect.objectContaining({
				id: extracted.id,
				parentNarratorId: null,
				restoreParentId: null,
				groupId: extracted.id,
				canManage: true,
			}),
		]);
		expect(graph.peers).toEqual([]);
		expect(
			await mutateCommunication(extracted.id, owner, {
				kind: "connect",
				targetNarratorId: peer.id,
			}),
		).toEqual({ changed: true });
		await expectSendByTitleSlug(peer.id, "release-review-notes", extracted.id);
		expect(db.select().from(narrators).where(eq(narrators.id, extracted.id)).get()).toMatchObject({
			title: "Release Review Notes",
			titleSlug: "release-review-notes",
		});
		expect(await topologyOf(source.id)).toEqual(originalGraph);
		expect(await refsOf(source.id)).toEqual(originalRefs);
		expect(await narratorService.getById(source.id)).toMatchObject({
			title: "Original Research",
			titleSlug: "original-research",
			type: "subagent",
			parentNarratorId: parent.id,
			aclRootNarratorId: parent.id,
			taskBackend: "spec",
		});
		expect(extracted).toMatchObject({
			type: "primary",
			parentNarratorId: null,
			taskBackend: "spec",
		});
		expect(await readSpecFile(source.id, taskUri)).toMatchObject({
			revisionId: originalTasks.revisionId,
			content: originalTasks.content,
		});
		expect((await readSpecFile(extracted.id, taskUri)).content).toBe(originalTasks.content);
	});

	test("importing the same session twice shares no tool ids, so neither sees the other's subagent", async () => {
		const callId = `dup-call-${TAG}`;
		const dup = session({
			externalId: `dup-${TAG}`,
			messages: [
				{
					role: "user",
					timestamp: "2026-01-01T00:00:00.000Z",
					blocks: [{ type: "text", text: "go" }],
				},
				{
					role: "assistant",
					timestamp: "2026-01-01T00:00:01.000Z",
					blocks: [
						{
							type: "tool_use",
							id: callId,
							name: "Agent",
							input: { prompt: "look" },
							subagentRef: "s",
						},
					],
				},
				{
					role: "tool_result",
					timestamp: "2026-01-01T00:00:02.000Z",
					toolUseId: callId,
					output: "done",
					isError: false,
				},
				{
					role: "assistant",
					timestamp: "2026-01-01T00:00:03.000Z",
					blocks: [{ type: "text", text: "ok" }],
				},
			],
			subagents: [
				{
					ref: "s",
					parentToolUseId: callId,
					messages: [
						{
							role: "user",
							timestamp: "2026-01-01T00:00:01.100Z",
							blocks: [{ type: "text", text: "look" }],
						},
						{
							role: "assistant",
							timestamp: "2026-01-01T00:00:01.500Z",
							blocks: [{ type: "text", text: "child report" }],
						},
					],
				},
			],
		});
		const first = await importInterchangeSession(dup, {
			ownerUserId: USER,
			source: { format: "claude-code" },
		});
		const second = await importInterchangeSession(dup, {
			ownerUserId: USER,
			source: { format: "claude-code" },
		});

		const callOf = async (narratorId: string) =>
			(
				await db
					.select({ toolUseId: narratorToolCalls.toolUseId })
					.from(narratorToolCalls)
					.where(eq(narratorToolCalls.narratorId, narratorId))
			)[0]?.toolUseId;
		const a = await callOf(first.narratorId);
		const b = await callOf(second.narratorId);
		expect(a).toBeDefined();
		expect(a).not.toBe(b);

		// The global lookup that exports and revert rely on now has exactly one owner.
		const childrenOfA = await db
			.select({ narratorId: narratorMessages.narratorId })
			.from(narratorMessages)
			.where(eq(narratorMessages.parentToolUseId, a ?? ""));
		expect(childrenOfA.length).toBe(2);
		expect(new Set(childrenOfA.map((r) => r.narratorId))).toEqual(new Set(first.subagentIds));

		// And the transcript export of one does not pick up the other's child report twice.
		const { streamNarratorExport } = await import("../narrator-export");
		let markdown = "";
		for await (const chunk of streamNarratorExport(first.narratorId, {
			format: "markdown",
			scope: "full",
			includeToolIO: true,
			lang: "en",
		})) {
			markdown += chunk;
		}
		expect(markdown.split("child report").length - 1).toBe(1);
	});
	test("an empty session is rejected without creating a narrator", async () => {
		const before = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(eq(narrators.ownerUserId, USER));
		await expect(
			importInterchangeSession(session({ messages: [] }), {
				ownerUserId: USER,
				source: { format: "codex" },
			}),
		).rejects.toThrow("no messages");
		const after = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(eq(narrators.ownerUserId, USER));
		expect(after.length).toBe(before.length);
	});

	test("a failure mid-import removes the half-built narrator", async () => {
		const before = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(eq(narrators.ownerUserId, USER));
		const broken = session({ externalId: `broken-${TAG}` });
		// A duplicate tool_use id violates nothing in the parser but collides on insert
		// only if the row id is reused; force a failure through an unserializable input.
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const assistant = broken.messages[1];
		if (assistant?.role === "assistant") {
			assistant.blocks.push({ type: "tool_use", id: `bad-${TAG}`, name: "Bash", input: circular });
		}
		await expect(
			importInterchangeSession(broken, { ownerUserId: USER, source: { format: "claude-code" } }),
		).rejects.toThrow();
		const after = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(eq(narrators.ownerUserId, USER));
		expect(after.length).toBe(before.length);
	});
});
