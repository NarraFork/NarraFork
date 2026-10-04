import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { terminalViewState } from "../db/schema";
import { generateId } from "../lib/id";
import { assertLegacyRuntimeOwner } from "./worktree-resource-owner";

export const terminalViewService = {
	async get(userId: string, opts: { chapterId?: string; narratorId?: string }) {
		assertLegacyRuntimeOwner(opts);
		const conditions = [
			eq(terminalViewState.userId, userId),
			isNull(terminalViewState.worktreeResourceId),
		];
		if (opts.chapterId) {
			conditions.push(eq(terminalViewState.chapterId, opts.chapterId));
		} else if (opts.narratorId) {
			conditions.push(eq(terminalViewState.narratorId, opts.narratorId));
		} else {
			return null;
		}

		return db.query.terminalViewState.findFirst({
			where: and(...conditions),
		});
	},

	async upsert(
		userId: string,
		opts: {
			chapterId?: string;
			narratorId?: string;
			layout?: string;
			activeTabId?: string | null;
			panelAssignments?: Record<string, string | string[]> | null;
		},
	) {
		const existing = await this.get(userId, opts);
		const now = new Date().toISOString();

		if (existing) {
			const updates: Record<string, unknown> = { updatedAt: now };
			if (opts.layout !== undefined) updates.layout = opts.layout;
			if (opts.activeTabId !== undefined) updates.activeTabId = opts.activeTabId;
			if (opts.panelAssignments !== undefined) updates.panelAssignments = opts.panelAssignments;

			await db.update(terminalViewState).set(updates).where(eq(terminalViewState.id, existing.id));
			return { ...existing, ...updates };
		}

		const [state] = await db
			.insert(terminalViewState)
			.values({
				id: generateId(),
				userId,
				chapterId: opts.chapterId ?? null,
				narratorId: opts.narratorId ?? null,
				layout: (opts.layout ?? "single") as "single" | "split-h" | "split-v" | "triple" | "quad",
				activeTabId: opts.activeTabId ?? null,
				panelAssignments: opts.panelAssignments ?? null,
				updatedAt: now,
			})
			.returning();

		return state;
	},
};
