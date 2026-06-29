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
import { resolveInjections } from "../knowledge-injection";
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

describe("passive injection reflects the triggering user's draft", () => {
	test("a term only in the draft body surfaces as an injection hit for that user", async () => {
		const injectTerm = `injectdraft${TAG}`;
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Epsilon ${TAG}`,
			content: "baseline content without the special term",
		});
		const draft = await knowledgeBranchService.createDraft(principal, entry.id, {});
		await knowledgeBranchService.updateDraft(principal, draft.id, {
			content: `baseline content with ${injectTerm} added`,
		});

		// Triggering user (draft author) — injection should find the entry via the draft.
		const mine = await resolveInjections(userId, `please recall ${injectTerm} details`, {
			collectionId,
		});
		expect(mine.some((h) => h.entryId === entry.id)).toBe(true);

		// A different user with no draft — the term lives only in the author's draft, so
		// the committed version doesn't contain it and it must not surface.
		const otherUserId = generateId();
		await db.insert(users).values({
			id: otherUserId,
			username: `other-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		const theirs = await resolveInjections(otherUserId, `please recall ${injectTerm} details`, {
			collectionId,
		});
		expect(theirs.some((h) => h.entryId === entry.id)).toBe(false);
	});
});
