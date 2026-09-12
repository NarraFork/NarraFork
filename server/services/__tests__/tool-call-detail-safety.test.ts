import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { testEnvironment } from "../../../tests/preload";
import { db, sqlite } from "../../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import { AppError, NotFoundError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { narratorRoutes } from "../../routes/narrators";
import { narratorPersistence } from "../narrator-persistence";
import { narratorService } from "../narrator-service";
import {
	clearTakenOver,
	getConclusionWatcher,
	isTakenOver,
	markTakenOver,
	registerConclusionWatcher,
	removeConclusionWatcher,
} from "../narrator-subagent";
import * as subagentFileChanges from "../subagent-file-changes";

const createdUsers: string[] = [];
const createdNarrators: string[] = [];
const now = "2026-09-07T00:00:00.000Z";

function user() {
	const id = generateId();
	db.insert(users)
		.values({
			id,
			username: `detail-${id}`,
			passwordHash: "test-only",
			role: "user",
			createdAt: now,
		})
		.run();
	createdUsers.push(id);
	return id;
}

function narrator(ownerUserId = user()) {
	const id = generateId();
	db.insert(narrators)
		.values({ id, ownerUserId, visibility: "private", createdAt: now, updatedAt: now })
		.run();
	createdNarrators.push(id);
	return { id, ownerUserId };
}

function tool(
	narratorId: string,
	toolUseId: string,
	opts?: {
		toolName?: string;
		parentToolUseId?: string;
		inputJson?: unknown;
		outputJson?: unknown;
	},
) {
	const messageId = generateId();
	const id = generateId();
	db.insert(narratorMessages)
		.values({
			id: messageId,
			narratorId,
			parentToolUseId: opts?.parentToolUseId ?? null,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: toolUseId, name: opts?.toolName ?? "Write" }],
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId, messageId, seq: createdNarrators.length })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id,
			narratorId,
			messageId,
			toolUseId,
			toolName: opts?.toolName ?? "Write",
			inputJson: opts?.inputJson ?? { content: "allowed input" },
			outputJson: opts?.outputJson ?? { content: "allowed output" },
			executionIdentityVersion: 1,
			status: "success",
			createdAt: now,
		})
		.run();
	return { id, messageId, toolUseId, narratorId };
}

function child(parent: ReturnType<typeof narrator>, parentTool: ReturnType<typeof tool>) {
	const record = narrator(parent.ownerUserId);
	db.update(narrators)
		.set({
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: parent.id,
			originToolCallId: parentTool.id,
		})
		.where(eq(narrators.id, record.id))
		.run();
	return record;
}

function share(messageId: string, narratorId: string) {
	db.insert(narratorMessageRefs).values({ id: generateId(), narratorId, messageId, seq: 1 }).run();
}

function removeRef(messageId: string, narratorId: string) {
	db.delete(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.messageId, messageId),
				eq(narratorMessageRefs.narratorId, narratorId),
			),
		)
		.run();
}

/** Observe actual SQLite projections, not a stubbed replacement service. */
function traceToolReads() {
	const queries: string[] = [];
	const prepare = sqlite.prepare.bind(sqlite);
	spyOn(sqlite, "prepare").mockImplementation((...args: Parameters<typeof sqlite.prepare>) => {
		queries.push(args[0]);
		return prepare(...args);
	});
	return {
		queries,
		payloadReads: () =>
			queries.filter((query) => query.includes('"input_json"') && !query.includes("octet_length")),
	};
}

function appFor(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) =>
		Response.json(
			{ error: error.message, code: error instanceof AppError ? error.code : "INTERNAL_ERROR" },
			{ status: error instanceof AppError ? error.statusCode : 500 },
		),
	);
	app.route("/api/narrators", narratorRoutes);
	return app;
}

function forgedForeignTool() {
	expect(process.env.HOME).toBe(testEnvironment.isolatedHome);
	expect(process.env.NARRAFORK_HOME).toBe(testEnvironment.narraforkHome);
	const own = narrator();
	const foreign = narrator();
	const parent = tool(own.id, "reused-parent-provider-id", { toolName: "Agent" });
	const secret = tool(foreign.id, "foreign-secret-tool", {
		parentToolUseId: parent.toolUseId,
		inputJson: { secret: "FOREIGN_INPUT_SECRET" },
		outputJson: { secret: "FOREIGN_OUTPUT_SECRET" },
	});
	return { own, foreign, parent, secret };
}

