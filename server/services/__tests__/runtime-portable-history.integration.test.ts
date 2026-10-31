import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InterchangeSession } from "@shared/session-interchange/model";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cleanDb } from "../../../tests/setup";
import {
	fileChangeExecutionSegments,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import { AnthropicProvider } from "../../lib/agent/anthropic-provider";
import type { ChatParams, ParsedStreamEvent, ProviderAdapter } from "../../lib/agent/provider";

// The snapshot worker shares the preload-isolated file-backed database.
const { db, sqlite } = await import("../../db");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const { toolRegistry } = await import("../../lib/agent/tool-registry");
const { settings } = await import("../../lib/settings");
const { startNarratorRun } = await import("../agent-runtime/run");
const { getExecutionOwner, getRunControl } = await import("../agent-runtime/ownership");
const { enqueueInboxAgent } = await import("../agent-runtime/inbox");
const { createAgentMessageDelivery } = await import("../agent-message-delivery");
const { activeNarrators } = await import("../narrator-session-state");
const { readSessionDeliverTo } = await import("../narrator-session");
const { narratorRoutes } = await import("../../routes/narrators");
const { importInterchangeSession } = await import("../session-interchange/import");
const { narratorService } = await import("../narrator-service");
const { materializeLegacyDelegations } = await import("../legacy-delegation-materializer");
const { narratorToInterchange } = await import("../session-interchange/export");
const { NARRATOR_EXPORT_DEFAULTS, streamNarratorExport, resolveTranscriptScope } = await import(
	"../narrator-export"
);
const { estimateNarratorBuildHistoryTokens } = await import("../narrator-history-token-estimate");

const MODEL = "portablehistory:model";
const TOOL = "PortableHistoryBoundary";
const NOW = "2026-10-01T00:00:00.000Z";
let cwd: string;
let ids: string[] = [];
let requests: string[] = [];
let builtHistories: string[] = [];
let principals: Array<string | null | undefined> = [];
let script: (params: ChatParams, index: number) => AsyncGenerator<ParsedStreamEvent>;
const base = new AnthropicProvider({
	id: "portablehistory",
	name: "Portable history",
	prefix: "portablehistory",
	apiKey: "unused",
	baseUrl: "https://example.invalid",
	defaultModel: "model",
});
const provider: ProviderAdapter = {
	formatTools: base.formatTools.bind(base),
	buildHistory: async (...args) => {
		const result = await base.buildHistory(...args);
		builtHistories.push(JSON.stringify(result.history));
		return result;
	},
	injectSystemPrompt: base.injectSystemPrompt.bind(base),
	async *chat(params) {
		params.onRequestStart?.();
		principals.push(getRunControl("recipient")?.principal);
		requests.push(
			JSON.stringify({
				content: params.content,
				history: params.history,
				toolResults: params.toolResults,
			}),
		);
		yield* script(params, requests.length - 1);
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const unregister = registerExternalProviderResolver({
	resolve: (prefix) => (prefix === "portablehistory" ? provider : null),
	listReadiness: () => [],
});
toolRegistry.register({
	name: TOOL,
	description: "No-I/O boundary probe",
	parameters: z.object({}),
	execute: async () => ({ output: "boundary completed" }),
});
beforeEach(async () => {
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	cwd = mkdtempSync(join(tmpdir(), "nf-portable-history-"));
	ids = [];
	requests = [];
	builtHistories = [];
	principals = [];
	settings.agent.autoContinuationMode = "off";
	script = async function* () {
		yield { text: "finished" };
	};
	db.insert(users)
		.values(
			["owner", "sender-user"].map((id) => ({
				id,
				username: id,
				passwordHash: "x",
				createdAt: NOW,
			})),
		)
		.run();
});
afterEach(async () => {
	for (const id of ids) {
		getExecutionOwner(id)?.release();
		activeNarrators.delete(id);
	}
	rmSync(cwd, { recursive: true, force: true });
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
});
afterAll(async () => {
	await closePrefixSnapshotStore();
	unregister();
	toolRegistry.unregister(TOOL);
});
function narrator(id: string, extra: Partial<typeof narrators.$inferInsert> = {}) {
	ids.push(id);
	db.insert(narrators)
		.values({
			id,
			ownerUserId: "owner",
			cwd,
			model: MODEL,
			permissionMode: "bypassPermissions",
			autoContinuationOverride: "off",
			runtimeRegistrationJson: { version: 1 },
			createdAt: NOW,
			updatedAt: NOW,
			...extra,
		})
		.run();
}
function history(id: string, placement: string) {
	for (const [index, role, text] of [
		[0, "user", "prior user"],
		[1, "assistant", "prior assistant"],
		[2, "assistant", "prior finish"],
	] as const) {
		const messageId = `${id}-history-${index}`;
		db.insert(narratorMessages)
			.values({
				id: messageId,
				narratorId: id,
				role,
				parentToolUseId: placement,
				contentText: text,
				contentJson: [
					{ type: "text", text },
					...(index === 1
						? [
								{
									type: "tool_use",
									id: `${id}-tool-use`,
									name: "Read",
									input: { file_path: "old.txt" },
								},
							]
						: []),
				],
				createdAt: NOW,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: `${messageId}-ref`, narratorId: id, messageId, seq: index })
			.run();
		if (index === 1)
			db.insert(narratorToolCalls)
				.values({
					id: `${id}-tool-call`,
					narratorId: id,
					messageId,
					toolUseId: `${id}-tool-use`,
					toolName: "Read",
					inputJson: { file_path: "old.txt" },
					outputJson: "prior tool output",
					status: "success",
					createdAt: NOW,
				})
				.run();
	}
}
async function run(id: string, binding?: Parameters<typeof startNarratorRun>[0]["binding"]) {
	const handle = await startNarratorRun({
		narratorId: id,
		locale: "en",
		text: "continue",
		principal: "owner",
		binding,
		deliver: false,
	});
	expect(handle.started).toBe(true);
	const result = await handle.completion;
	expect(result.hasError).toBe(false);
	expect(requests.length).toBeGreaterThan(0);
}
function expectPriorHistory(request: string) {
	for (const text of ["prior user", "prior assistant", "prior tool output", "prior finish"])
		expect(request).toContain(text);
}
async function expectHistoryEstimate(id: string) {
	const estimate = await estimateNarratorBuildHistoryTokens(id, "en");
	expect(estimate?.promptTokens).toBeGreaterThan(0);
	expectPriorHistory(builtHistories[builtHistories.length - 1]);
}
async function expectExports(id: string) {
	for (const format of ["markdown", "json"] as const) {
		let output = "";
		for await (const chunk of streamNarratorExport(id, {
			...NARRATOR_EXPORT_DEFAULTS,
			format,
			scope: "full",
		}))
			output += chunk;
		expectPriorHistory(output);
		expect(output).not.toContain("unrelated nested transcript");
	}
	const interchange = JSON.stringify(await narratorToInterchange(id));
	expectPriorHistory(interchange);
	expect(interchange).not.toContain("unrelated nested transcript");
}
test("materialized legacy standalone continues through real executor/provider with its mounted history and no delivery target", async () => {
	narrator("parent");
	narrator("worker", {
		type: "subagent",
		variant: "subagent:general",
		parentNarratorId: "parent",
		runtimeRegistrationJson: null,
	});
	history("worker", "standalone-worker");
	expect(await materializeLegacyDelegations(["worker"])).toBe(1);
	await expectExports("worker");
	expect(await readSessionDeliverTo("worker")).toBeUndefined();
	await run("worker");
	expectPriorHistory(requests[0]);
	await expectHistoryEstimate("worker");
	expect(await readSessionDeliverTo("worker")).toBeUndefined();
});
test("imported mounted history remains visible in its document page and first real continuation", async () => {
	const messages: InterchangeSession["messages"] = [
		{ role: "user", timestamp: NOW, blocks: [{ type: "text", text: "prior user" }] },
		{
			role: "assistant",
			timestamp: NOW,
			blocks: [
				{ type: "text", text: "prior assistant" },
				{ type: "tool_use", id: "old-read", name: "Read", input: { file_path: "old.txt" } },
			],
		},
		{
			role: "tool_result",
			timestamp: NOW,
			toolUseId: "old-read",
			output: "prior tool output",
			isError: false,
		},
		{ role: "assistant", timestamp: NOW, blocks: [{ type: "text", text: "prior finish" }] },
	];
	const imported = await importInterchangeSession(
		{
			source: "claude-code",
			externalId: "external-import",
			createdAt: NOW,
			updatedAt: NOW,
			messages: [
				{ role: "user", timestamp: NOW, blocks: [{ type: "text", text: "delegate" }] },
				{
					role: "assistant",
					timestamp: NOW,
					blocks: [{ type: "tool_use", id: "agent", name: "Agent", input: {} }],
				},
			],
			subagents: [{ ref: "sub", parentToolUseId: "agent", messages }],
			warnings: [],
		},
		{ ownerUserId: "owner", cwd, model: MODEL, source: { format: "claude-code" } },
	);
	ids.push(imported.narratorId, ...imported.subagentIds);
	const child = imported.subagentIds[0];
	if (!child) throw new Error("Missing imported child");
	await db
		.update(narrators)
		.set({ model: MODEL, autoContinuationOverride: "off", permissionMode: "bypassPermissions" })
		.where(eq(narrators.id, child));
	expect(await readSessionDeliverTo(child)).toBeUndefined();
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: "owner", role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.route("/narrators", narratorRoutes);
	const response = await app.request(`http://localhost/narrators/${child}/pretext-document`);
	expect(response.status).toBe(200);
	const page = JSON.stringify(await response.json());
	for (const text of ["prior user", "prior assistant", "prior tool output", "prior finish"])
		expect(page).toContain(text);
	expect((await narratorService.getById(child)).runtimeRegistrationJson).toHaveProperty(
		"historyPlacement",
	);
	await expectExports(child);
	db.insert(narratorMessages)
		.values({
			id: "new-agent-message",
			narratorId: imported.narratorId,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "new-use", name: "Agent", input: {} }],
			createdAt: NOW,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({
			id: "new-agent-ref",
			narratorId: imported.narratorId,
			messageId: "new-agent-message",
			seq: 100,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: "new-agent-call",
			narratorId: imported.narratorId,
			messageId: "new-agent-message",
			toolUseId: "new-use",
			toolName: "Agent",
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			createdAt: NOW,
		})
		.run();
	const binding = {
		deliverTo: {
			narratorId: imported.narratorId,
			toolUseId: "new-use",
			toolCallId: "new-agent-call",
			attempt: 1,
		},
		principal: { userId: "owner" },
	};
	await Bun.write(join(cwd, "new.txt"), "boundary completed");
	script = async function* (_params, index) {
		if (index === 0) {
			yield { text: "new assistant with tool" };
			yield {
				toolUses: [
					{ toolUseId: "new-boundary", name: "Read", input: { file_path: join(cwd, "new.txt") } },
				],
			};
		} else yield { text: "new finished answer" };
	};
	await run(child, binding);
	await run(child);
	expectPriorHistory(requests[0]);
	expectPriorHistory(requests[requests.length - 1]);
	for (const text of ["new assistant with tool", "boundary completed", "new finished answer"])
		expect(requests[requests.length - 1]).toContain(text);
	await expectHistoryEstimate(child);
	const refreshed = await app.request(`http://localhost/narrators/${child}/pretext-document`);
	const refreshedPage = JSON.stringify(await refreshed.json());
	expectPriorHistory(refreshedPage);
	for (const text of ["new assistant with tool", "boundary completed", "new finished answer"])
		expect(refreshedPage).toContain(text);
	await expectExports(child);
	for (const format of ["markdown", "json"] as const) {
		let output = "";
		for await (const chunk of streamNarratorExport(child, {
			...NARRATOR_EXPORT_DEFAULTS,
			format,
			scope: "full",
		}))
			output += chunk;
		for (const text of ["new assistant with tool", "boundary completed", "new finished answer"])
			expect(output).toContain(text);
	}
	expect(
		(await narratorService.getById(child)).runtimeRegistrationJson?.historyPlacement?.toolUseId,
	).not.toBe("new-use");
	expect(await readSessionDeliverTo(child)).toMatchObject({ toolUseId: "new-use" });
});
test("ordinary session export uses its historical mount, not its variant, including the visible compact probe", async () => {
	narrator("ordinary", {
		runtimeRegistrationJson: { version: 1, historyPlacement: { toolUseId: "historical-mount" } },
	});
	history("ordinary", "historical-mount");
	for (const [index, parentToolUseId, text, isCompact] of [
		[3, "nested-mount", "unrelated nested transcript", 0],
		[4, "historical-mount", "compact marker", 1],
		[5, "historical-mount", "after compact", 0],
	] as const) {
		const id = `ordinary-extra-${index}`;
		db.insert(narratorMessages)
			.values({
				id,
				narratorId: "ordinary",
				role: "user",
				parentToolUseId,
				contentText: text,
				contentJson: [{ type: "text", text }],
				createdAt: NOW,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: `${id}-ref`, narratorId: "ordinary", messageId: id, seq: index, isCompact })
			.run();
	}
	await expectExports("ordinary");
	expect((await resolveTranscriptScope("ordinary", "visible")).earlierHistoryOmitted).toBe(true);
});

async function send(text: string, index: number) {
	const id = `send-${index}`;
	db.insert(narratorMessages)
		.values({ id, narratorId: "sender", role: "assistant", contentJson: [], createdAt: NOW })
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: `${id}-ref`, narratorId: "sender", messageId: id, seq: index })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: `${id}-call`,
			narratorId: "sender",
			messageId: id,
			toolUseId: `${id}-use`,
			toolName: "Send",
			status: "running",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			executionSegmentId: `${id}-segment`,
			createdAt: NOW,
		})
		.run();
	db.insert(fileChangeExecutionSegments)
		.values({
			id: `${id}-segment`,
			narratorId: "sender",
			sourceToolCallId: `${id}-call`,
			sourceExecutionAttempt: 1,
			createdAt: NOW,
		})
		.run();
	const delivery = createAgentMessageDelivery(
		"recipient",
		{ id: "sender", title: "Sender", label: "sender", type: "general", isParent: false },
		`${id}-use`,
		text,
		{ toolCallId: `${id}-call`, attempt: 1 },
	);
	await enqueueInboxAgent(delivery, delivery.text, { userId: "sender-user", createdBy: null });
}
for (const delegated of [false, true])
	test(`real executor → loop → provider adopts Send at two consecutive boundaries (${delegated ? "delegated" : "unrelated"})`, async () => {
		narrator("sender");
		narrator("caller");
		db.insert(narratorMessages)
			.values({
				id: "origin-message",
				narratorId: "caller",
				role: "assistant",
				contentJson: [{ type: "tool_use", id: "origin-use", name: "Agent", input: {} }],
				createdAt: NOW,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: "origin-ref", narratorId: "caller", messageId: "origin-message", seq: 0 })
			.run();
		db.insert(narratorToolCalls)
			.values({
				id: "origin-call",
				narratorId: "caller",
				messageId: "origin-message",
				toolUseId: "origin-use",
				toolName: "Agent",
				status: "running",
				executionIdentityVersion: 1,
				executionAttempt: 1,
				createdAt: NOW,
			})
			.run();
		narrator(
			"recipient",
			delegated
				? { type: "subagent", variant: "subagent:general", parentNarratorId: "caller" }
				: {},
		);
		script = async function* (_params, index) {
			if (index < 2) {
				await send(index === 0 ? "first report" : "second report", index);
				yield { toolUses: [{ toolUseId: `boundary-${index}`, name: TOOL, input: {} }] };
			} else yield { text: "finished" };
		};
		await run("recipient", {
			deliverTo: {
				narratorId: "caller",
				toolUseId: "origin-use",
				toolCallId: "origin-call",
				attempt: 1,
			},
			principal: { userId: "owner" },
		});
		expect(requests[1]).toContain("first report");
		expect(requests[1]).not.toContain("second report");
		expect(requests[2]).toContain("second report");
		expect(requests).toHaveLength(3);
		expect(principals).toEqual(["owner", "owner", "owner"]);
		const rows = db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.narratorId, "recipient"))
			.all();
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.state).toBe("materialized");
			expect(row.adoptedRevision).toBe(1);
			expect(row.adoptedAt).not.toBeNull();
			expect(row.recipientMessageId).not.toBeNull();
		}
	});
