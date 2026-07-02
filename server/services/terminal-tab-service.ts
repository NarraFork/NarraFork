import { eq } from "drizzle-orm";
import { db } from "../db";
import { terminalTabs } from "../db/schema";
import { NotFoundError } from "../lib/errors";
import { generateId } from "../lib/id";

export const terminalTabService = {
	async list(opts: { chapterId?: string; narratorId?: string }) {
		if (opts.chapterId) {
			return db.query.terminalTabs.findMany({
				where: eq(terminalTabs.chapterId, opts.chapterId),
				orderBy: terminalTabs.sortOrder,
			});
		}
		if (opts.narratorId) {
			return db.query.terminalTabs.findMany({
				where: eq(terminalTabs.narratorId, opts.narratorId),
				orderBy: terminalTabs.sortOrder,
			});
		}
		return [];
	},

	async create(opts: { chapterId?: string; narratorId?: string; name: string }) {
		const id = generateId();
		const now = new Date().toISOString();

		// Get max sort order for this context
		const existing = await this.list(opts);
		const maxOrder = existing.reduce((max, t) => Math.max(max, t.sortOrder), -1);

		const [tab] = await db
			.insert(terminalTabs)
			.values({
				id,
				chapterId: opts.chapterId ?? null,
				narratorId: opts.narratorId ?? null,
				name: opts.name,
				sortOrder: maxOrder + 1,
				createdAt: now,
			})
			.returning();

		return tab;
	},

	async update(id: string, opts: { name?: string }) {
		const tab = await db.query.terminalTabs.findFirst({
			where: eq(terminalTabs.id, id),
		});
		if (!tab) throw new NotFoundError("TerminalTab", id);

		const updates: Record<string, unknown> = {};
		if (opts.name !== undefined) updates.name = opts.name;

		if (Object.keys(updates).length > 0) {
			await db.update(terminalTabs).set(updates).where(eq(terminalTabs.id, id));
		}

		return { ...tab, ...updates };
	},

	async delete(id: string) {
		const tab = await db.query.terminalTabs.findFirst({
			where: eq(terminalTabs.id, id),
		});
		if (!tab) throw new NotFoundError("TerminalTab", id);
		await db.delete(terminalTabs).where(eq(terminalTabs.id, id));
	},

	async reorder(ids: string[]) {
		db.transaction((tx) => {
			for (let i = 0; i < ids.length; i++) {
				tx.update(terminalTabs).set({ sortOrder: i }).where(eq(terminalTabs.id, ids[i])).run();
			}
		});
	},

	async cleanupForChapter(chapterId: string) {
		await db.delete(terminalTabs).where(eq(terminalTabs.chapterId, chapterId));
	},

	async cleanupForNarrator(narratorId: string) {
		await db.delete(terminalTabs).where(eq(terminalTabs.narratorId, narratorId));
	},
};