describe("outbound history aggregation respects narrator boundaries", () => {
	for (const surface of ["page", "catch-up", "anchor"] as const) {
		test(`${surface} does not load a foreign primary as inline child text or tool IO`, async () => {
			const own = narrator();
			const foreign = narrator();
			const boundary = tool(own.id, "boundary");
			const parent = tool(own.id, "reused-inline-parent", { toolName: "Read" });
			db.update(narratorMessageRefs)
				.set({ seq: 1 })
				.where(eq(narratorMessageRefs.messageId, boundary.messageId))
				.run();
			db.update(narratorMessageRefs)
				.set({ seq: 2 })
				.where(eq(narratorMessageRefs.messageId, parent.messageId))
				.run();
			const secret = tool(foreign.id, "secret-child", {
				parentToolUseId: parent.toolUseId,
				inputJson: { secret: "FOREIGN_INLINE_INPUT" },
				outputJson: { secret: "FOREIGN_INLINE_OUTPUT" },
			});
			db.update(narratorMessages)
				.set({ contentText: "FOREIGN_INLINE_BODY" })
				.where(eq(narratorMessages.id, secret.messageId))
				.run();
			const result =
				surface === "page"
					? await narratorService.getPretextDocumentPage(own.id, { limit: 20 })
					: await narratorService.getMessagesAfter(own.id, {
							parentLastMessageId: surface === "catch-up" ? boundary.messageId : parent.messageId,
							...(surface === "anchor"
								? { childAnchors: [{ parentToolUseId: parent.toolUseId, narratorId: foreign.id }] }
								: {}),
						});
			const output = JSON.stringify(result);
			for (const value of [
				foreign.id,
				secret.id,
				secret.messageId,
				"FOREIGN_INLINE_BODY",
				"FOREIGN_INLINE_INPUT",
				"FOREIGN_INLINE_OUTPUT",
			])
				expect(output).not.toContain(value);
		});

		test(`${surface} does not classify a foreign primary as a subagent activity owner`, async () => {
			const own = narrator();
			const foreign = narrator();
			const boundary = tool(own.id, "activity-boundary");
			const parent = tool(own.id, "reused-agent-parent", { toolName: "Agent" });
			db.update(narratorMessageRefs)
				.set({ seq: 1 })
				.where(eq(narratorMessageRefs.messageId, boundary.messageId))
				.run();
			db.update(narratorMessageRefs)
				.set({ seq: 2 })
				.where(eq(narratorMessageRefs.messageId, parent.messageId))
				.run();
			const secret = tool(foreign.id, "foreign-activity-tool", {
				parentToolUseId: parent.toolUseId,
				inputJson: { file_path: "/private/FOREIGN_ACTIVITY_PATH" },
			});
			const result =
				surface === "page"
					? await narratorService.getPretextDocumentPage(own.id, { limit: 20 })
					: await narratorService.getMessagesAfter(own.id, {
							parentLastMessageId: surface === "catch-up" ? boundary.messageId : parent.messageId,
							...(surface === "anchor"
								? { childAnchors: [{ parentToolUseId: parent.toolUseId }] }
								: {}),
						});
			const output = JSON.stringify(result);
			for (const value of [foreign.id, secret.id, secret.toolUseId, "FOREIGN_ACTIVITY_PATH"])
				expect(output).not.toContain(value);
		});
	}
});

