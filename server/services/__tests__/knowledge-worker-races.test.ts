import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
	knowledgeDrafts,
	knowledgeEntries,
	knowledgeRevisions,
	knowledgeSubmissions,
	users,
} from "../../db/schema";
import * as bridge from "../../db/worker-read";
import { generateId } from "../../lib/id";
import { knowledgeBranchService as branch } from "../knowledge-branch-service";
import { knowledgeService } from "../knowledge-service";

afterEach(() => mock.restore());

async function fixture() {
	const author = { userId: generateId(), role: "user" as const };
	const admin = { userId: generateId(), role: "admin" as const };
	for (const principal of [author, admin])
		await db.insert(users).values({
			id: principal.userId,
			username: principal.userId,
			passwordHash: "x",
			role: principal.role,
			createdAt: new Date().toISOString(),
		});
	const collection = await knowledgeService.createCollection({ name: generateId() });
	const entry = await knowledgeService.createEntry({
		collectionId: collection.id,
		title: generateId(),
		content: "base\n",
	});
	const draft = await branch.createDraft(author, entry.id, {});
	await branch.updateDraft(author, draft.id, { content: "base\nproposed\n" });
	const baseRevisionId = entry.currentRevisionId;
	if (!baseRevisionId) throw new Error("Fixture has no initial revision");
	return { author, admin, collection, entry, draft, baseRevisionId };
}

function interleave(table: string, ids: string[], write: () => Promise<unknown>) {
	const original = bridge.readQueryFirst;
	const originalMany = bridge.readQuery;
	let injected = false;
	const before = async (query: { toSQL(): { sql: string; params: unknown[] } }) => {
		const compiled = query.toSQL();
		if (
			!injected &&
			compiled.sql.includes(table) &&
			compiled.params.some((id) => ids.includes(String(id)))
		) {
			injected = true;
			await write();
		}
	};
	spyOn(bridge, "readQueryFirst").mockImplementation((async (query, options) => {
		await before(query);
		return original(query as Parameters<typeof original>[0], options);
	}) as typeof bridge.readQueryFirst);
	spyOn(bridge, "readQuery").mockImplementation((async (query, options) => {
		await before(query);
		return originalMany(query as Parameters<typeof originalMany>[0], options);
	}) as typeof bridge.readQuery);
	return () => expect(injected).toBe(true);
}

test("viewer never returns main content authorized by an entry older than its collection read", async () => {
	const f = await fixture();
	const injected = interleave("knowledge_collections", [f.collection.id, f.entry.id], async () => {
		await db
			.update(knowledgeEntries)
			.set({ classificationLevel: "confidential" })
			.where(eq(knowledgeEntries.id, f.entry.id));
	});
	const view = await branch.getMineForViewer(f.author, f.draft.id);
	injected();
	expect(view.currentMainContent).toBeNull();
	expect(view.entryTitle).toBeNull();
	expect(view.viewerCaps.canRebase).toBe(false);
});

test("merge refuses a main revision committed while loading the merge base", async () => {
	const f = await fixture();
	const submission = await branch.submitForReview(f.author, f.draft.id, {});
	const injected = interleave("knowledge_revisions", [f.baseRevisionId], async () => {
		await knowledgeService.addRevision(f.entry.id, { content: "concurrent main\n" });
	});
	const error = await branch.review(f.admin, submission.id, { verdict: "approve" }).catch((e) => e);
	injected();
	expect(error).toMatchObject({ code: "KNOWLEDGE_MAIN_CONFLICT", statusCode: 409 });
	expect(
		(await db.query.knowledgeEntries.findFirst({ where: eq(knowledgeEntries.id, f.entry.id) }))
			?.currentContent,
	).toBe("concurrent main\n");
	expect(
		db.select().from(knowledgeRevisions).where(eq(knowledgeRevisions.entryId, f.entry.id)).all(),
	).toHaveLength(2);
	expect(
		(
			await db.query.knowledgeSubmissions.findFirst({
				where: eq(knowledgeSubmissions.id, submission.id),
			})
		)?.status,
	).toBe("pending");
});

test("verdict refuses a submission published during the authority read", async () => {
	const f = await fixture();
	const submission = await branch.submitForReview(f.author, f.draft.id, {});
	const injected = interleave("knowledge_entries", [f.entry.id], async () => {
		await branch.review(f.admin, submission.id, { verdict: "approve" });
	});
	const error = await branch.review(f.admin, submission.id, { verdict: "reject" }).catch((e) => e);
	injected();
	expect(error).toMatchObject({ code: "KNOWLEDGE_SUBMISSION_CONFLICT", statusCode: 409 });
	expect(
		(
			await db.query.knowledgeSubmissions.findFirst({
				where: eq(knowledgeSubmissions.id, submission.id),
			})
		)?.status,
	).toBe("approved");
	expect(
		(await db.query.knowledgeEntries.findFirst({ where: eq(knowledgeEntries.id, f.entry.id) }))
			?.currentContent,
	).toBe("base\nproposed\n");
});

test("rebase preserves a draft saved while loading the merge base", async () => {
	const f = await fixture();
	await knowledgeService.addRevision(f.entry.id, { content: "main\nbase\n" });
	const injected = interleave("knowledge_revisions", [f.baseRevisionId], async () => {
		await branch.updateDraft(f.author, f.draft.id, { content: "saved in another tab\n" });
	});
	const error = await branch.rebaseDraft(f.author, f.draft.id, {}).catch((e) => e);
	injected();
	expect(error).toMatchObject({ code: "KNOWLEDGE_DRAFT_CONFLICT", statusCode: 409 });
	const draft = await db.query.knowledgeDrafts.findFirst({
		where: eq(knowledgeDrafts.id, f.draft.id),
	});
	expect(draft?.content).toBe("saved in another tab\n");
	expect(draft?.baseRevisionId).toBe(f.entry.currentRevisionId);
});

test("submission refuses a draft saved during the main revision lookup", async () => {
	const f = await fixture();
	const injected = interleave("knowledge_entries", [f.entry.id], async () => {
		await branch.updateDraft(f.author, f.draft.id, { content: "saved in another tab\n" });
	});
	const error = await branch.submitForReview(f.author, f.draft.id, {}).catch((e) => e);
	injected();
	expect(error).toMatchObject({ code: "KNOWLEDGE_DRAFT_CONFLICT", statusCode: 409 });
	expect(
		db
			.select()
			.from(knowledgeSubmissions)
			.where(eq(knowledgeSubmissions.draftId, f.draft.id))
			.all(),
	).toHaveLength(0);
	expect(
		(await db.query.knowledgeDrafts.findFirst({ where: eq(knowledgeDrafts.id, f.draft.id) }))
			?.content,
	).toBe("saved in another tab\n");
});
