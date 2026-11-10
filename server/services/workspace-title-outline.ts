import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { outlineBlocks, workspacePanels, workspaces } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { workspaceTitleInputsChanged } from "./workspace-title";

export const OUTLINE_TITLE_EVENT_DEBOUNCE_MS = 100;
const MAX_PENDING_SPACES = 256;
const MAX_PENDING_PAGES = 256;
type Changes = Map<string, Set<string> | null>;
let pending: Changes = new Map();
let pendingAllSpaces = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let active: Promise<void> | undefined;

/**
 * Walk only kind-indexed outline memberships, in bounded pages, yielding between
 * pages. One scan serves every pending space; workspace grouping deduplicates in
 * constant memory. Never read layouts, outline bodies, or unrelated panel kinds.
 */
async function scanOutlineWorkspaceTitles(changes: Changes, allSpaces = false) {
	let afterWorkspace = "";
	let afterId = "";
	let lastInvalidatedWorkspace = "";
	for (;;) {
		const rows = await db
			.select({
				id: workspacePanels.id,
				workspaceId: workspacePanels.workspaceId,
				userId: workspaces.userId,
				configJson: workspacePanels.configJson,
			})
			.from(workspacePanels)
			.innerJoin(workspaces, eq(workspaces.id, workspacePanels.workspaceId))
			.where(
				and(
					eq(workspacePanels.kind, "outline"),
					sql`(${workspacePanels.workspaceId}, ${workspacePanels.id}) > (${afterWorkspace}, ${afterId})`,
				),
			)
			.orderBy(asc(workspacePanels.workspaceId), asc(workspacePanels.id))
			.limit(100);
		for (const row of rows) {
			if (row.workspaceId === lastInvalidatedWorkspace) continue;
			let config: Record<string, unknown> | null = null;
			try {
				config = JSON.parse(row.configJson ?? "null");
			} catch {
				/* ignore malformed historical metadata */
			}
			if (!config || typeof config.spaceId !== "string") continue;
			const changedPages = changes.get(config.spaceId);
			if (!allSpaces && changedPages === undefined) continue;
			if (
				!allSpaces &&
				typeof config.blockId === "string" &&
				changedPages?.size &&
				!changedPages.has(config.blockId)
			) {
				// Child-focused panels display their root page heading. A missing/deleted
				// focused block invalidates conservatively rather than preserving a stale token.
				const focused = await db.query.outlineBlocks.findFirst({
					where: and(
						eq(outlineBlocks.id, config.blockId),
						eq(outlineBlocks.spaceId, config.spaceId),
					),
					columns: { pageId: true },
				});
				if (focused && !changedPages.has(focused.pageId)) continue;
			}
			workspaceTitleInputsChanged(row.userId, row.workspaceId);
			lastInvalidatedWorkspace = row.workspaceId;
		}
		if (rows.length < 100) break;
		const last = rows[rows.length - 1];
		afterWorkspace = last.workspaceId;
		afterId = last.id;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

function scheduleFlush() {
	if (timer || active || (!pending.size && !pendingAllSpaces)) return;
	timer = setTimeout(() => {
		timer = undefined;
		void flushOutlineTitleInvalidations().catch((error) =>
			logger.warn("outline workspace title invalidation failed", { error }),
		);
	}, OUTLINE_TITLE_EVENT_DEBOUNCE_MS);
	timer.unref();
}

/** Bounded coalescing: overflow becomes one conservative sweep, never dropped changes. */
export function queueOutlineTitleInvalidation(spaceId: string, pageIds: readonly string[]) {
	if (pendingAllSpaces) return;
	if (!pending.has(spaceId) && pending.size >= MAX_PENDING_SPACES) {
		pending.clear();
		pendingAllSpaces = true;
	} else {
		const pages = pending.get(spaceId);
		if (!pageIds.length || pages === null || pageIds.length > MAX_PENDING_PAGES)
			pending.set(spaceId, null);
		else {
			const merged = pages ?? new Set<string>();
			for (const id of pageIds) {
				merged.add(id);
				if (merged.size > MAX_PENDING_PAGES) break;
			}
			pending.set(spaceId, merged.size > MAX_PENDING_PAGES ? null : merged);
		}
	}
	scheduleFlush();
}

/** Global single flight. Commits arriving during a sweep merge into the next bounded batch. */
export function flushOutlineTitleInvalidations(): Promise<void> {
	if (active) return active;
	if (timer) {
		clearTimeout(timer);
		timer = undefined;
	}
	if (!pending.size && !pendingAllSpaces) return Promise.resolve();
	const changes = pending;
	const allSpaces = pendingAllSpaces;
	pending = new Map();
	pendingAllSpaces = false;
	const started = Date.now();
	const flight = scanOutlineWorkspaceTitles(changes, allSpaces).finally(() => {
		active = undefined;
		if (Date.now() - started > 1000)
			logger.info("outline workspace title invalidation slow", {
				durationMs: Date.now() - started,
				spaces: changes.size,
				allSpaces,
			});
		scheduleFlush();
	});
	active = flight;
	return flight;
}

export function hasPendingOutlineTitleInvalidations(): boolean {
	return !!active || pending.size > 0 || pendingAllSpaces;
}

/**
 * Adoption waits for at most one batch, with a short deadline. Continuous commits
 * must cause a conflict, not an unbounded request. Callers check pending state
 * synchronously after their LAST await and before reading a revision / writing CAS.
 */
export async function settleOutlineTitleInvalidations(): Promise<void> {
	if (!hasPendingOutlineTitleInvalidations()) return;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			flushOutlineTitleInvalidations(),
			new Promise<void>((resolve) => {
				deadline = setTimeout(resolve, 250);
			}),
		]);
	} finally {
		clearTimeout(deadline);
	}
}

eventBus.on("outline:committed", ({ spaceId, pageIds }) =>
	queueOutlineTitleInvalidation(spaceId, pageIds),
);