describe("outbound aggregation positive scope and metadata budgets", () => {
	test("caller-referenced inline rows survive paging, shared prefixes and cursor catch-up", async () => {
		const own = narrator();
		const parent = tool(own.id, "visible-inline", { toolName: "Read" });
		const inline = tool(own.id, "visible-inline-tool", { parentToolUseId: parent.toolUseId });
		db.update(narratorMessageRefs)
			.set({ seq: 1 })
			.where(eq(narratorMessageRefs.messageId, parent.messageId))
			.run();
		db.update(narratorMessageRefs)
			.set({ seq: 2 })
			.where(eq(narratorMessageRefs.messageId, inline.messageId))
			.run();
		const foreign = narrator();
		tool(foreign.id, "foreign-inline", { parentToolUseId: parent.toolUseId });
		const fork = narrator(own.ownerUserId);
		share(parent.messageId, fork.id);
		share(inline.messageId, fork.id);
		const page = await narratorService.getPretextDocumentPage(fork.id, { limit: 20 });
		expect(JSON.stringify(page)).toContain(inline.messageId);
		expect(JSON.stringify(page)).not.toContain(foreign.id);
		const catchUp = await narratorService.getMessagesAfter(own.id, {
			parentLastMessageId: parent.messageId,
		});
		expect(catchUp.orphanChildren.map((row: { id: string }) => row.id)).toContain(inline.messageId);
		expect(JSON.stringify(catchUp)).not.toContain(foreign.id);
		removeRef(inline.messageId, fork.id);
		const revoked = await narratorService.getPretextDocumentPage(fork.id, { limit: 20 });
		expect(JSON.stringify(revoked)).not.toContain(inline.messageId);
	});

	test("real-origin activity remains bound to the correct child across parent COW", async () => {
		const own = narrator();
		const parent = tool(own.id, "real-aggregate-origin", { toolName: "Agent" });
		const realChild = child(own, parent);
		const realTool = tool(realChild.id, "real-child-activity", {
			parentToolUseId: parent.toolUseId,
			inputJson: { file_path: "/visible/child.ts" },
		});
		const foreign = narrator();
		const foreignParent = tool(foreign.id, parent.toolUseId, { toolName: "Agent" });
		const foreignChild = child(foreign, foreignParent);
		tool(foreignChild.id, "foreign-child-activity", {
			parentToolUseId: parent.toolUseId,
			inputJson: { file_path: "/private/foreign.ts" },
		});
		const fork = narrator(own.ownerUserId);
		share(parent.messageId, fork.id);
		const copiedId = await narratorService.copyOnWriteMessage(fork.id, parent.messageId);
		removeRef(parent.messageId, own.id);
		db.delete(narratorToolCalls).where(eq(narratorToolCalls.id, parent.id)).run();
		db.delete(narratorMessages).where(eq(narratorMessages.id, parent.messageId)).run();
		const page = await narratorService.getPretextDocumentPage(fork.id, { limit: 20 });
		const output = JSON.stringify(page);
		expect(output).toContain(realChild.id);
		expect(output).toContain(realTool.id);
		expect(output).toContain("/visible/child.ts");
		expect(output).not.toContain(foreignChild.id);
		expect(output).not.toContain("/private/foreign.ts");
		const catchUp = await narratorService.getMessagesAfter(fork.id, {
			parentLastMessageId: copiedId,
		});
		expect(JSON.stringify(catchUp)).toContain(realChild.id);
		removeRef(copiedId, fork.id);
		const revoked = await narratorService.getMessagesAfter(fork.id, {
			childAnchors: [{ parentToolUseId: parent.toolUseId }],
		});
		expect(JSON.stringify(revoked)).not.toContain(realChild.id);
	});

	for (const invalid of ["legacy", "primary-fork", "missing-child-ref", "wrong-parent"] as const) {
		test(`${invalid} never becomes an activity owner even when provider IDs match`, async () => {
			const own = narrator();
			const parent = tool(own.id, "unknown-origin", { toolName: "Agent" });
			const candidate = child(own, parent);
			const stored = tool(candidate.id, "unknown-child-summary", {
				parentToolUseId: parent.toolUseId,
				inputJson: { file_path: "/must-not-appear" },
			});
			if (invalid === "legacy")
				db.update(narrators)
					.set({ originToolCallId: null })
					.where(eq(narrators.id, candidate.id))
					.run();
			if (invalid === "primary-fork")
				db.update(narrators)
					.set({ type: "primary", variant: "primary" })
					.where(eq(narrators.id, candidate.id))
					.run();
			if (invalid === "missing-child-ref") removeRef(stored.messageId, candidate.id);
			if (invalid === "wrong-parent")
				db.update(narrators)
					.set({ parentNarratorId: narrator().id })
					.where(eq(narrators.id, candidate.id))
					.run();
			const page = await narratorService.getPretextDocumentPage(own.id, { limit: 20 });
			expect(JSON.stringify(page)).not.toContain(candidate.id);
			expect(JSON.stringify(page)).not.toContain("/must-not-appear");
		});
	}

	test("multiple visible parent calls sharing a provider ID cannot borrow a single group's owner", async () => {
		const own = narrator();
		const first = tool(own.id, "ambiguous-aggregate-parent", { toolName: "Agent" });
		const second = tool(own.id, first.toolUseId, { toolName: "Agent" });
		const childOne = child(own, first);
		const childTwo = child(own, second);
		tool(childOne.id, "first-summary", { parentToolUseId: first.toolUseId });
		tool(childTwo.id, "second-summary", { parentToolUseId: first.toolUseId });
		const page = await narratorService.getPretextDocumentPage(own.id, { limit: 1 });
		for (const id of [childOne.id, childTwo.id]) expect(JSON.stringify(page)).not.toContain(id);
	});

	test("multiple genuine child owners for one origin stay unknown, not last-row-wins", async () => {
		const own = narrator();
		const parent = tool(own.id, "duplicate-child-origin", { toolName: "Agent" });
		const one = child(own, parent);
		const two = child(own, parent);
		tool(one.id, "child-one", { parentToolUseId: parent.toolUseId });
		tool(two.id, "child-two", { parentToolUseId: parent.toolUseId });
		const page = await narratorService.getPretextDocumentPage(own.id, { limit: 20 });
		for (const id of [one.id, two.id]) expect(JSON.stringify(page)).not.toContain(id);
	});

	test("malformed foreign child input is never read by inline hydration", async () => {
		const own = narrator();
		const parent = tool(own.id, "malformed-foreign-inline-parent", { toolName: "Read" });
		const foreign = narrator();
		const secret = tool(foreign.id, "malformed-foreign-inline", {
			parentToolUseId: parent.toolUseId,
		});
		sqlite.run("UPDATE narrator_tool_calls SET input_json = ? WHERE id = ?", [
			"foreign invalid JSON",
			secret.id,
		]);
		const page = await narratorService.getPretextDocumentPage(own.id, { limit: 20 });
		expect(JSON.stringify(page)).not.toContain(secret.id);
		const catchUp = await narratorService.getMessagesAfter(own.id, {
			parentLastMessageId: parent.messageId,
			childAnchors: [{ parentToolUseId: parent.toolUseId }],
		});
		expect(JSON.stringify(catchUp)).not.toContain(secret.messageId);
	});

	for (const toolName of ["Read", "Agent"]) {
		for (const collision of ["parent", "child"]) {
			test(`501 foreign ${collision} collisions do not consume ${toolName} aggregation budget`, async () => {
				const own = narrator();
				const parent = tool(own.id, "collision-budget-parent", { toolName });
				const owner = toolName === "Agent" ? child(own, parent) : own;
				const visible = tool(owner.id, "visible-child", { parentToolUseId: parent.toolUseId });
				const foreign = narrator();
				const foreignOwner =
					toolName === "Agent" && collision === "child"
						? child(foreign, tool(foreign.id, parent.toolUseId, { toolName }))
						: foreign;
				db.transaction(() => {
					for (let index = 0; index < 501; index++)
						tool(foreignOwner.id, collision === "parent" ? parent.toolUseId : `foreign-${index}`, {
							toolName,
							...(collision === "child" ? { parentToolUseId: parent.toolUseId } : {}),
						});
				});
				const page = await narratorService.getPretextDocumentPage(own.id, { limit: 20 });
				const catchUp = await narratorService.getMessagesAfter(own.id, {
					parentLastMessageId: parent.messageId,
				});
				for (const result of [page, catchUp]) {
					expect(JSON.stringify(result)).toContain(visible.id);
					expect(JSON.stringify(result)).not.toContain(foreign.id);
					expect(JSON.stringify(result)).not.toContain(foreignOwner.id);
				}
			});
		}
	}

	for (const childMessageCounts of [[501], [260, 260]]) {
		test(`child transcripts of ${childMessageCounts.join(" + ")} messages use owner, not message budgets`, async () => {
			const own = narrator();
			const boundary = tool(own.id, "long-history-boundary");
			db.update(narratorMessageRefs)
				.set({ seq: 1 })
				.where(eq(narratorMessageRefs.messageId, boundary.messageId))
				.run();
			const children = childMessageCounts.map((count, childIndex) => {
				const parent = tool(own.id, `long-history-parent-${childIndex}`, { toolName: "Agent" });
				db.update(narratorMessageRefs)
					.set({ seq: childIndex + 2 })
					.where(eq(narratorMessageRefs.messageId, parent.messageId))
					.run();
				const owner = child(own, parent);
				db.transaction(() => {
					for (let index = 0; index < count; index++)
						tool(owner.id, `long-history-${childIndex}-${index}`, {
							parentToolUseId: parent.toolUseId,
						});
				});
				return owner;
			});
			const page = await narratorService.getPretextDocumentPage(own.id, {
				limit: children.length,
			});
			const catchUp = await narratorService.getMessagesAfter(own.id, {
				parentLastMessageId: boundary.messageId,
			});
			for (const result of [page, catchUp]) {
				const output = JSON.stringify(result);
				for (const owner of children) expect(output).toContain(owner.id);
				expect(output).toContain("latestToolCalls");
				// Only bounded activity summaries, never the child's full transcript.
				expect(output.length).toBeLessThan(50_000);
			}
		});
	}

	for (const source of ["parent", "inline-child"]) {
		test(`501 real ${source} rows still fail closed rather than proving uniqueness from a truncated group`, async () => {
			const own = narrator();
			const parent = tool(own.id, "real-budget-parent", { toolName: "Read" });
			const owner = own;
			db.transaction(() => {
				for (let index = 0; index < 501; index++)
					tool(owner.id, source === "parent" ? parent.toolUseId : `child-${index}`, {
						...(source !== "parent" ? { parentToolUseId: parent.toolUseId } : {}),
					});
			});
			await expect(
				narratorService.getPretextDocumentPage(own.id, { limit: 1 }),
			).rejects.toMatchObject({ code: "HISTORY_AGGREGATE_UNAVAILABLE" });
			await expect(
				narratorService.getMessagesAfter(own.id, { parentLastMessageId: parent.messageId }),
			).rejects.toMatchObject({ code: "HISTORY_AGGREGATE_UNAVAILABLE" });
		});
	}

	test("COW validates retained original PK even when the original has a different provider ID", async () => {
		const own = narrator();
		const parent = tool(own.id, "cow-origin-validation", { toolName: "Agent" });
		const realChild = child(own, parent);
		tool(realChild.id, "cow-child-activity", { parentToolUseId: parent.toolUseId });
		const fork = narrator(own.ownerUserId);
		share(parent.messageId, fork.id);
		await narratorService.copyOnWriteMessage(fork.id, parent.messageId);
		expect(
			JSON.stringify(await narratorService.getPretextDocumentPage(fork.id, { limit: 20 })),
		).toContain(realChild.id);
		db.update(narratorToolCalls)
			.set({ toolUseId: "mismatched-origin-provider" })
			.where(eq(narratorToolCalls.id, parent.id))
			.run();
		expect(
			JSON.stringify(await narratorService.getPretextDocumentPage(fork.id, { limit: 20 })),
		).not.toContain(realChild.id);
	});

	test("revoking a parent ref during async activity aggregation prevents the response", async () => {
		const own = narrator();
		const parent = tool(own.id, "revoke-during-aggregate", { toolName: "Agent" });
		const realChild = child(own, parent);
		tool(realChild.id, "revoke-child", { parentToolUseId: parent.toolUseId });
		spyOn(subagentFileChanges, "getFileChangesBySubagent").mockImplementation(async () => {
			removeRef(parent.messageId, own.id);
			return new Map();
		});
		await expect(
			narratorService.getPretextDocumentPage(own.id, { limit: 20 }),
		).rejects.toMatchObject({ code: "HISTORY_AGGREGATE_UNAVAILABLE" });
	});

	test("revoking the last author ref during activity aggregation prevents the response", async () => {
		const own = narrator();
		const parent = tool(own.id, "revoke-author-during-aggregate", { toolName: "Agent" });
		const realChild = child(own, parent);
		const stored = tool(realChild.id, "revoke-author-child", { parentToolUseId: parent.toolUseId });
		// A foreign shared ref is not a replacement for the child's own author ref.
		share(stored.messageId, narrator().id);
		spyOn(subagentFileChanges, "getFileChangesBySubagent").mockImplementation(async () => {
			removeRef(stored.messageId, realChild.id);
			return new Map();
		});
		await expect(
			narratorService.getPretextDocumentPage(own.id, { limit: 1 }),
		).rejects.toMatchObject({ code: "HISTORY_AGGREGATE_UNAVAILABLE" });
	});

	test("501 genuine owners still exceed the entity budget and fail closed", async () => {
		const own = narrator();
		const parent = tool(own.id, "real-owner-budget", { toolName: "Agent" });
		db.transaction(() => {
			for (let index = 0; index < 501; index++) {
				const owner = child(own, parent);
				tool(owner.id, `owner-budget-${index}`, { parentToolUseId: parent.toolUseId });
			}
		});
		await expect(
			narratorService.getPretextDocumentPage(own.id, { limit: 1 }),
		).rejects.toMatchObject({ code: "HISTORY_AGGREGATE_UNAVAILABLE" });
		await expect(
			narratorService.getMessagesAfter(own.id, {
				parentLastMessageId: parent.messageId,
			}),
		).rejects.toMatchObject({ code: "HISTORY_AGGREGATE_UNAVAILABLE" });
	});

	test("conflicting provider IDs for a deleted COW origin cannot borrow an owner's proof", async () => {
		const own = narrator();
		const parent = tool(own.id, "cow-conflicting-provider", { toolName: "Agent" });
		const realChild = child(own, parent);
		tool(realChild.id, "cow-conflicting-activity", { parentToolUseId: parent.toolUseId });
		const fork = narrator(own.ownerUserId);
		share(parent.messageId, fork.id);
		await narratorService.copyOnWriteMessage(fork.id, parent.messageId);
		const conflicting = tool(fork.id, "different-cow-provider", { toolName: "Agent" });
		db.update(narratorToolCalls)
			.set({ executionOriginToolCallId: parent.id })
			.where(eq(narratorToolCalls.id, conflicting.id))
			.run();
		removeRef(parent.messageId, own.id);
		db.delete(narratorToolCalls).where(eq(narratorToolCalls.id, parent.id)).run();
		db.delete(narratorMessages).where(eq(narratorMessages.id, parent.messageId)).run();
		const page = await narratorService.getPretextDocumentPage(fork.id, { limit: 20 });
		expect(JSON.stringify(page)).not.toContain(realChild.id);
	});

	test("large authorized inline IO is size checked before hydration", async () => {
		const own = narrator();
		const parent = tool(own.id, "large-inline-parent", { toolName: "Read" });
		const inline = tool(own.id, "large-inline-tool", { parentToolUseId: parent.toolUseId });
		sqlite.run(
			"UPDATE narrator_tool_calls SET input_json = '\"' || printf('%.*c', ?, 'x') || '\"' WHERE id = ?",
			[4 * 1024 * 1024 + 1, inline.id],
		);
		await expect(
			narratorService.getPretextDocumentPage(own.id, { limit: 20 }),
		).rejects.toMatchObject({ code: "HISTORY_AGGREGATE_UNAVAILABLE" });
	});
});

