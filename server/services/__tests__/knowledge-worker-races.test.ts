import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { knowledgeEntries, users } from "../../db/schema";
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
	return { author, admin, collection, entry, draft };
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
		return original(query, options);
	}) as typeof bridge.readQueryFirst);
	spyOn(bridge, "readQuery").mockImplementation((async (query, options) => {
		await before(query);
		return originalMany(query, options);
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
