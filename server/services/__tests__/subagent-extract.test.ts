/**
 * Extract subagent → primary narrator.
 *
 * Pins the control-plane promotion contract:
 * - new session is primary with full AskUserQuestion policy
 * - history is a materialized copy (own message ids, parentToolUseId cleared)
 * - source subagent is untouched and extraction is independent of source deletion
 * - ordinary fork still refuses subagent sources
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { narratorMessageRefs, narratorMessages, narrators } from "../../db/schema";
import * as reads from "../../db/worker-read";
import { drainContextCharacterRefreshes } from "../../lib/context-characters";
import * as pool from "../../lib/db-worker/pool";
import { delegationRegistration } from "../../lib/validators/runtime-registration";
import { compileDelegationPolicy, resolveRuntimePolicy } from "../agent-runtime/policy";
import {
	captureWorkerRejection,
	captureWorkerRejectionThrower,
	getNarratorWorkerTestDb,
} from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const { extractSubagentToPrimary } = await import("../subagent-extract");
const { narratorService } = await import("../narrator-service");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");

const now = "2026-08-01T10:00:00.000Z";

function seedUser(id = "u1") {
	const exists = sqlite.prepare("SELECT id FROM users WHERE id = ?").get(id);
	if (exists) return;
	sqlite
		.prepare(
			`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'hash', 'user', ?)`,
		)
		.run(id, id, now);
}

function seedPrimary(id = "parent") {
	seedUser();
	sqlite
		.prepare(
			`INSERT INTO narrators (id, type, variant, status, permission_mode, visibility, write_audience, inherit_mode, traits, system_prompt, parent_narrator_id, owner_user_id, created_at, updated_at)
			 VALUES (?, 'primary', 'primary', 'idle', 'default', 'project', 'owner', 'full', '[]', 'parent prompt', NULL, 'u1', ?, ?)`,
		)
		.run(id, now, now);
}

function seedSubagent(
	id = "sub",
	opts?: {
		parentNarratorId?: string | null;
		status?: string;
		permissionMode?: string;
		systemPrompt?: string | null;
		title?: string | null;
	},
) {
	seedUser();
	const parent = opts?.parentNarratorId === undefined ? "parent" : opts.parentNarratorId;
	if (parent) {
		const exists = sqlite.prepare("SELECT id FROM narrators WHERE id = ?").get(parent) as
			| { id: string }
			| undefined;
		if (!exists) seedPrimary(parent);
	}
	sqlite
		.prepare(
			`INSERT INTO narrators (
				id, type, variant, subagent_type, status, permission_mode, inherit_mode,
				traits, system_prompt, parent_narrator_id, policy_source_narrator_id,
				runtime_registration_json, title, owner_user_id, visibility, write_audience,
				created_at, updated_at
			) VALUES (?, 'subagent', 'subagent:explore', 'explore', ?, ?, 'fresh', ?, ?, ?, ?, ?, ?, 'u1', 'private', 'owner', ?, ?)`,
		)
		.run(
			id,
			opts?.status ?? "idle",
			opts?.permissionMode ?? "readOnly",
			JSON.stringify([]),
			opts?.systemPrompt ?? "You are a subagent explorer.",
			parent,
			parent,
			parent ? JSON.stringify(delegationRegistration(parent, "explore")) : null,
			opts?.title ?? "Explore auth",
			now,
			now,
		);
}

function seedSourceMessage(id: string, narratorId: string, seq: number, text: string) {
	sqlite
		.prepare(
			`INSERT INTO narrator_messages (id, narrator_id, sdk_message_uuid, parent_tool_use_id, role, content_json, content_text, origin, origin_label, created_at)
			 VALUES (?, ?, ?, 'tool-use-1', 'assistant', ?, ?, 'system', 'subagentRun', ?)`,
		)
		.run(id, narratorId, `uuid-${id}`, JSON.stringify([{ type: "text", text }]), text, now);
	sqlite
		.prepare(
			`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq, is_compact)
			 VALUES (?, ?, ?, ?, 0)`,
		)
		.run(`ref-${id}`, narratorId, id, seq);
}

async function drain() {
	await drainContextCharacterRefreshes({ deadlineAt: Date.now() + 30_000 });
	await backgroundOccupancyStore.drain();
}
beforeEach(async () => {
	await drain();
	cleanDb(sqlite);
});
afterEach(async () => {
	mock.restore();
	await drain();
});

afterAll(async () => {
	await drain();
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
	await fixture.close();
});

describe("extract metadata Worker isolation and observation guards", () => {
	function interleave(match: (query: string) => boolean, mutate: () => void) {
		const original = reads.readQuery;
		let fired = false;
		spyOn(reads, "readQuery").mockImplementation((async (query, options) => {
			const result = await original(query as Parameters<typeof reads.readQuery>[0], options);
			if (!fired && match(query.toSQL().sql)) {
				fired = true;
				mutate();
			}
			return result;
		}) as typeof reads.readQuery);
		return () => expect(fired).toBe(true);
	}
	async function conflict() {
		expect(await captureWorkerRejection(extractSubagentToPrimary("sub"))).toMatchObject({
			statusCode: 409,
			code: "RUNTIME_READ_CONFLICT",
			message: "Runtime state changed while reading",
		});
		expect(await db.select({ id: narrators.id }).from(narrators)).toHaveLength(2);
	}
	test.each([
		"status",
		"model",
		"owner",
		"workspace",
	])("source %s changes conflict without creating a primary", async (field) => {
		seedPrimary();
		seedSubagent();
		const checked = interleave(
			(sql) => sql.includes("narrator_message_refs"),
			() => {
				db.update(narrators)
					.set(
						field === "status"
							? { status: "archived" }
							: field === "model"
								? { model: "changed" }
								: field === "owner"
									? { ownerUserId: null }
									: { cwd: "/changed" },
					)
					.where(eq(narrators.id, "sub"))
					.run();
			},
		);
		await conflict();
		checked();
	});
	test("parent audience changes conflict", async () => {
		seedPrimary();
		seedSubagent();
		const original = reads.readQueryFirst;
		let fired = false;
		spyOn(reads, "readQueryFirst").mockImplementation(async (query, options) => {
			const result = await original(query, options);
			if (!fired && query.toSQL().sql.startsWith('select "visibility", "write_audience"')) {
				fired = true;
				db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, "parent")).run();
			}
			return result;
		});
		await conflict();
		expect(fired).toBe(true);
	});
	test("a ref appended after the Worker snapshot conflicts", async () => {
		seedPrimary();
		seedSubagent();
		const checked = interleave(
			(sql) => sql.includes("narrator_message_refs"),
			() => seedSourceMessage("late", "sub", 0, "late"),
		);
		await conflict();
		checked();
	});
	test("timestamp renewal does not conflict and empty history is supported", async () => {
		seedPrimary();
		seedSubagent();
		const checked = interleave(
			(sql) => sql.includes("narrator_message_refs"),
			() => {
				db.update(narrators).set({ updatedAt: "2099-01-01" }).where(eq(narrators.id, "sub")).run();
			},
		);
		const created = await extractSubagentToPrimary("sub");
		checked();
		expect(created.status).toBe("idle");
		expect(
			await db
				.select()
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, created.id)),
		).toEqual([]);
	});
	test("metadata reads require Workers, preserve caller budgets and bound history at the soft cap", async () => {
		seedPrimary();
		seedSubagent();
		seedSourceMessage("one", "sub", 0, "first");
		seedSourceMessage("two", "sub", 1, "second");
		const { narratorContext } = await import("../narrator-context");
		spyOn(narratorContext, "generateContextSummary").mockResolvedValue("bounded summary");
		const original = reads.readQuery;
		const optionsSeen: reads.ReadQueryOptions[] = [];
		spyOn(reads, "readQuery").mockImplementation((async (query, options) => {
			optionsSeen.push(options ?? {});
			return original(query as Parameters<typeof reads.readQuery>[0], options);
		}) as typeof reads.readQuery);
		const signal = new AbortController().signal,
			deadlineAt = Date.now() + 10_000;
		const created = await narratorService.extractSubagentToPrimary("sub", {
			maxFullMessages: 1,
			signal,
			deadlineAt,
			timeoutMs: 5_000,
		});
		expect(created.inheritMode).toBe("compressed");
		expect(
			optionsSeen.some(
				(options) =>
					options.maxRows === 2 &&
					options.executionPolicy === "worker-required" &&
					options.signal === signal &&
					options.deadlineAt === deadlineAt &&
					options.timeoutMs === 5_000,
			),
		).toBe(true);
	});
	test("missing source is an explicit error", async () => {
		expect(await captureWorkerRejection(extractSubagentToPrimary("missing"))).toMatchObject({
			message: "Subagent not found",
		});
	});
	test.each([
		"unavailable",
		"crashed",
		"timed out",
		"disabled",
	])("Worker %s fails without a primary or local fallback", async (failure) => {
		seedPrimary();
		seedSubagent();
		spyOn(pool, "runReadTask").mockRejectedValue(new Error(failure));
		const local = spyOn(sqlite, "prepare");
		expect(await captureWorkerRejection(extractSubagentToPrimary("sub"))).toMatchObject({
			message: failure,
		});
		expect(local).not.toHaveBeenCalled();
	});
	test("cancellation and deadline failures remain failures", async () => {
		seedPrimary();
		seedSubagent();
		const controller = new AbortController();
		controller.abort();
		expect(
			await captureWorkerRejection(extractSubagentToPrimary("sub", { signal: controller.signal })),
		).toMatchObject({ code: "DB_READ_ABORTED" });
		expect(
			await captureWorkerRejection(extractSubagentToPrimary("sub", { deadlineAt: Date.now() - 1 })),
		).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
	});
});

describe("extractSubagentToPrimary", () => {
	test("materializes a following child's current model before dropping the parent", async () => {
		seedSubagent("following-sub");
		await db
			.update(narrators)
			.set({ model: "__parent__" })
			.where(eq(narrators.id, "following-sub"));
		await db
			.update(narrators)
			.set({ model: "openai:parent-new" })
			.where(eq(narrators.id, "parent"));
		const extracted = await extractSubagentToPrimary("following-sub");
		expect(extracted.model).toBe("openai:parent-new");
		expect(extracted.parentNarratorId).toBeNull();
		const source = await db.query.narrators.findFirst({ where: eq(narrators.id, "following-sub") });
		expect(source?.model).toBe("__parent__");
		await db
			.update(narrators)
			.set({ model: "openai:parent-later" })
			.where(eq(narrators.id, "parent"));
		const independent = await db.query.narrators.findFirst({
			where: eq(narrators.id, extracted.id),
		});
		expect(independent?.model).toBe("openai:parent-new");
	});
	test("preserves partial reference cost coverage when materializing messages", async () => {
		seedSubagent("sub");
		seedSourceMessage("cost-message", "sub", 0, "answer");
		sqlite
			.prepare(
				"UPDATE narrator_messages SET cost_usd=0, cost_status='partial', cost_missing_fields='[\"output\"]' WHERE id='cost-message'",
			)
			.run();
		const extracted = await extractSubagentToPrimary("sub", { title: "Cost coverage" });
		const row = sqlite
			.prepare(
				"SELECT cost_usd, cost_status, cost_missing_fields FROM narrator_messages WHERE narrator_id=?",
			)
			.get(extracted.id);
		expect(row).toMatchObject({
			cost_usd: 0,
			cost_status: "partial",
			cost_missing_fields: '["output"]',
		});
	});
	test("creates an independent primary with materialized history and full ask policy", async () => {
		seedPrimary("parent");
		seedSubagent("sub", { parentNarratorId: "parent" });
		sqlite.run(
			"UPDATE narrators SET context_system_chars=91,context_tools_chars=73 WHERE id='sub'",
		);
		seedSourceMessage("m0", "sub", 0, "found route A");
		seedSourceMessage("m1", "sub", 1, "found route B");

		const extracted = await extractSubagentToPrimary("sub", { title: "Auth exploration" });

		expect(extracted.variant).toBe("primary");
		expect(extracted.type).toBe("primary");
		expect(extracted.parentNarratorId).toBeNull();
		expect(extracted.systemPrompt).toBeNull();
		expect(extracted.contextSystemChars).toBe(0);
		expect(extracted.contextToolsChars).toBe(0);
		expect(extracted.contextProjectId).toBeNull();
		expect(extracted.permissionMode).toBe("default");
		expect(extracted.refsInheritedFrom).toBeNull();
		expect(extracted.aclRootNarratorId).toBeNull();
		expect(extracted.subagentType).toBeNull();
		const traitsRaw = extracted.traits;
		const traits = Array.isArray(traitsRaw) ? traitsRaw : JSON.parse(String(traitsRaw ?? "[]"));
		expect(traits).toEqual(["standalone", "extracted-from-subagent"]);
		expect(extracted.title).toBe("Auth exploration");
		// Parent is project-visible; standalone extract clamps project → private.
		expect(extracted.visibility).toBe("private");
		expect(extracted.writeAudience).toBe("owner");

		// Acceptance: primary runtime policy unlocks AskUserQuestion + full builtin tools.
		const policy = resolveRuntimePolicy([]);
		expect(policy.capabilities.askUserQuestion).toBe("sync-or-async");
		expect(policy.tools.builtin).toBe("all");

		const subPolicy = resolveRuntimePolicy([compileDelegationPolicy({ template: "explore" })]);
		expect(subPolicy.capabilities.askUserQuestion).toBe("disabled");
	});

	test("materializes source history as independent copies with parentToolUseId cleared", async () => {
		seedPrimary();
		seedSubagent("sub");
		seedSourceMessage("m0", "sub", 0, "found route A");
		seedSourceMessage("m1", "sub", 1, "found route B");

		const extracted = await extractSubagentToPrimary("sub", { inheritMode: "full" });

		const newRefs = await db
			.select()
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, extracted.id))
			.orderBy(narratorMessageRefs.seq);
		expect(newRefs).toHaveLength(2);

		const copied = await db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, extracted.id));
		expect(copied).toHaveLength(2);
		for (const msg of copied) {
			expect(msg.parentToolUseId).toBeNull();
			expect(msg.messageUuid).toBeNull();
			// A fresh copy, never the source row. (Checking a letter prefix was flaky: random
			// nanoids start with "m" about once in 64 extractions.)
			expect(["m0", "m1"]).not.toContain(msg.id);
		}
		const texts = copied.map((m) => m.contentText).sort();
		expect(texts).toEqual(["found route A", "found route B"]);

		// Source messages remain on the subagent, still nested under the parent tool call.
		const sourceMsgs = await db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, "sub"));
		expect(sourceMsgs).toHaveLength(2);
		for (const msg of sourceMsgs) {
			expect(msg.parentToolUseId).toBe("tool-use-1");
		}
	});

	test("leaves the source subagent unchanged", async () => {
		seedPrimary();
		seedSubagent("sub", { systemPrompt: "explore only", permissionMode: "readOnly" });
		seedSourceMessage("m0", "sub", 0, "note");

		await extractSubagentToPrimary("sub");

		const source = await db.query.narrators.findFirst({ where: eq(narrators.id, "sub") });
		expect(source?.variant).toBe("subagent:explore");
		expect(source?.systemPrompt).toBe("explore only");
		expect(source?.permissionMode).toBe("readOnly");
		expect(source?.parentNarratorId).toBe("parent");
	});

	test("extract survives source deletion (no parentNarratorId cascade)", async () => {
		seedPrimary();
		seedSubagent("sub");
		seedSourceMessage("m0", "sub", 0, "keep me");

		const extracted = await extractSubagentToPrimary("sub");

		// Simulate cascade delete of the subagent row + its owned messages/refs.
		sqlite.prepare("DELETE FROM narrator_message_refs WHERE narrator_id = ?").run("sub");
		sqlite.prepare("DELETE FROM narrator_tool_calls WHERE narrator_id = ?").run("sub");
		sqlite.prepare("DELETE FROM narrator_messages WHERE narrator_id = ?").run("sub");
		sqlite.prepare("DELETE FROM narrators WHERE id = ?").run("sub");

		const survivor = await db.query.narrators.findFirst({
			where: eq(narrators.id, extracted.id),
		});
		expect(survivor).toBeDefined();
		expect(survivor?.parentNarratorId).toBeNull();

		const survivorMsgs = await db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, extracted.id));
		expect(survivorMsgs).toHaveLength(1);
		expect(survivorMsgs[0]?.contentText).toBe("keep me");
	});

	test("rejects non-subagent and archived sources", async () => {
		seedPrimary("parent");
		await expect(await captureWorkerRejectionThrower(extractSubagentToPrimary("parent"))).toThrow(
			"Only subagent narrators can be extracted",
		);

		seedSubagent("sub-archived", { status: "archived" });
		await expect(
			await captureWorkerRejectionThrower(extractSubagentToPrimary("sub-archived")),
		).toThrow("Archived subagents cannot be extracted");
	});

	test("compressed inheritMode writes a compact marker instead of full copies", async () => {
		seedPrimary();
		seedSubagent("sub");
		seedSourceMessage("m0", "sub", 0, "note");

		// Avoid depending on a live summary model in unit tests.
		const { narratorContext } = await import("../narrator-context");
		const spy = spyOn(narratorContext, "generateContextSummary").mockResolvedValue(
			"summary of exploration",
		);

		try {
			const extracted = await extractSubagentToPrimary("sub", { inheritMode: "compressed" });
			expect(extracted.inheritMode).toBe("compressed");
			expect(extracted.contextSummary).toBe("summary of exploration");

			const msgs = await db
				.select()
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, extracted.id));
			expect(msgs).toHaveLength(1);
			expect(msgs[0]?.role).toBe("system");
			expect(msgs[0]?.parentToolUseId).toBeNull();
			const rawBlock = msgs[0]?.contentJson;
			const block = (typeof rawBlock === "string" ? JSON.parse(rawBlock) : rawBlock) as Array<{
				type: string;
				summary?: string;
			}>;
			expect(block[0]?.type).toBe("compact");
			expect(block[0]?.summary).toBe("summary of exploration");
		} finally {
			spy.mockRestore();
		}
	});

	test("ordinary fork still refuses subagent sources", async () => {
		seedPrimary();
		seedSubagent("sub");
		await expect(
			await captureWorkerRejectionThrower(
				narratorService.forkNarrator("sub", "m0", { inheritMode: "full" }),
			),
		).toThrow("Cannot fork from a subagent narrator");
	});
});