describe("tool detail references and durable child origins", () => {
	test("unique direct shared refs remain readable and removing the ref revokes access", async () => {
		const source = narrator();
		const fork = narrator(source.ownerUserId);
		const stored = tool(source.id, "direct-shared");
		await expect(
			narratorService.getToolCallDetail(fork.id, stored.toolUseId),
		).rejects.toBeInstanceOf(NotFoundError);
		share(stored.messageId, fork.id);
		expect((await narratorService.getToolCallDetail(fork.id, stored.toolUseId)).id).toBe(stored.id);
		removeRef(stored.messageId, fork.id);
		await expect(
			narratorService.getToolCallDetail(fork.id, stored.toolUseId),
		).rejects.toBeInstanceOf(NotFoundError);
		expect((await narratorService.getToolCallDetail(source.id, stored.toolUseId)).id).toBe(
			stored.id,
		);
	});

	test("a real child's durable origin grants parent and shared-prefix access", async () => {
		const parent = narrator();
		const parentCall = tool(parent.id, "origin-agent", { toolName: "Agent" });
		const childNarrator = child(parent, parentCall);
		const stored = tool(childNarrator.id, "real-child-tool", {
			parentToolUseId: parentCall.toolUseId,
		});
		const fork = narrator(parent.ownerUserId);
		share(parentCall.messageId, fork.id);
		expect((await narratorService.getToolCallDetail(parent.id, stored.toolUseId)).id).toBe(
			stored.id,
		);
		expect((await narratorService.getToolCallDetail(fork.id, stored.toolUseId)).id).toBe(stored.id);
		const response = await appFor(parent.ownerUserId).request(
			`/api/narrators/${fork.id}/tool-calls/${stored.toolUseId}`,
		);
		expect(response.status).toBe(200);
		expect((await response.json()).id).toBe(stored.id);
		removeRef(parentCall.messageId, fork.id);
		await expect(
			narratorService.getToolCallDetail(fork.id, stored.toolUseId),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("a parent COW origin grants access after original deletion, but not after the copy ref is removed", async () => {
		const parent = narrator();
		const parentCall = tool(parent.id, "cow-origin-agent", { toolName: "Agent" });
		const childNarrator = child(parent, parentCall);
		const stored = tool(childNarrator.id, "cow-child-tool", {
			parentToolUseId: parentCall.toolUseId,
		});
		const fork = narrator(parent.ownerUserId);
		share(parentCall.messageId, fork.id);
		const copiedMessageId = await narratorService.copyOnWriteMessage(fork.id, parentCall.messageId);
		expect(copiedMessageId).not.toBe(parentCall.messageId);
		removeRef(parentCall.messageId, parent.id);
		db.delete(narratorToolCalls).where(eq(narratorToolCalls.id, parentCall.id)).run();
		db.delete(narratorMessages).where(eq(narratorMessages.id, parentCall.messageId)).run();
		expect((await narratorService.getToolCallDetail(fork.id, stored.toolUseId)).id).toBe(stored.id);
		removeRef(copiedMessageId, fork.id);
		await expect(
			narratorService.getToolCallDetail(fork.id, stored.toolUseId),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("an orphaned child source ref cannot be replaced by somebody else's shared ref", async () => {
		const parent = narrator();
		const parentCall = tool(parent.id, "detached-origin", { toolName: "Agent" });
		const childNarrator = child(parent, parentCall);
		const stored = tool(childNarrator.id, "detached-child-tool", {
			parentToolUseId: parentCall.toolUseId,
		});
		const fork = narrator(parent.ownerUserId);
		share(stored.messageId, fork.id);
		removeRef(stored.messageId, childNarrator.id);
		await expect(
			narratorService.getToolCallDetail(parent.id, stored.toolUseId),
		).rejects.toBeInstanceOf(NotFoundError);
		expect((await narratorService.getToolCallDetail(fork.id, stored.toolUseId)).id).toBe(stored.id);
	});

	for (const invalid of [
		"ordinary fork",
		"missing origin",
		"other parent",
		"wrong origin",
		"legacy parent row",
		"wrong provider parent",
	] as const) {
		test(`${invalid} never authorizes child tool IO`, async () => {
			const own = narrator();
			const foreign = narrator();
			const parentCall = tool(own.id, "ambiguous-parent", { toolName: "Agent" });
			const otherCall = tool(foreign.id, parentCall.toolUseId, { toolName: "Agent" });
			const childNarrator = child(own, parentCall);
			const stored = tool(childNarrator.id, "untrusted-child-tool", {
				parentToolUseId: parentCall.toolUseId,
				inputJson: { secret: "do not disclose" },
			});
			if (invalid === "ordinary fork")
				db.update(narrators)
					.set({ type: "primary", variant: "primary" })
					.where(eq(narrators.id, childNarrator.id))
					.run();
			if (invalid === "missing origin")
				db.update(narrators)
					.set({ originToolCallId: null })
					.where(eq(narrators.id, childNarrator.id))
					.run();
			if (invalid === "other parent")
				db.update(narrators)
					.set({ parentNarratorId: foreign.id })
					.where(eq(narrators.id, childNarrator.id))
					.run();
			if (invalid === "wrong origin")
				db.update(narrators)
					.set({ parentNarratorId: foreign.id, originToolCallId: otherCall.id })
					.where(eq(narrators.id, childNarrator.id))
					.run();
			if (invalid === "legacy parent row")
				db.update(narratorToolCalls)
					.set({ executionIdentityVersion: 0 })
					.where(eq(narratorToolCalls.id, parentCall.id))
					.run();
			if (invalid === "wrong provider parent")
				db.update(narratorMessages)
					.set({ parentToolUseId: "wrong-provider-parent" })
					.where(eq(narratorMessages.id, stored.messageId))
					.run();
			const trace = traceToolReads();
			await expect(
				narratorService.getToolCallDetail(own.id, stored.toolUseId),
			).rejects.toBeInstanceOf(NotFoundError);
			expect(trace.payloadReads()).toHaveLength(0);
		});
	}
});

describe("tool detail unique selection and bounded payload reads", () => {
	test("two visible message rows require a true selector; the real route forwards both selectors", async () => {
		const own = narrator();
		const first = tool(own.id, "repeated-tool", { inputJson: { which: "first" } });
		const second = tool(own.id, "repeated-tool", { inputJson: { which: "second" } });
		const trace = traceToolReads();
		await expect(narratorService.getToolCallDetail(own.id, first.toolUseId)).rejects.toMatchObject({
			code: "TOOL_CALL_DETAIL_SELECTION_REQUIRED",
		});
		expect(trace.payloadReads()).toHaveLength(0);
		const app = appFor(own.ownerUserId);
		const ambiguous = await app.request(`/api/narrators/${own.id}/tool-calls/${first.toolUseId}`);
		expect(ambiguous.status).toBe(409);
		const body = await ambiguous.text();
		for (const id of [first.id, second.id, first.messageId, second.messageId])
			expect(body).not.toContain(id);
		for (const selector of [
			`toolCallId=${second.id}`,
			`messageId=${second.messageId}`,
			`toolCallId=${second.id}&messageId=${second.messageId}`,
		]) {
			const response = await app.request(
				`/api/narrators/${own.id}/tool-calls/${second.toolUseId}?${selector}`,
			);
			expect(response.status).toBe(200);
			expect((await response.json()).inputJson).toEqual({ which: "second" });
		}
		const mismatch = await app.request(
			`/api/narrators/${own.id}/tool-calls/${first.toolUseId}?toolCallId=${first.id}&messageId=${second.messageId}`,
		);
		expect(mismatch.status).toBe(404);
	});

	test("a message selector cannot choose between repeated rows within that message", async () => {
		const own = narrator();
		const first = tool(own.id, "same-message-repeat");
		const secondId = generateId();
		db.insert(narratorToolCalls)
			.values({
				id: secondId,
				messageId: first.messageId,
				narratorId: own.id,
				toolUseId: first.toolUseId,
				toolName: "Write",
				inputJson: { which: "second attempt" },
				status: "success",
				createdAt: now,
			})
			.run();
		await expect(
			narratorService.getToolCallDetail(own.id, first.toolUseId, { messageId: first.messageId }),
		).rejects.toMatchObject({ code: "TOOL_CALL_DETAIL_SELECTION_REQUIRED" });
		expect(
			(await narratorService.getToolCallDetail(own.id, first.toolUseId, { toolCallId: secondId }))
				.id,
		).toBe(secondId);
	});

	test("even an exact foreign PK or message selector is not permission to read it", async () => {
		const { own, secret } = forgedForeignTool();
		const trace = traceToolReads();
		for (const selector of [`toolCallId=${secret.id}`, `messageId=${secret.messageId}`]) {
			const response = await appFor(own.ownerUserId).request(
				`/api/narrators/${own.id}/tool-calls/${secret.toolUseId}?${selector}`,
			);
			expect(response.status).toBe(404);
			expect(await response.text()).not.toContain("FOREIGN_INPUT_SECRET");
		}
		expect(trace.payloadReads()).toHaveLength(0);
	});

	test("unauthorized and malformed large tool bodies are never selected during candidate discovery", async () => {
		const own = narrator();
		const foreign = narrator();
		const secret = tool(foreign.id, "same-global-id", {
			outputJson: { secret: "x".repeat(256 * 1024) },
		});
		// A full candidate SELECT would parse this JSON and fail before reaching the
		// allowed row. Metadata-only resolution never reads this foreign payload.
		sqlite.run("UPDATE narrator_tool_calls SET input_json = ? WHERE id = ?", [
			"invalid foreign JSON",
			secret.id,
		]);
		const allowed = tool(own.id, secret.toolUseId, {
			inputJson: { complete: "y".repeat(128 * 1024) },
		});
		const trace = traceToolReads();
		const detail = await narratorService.getToolCallDetail(own.id, allowed.toolUseId);
		expect(detail.id).toBe(allowed.id);
		expect(detail.inputJson).toEqual({ complete: "y".repeat(128 * 1024) });
		expect(trace.payloadReads()).toHaveLength(1);
		expect(trace.payloadReads()[0]).toMatch(/where .*"id" = \?/);
		expect(
			trace.queries.some(
				(query) => query.includes('"tool_use_id" = ?') && query.includes("limit ?"),
			),
		).toBe(true);
	});

	test("a truncated metadata prefix cannot masquerade as a unique visible row", async () => {
		const own = narrator();
		const foreign = narrator();
		const allowed = tool(own.id, "metadata-budget");
		db.transaction(() => {
			for (let index = 0; index < 200; index++) tool(foreign.id, allowed.toolUseId);
		});
		const trace = traceToolReads();
		await expect(
			narratorService.getToolCallDetail(own.id, allowed.toolUseId),
		).rejects.toMatchObject({ code: "TOOL_CALL_DETAIL_SELECTION_REQUIRED" });
		expect(trace.payloadReads()).toHaveLength(0);
		expect(
			(
				await narratorService.getToolCallDetail(own.id, allowed.toolUseId, {
					toolCallId: allowed.id,
				})
			).id,
		).toBe(allowed.id);
		expect(trace.payloadReads()).toHaveLength(1);
	});

	test("the unique authorized payload is size checked before reading its large fields", async () => {
		const own = narrator();
		const allowed = tool(own.id, "oversized-detail");
		sqlite.run(
			"UPDATE narrator_tool_calls SET output_json = '\"' || printf('%.*c', ?, 'x') || '\"' WHERE id = ?",
			[32 * 1024 * 1024 + 1, allowed.id],
		);
		const trace = traceToolReads();
		await expect(
			narratorService.getToolCallDetail(own.id, allowed.toolUseId),
		).rejects.toMatchObject({ code: "TOOL_CALL_DETAIL_TOO_LARGE" });
		expect(trace.payloadReads()).toHaveLength(0);
	});

	test("route selectors are bounded and do not bypass the caller narrator ACL", async () => {
		const { own, foreign, secret } = forgedForeignTool();
		const app = appFor(own.ownerUserId);
		const inaccessible = await app.request(
			`/api/narrators/${foreign.id}/tool-calls/${secret.toolUseId}?toolCallId=${secret.id}`,
		);
		expect(inaccessible.status).toBe(404);
		for (const selector of ["toolCallId=", `messageId=${"x".repeat(129)}`]) {
			const response = await app.request(
				`/api/narrators/${own.id}/tool-calls/${secret.toolUseId}?${selector}`,
			);
			expect(response.status).toBe(400);
		}
	});
});

describe("subagent conclusion routes retain exact parent bindings", () => {
	function fixture() {
		const own = narrator();
		const parent = tool(own.id, "reused-conclusion-provider", { toolName: "Agent" });
		const other = tool(own.id, parent.toolUseId, { toolName: "Agent" });
		const foreign = tool(narrator().id, parent.toolUseId, { toolName: "Agent" });
		const subagent = child(own, parent);
		db.update(narrators)
			.set({ aclRootNarratorId: own.id, status: "idle" })
			.where(eq(narrators.id, subagent.id))
			.run();
		let resultMessageId = "";
		for (const role of ["user", "assistant"] as const) {
			const messageId = generateId();
			db.insert(narratorMessages)
				.values({
					id: messageId,
					narratorId: subagent.id,
					parentToolUseId: parent.toolUseId,
					role,
					contentText: "first conclusion",
					contentJson: [{ type: "text", text: "first conclusion" }],
					createdAt: now,
				})
				.run();
			db.insert(narratorMessageRefs)
				.values({
					id: generateId(),
					narratorId: subagent.id,
					messageId,
					seq: role === "user" ? 1 : 2,
				})
				.run();
			if (role === "assistant") resultMessageId = messageId;
		}
		return { own, parent, other, foreign, subagent, resultMessageId };
	}

	function output(toolCallId: string) {
		return db.query.narratorToolCalls
			.findFirst({ where: eq(narratorToolCalls.id, toolCallId), columns: { outputJson: true } })
			.sync()?.outputJson;
	}

	for (const shared of [false, true]) {
		test(`two manual updates target only the spawning row with duplicate IDs (shared=${shared})`, async () => {
			const f = fixture();
			const initial = output(f.parent.id);
			if (shared) share(f.parent.messageId, narrator(f.own.ownerUserId).id);
			const app = appFor(f.own.ownerUserId);
			let firstReference:
				| Awaited<ReturnType<typeof narratorPersistence.resolveSubagentConclusionReference>>
				| undefined;
			for (const text of ["first conclusion", "second conclusion"]) {
				db.update(narratorMessages)
					.set({ contentText: text, contentJson: [{ type: "text", text }] })
					.where(eq(narratorMessages.id, f.resultMessageId))
					.run();
				const response = await app.request(`/api/narrators/${f.subagent.id}/update-conclusion`, {
					method: "POST",
				});
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({ outcome: "updated_existing_conclusion" });
				const reference = await narratorPersistence.resolveSubagentConclusionReference(
					f.subagent.id,
					f.own.id,
					f.parent.toolUseId,
				);
				expect(JSON.stringify(output(reference.toolCallId))).toContain(text);
				if (firstReference) expect(reference).toEqual(firstReference);
				firstReference = reference;
				if (shared) {
					expect(reference.toolCallId).not.toBe(f.parent.id);
					expect(reference.messageId).not.toBe(f.parent.messageId);
					expect(output(f.parent.id)).toEqual(initial);
				}
				expect(output(f.other.id)).toEqual(initial);
				expect(output(f.foreign.id)).toEqual(initial);
			}
		});
	}

	for (const failure of ["binding", "write"]) {
		test(`stop takeover retains watcher and state after ${failure} failure, then retries after COW`, async () => {
			const f = fixture();
			share(f.parent.messageId, narrator(f.own.ownerUserId).id);
			markTakenOver(f.subagent.id);
			db.update(narrators)
				.set({ substatus: JSON.stringify(["taken_over"]) })
				.where(eq(narrators.id, f.subagent.id))
				.run();
			registerConclusionWatcher(f.subagent.id, f.own.id, f.parent.toolUseId, f.parent.id);
			const watcher = getConclusionWatcher(f.subagent.id);
			if (failure === "binding") removeRef(f.parent.messageId, f.own.id);
			else
				spyOn(narratorService, "updateToolCallResult").mockRejectedValueOnce(
					new Error("write failed"),
				);
			const app = appFor(f.own.ownerUserId);
			const failed = await app.request(`/api/narrators/${f.subagent.id}/stop-takeover`, {
				method: "POST",
			});
			expect(failed.status).toBe(failure === "binding" ? 400 : 500);
			expect(getConclusionWatcher(f.subagent.id)).toBe(watcher);
			expect(isTakenOver(f.subagent.id)).toBe(true);
			expect((await narratorService.getById(f.subagent.id)).substatus).toContain("taken_over");
			if (failure === "binding") share(f.parent.messageId, f.own.id);
			const retried = await app.request(`/api/narrators/${f.subagent.id}/stop-takeover`, {
				method: "POST",
			});
			expect(retried.status).toBe(200);
			expect(await retried.json()).toEqual({ stopped: true, deferred: false });
			expect(getConclusionWatcher(f.subagent.id)).toBeUndefined();
			expect(isTakenOver(f.subagent.id)).toBe(false);
			const reference = await narratorPersistence.resolveSubagentConclusionReference(
				f.subagent.id,
				f.own.id,
				f.parent.toolUseId,
			);
			expect(reference.toolCallId).not.toBe(f.parent.id);
			expect(JSON.stringify(output(reference.toolCallId))).toContain("first conclusion");
			for (const row of [f.parent, f.other, f.foreign])
				expect(output(row.id)).toEqual({ content: "allowed output" });
		});
	}
});

afterEach(() => {
	mock.restore();
	for (const narratorId of createdNarrators) {
		clearTakenOver(narratorId);
		removeConclusionWatcher(narratorId);
	}
	if (createdNarrators.length > 0) {
		db.update(narrators)
			.set({ parentNarratorId: null, forkMessageId: null })
			.where(inArray(narrators.id, createdNarrators))
			.run();
		db.delete(narratorMessageRefs)
			.where(inArray(narratorMessageRefs.narratorId, createdNarrators))
			.run();
		db.delete(narratorToolCalls)
			.where(inArray(narratorToolCalls.narratorId, createdNarrators))
			.run();
		db.delete(narratorMessages).where(inArray(narratorMessages.narratorId, createdNarrators)).run();
		db.delete(narrators)
			.where(inArray(narrators.id, createdNarrators.splice(0)))
			.run();
	}
	if (createdUsers.length > 0)
		db.delete(users)
			.where(inArray(users.id, createdUsers.splice(0)))
			.run();
});

describe("tool detail rejects forged child-shaped foreign history", () => {
	test("service does not authorize another user's primary via a reused parent provider ID", async () => {
		const { own, secret } = forgedForeignTool();
		await expect(
			narratorService.getToolCallDetail(own.id, secret.toolUseId),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("real route neither returns foreign input/output nor exposes foreign identifiers", async () => {
		const { own, foreign, secret } = forgedForeignTool();
		const response = await appFor(own.ownerUserId).request(
			`/api/narrators/${own.id}/tool-calls/${secret.toolUseId}`,
		);
		expect(response.status).toBe(404);
		const body = await response.text();
		for (const value of [
			"FOREIGN_INPUT_SECRET",
			"FOREIGN_OUTPUT_SECRET",
			secret.id,
			secret.messageId,
			foreign.id,
		])
			expect(body).not.toContain(value);
	});
});
