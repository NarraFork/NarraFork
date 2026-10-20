/**
 * Draft-shadow search/read tests for the knowledge service.
 *
 * Verifies the "working copy" model: when a user has an ACTIVE draft on an entry,
 * `search({ draftUserId })` matches and returns that entry from the DRAFT (title +
 * content via knowledge_drafts_fts), shadowing the committed main version. Without
 * draftUserId, search reflects only the committed version.
 *
 * Covers the title-dimension guarantee (reflection requirement): a draft only edits
 * content, not the title — so a term that survives only in the title must still match
 * even when the body no longer contains it.
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME (FTS triggers + ACL +
 * branch service all exercised).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { knowledgeDrafts, knowledgeEntries, narrators, projects, users } from "../../db/schema";
import { knowledgeSearchTool } from "../../lib/agent/tools/knowledge";
import type { ToolContext } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import { knowledgeBranchService } from "../knowledge-branch-service";
import {
	formatInjectionsBare,
	injectionKey,
	resolveInjections,
	scanToolOutputForKnowledge,
} from "../knowledge-injection";
import { knowledgeService } from "../knowledge-service";

let collectionId: string;
let userId: string;
const principal = { userId: "", role: "user" as const };

// Distinctive 3+ char tokens so the trigram FTS index can tokenize them.
const TAG = Date.now();
const BODY_ONLY_TERM = `bodyterm${TAG}`; // only ever in the body
const TITLE_ONLY_TERM = `titleterm${TAG}`; // only ever in the title
const DRAFT_NEW_TERM = `draftonly${TAG}`; // added by the draft only

beforeAll(async () => {
	const now = new Date().toISOString();
	userId = generateId();
	await db.insert(users).values({
		id: userId,
		username: `draft-author-${TAG}`,
		passwordHash: "x",
		role: "user",
		createdAt: now,
	});
	principal.userId = userId;

	const col = await knowledgeService.createCollection({ name: `draft-search-${TAG}` });
	collectionId = col.id;
});

describe("draft-shadow search", () => {
	test("a term added only in the draft is found WITH draftUserId, not without", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Alpha ${TITLE_ONLY_TERM}`,
			content: `original ${BODY_ONLY_TERM}`,
		});
		// Draft adds a brand-new term to the body.
		const draft = await knowledgeBranchService.createDraft(principal, entry.id, {});
		await knowledgeBranchService.updateDraft(principal, draft.id, {
			content: `original ${BODY_ONLY_TERM} ${DRAFT_NEW_TERM}`,
		});

		const withDraft = await knowledgeService.search({
			q: DRAFT_NEW_TERM,
			collectionId,
			draftUserId: userId,
		});
		expect(withDraft.some((r) => r.id === entry.id)).toBe(true);
		// The matched row should be flagged as coming from the draft.
		expect(withDraft.find((r) => r.id === entry.id)?.fromDraft).toBe(true);

		const withoutDraft = await knowledgeService.search({ q: DRAFT_NEW_TERM, collectionId });
		expect(withoutDraft.some((r) => r.id === entry.id)).toBe(false);
	});

	test("body shadow: a term the draft REMOVED from the body no longer matches with draftUserId", async () => {
		const removeTerm = `removeme${TAG}`;
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Beta ${TAG}`,
			content: `keep this ${removeTerm} here`,
		});
		// Draft deletes the term from the body.
		const draft = await knowledgeBranchService.createDraft(principal, entry.id, {});
		await knowledgeBranchService.updateDraft(principal, draft.id, {
			content: "keep this here",
		});

		// With draft shadow: the entry is represented by the draft, which no longer has the term.
		const withDraft = await knowledgeService.search({
			q: removeTerm,
			collectionId,
			draftUserId: userId,
		});
		expect(withDraft.some((r) => r.id === entry.id)).toBe(false);

		// Without draft shadow: the committed main version still has it.
		const withoutDraft = await knowledgeService.search({ q: removeTerm, collectionId });
		expect(withoutDraft.some((r) => r.id === entry.id)).toBe(true);
	});

	test("title dimension preserved: a title-only term still matches even after the draft empties the body", async () => {
		const titleTerm = `titlekeep${TAG}`;
		const bodyTerm = `bodydrop${TAG}`;
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Gamma ${titleTerm}`,
			content: `has ${bodyTerm} in body`,
		});
		// Draft wipes the body entirely (title is unchanged — drafts can't edit titles).
		const draft = await knowledgeBranchService.createDraft(principal, entry.id, {});
		await knowledgeBranchService.updateDraft(principal, draft.id, { content: "" });

		// The body term is gone from the draft → should NOT match.
		const byBody = await knowledgeService.search({
			q: bodyTerm,
			collectionId,
			draftUserId: userId,
		});
		expect(byBody.some((r) => r.id === entry.id)).toBe(false);

		// The title term must STILL match (de-normalized title in the draft FTS index).
		const byTitle = await knowledgeService.search({
			q: titleTerm,
			collectionId,
			draftUserId: userId,
		});
		expect(byTitle.some((r) => r.id === entry.id)).toBe(true);
		expect(byTitle.find((r) => r.id === entry.id)?.fromDraft).toBe(true);
	});

	test("entry without a draft is unaffected by draftUserId", async () => {
		const term = `plainentry${TAG}`;
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Delta ${TAG}`,
			content: `content ${term}`,
		});
		const res = await knowledgeService.search({ q: term, collectionId, draftUserId: userId });
		const hit = res.find((r) => r.id === entry.id);
		expect(hit).toBeDefined();
		expect(hit?.fromDraft).toBe(false);
	});
});

describe("standalone personal search", () => {
	test("linked results keep global identity and cannot bypass global ACL", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: "linkedaclmarker",
			content: "initial",
			tags: ["linked-tag"],
		});
		await knowledgeBranchService.createDraft(principal, entry.id, {});
		const ctx = { userId } as ToolContext;
		const result = await knowledgeSearchTool.execute(
			{ query: "linkedaclmarker", tag: "linked-tag" },
			ctx,
		);
		expect(result.metadata?.results).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: entry.id, fromDraft: true })]),
		);
		expect(
			(
				await knowledgeService.search({
					q: "linkedaclmarker",
					draftUserId: userId,
					includeStandalone: true,
				})
			)[0]?.personalEntryId,
		).toBeUndefined();
		await db
			.update(knowledgeEntries)
			.set({ classificationLevel: "unknown-denied-level" })
			.where(eq(knowledgeEntries.id, entry.id));
		expect(
			(await knowledgeSearchTool.execute({ query: "linkedaclmarker" }, ctx)).output,
		).not.toContain(entry.id);
	});
	test("owner-only index/substring search works without linked shadows and remains opt-in", async () => {
		const ownerId = generateId();
		await db.insert(users).values({
			id: ownerId,
			username: ownerId,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		const owner = { userId: ownerId, role: "user" as const };
		const draft = await knowledgeBranchService.createStandalone(owner, {
			title: "standalonesearchmarker 电池",
			content: "bodymatchmarker",
		});
		for (const q of ["standalonesearchmarker", "bodymatchmarker", "电池", ""]) {
			const opts = { q, draftUserId: ownerId, includeStandalone: true };
			const rows = await knowledgeService.search(opts);
			const hit = rows.find((row) => row.personalEntryId === draft.id);
			expect(hit).toMatchObject({
				id: draft.id,
				collectionId: null,
				fromDraft: true,
				drifted: false,
				tags: [],
			});
			expect(
				(await knowledgeService.search({ ...opts, includeStandalone: false })).some(
					(row) => row.id === draft.id,
				),
			).toBe(false);
			expect(
				(await knowledgeService.search({ ...opts, draftUserId: userId })).some(
					(row) => row.id === draft.id,
				),
			).toBe(false);
			expect(
				(await knowledgeService.search({ ...opts, draftUserId: undefined })).some(
					(row) => row.id === draft.id,
				),
			).toBe(false);
			expect(
				(await knowledgeService.search({ ...opts, tag: "anything" })).some(
					(row) => row.id === draft.id,
				),
			).toBe(false);
			expect(
				(await knowledgeService.search({ ...opts, collectionId })).some(
					(row) => row.id === draft.id,
				),
			).toBe(false);
		}
		const ctx = { userId: ownerId } as ToolContext;
		const result = await knowledgeSearchTool.execute({ query: "standalonesearchmarker" }, ctx);
		expect(result.output).toContain(`personalEntryId: ${draft.id}`);
		expect(result.metadata?.results).toEqual(
			expect.arrayContaining([expect.objectContaining({ personalEntryId: draft.id })]),
		);
		expect(
			(await knowledgeSearchTool.execute({ query: "standalonesearchmarker", useDraft: false }, ctx))
				.output,
		).not.toContain(draft.id);
		expect(
			(
				await knowledgeSearchTool.execute({ query: "standalonesearchmarker" }, {
					userId,
				} as ToolContext)
			).output,
		).not.toContain(draft.id);
		await db
			.update(knowledgeDrafts)
			.set({ status: "archived" })
			.where(eq(knowledgeDrafts.id, draft.id));
		expect(
			(
				await knowledgeService.search({
					q: "standalonesearchmarker",
					draftUserId: ownerId,
					includeStandalone: true,
				})
			).some((row) => row.id === draft.id),
		).toBe(false);
	});

	test("target collection obeys project/global scope while untargeted entries remain available", async () => {
		const projectId = generateId();
		const otherProjectId = generateId();
		const now = new Date().toISOString();
		await db.insert(projects).values(
			[projectId, otherProjectId].map((id) => ({
				id,
				name: id,
				status: "active" as const,
				flowMode: "classic" as const,
				createdAt: now,
				updatedAt: now,
			})),
		);
		const local = await knowledgeService.createCollection({ name: generateId(), projectId });
		const other = await knowledgeService.createCollection({
			name: generateId(),
			projectId: otherProjectId,
		});
		const drafts = await Promise.all(
			[undefined, collectionId, local.id, other.id].map((targetCollectionId) =>
				knowledgeBranchService.createStandalone(principal, {
					title: "targetscopemarker 电机",
					targetCollectionId,
				}),
			),
		);
		for (const q of ["targetscopemarker", "电机"]) {
			const opts = { q, draftUserId: userId, includeStandalone: true, projectId };
			const ids = (await knowledgeService.search(opts)).map((row) => row.id);
			for (const draft of drafts.slice(0, 3)) expect(ids).toContain(draft.id);
			expect(ids).not.toContain(drafts[3]!.id);
			expect(
				(await knowledgeService.search({ ...opts, collectionId: local.id })).map((row) => row.id),
			).toEqual([drafts[2]!.id]);
			expect(await knowledgeService.search({ ...opts, collectionId: other.id })).toEqual([]);
		}
	});
});

describe("passive injection matches author-declared keywords only", () => {
	test("an entry surfaces when the input contains a declared keyword", async () => {
		const kw = `injectkw${TAG}`;
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Epsilon ${TAG}`,
			content: "baseline content without the special term",
			keywords: [kw],
		});

		const hits = await resolveInjections(userId, `please recall ${kw} details`, {
			collectionId,
		});
		expect(hits.some((h) => h.entryId === entry.id)).toBe(true);
	});

	test("an entry with the term ONLY in its body (no keyword) is NOT injected", async () => {
		const bodyTerm = `bodyonlyterm${TAG}`;
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Zeta ${TAG}`,
			content: `this body mentions ${bodyTerm} but declares no keywords`,
			// no keywords → must never auto-inject
		});

		const hits = await resolveInjections(userId, `tell me about ${bodyTerm}`, {
			collectionId,
		});
		expect(hits.some((h) => h.entryId === entry.id)).toBe(false);

		// Sanity: the entry IS still findable via the explicit full-text search path.
		const found = await knowledgeService.search({ q: bodyTerm, collectionId });
		expect(found.some((r) => r.id === entry.id)).toBe(true);
	});

	test("updateEntryMeta keywords drive subsequent injection", async () => {
		const kw = `latekw${TAG}`;
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Eta ${TAG}`,
			content: "no special markers here",
			// Own the entry so updateEntryMeta (direct main write) is permitted below.
			authorUserId: userId,
		});
		// Not injected before any keyword is declared.
		const before = await resolveInjections(userId, `looking for ${kw}`, { collectionId });
		expect(before.some((h) => h.entryId === entry.id)).toBe(false);

		await knowledgeService.updateEntryMeta(entry.id, { keywords: [kw] }, principal);

		const after = await resolveInjections(userId, `looking for ${kw}`, { collectionId });
		expect(after.some((h) => h.entryId === entry.id)).toBe(true);
	});

	test("CJK sentence matches a declared keyword appearing anywhere in the input", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `CJK ${TAG}`,
			content: "charging diagnostics",
			keywords: ["充电故障"],
		});

		const hits = await resolveInjections(userId, "机器人出现了充电故障怎么办", {
			collectionId,
		});
		expect(hits.some((h) => h.entryId === entry.id)).toBe(true);
	});

	test("short CJK keywords are matched by dictionary scan", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Short CJK ${TAG}`,
			content: "battery diagnostics",
			keywords: ["电池"],
		});

		const hits = await resolveInjections(userId, "电池温度太高", { collectionId });
		expect(hits.some((h) => h.entryId === entry.id)).toBe(true);
	});

	test("nearby CJK text does not falsely match a longer keyword", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `CJK False Positive ${TAG}`,
			content: "charging diagnostics",
			keywords: ["充电故障"],
		});

		const hits = await resolveInjections(userId, "这里是充电故意写错的句子", {
			collectionId,
		});
		expect(hits.some((h) => h.entryId === entry.id)).toBe(false);
	});

	test("latin keywords require word boundaries", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Latin Boundary ${TAG}`,
			content: "cat diagnostics",
			keywords: ["cat"],
		});

		const falseHits = await resolveInjections(userId, "please concatenate these strings", {
			collectionId,
		});
		expect(falseHits.some((h) => h.entryId === entry.id)).toBe(false);

		const trueHits = await resolveInjections(userId, "the cat sensor failed", { collectionId });
		expect(trueHits.some((h) => h.entryId === entry.id)).toBe(true);
	});

	test("keyword late in a long tool output is still matched", async () => {
		const kw = `tooltailkw${TAG}`;
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Tool Tail ${TAG}`,
			content: "tool output diagnostics",
			keywords: [kw],
		});
		const already = new Set<string>();
		const output = `${"noise ".repeat(300)}final marker ${kw}`;

		const block = await scanToolOutputForKnowledge(userId, output, already, { collectionId });
		expect(block).not.toBeNull();
		expect(block).toContain(entry.id);
	});
});

describe("personal keyword injection", () => {
	test("owner-only standalone hints use explicit identity and durable cycle dedupe", async () => {
		const keyword = `personalhint${TAG}`;
		const draft = await knowledgeBranchService.createStandalone(principal, {
			title: "Personal hint",
			content: "private body",
			keywords: [keyword],
		});
		const hits = await resolveInjections(userId, keyword);
		expect(hits).toContainEqual(
			expect.objectContaining({ scope: "personal", entryId: draft.id, summary: "private body" }),
		);
		expect(await resolveInjections(null, keyword)).toEqual([]);
		const other = generateId();
		await db.insert(users).values({
			id: other,
			username: other,
			passwordHash: "x",
			role: "admin",
			createdAt: new Date().toISOString(),
		});
		expect(await resolveInjections(other, keyword)).toEqual([]);
		expect(formatInjectionsBare(hits, "heading")).toContain(
			JSON.stringify({ personalEntryId: draft.id }),
		);
		expect(
			formatInjectionsBare([{ entryId: "main", title: "Main", summary: "" }], "heading"),
		).toContain(JSON.stringify({ entryId: "main" }));
		const narratorId = generateId();
		const now = new Date().toISOString();
		await db.insert(narrators).values({ id: narratorId, createdAt: now, updatedAt: now });
		knowledgeService.recordInjectionEvents({
			narratorId,
			compactSeq: -1,
			source: "user_message",
			hits,
		});
		knowledgeService.recordInjectionEvents({
			narratorId,
			compactSeq: -1,
			source: "user_message",
			hits,
		});
		const already = await knowledgeService.listInjectedEntryIds(narratorId, -1);
		expect([...already]).toEqual([`personal:${draft.id}`]);
		expect(await resolveInjections(userId, keyword, { already })).toEqual([]);
		expect(
			(
				await resolveInjections(userId, keyword, {
					already: await knowledgeService.listInjectedEntryIds(narratorId, 1),
				})
			).length,
		).toBe(1);
		await db
			.update(knowledgeDrafts)
			.set({ status: "archived" })
			.where(eq(knowledgeDrafts.id, draft.id));
		expect(await resolveInjections(userId, keyword)).toEqual([]);
	});

	test("project/global targets and unassigned entries are eligible; edits refresh matcher", async () => {
		const now = new Date().toISOString();
		const projectId = generateId();
		const otherProjectId = generateId();
		await db.insert(projects).values(
			[projectId, otherProjectId].map((id) => ({
				id,
				name: id,
				gitPath: `/test/${id}`,
				createdAt: now,
				updatedAt: now,
			})),
		);
		const local = await knowledgeService.createCollection({ name: generateId(), projectId });
		const other = await knowledgeService.createCollection({
			name: generateId(),
			projectId: otherProjectId,
		});
		const keyword = `scopehint${TAG}`;
		const drafts = await Promise.all(
			[undefined, collectionId, local.id, other.id].map((targetCollectionId) =>
				knowledgeBranchService.createStandalone(principal, {
					title: "Scope",
					content: "body",
					keywords: [keyword],
					targetCollectionId,
				}),
			),
		);
		const ids = (await resolveInjections(userId, keyword, { projectId })).map((hit) => hit.entryId);
		for (const draft of drafts.slice(0, 3)) expect(ids).toContain(draft.id);
		expect(ids).not.toContain(drafts[3]!.id);
		const edited = drafts[0];
		if (!edited) throw new Error("Missing personal entry fixture");
		await db
			.update(knowledgeDrafts)
			.set({ keywordsJson: [`changed${TAG}`], updatedAt: "2099-01-01T00:00:00.000Z" })
			.where(eq(knowledgeDrafts.id, edited.id));
		expect(
			(await resolveInjections(userId, keyword, { projectId })).map((hit) => hit.entryId),
		).not.toContain(edited.id);
		expect(
			(await resolveInjections(userId, `changed${TAG}`, { projectId })).map((hit) => hit.entryId),
		).toContain(edited.id);
	});
});

describe("persistent injection de-dup ledger", () => {
	test("fresh in-memory sets can rebuild already-injected entries from DB", async () => {
		const kw = `ledgerkw${TAG}`;
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Ledger ${TAG}`,
			content: "body",
			keywords: [kw],
		});
		const narratorId = generateId();
		const now = new Date().toISOString();
		await db.insert(narrators).values({ id: narratorId, createdAt: now, updatedAt: now });

		const firstAlready = await knowledgeService.listInjectedEntryIds(narratorId, -1);
		const first = await resolveInjections(userId, `need ${kw}`, {
			collectionId,
			already: firstAlready,
		});
		expect(first.some((h) => h.entryId === entry.id)).toBe(true);
		knowledgeService.recordInjectionEvents({
			narratorId,
			compactSeq: -1,
			source: "user_message",
			hits: first,
		});

		const rebuiltAlready = await knowledgeService.listInjectedEntryIds(narratorId, -1);
		expect(rebuiltAlready.has(`global:${entry.id}`)).toBe(true);
		const second = await resolveInjections(userId, `need ${kw}`, {
			collectionId,
			already: rebuiltAlready,
		});
		expect(second.some((h) => h.entryId === entry.id)).toBe(false);

		const nextCycleAlready = await knowledgeService.listInjectedEntryIds(narratorId, 100);
		const afterCompact = await resolveInjections(userId, `need ${kw}`, {
			collectionId,
			already: nextCycleAlready,
		});
		expect(afterCompact.some((h) => h.entryId === entry.id)).toBe(true);
	});
});

describe("injection de-dup within a compact cycle (shared `already` set)", () => {
	test("the same entry is not re-injected while it stays in the shared set", async () => {
		const kw = `dedupkw${TAG}`;
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Theta ${TAG}`,
			content: "body",
			keywords: [kw],
		});

		// Simulate the cycle-scoped shared set used by the session runner (points A + B).
		const already = new Set<string>();

		// First scan finds and emits the entry, then records it in the shared set.
		const first = await scanToolOutputForKnowledge(userId, `log mentions ${kw}`, already, {
			collectionId,
		});
		expect(first).not.toBeNull();
		expect(first).toContain(entry.id);
		expect(already.has(`global:${entry.id}`)).toBe(true);

		// Second scan with the SAME set must not re-surface the entry (de-dup).
		const second = await scanToolOutputForKnowledge(userId, `again ${kw} here`, already, {
			collectionId,
		});
		expect(second).toBeNull();

		// A fresh set (simulating a crossed compact boundary) allows re-injection.
		const freshCycle = new Set<string>();
		const reinjected = await scanToolOutputForKnowledge(userId, `again ${kw} here`, freshCycle, {
			collectionId,
		});
		expect(reinjected).not.toBeNull();
		expect(reinjected).toContain(entry.id);
	});

	test("resolveInjections (point A) honours the same `already` set", async () => {
		const kw = `dedupakw${TAG}`;
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Iota ${TAG}`,
			content: "body",
			keywords: [kw],
		});
		const already = new Set<string>();

		const first = await resolveInjections(userId, `need ${kw}`, { collectionId, already });
		expect(first.some((h) => h.entryId === entry.id)).toBe(true);
		// Caller records the hit (mirrors the session runner) — next call skips it.
		for (const h of first) already.add(injectionKey(h));

		const second = await resolveInjections(userId, `need ${kw}`, { collectionId, already });
		expect(second.some((h) => h.entryId === entry.id)).toBe(false);
	});
});
