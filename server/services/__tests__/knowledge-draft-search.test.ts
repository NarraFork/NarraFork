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
import { db } from "../../db";
import { users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { knowledgeBranchService } from "../knowledge-branch-service";
import { resolveInjections, scanToolOutputForKnowledge } from "../knowledge-injection";
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

		const withDraft = knowledgeService.search({
			q: DRAFT_NEW_TERM,
			collectionId,
			draftUserId: userId,
		});
		expect(withDraft.some((r) => r.id === entry.id)).toBe(true);
		// The matched row should be flagged as coming from the draft.
		expect(withDraft.find((r) => r.id === entry.id)?.fromDraft).toBe(true);

		const withoutDraft = knowledgeService.search({ q: DRAFT_NEW_TERM, collectionId });
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
		const withDraft = knowledgeService.search({
			q: removeTerm,
			collectionId,
			draftUserId: userId,
		});
		expect(withDraft.some((r) => r.id === entry.id)).toBe(false);

		// Without draft shadow: the committed main version still has it.
		const withoutDraft = knowledgeService.search({ q: removeTerm, collectionId });
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
		const byBody = knowledgeService.search({
			q: bodyTerm,
			collectionId,
			draftUserId: userId,
		});
		expect(byBody.some((r) => r.id === entry.id)).toBe(false);

		// The title term must STILL match (de-normalized title in the draft FTS index).
		const byTitle = knowledgeService.search({
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
		const res = knowledgeService.search({ q: term, collectionId, draftUserId: userId });
		const hit = res.find((r) => r.id === entry.id);
		expect(hit).toBeDefined();
		expect(hit?.fromDraft).toBe(false);
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
		const found = knowledgeService.search({ q: bodyTerm, collectionId });
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
		expect(already.has(entry.id)).toBe(true);

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
		for (const h of first) already.add(h.entryId);

		const second = await resolveInjections(userId, `need ${kw}`, { collectionId, already });
		expect(second.some((h) => h.entryId === entry.id)).toBe(false);
	});
});
