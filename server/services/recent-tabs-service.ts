import {
	type PersistedRecentTab,
	RECENT_TABS_LEGACY_LIMIT,
	RECENT_TABS_LIVE_LIMIT,
	RECENT_TABS_PAGE_SIZE,
	RECENT_TABS_STALE_CURSOR_CODE,
	RECENT_TABS_STORAGE_LIMIT,
	RECENT_TABS_UNDO_CONFLICT_CODE,
	RECENT_TABS_WS_BATCH_SIZE,
	type RecentTabRuntimePatch,
	type RecentTabsDelta,
	type RecentTabsMutationResult,
	type RecentTabsOperation,
	type RecentTabsPageResult,
	type RecentTabsRuntimeResult,
	type RecentTabsSection,
	type RecentTabType,
} from "@shared/recent-tabs";
import { and, asc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	narrators,
	userPreferences,
	userRecentTabs,
	userRecentTabsMeta,
	users,
	workspaces,
} from "../db/schema";
import { userPreferencesLock } from "../lib/async-mutex";
import { AppError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import { broadcastToUser } from "../websocket/narrator-ws";

const RECENT_TAB_TEXT_MAX_CHARS = 1_000;
const UNDO_TTL_MS = 30_000;
const UNDO_MAX_ENTRIES = 1_000;
const PENDING_WORKSPACE_CLEANUP_MAX_ENTRIES = 1_000;
const SORT_ORDER_GAP = 1_000_000_000;
const ACTIVE_STATUSES = new Set(["working", "waiting"]);
const ATTENTION_SUBSTATUS = new Set(["unread", "error"]);

type RecentTabRow = typeof userRecentTabs.$inferSelect;
type RecentTabInsert = typeof userRecentTabs.$inferInsert;

interface UndoEntry {
	token: string;
	userId: string;
	expiresAt: number;
	revision: number;
	tabs: PersistedRecentTab[];
	deferredWorkspaceIds: string[];
}

interface PendingWorkspaceCleanup {
	token: string;
	userId: string;
	expiresAt: number;
	workspaceIds: string[];
}

interface MutationOptions {
	removedCount?: number;
	undoTabs?: PersistedRecentTab[];
	workspaceIdsToDelete?: string[];
	deferredWorkspaceIds?: string[];
	/**
	 * Extra work to run INSIDE the same transaction that persists the tab rows.
	 *
	 * This exists so workspace membership and its sidebar projection commit
	 * together. Writing them as two requests is what allowed a persisted sidebar
	 * tab to coexist with a panel that was never stored anywhere, and no amount of
	 * client-side reconciliation can close that window from outside a transaction.
	 *
	 * Runs even when the tab rows themselves need no change: "the projection
	 * already matches" is a normal outcome (re-adding a panel for a narrator whose
	 * tab is already attached), and skipping the membership write in that case
	 * would drop the caller's actual work.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Drizzle transaction type is private to the driver.
	inTransaction?: (tx: any) => void;
}

interface MutationState {
	tabs: PersistedRecentTab[];
	options?: MutationOptions;
}

const undoByUser = new Map<string, UndoEntry>();
const pendingWorkspaceCleanups = new Map<string, PendingWorkspaceCleanup>();
let workspaceCleanupTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleNextWorkspaceCleanup(): void {
	if (workspaceCleanupTimer) clearTimeout(workspaceCleanupTimer);
	workspaceCleanupTimer = undefined;
	let nextExpiry = Number.POSITIVE_INFINITY;
	for (const cleanup of pendingWorkspaceCleanups.values()) {
		nextExpiry = Math.min(nextExpiry, cleanup.expiresAt);
	}
	if (!Number.isFinite(nextExpiry)) return;
	workspaceCleanupTimer = setTimeout(
		() => {
			workspaceCleanupTimer = undefined;
			runExpiredRecentTabsWorkspaceCleanup().catch((error) => {
				logger.warn("Deferred RecentTabs workspace cleanup failed", { error: String(error) });
			});
		},
		Math.max(0, nextExpiry - Date.now()),
	);
	workspaceCleanupTimer.unref?.();
}

function scheduleDeferredWorkspaceCleanup(cleanup: PendingWorkspaceCleanup): void {
	if (cleanup.workspaceIds.length === 0) return;
	if (pendingWorkspaceCleanups.size >= PENDING_WORKSPACE_CLEANUP_MAX_ENTRIES) {
		logger.warn("Deferred RecentTabs workspace cleanup queue is full; startup cleanup will retry", {
			userId: cleanup.userId,
			workspaceCount: cleanup.workspaceIds.length,
		});
		return;
	}
	pendingWorkspaceCleanups.set(cleanup.token, cleanup);
	scheduleNextWorkspaceCleanup();
}

function cancelDeferredWorkspaceCleanup(token: string): void {
	if (!pendingWorkspaceCleanups.delete(token)) return;
	scheduleNextWorkspaceCleanup();
}

export async function runExpiredRecentTabsWorkspaceCleanup(now = Date.now()): Promise<number> {
	const due = [...pendingWorkspaceCleanups.values()].filter((cleanup) => cleanup.expiresAt <= now);
	let removed = 0;
	for (const cleanup of due) {
		pendingWorkspaceCleanups.delete(cleanup.token);
		const undo = undoByUser.get(cleanup.userId);
		if (undo?.token === cleanup.token && undo.expiresAt <= now) undoByUser.delete(cleanup.userId);
		const referencedRows = await db
			.select({ id: userRecentTabs.entityId })
			.from(userRecentTabs)
			.where(
				and(
					eq(userRecentTabs.userId, cleanup.userId),
					eq(userRecentTabs.type, "workspace"),
					inArray(userRecentTabs.entityId, cleanup.workspaceIds),
				),
			);
		const referenced = new Set(referencedRows.map((row) => row.id));
		const orphanIds = cleanup.workspaceIds.filter((id) => !referenced.has(id));
		if (orphanIds.length === 0) continue;
		const existingRows = await db
			.select({ id: workspaces.id })
			.from(workspaces)
			.where(and(eq(workspaces.userId, cleanup.userId), inArray(workspaces.id, orphanIds)));
		if (existingRows.length === 0) continue;
		await db.delete(workspaces).where(
			and(
				eq(workspaces.userId, cleanup.userId),
				inArray(
					workspaces.id,
					existingRows.map((row) => row.id),
				),
			),
		);
		removed += existingRows.length;
	}
	scheduleNextWorkspaceCleanup();
	return removed;
}

function storeUndo(entry: UndoEntry): void {
	const now = Date.now();
	for (const [userId, candidate] of undoByUser) {
		if (candidate.expiresAt < now) undoByUser.delete(userId);
	}
	undoByUser.delete(entry.userId);
	while (undoByUser.size >= UNDO_MAX_ENTRIES) {
		const oldestUserId = undoByUser.keys().next().value;
		if (typeof oldestUserId !== "string") break;
		undoByUser.delete(oldestUserId);
	}
	undoByUser.set(entry.userId, entry);
}

function tabKey(tab: Pick<PersistedRecentTab, "type" | "id">): string {
	return `${tab.type}:${tab.id}`;
}

function tabSection(type: RecentTabType): RecentTabsSection {
	return type === "project" ? "projects" : "work";
}

function getTabNarratorId(tab: PersistedRecentTab): string | undefined {
	if (tab.type === "narrator" || tab.type === "subagent") return tab.id;
	if (tab.type === "chapter") return tab.narratorId;
	return undefined;
}

function cloneTab(tab: PersistedRecentTab): PersistedRecentTab {
	return { ...tab };
}

function normalizeLegacyTab(value: unknown): PersistedRecentTab | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const rawType = raw.type === "session" ? "narrator" : raw.type;
	// "group" (chat-group) tabs are dropped: the feature was removed, so such a
	// tab would render without a target route. The enum itself stays so historical
	// rows still decode; they are filtered out on read (see readRows).
	if (
		rawType !== "chapter" &&
		rawType !== "narrator" &&
		rawType !== "project" &&
		rawType !== "workspace" &&
		rawType !== "subagent"
	) {
		return null;
	}
	if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 50) return null;
	if (typeof raw.title !== "string") return null;
	if (typeof raw.lastVisitedAt !== "number" || !Number.isFinite(raw.lastVisitedAt)) return null;

	const tab: PersistedRecentTab = {
		type: rawType,
		id: raw.id,
		title: raw.title.slice(0, RECENT_TAB_TEXT_MAX_CHARS),
		lastVisitedAt: Math.trunc(raw.lastVisitedAt),
	};
	if (typeof raw.narratorId === "string" && raw.narratorId.length <= 50) {
		tab.narratorId = raw.narratorId;
	}
	if (typeof raw.parentNarratorId === "string" && raw.parentNarratorId.length <= 50) {
		tab.parentNarratorId = raw.parentNarratorId;
	}
	if (typeof raw.workspaceId === "string" && raw.workspaceId.length <= 50) {
		tab.workspaceId = raw.workspaceId;
	}
	if (typeof raw.subtitle === "string") {
		tab.subtitle = raw.subtitle.slice(0, RECENT_TAB_TEXT_MAX_CHARS);
	}
	if (typeof raw.status === "string" && raw.status.length <= 50) tab.status = raw.status;
	if (raw.pinned === true) tab.pinned = true;
	if (raw.isScheduled === true) tab.isScheduled = true;
	return tab;
}

function normalizeTab(tab: PersistedRecentTab): PersistedRecentTab {
	const normalized: PersistedRecentTab = {
		type: tab.type,
		id: tab.id,
		title: tab.title.slice(0, RECENT_TAB_TEXT_MAX_CHARS),
		lastVisitedAt: Math.trunc(tab.lastVisitedAt),
	};
	if (tab.narratorId) normalized.narratorId = tab.narratorId;
	if (tab.parentNarratorId) normalized.parentNarratorId = tab.parentNarratorId;
	if (tab.workspaceId !== undefined) normalized.workspaceId = tab.workspaceId;
	if (tab.subtitle !== undefined) {
		normalized.subtitle = tab.subtitle.slice(0, RECENT_TAB_TEXT_MAX_CHARS);
	}
	if (tab.status !== undefined) normalized.status = tab.status;
	if (tab.pinned) normalized.pinned = true;
	if (tab.isScheduled) normalized.isScheduled = true;
	if (tab.dirSortOrder !== undefined) normalized.dirSortOrder = tab.dirSortOrder;
	return normalized;
}

/** Keep workspace headers and children contiguous. Orphans become top-level tabs. */
function regroupWorkspaces(input: PersistedRecentTab[]): PersistedRecentTab[] {
	const tabs = input.map(cloneTab);
	const childrenByWorkspace = new Map<string, PersistedRecentTab[]>();
	for (const tab of tabs) {
		if (!tab.workspaceId) continue;
		const children = childrenByWorkspace.get(tab.workspaceId);
		if (children) children.push(tab);
		else childrenByWorkspace.set(tab.workspaceId, [tab]);
	}
	if (childrenByWorkspace.size === 0) return tabs;

	const topLevel = tabs.filter((tab) => !tab.workspaceId);
	const result: PersistedRecentTab[] = [];
	const headerIds = new Set<string>();
	for (const tab of topLevel) {
		result.push(tab);
		if (tab.type !== "workspace") continue;
		headerIds.add(tab.id);
		result.push(...(childrenByWorkspace.get(tab.id) ?? []));
	}
	for (const [workspaceId, children] of childrenByWorkspace) {
		if (headerIds.has(workspaceId)) continue;
		for (const child of children) {
			delete child.workspaceId;
			result.push(child);
		}
	}
	return result;
}

function deduplicateTabs(input: PersistedRecentTab[]): PersistedRecentTab[] {
	const seen = new Set<string>();
	const result: PersistedRecentTab[] = [];
	for (const tab of input) {
		const key = tabKey(tab);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalizeTab(tab));
	}
	return regroupWorkspaces(result);
}

function workspaceGroupRange(
	tabs: PersistedRecentTab[],
	index: number,
): { start: number; end: number } {
	const tab = tabs[index];
	if (!tab) return { start: index, end: index };
	const workspaceId = tab.type === "workspace" ? tab.id : tab.workspaceId;
	if (!workspaceId) return { start: index, end: index };
	const start = tabs.findIndex(
		(candidate) => candidate.type === "workspace" && candidate.id === workspaceId,
	);
	if (start < 0) return { start: index, end: index };
	let end = start;
	while (end + 1 < tabs.length && tabs[end + 1]?.workspaceId === workspaceId) end++;
	return { start, end };
}

function trimTabsAtomic(
	input: PersistedRecentTab[],
	limit: number,
	protectedKey?: string,
): { tabs: PersistedRecentTab[]; protectedGroupTooLarge: boolean } {
	const tabs = regroupWorkspaces(input);
	if (tabs.length <= limit) return { tabs, protectedGroupTooLarge: false };

	const protectedIndex = protectedKey
		? tabs.findIndex((candidate) => tabKey(candidate) === protectedKey)
		: -1;
	const protectedRange = protectedIndex >= 0 ? workspaceGroupRange(tabs, protectedIndex) : null;
	if (protectedRange && protectedRange.end - protectedRange.start + 1 > limit) {
		return { tabs: input, protectedGroupTooLarge: true };
	}

	const isProtectedIndex = (index: number): boolean =>
		protectedRange != null && index >= protectedRange.start && index <= protectedRange.end;
	const findCandidate = (kind: "subagent" | "unpinned" | "any"): number => {
		for (let index = tabs.length - 1; index >= 0; index--) {
			if (tabs[index]?.workspaceId) continue;
			const range = workspaceGroupRange(tabs, index);
			if (isProtectedIndex(range.start)) continue;
			const header = tabs[range.start];
			if (kind === "subagent" && (header.type !== "subagent" || header.pinned)) continue;
			if (kind === "unpinned" && header.pinned) continue;
			return range.start;
		}
		return -1;
	};

	while (tabs.length > limit) {
		let index = findCandidate("subagent");
		if (index < 0) index = findCandidate("unpinned");
		if (index < 0) index = findCandidate("any");
		if (index < 0) return { tabs: input, protectedGroupTooLarge: true };
		const range = workspaceGroupRange(tabs, index);
		tabs.splice(range.start, range.end - range.start + 1);
	}
	return { tabs, protectedGroupTooLarge: false };
}

function normalizeAndLimitTabs(
	input: PersistedRecentTab[],
	protectedKey?: string,
): { tabs: PersistedRecentTab[]; protectedGroupTooLarge: boolean } {
	return trimTabsAtomic(deduplicateTabs(input), RECENT_TABS_STORAGE_LIMIT, protectedKey);
}

function parseLegacyTabs(recentTabsJson: string | null | undefined): PersistedRecentTab[] {
	let values: unknown[] = [];
	try {
		const parsed = JSON.parse(recentTabsJson ?? "[]");
		if (Array.isArray(parsed)) values = parsed;
	} catch {
		// Corrupt legacy JSON migrates to an empty authoritative list.
	}
	const tabs = values
		.map(normalizeLegacyTab)
		.filter((tab): tab is PersistedRecentTab => tab !== null);
	return normalizeAndLimitTabs(tabs).tabs;
}

function rowToTab(row: RecentTabRow): PersistedRecentTab {
	const tab: PersistedRecentTab = {
		type: row.type,
		id: row.entityId,
		title: row.title,
		lastVisitedAt: row.lastVisitedAt,
	};
	if (row.narratorId) tab.narratorId = row.narratorId;
	if (row.parentNarratorId) tab.parentNarratorId = row.parentNarratorId;
	if (row.workspaceId) tab.workspaceId = row.workspaceId;
	if (row.subtitle != null) tab.subtitle = row.subtitle;
	if (row.status != null) tab.status = row.status;
	if (row.pinned) tab.pinned = true;
	if (row.isScheduled) tab.isScheduled = true;
	if (row.dirSortOrder != null) tab.dirSortOrder = row.dirSortOrder;
	return tab;
}

/**
 * Chat groups were removed, but historical `type = "group"` rows are still in the
 * table (the enum is kept so they decode). They have no route to open, so every
 * read path excludes them at the SQL level — inside the query, so cursor/hasMore
 * math on the paginated path stays consistent.
 */
const EXCLUDE_REMOVED_TAB_TYPES = ne(userRecentTabs.type, "group");

function readRows(userId: string): RecentTabRow[] {
	return db
		.select()
		.from(userRecentTabs)
		.where(and(eq(userRecentTabs.userId, userId), EXCLUDE_REMOVED_TAB_TYPES))
		.orderBy(asc(userRecentTabs.sortOrder), asc(userRecentTabs.tabKey))
		.limit(RECENT_TABS_STORAGE_LIMIT + 1)
		.all();
}

function readRevision(userId: string): number | null {
	return (
		db
			.select({ revision: userRecentTabsMeta.revision })
			.from(userRecentTabsMeta)
			.where(eq(userRecentTabsMeta.userId, userId))
			.get()?.revision ?? null
	);
}

function buildRowValue(
	userId: string,
	tab: PersistedRecentTab,
	sortOrder: number,
	now: string,
	existing?: RecentTabRow,
): RecentTabInsert {
	return {
		id: existing?.id ?? generateId(),
		userId,
		tabKey: tabKey(tab),
		section: tabSection(tab.type),
		type: tab.type,
		entityId: tab.id,
		narratorId: tab.narratorId ?? null,
		representedNarratorId: getTabNarratorId(tab) ?? null,
		parentNarratorId: tab.parentNarratorId ?? null,
		workspaceId: tab.workspaceId ?? null,
		title: tab.title,
		subtitle: tab.subtitle ?? null,
		status: tab.status ?? null,
		lastVisitedAt: tab.lastVisitedAt,
		pinned: tab.pinned ?? false,
		isScheduled: tab.isScheduled ?? false,
		sortOrder,
		// A cwd change moves the tab to a DIFFERENT directory group, so a position
		// index earned in the old group must not travel with it — it would interleave
		// with the new group's members and produce an order nobody chose. Only
		// narrator/subagent subtitles are cwds, and for those a subtitle change IS a
		// cwd change; other types never take part in directory aggregation, so
		// clearing is a no-op for them.
		dirSortOrder: dirSortOrderFor(tab, existing),
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
}

/**
 * The `dir_sort_order` to persist for a tab.
 *
 * A cwd change wins over the value on the tab, and that ordering is load-bearing rather
 * than a preference. An upsert merges the STORED tab under the incoming one
 * (`{...tabs[index], ...tab}`), so by the time the value reaches here a position carried
 * over from the database is indistinguishable from one the reorder endpoint just set —
 * checking "explicit value present" first therefore never cleared anything.
 *
 * Testing the subtitle first is safe because the reorder endpoint writes only
 * `dirSortOrder` and never touches the subtitle, so its writes always take the branch
 * below.
 */
function dirSortOrderFor(tab: PersistedRecentTab, existing?: RecentTabRow): number | null {
	if (existing && existing.subtitle !== (tab.subtitle ?? null)) return null;
	if (tab.dirSortOrder !== undefined) return tab.dirSortOrder;
	return existing?.dirSortOrder ?? null;
}

function insertRowsInTransaction(
	// biome-ignore lint/suspicious/noExplicitAny: Drizzle transaction type is private to the driver.
	tx: any,
	userId: string,
	tabs: PersistedRecentTab[],
	oldRows: RecentTabRow[],
	now: string,
): void {
	if (tabs.length === 0) return;
	const existingByKey = new Map(oldRows.map((row) => [row.tabKey, row]));
	const values = tabs.map((tab, index) =>
		buildRowValue(userId, tab, index * SORT_ORDER_GAP, now, existingByKey.get(tabKey(tab))),
	);
	tx.insert(userRecentTabs).values(values).run();
}

/** Longest order-preserving subset whose existing sort keys can remain untouched. */
function stableOrderKeys(oldRows: RecentTabRow[], tabs: PersistedRecentTab[]): Set<string> {
	const oldIndexByKey = new Map(oldRows.map((row, index) => [row.tabKey, index]));
	const sequence = tabs
		.map((tab) => ({ key: tabKey(tab), oldIndex: oldIndexByKey.get(tabKey(tab)) }))
		.filter((entry): entry is { key: string; oldIndex: number } => entry.oldIndex !== undefined);
	if (sequence.length === 0) return new Set();

	const tails: number[] = [];
	const previous = new Array<number>(sequence.length).fill(-1);
	for (let index = 0; index < sequence.length; index++) {
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (sequence[tails[middle]].oldIndex < sequence[index].oldIndex) low = middle + 1;
			else high = middle;
		}
		if (low > 0) previous[index] = tails[low - 1];
		tails[low] = index;
	}

	const stable = new Set<string>();
	let cursor = tails.at(-1) ?? -1;
	while (cursor >= 0) {
		stable.add(sequence[cursor].key);
		cursor = previous[cursor];
	}
	return stable;
}

function reindexedSortOrders(tabs: PersistedRecentTab[]): Map<string, number> {
	return new Map(tabs.map((tab, index) => [tabKey(tab), index * SORT_ORDER_GAP]));
}

/**
 * Preserve existing sort keys for the longest unchanged subsequence and allocate sparse integer
 * keys only for inserted/moved rows. A full reindex is the bounded fallback when a gap is exhausted.
 */
function desiredSortOrders(
	tabs: PersistedRecentTab[],
	oldRows: RecentTabRow[],
): Map<string, number> {
	const oldByKey = new Map(oldRows.map((row) => [row.tabKey, row]));
	const stable = stableOrderKeys(oldRows, tabs);
	const result = new Map<string, number>();
	for (const key of stable) {
		const row = oldByKey.get(key);
		if (row) result.set(key, row.sortOrder);
	}

	let index = 0;
	while (index < tabs.length) {
		const key = tabKey(tabs[index]);
		if (stable.has(key)) {
			index++;
			continue;
		}
		const start = index;
		while (index < tabs.length && !stable.has(tabKey(tabs[index]))) index++;
		const count = index - start;
		const lower = start > 0 ? result.get(tabKey(tabs[start - 1])) : undefined;
		const upper = index < tabs.length ? result.get(tabKey(tabs[index])) : undefined;
		const values: number[] = [];
		if (lower !== undefined && upper !== undefined) {
			const step = Math.floor((upper - lower) / (count + 1));
			if (step < 1) return reindexedSortOrders(tabs);
			for (let offset = 1; offset <= count; offset++) values.push(lower + step * offset);
		} else if (lower !== undefined) {
			for (let offset = 1; offset <= count; offset++) values.push(lower + SORT_ORDER_GAP * offset);
		} else if (upper !== undefined) {
			for (let offset = count; offset >= 1; offset--) values.push(upper - SORT_ORDER_GAP * offset);
		} else {
			for (let offset = 0; offset < count; offset++) values.push(offset * SORT_ORDER_GAP);
		}
		if (values.some((value) => !Number.isSafeInteger(value))) return reindexedSortOrders(tabs);
		for (let offset = 0; offset < count; offset++) {
			result.set(tabKey(tabs[start + offset]), values[offset]);
		}
	}
	return result;
}

function rowNeedsUpdate(row: RecentTabRow, desired: RecentTabInsert): boolean {
	return (
		row.section !== desired.section ||
		row.type !== desired.type ||
		row.entityId !== desired.entityId ||
		row.narratorId !== desired.narratorId ||
		row.representedNarratorId !== desired.representedNarratorId ||
		row.parentNarratorId !== desired.parentNarratorId ||
		row.workspaceId !== desired.workspaceId ||
		row.title !== desired.title ||
		row.subtitle !== desired.subtitle ||
		row.status !== desired.status ||
		row.lastVisitedAt !== desired.lastVisitedAt ||
		row.pinned !== desired.pinned ||
		row.isScheduled !== desired.isScheduled ||
		row.sortOrder !== desired.sortOrder ||
		// Normalize both sides: the column is nullable and the desired value may be
		// `undefined` from a partially built insert, and `null !== undefined` would
		// otherwise report a change on every write.
		(row.dirSortOrder ?? null) !== (desired.dirSortOrder ?? null)
	);
}

function applyRowDiffInTransaction(
	// biome-ignore lint/suspicious/noExplicitAny: Drizzle transaction type is private to the driver.
	tx: any,
	userId: string,
	tabs: PersistedRecentTab[],
	oldRows: RecentTabRow[],
	now: string,
): void {
	const oldByKey = new Map(oldRows.map((row) => [row.tabKey, row]));
	const nextKeys = new Set(tabs.map(tabKey));
	const removedKeys = oldRows.filter((row) => !nextKeys.has(row.tabKey)).map((row) => row.tabKey);
	if (removedKeys.length > 0) {
		tx.delete(userRecentTabs)
			.where(and(eq(userRecentTabs.userId, userId), inArray(userRecentTabs.tabKey, removedKeys)))
			.run();
	}

	const sortOrders = desiredSortOrders(tabs, oldRows);
	const inserts: RecentTabInsert[] = [];
	for (const tab of tabs) {
		const key = tabKey(tab);
		const existing = oldByKey.get(key);
		const desired = buildRowValue(userId, tab, sortOrders.get(key) ?? 0, now, existing);
		if (!existing) {
			inserts.push(desired);
			continue;
		}
		if (!rowNeedsUpdate(existing, desired)) continue;
		tx.update(userRecentTabs)
			.set({
				section: desired.section,
				type: desired.type,
				entityId: desired.entityId,
				narratorId: desired.narratorId,
				representedNarratorId: desired.representedNarratorId,
				parentNarratorId: desired.parentNarratorId,
				workspaceId: desired.workspaceId,
				title: desired.title,
				subtitle: desired.subtitle,
				status: desired.status,
				lastVisitedAt: desired.lastVisitedAt,
				pinned: desired.pinned,
				isScheduled: desired.isScheduled,
				sortOrder: desired.sortOrder,
				dirSortOrder: desired.dirSortOrder ?? null,
				updatedAt: now,
			})
			.where(eq(userRecentTabs.id, existing.id))
			.run();
	}
	if (inserts.length > 0) tx.insert(userRecentTabs).values(inserts).run();
}

function writeLegacyShadowInTransaction(
	// biome-ignore lint/suspicious/noExplicitAny: Drizzle transaction type is private to the driver.
	tx: any,
	userId: string,
	tabs: PersistedRecentTab[],
	now: string,
): void {
	const recentTabs = JSON.stringify(tabs.slice(0, RECENT_TABS_LEGACY_LIMIT));
	tx.insert(userPreferences)
		.values({
			id: generateId(),
			userId,
			recentTabs,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: userPreferences.userId,
			set: { recentTabs, updatedAt: now },
		})
		.run();
}

function ensureMigratedLocked(userId: string): number {
	const existingRevision = readRevision(userId);
	if (existingRevision != null) return existingRevision;

	const legacy = db
		.select({ recentTabs: userPreferences.recentTabs })
		.from(userPreferences)
		.where(eq(userPreferences.userId, userId))
		.get();
	const tabs = parseLegacyTabs(legacy?.recentTabs);
	const now = new Date().toISOString();

	db.transaction((tx) => {
		insertRowsInTransaction(tx, userId, tabs, [], now);
		tx.insert(userRecentTabsMeta)
			.values({ userId, revision: 0, migratedAt: now, createdAt: now, updatedAt: now })
			.run();
		writeLegacyShadowInTransaction(tx, userId, tabs, now);
	});
	return 0;
}

/** Lazily migrate one user's legacy JSON array into the authoritative row store. */
export async function ensureMigrated(userId: string): Promise<number> {
	return userPreferencesLock.acquire(userId, async () => ensureMigratedLocked(userId));
}

const MIGRATION_BATCH_SIZE = 100;
let ensureAllRecentTabsMigrationPromise: Promise<void> | undefined;

async function runAllRecentTabsMigration(): Promise<void> {
	let cursor: string | undefined;
	while (true) {
		const rows = await db
			.select({ userId: userPreferences.userId })
			.from(userPreferences)
			.leftJoin(userRecentTabsMeta, eq(userRecentTabsMeta.userId, userPreferences.userId))
			.where(
				and(
					isNull(userRecentTabsMeta.userId),
					cursor ? gt(userPreferences.userId, cursor) : undefined,
				),
			)
			.orderBy(asc(userPreferences.userId))
			.limit(MIGRATION_BATCH_SIZE);
		if (rows.length === 0) break;
		for (const row of rows) await ensureMigrated(row.userId);
		cursor = rows.at(-1)?.userId;
		if (rows.length < MIGRATION_BATCH_SIZE) break;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

async function migratePendingRecentTabsUsers(): Promise<void> {
	const pending = await db
		.select({ userId: userPreferences.userId })
		.from(userPreferences)
		.leftJoin(userRecentTabsMeta, eq(userRecentTabsMeta.userId, userPreferences.userId))
		.where(isNull(userRecentTabsMeta.userId))
		.limit(1);
	if (pending.length > 0) await runAllRecentTabsMigration();
}

/** One process-wide in-flight migration pass used by membership-index consumers. */
export function ensureAllRecentTabsMigrated(): Promise<void> {
	if (!ensureAllRecentTabsMigrationPromise) {
		ensureAllRecentTabsMigrationPromise = migratePendingRecentTabsUsers().finally(() => {
			ensureAllRecentTabsMigrationPromise = undefined;
		});
	}
	return ensureAllRecentTabsMigrationPromise;
}

function tabsEqual(left: PersistedRecentTab[], right: PersistedRecentTab[]): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function operationAnchors(
	tabs: PersistedRecentTab[],
	index: number,
): { beforeKey: string | null; afterKey: string | null } {
	return {
		beforeKey: index + 1 < tabs.length ? tabKey(tabs[index + 1]) : null,
		afterKey: index > 0 ? tabKey(tabs[index - 1]) : null,
	};
}

function diffOperations(
	before: PersistedRecentTab[],
	after: PersistedRecentTab[],
): RecentTabsOperation[] {
	const beforeByKey = new Map(before.map((tab, index) => [tabKey(tab), { tab, index }]));
	const afterKeys = new Set(after.map(tabKey));
	const operations: RecentTabsOperation[] = [];
	for (const tab of before) {
		const key = tabKey(tab);
		if (!afterKeys.has(key)) operations.push({ type: "remove", key });
	}
	for (let index = 0; index < after.length; index++) {
		const tab = after[index];
		const key = tabKey(tab);
		const previous = beforeByKey.get(key);
		const anchors = operationAnchors(after, index);
		if (!previous || JSON.stringify(previous.tab) !== JSON.stringify(tab)) {
			operations.push({ type: "upsert", key, tab, ...anchors });
			continue;
		}
		const previousKey = previous.index > 0 ? tabKey(before[previous.index - 1]) : null;
		if (previousKey !== anchors.afterKey) operations.push({ type: "move", key, ...anchors });
	}
	return operations;
}

function broadcastDelta(userId: string, result: RecentTabsMutationResult): void {
	if (!result.changed || result.operations.length === 0) return;
	const batchCount = Math.ceil(result.operations.length / RECENT_TABS_WS_BATCH_SIZE);
	for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
		const event: RecentTabsDelta = {
			type: "user:recent_tabs_delta",
			baseRevision: result.baseRevision,
			revision: result.revision,
			operations: result.operations.slice(
				batchIndex * RECENT_TABS_WS_BATCH_SIZE,
				(batchIndex + 1) * RECENT_TABS_WS_BATCH_SIZE,
			),
			batchIndex,
			batchCount,
		};
		broadcastToUser(userId, event);
	}
}

function persistMutationLocked(
	userId: string,
	oldRows: RecentTabRow[],
	before: PersistedRecentTab[],
	after: PersistedRecentTab[],
	baseRevision: number,
	options: MutationOptions = {},
): RecentTabsMutationResult {
	if (tabsEqual(before, after)) {
		// The tab rows need no change, but `inTransaction` work still has to run and
		// still has to be atomic — see the field's note. Without this branch, adding a
		// panel for a narrator whose sidebar tab was already attached would silently
		// perform no membership write at all.
		if (options.inTransaction) {
			const runInTransaction = options.inTransaction;
			db.transaction((tx) => {
				runInTransaction(tx);
			});
		}
		return {
			changed: false,
			baseRevision,
			revision: baseRevision,
			operations: [],
			removedCount: options.removedCount,
		};
	}

	const revision = baseRevision + 1;
	const now = new Date().toISOString();
	db.transaction((tx) => {
		applyRowDiffInTransaction(tx, userId, after, oldRows, now);
		// Before the meta/revision write so a throw from the caller's work aborts the
		// whole thing, leaving neither the membership change nor a bumped revision.
		options.inTransaction?.(tx);
		tx.update(userRecentTabsMeta)
			.set({ revision, updatedAt: now })
			.where(eq(userRecentTabsMeta.userId, userId))
			.run();
		writeLegacyShadowInTransaction(tx, userId, after, now);
		const workspaceIds = [...new Set(options.workspaceIdsToDelete ?? [])];
		if (workspaceIds.length > 0) {
			tx.delete(workspaces)
				.where(and(eq(workspaces.userId, userId), inArray(workspaces.id, workspaceIds)))
				.run();
		}
	});

	const result: RecentTabsMutationResult = {
		changed: true,
		baseRevision,
		revision,
		operations: diffOperations(before, after),
		removedCount: options.removedCount,
	};
	if (options.undoTabs && (options.removedCount ?? 0) > 0) {
		const token = generateId();
		const expiresAt = Date.now() + UNDO_TTL_MS;
		const deferredWorkspaceIds = [...new Set(options.deferredWorkspaceIds ?? [])];
		storeUndo({
			token,
			userId,
			expiresAt,
			revision,
			tabs: options.undoTabs.map(cloneTab),
			deferredWorkspaceIds,
		});
		scheduleDeferredWorkspaceCleanup({
			token,
			userId,
			expiresAt,
			workspaceIds: deferredWorkspaceIds,
		});
		result.undoToken = token;
	}
	broadcastDelta(userId, result);
	return result;
}

async function mutate(
	userId: string,
	transform: (tabs: PersistedRecentTab[]) => MutationState | Promise<MutationState>,
): Promise<RecentTabsMutationResult> {
	return userPreferencesLock.acquire(userId, async () => {
		const baseRevision = ensureMigratedLocked(userId);
		const oldRows = readRows(userId);
		const before = oldRows.map(rowToTab);
		const transformed = await transform(before.map(cloneTab));
		const normalized = normalizeAndLimitTabs(transformed.tabs);
		return persistMutationLocked(
			userId,
			oldRows,
			before,
			normalized.tabs,
			baseRevision,
			transformed.options,
		);
	});
}

function getPinnedSectionEndIndex(tabs: PersistedRecentTab[]): number {
	let index = 0;
	while (index < tabs.length) {
		const tab = tabs[index];
		if (tab.workspaceId) {
			index++;
			continue;
		}
		if (!tab.pinned) break;
		const range = workspaceGroupRange(tabs, index);
		index = range.end + 1;
	}
	return index;
}

function findRepresentedTabIndex(
	tabs: PersistedRecentTab[],
	tab: PersistedRecentTab,
	updateOnly: boolean,
): number {
	let index = tabs.findIndex((candidate) => tabKey(candidate) === tabKey(tab));
	if (index < 0 && updateOnly && tab.type === "narrator") {
		index = tabs.findIndex((candidate) => getTabNarratorId(candidate) === tab.id);
	}
	return index;
}

export type RecentTabUpsertInput = PersistedRecentTab & {
	updateOnly?: boolean;
	/**
	 * Position the tab relative to an existing one, in the same revision that creates
	 * or updates it. Mutually exclusive; see `upsertRecentTabSchema`.
	 */
	beforeKey?: string;
	afterKey?: string;
};

/**
 * Place a group at `anchorKey`, reporting whether the anchor existed.
 *
 * Deliberately NOT `insertRelativeToKey`, which appends when the anchor is missing. That
 * is right for an explicit move (the user asked for a position; the bottom is a position),
 * but wrong for an upsert: a stale anchor there would yank an existing tab to the bottom
 * of the list on what the user experienced as a plain revisit.
 */
function tryInsertRelativeToKey(
	tabs: PersistedRecentTab[],
	group: PersistedRecentTab[],
	anchorKey: string,
	position: "before" | "after",
): boolean {
	const anchorIndex = tabs.findIndex((tab) => tabKey(tab) === anchorKey);
	if (anchorIndex < 0) return false;
	// Anchoring to a member of a workspace means anchoring to the whole group: the group
	// is kept contiguous by `regroupWorkspaces`, so an index inside it is not a position
	// anything can actually land at.
	const range = workspaceGroupRange(tabs, anchorIndex);
	tabs.splice(position === "before" ? range.start : range.end + 1, 0, ...group);
	return true;
}

function applyRecentTabUpsert(
	current: PersistedRecentTab[],
	input: RecentTabUpsertInput,
): PersistedRecentTab[] {
	const { updateOnly, beforeKey, afterKey, ...tabInput } = input;
	const tab = normalizeTab(tabInput);
	const key = tabKey(tab);
	const anchorKey = beforeKey ?? afterKey;
	// Self-anchoring has no meaning and would be read as "already in place".
	const anchor =
		anchorKey && anchorKey !== key
			? { key: anchorKey, position: beforeKey ? ("before" as const) : ("after" as const) }
			: null;
	const before = current.map(cloneTab);
	const tabs = current.map(cloneTab);
	const index = findRepresentedTabIndex(tabs, tab, updateOnly === true);
	if (index >= 0) {
		if (updateOnly) {
			const patch: Partial<PersistedRecentTab> = {};
			for (const [field, value] of Object.entries(tab)) {
				if (field === "type" || field === "id") continue;
				if (value !== "" && value !== undefined) {
					(patch as Record<string, unknown>)[field] = value;
				}
			}
			tabs[index] = normalizeTab({ ...tabs[index], ...patch });
		} else {
			// Re-visiting a normal tab updates metadata in place. Only explicit move/pin changes order.
			tabs[index] = normalizeTab({ ...tabs[index], ...tab });
		}
		// An anchor on an already-present tab repositions it, so dropping a tab that
		// happens to be in the sidebar already lands where it was aimed instead of
		// silently doing nothing. Skipped once the tab belongs to a workspace: the group
		// owns its members' positions (`regroupWorkspaces` would undo it anyway).
		if (anchor && !tabs[index].workspaceId) {
			const { group } = extractMovedGroup(tabs, index);
			if (!tryInsertRelativeToKey(tabs, group, anchor.key, anchor.position)) {
				// Anchor gone: leave the tab exactly where it was rather than relocating it.
				tabs.splice(index, 0, ...group);
			}
		}
	} else if (!updateOnly) {
		if (tab.workspaceId) {
			const headerIndex = tabs.findIndex(
				(candidate) => candidate.type === "workspace" && candidate.id === tab.workspaceId,
			);
			if (headerIndex >= 0) {
				const range = workspaceGroupRange(tabs, headerIndex);
				tabs.splice(range.end + 1, 0, tab);
			} else {
				delete tab.workspaceId;
				insertNewTab(tabs, tab, anchor);
			}
		} else {
			insertNewTab(tabs, tab, anchor);
		}
	}
	const normalized = normalizeAndLimitTabs(tabs, key);
	return normalized.protectedGroupTooLarge ? before : normalized.tabs;
}

/** Insert a brand-new top-level tab at its anchor, or at the default insertion point. */
function insertNewTab(
	tabs: PersistedRecentTab[],
	tab: PersistedRecentTab,
	anchor: { key: string; position: "before" | "after" } | null,
): void {
	if (anchor && tryInsertRelativeToKey(tabs, [tab], anchor.key, anchor.position)) return;
	tabs.splice(getPinnedSectionEndIndex(tabs), 0, tab);
}

export async function upsertRecentTabsBatch(
	userId: string,
	inputs: RecentTabUpsertInput[],
): Promise<RecentTabsMutationResult> {
	if (inputs.length === 0 || inputs.length > RECENT_TABS_WS_BATCH_SIZE) {
		throw new ValidationError(`Recent-tabs batch must contain 1-${RECENT_TABS_WS_BATCH_SIZE} tabs`);
	}
	return userPreferencesLock.acquire(userId, async () => {
		const baseRevision = ensureMigratedLocked(userId);
		const oldRows = readRows(userId);
		const before = oldRows.map(rowToTab);
		let after = before.map(cloneTab);
		const orderedInputs = [
			...inputs.filter((input) => input.type === "workspace" && !input.workspaceId),
			...inputs.filter((input) => input.type !== "workspace" || !!input.workspaceId),
		];
		for (const input of orderedInputs) after = applyRecentTabUpsert(after, input);
		return persistMutationLocked(userId, oldRows, before, after, baseRevision);
	});
}

export async function upsertRecentTab(
	userId: string,
	tabInput: PersistedRecentTab,
	options: { updateOnly?: boolean; beforeKey?: string; afterKey?: string } = {},
): Promise<RecentTabsMutationResult> {
	return upsertRecentTabsBatch(userId, [
		{
			...tabInput,
			updateOnly: options.updateOnly,
			...(options.beforeKey ? { beforeKey: options.beforeKey } : {}),
			...(options.afterKey ? { afterKey: options.afterKey } : {}),
		},
	]);
}

/**
 * Attach or detach one narrator's sidebar tab from a workspace group, running
 * the caller's own membership write in the SAME transaction.
 *
 * This is the only way `workspace_panels` and `user_recent_tabs.workspace_id`
 * are allowed to change together. The membership row is the authority; this
 * function maintains its sidebar projection so the two cannot diverge — which is
 * precisely what happened while a client wrote the tab and separately hoped a
 * panel would be persisted later.
 *
 * `attach` is expressed as an update-only upsert: the tab must already exist for
 * it to join a group. A narrator with no sidebar tab still becomes a real panel
 * (membership does not depend on the projection); it simply has no row to move,
 * and the tab it later acquires is created attached.
 */
export async function applyWorkspaceMembershipProjection(
	userId: string,
	input: {
		narratorId: string;
		/** Target workspace, or null to release the tab back to the top level. */
		workspaceId: string | null;
		// biome-ignore lint/suspicious/noExplicitAny: Drizzle transaction type is private to the driver.
		inTransaction: (tx: any) => void;
	},
): Promise<RecentTabsMutationResult> {
	return userPreferencesLock.acquire(userId, async () => {
		const baseRevision = ensureMigratedLocked(userId);
		const oldRows = readRows(userId);
		const before = oldRows.map(rowToTab);
		const after = before.map((tab) => {
			if (getTabNarratorId(tab) !== input.narratorId) return cloneTab(tab);
			const next = cloneTab(tab);
			if (input.workspaceId === null) delete next.workspaceId;
			else next.workspaceId = input.workspaceId;
			return next;
		});
		// `regroupWorkspaces` (inside normalizeAndLimitTabs, via persistMutationLocked's
		// caller contract) keeps a header and its children contiguous, so the moved tab
		// lands in the right group without this function knowing the ordering rules.
		const normalized = normalizeAndLimitTabs(after);
		return persistMutationLocked(userId, oldRows, before, normalized.tabs, baseRevision, {
			inTransaction: input.inTransaction,
		});
	});
}

export async function removeRecentTab(
	userId: string,
	type: RecentTabType,
	id: string,
): Promise<RecentTabsMutationResult> {
	return mutate(userId, (tabs) => {
		const key = `${type}:${id}`;
		const index = tabs.findIndex((tab) => tabKey(tab) === key);
		if (index < 0) return { tabs };
		if (type !== "workspace") {
			tabs.splice(index, 1);
			return { tabs };
		}
		const range = workspaceGroupRange(tabs, index);
		const children = tabs.slice(range.start + 1, range.end + 1).map((child) => {
			const released = cloneTab(child);
			delete released.workspaceId;
			return released;
		});
		tabs.splice(range.start, range.end - range.start + 1, ...children);
		return { tabs, options: { workspaceIdsToDelete: [id] } };
	});
}

function extractMovedGroup(
	tabs: PersistedRecentTab[],
	index: number,
): { group: PersistedRecentTab[]; originalIndex: number } {
	const tab = tabs[index];
	if (tab.type !== "workspace") return { group: tabs.splice(index, 1), originalIndex: index };
	const range = workspaceGroupRange(tabs, index);
	return {
		group: tabs.splice(range.start, range.end - range.start + 1),
		originalIndex: range.start,
	};
}

/**
 * Move-path insert: falls back to the END of the list when the anchor is gone.
 *
 * That fallback is specific to an explicit move — the user asked for a position, so
 * landing at the bottom is a worse position but still an answer. The upsert path must
 * NOT behave this way (see `tryInsertRelativeToKey`).
 */
function insertRelativeToKey(
	tabs: PersistedRecentTab[],
	group: PersistedRecentTab[],
	anchorKey: string,
	position: "before" | "after",
): void {
	if (!tryInsertRelativeToKey(tabs, group, anchorKey, position)) tabs.push(...group);
}

export interface MoveRecentTabInput {
	key: string;
	toIndex?: number;
	position?: "top" | "above_idle";
	beforeKey?: string;
	afterKey?: string;
}

export async function moveRecentTab(
	userId: string,
	input: MoveRecentTabInput,
): Promise<RecentTabsMutationResult> {
	return mutate(userId, async (tabs) => {
		let index = tabs.findIndex((tab) => tabKey(tab) === input.key);
		if (index < 0) return { tabs };
		if (input.position === "above_idle" && tabs[index]?.workspaceId) {
			const workspaceId = tabs[index].workspaceId;
			index = tabs.findIndex((tab) => tab.type === "workspace" && tab.id === workspaceId);
			if (index < 0) return { tabs };
		}
		const { group, originalIndex } = extractMovedGroup(tabs, index);

		if (input.beforeKey) insertRelativeToKey(tabs, group, input.beforeKey, "before");
		else if (input.afterKey) insertRelativeToKey(tabs, group, input.afterKey, "after");
		else if (input.position === "top") tabs.unshift(...group);
		else if (input.position === "above_idle") {
			const narratorIds = tabs.map(getTabNarratorId).filter((id): id is string => id !== undefined);
			const statusByNarrator = new Map<string, string>();
			if (narratorIds.length > 0) {
				const rows = await db
					.select({ id: narrators.id, status: narrators.status })
					.from(narrators)
					.where(inArray(narrators.id, narratorIds));
				for (const row of rows) statusByNarrator.set(row.id, row.status);
			}
			let firstIdle = -1;
			for (let candidateIndex = 0; candidateIndex < tabs.length; candidateIndex++) {
				const candidate = tabs[candidateIndex];
				if (candidate.workspaceId || candidate.pinned) continue;
				const range = workspaceGroupRange(tabs, candidateIndex);
				const groupTabs = tabs.slice(range.start, range.end + 1);
				const represented = groupTabs
					.map(getTabNarratorId)
					.filter((id): id is string => id !== undefined);
				if (
					represented.length > 0 &&
					represented.every((id) => statusByNarrator.get(id) === "idle")
				) {
					firstIdle = range.start;
					break;
				}
				candidateIndex = range.end;
			}
			tabs.splice(firstIdle < 0 ? tabs.length : firstIdle, 0, ...group);
		} else if (input.toIndex != null) {
			tabs.splice(Math.min(input.toIndex, tabs.length), 0, ...group);
		} else {
			tabs.splice(originalIndex, 0, ...group);
		}
		return { tabs: regroupWorkspaces(tabs) };
	});
}

/**
 * Persist the member order the user arranged by hand inside one directory group.
 *
 * Writes ONLY `dir_sort_order`; the flat order is left exactly as it was. That
 * separation is the whole point: the flat order carries recency and is rewritten by
 * the `above_idle` auto-promote whenever a narrator starts working, so expressing a
 * hand-made arrangement as flat moves meant it was wiped by the next status change.
 *
 * `keys` is the desired order. Keys not present in the user's tabs are ignored rather
 * than rejected — the client's view can legitimately lag a removal, and failing the
 * whole reorder because one row vanished would lose the rest of the intent.
 */
export async function setRecentTabDirectoryOrder(
	userId: string,
	keys: string[],
): Promise<RecentTabsMutationResult> {
	return mutate(userId, (tabs) => {
		const positionByKey = new Map(keys.map((key, index) => [key, index]));
		for (const tab of tabs) {
			const position = positionByKey.get(tabKey(tab));
			if (position === undefined) continue;
			tab.dirSortOrder = position;
		}
		return { tabs };
	});
}

export async function pinRecentTab(
	userId: string,
	key: string,
	pinned: boolean,
): Promise<RecentTabsMutationResult> {
	return mutate(userId, (tabs) => {
		let index = tabs.findIndex((tab) => tabKey(tab) === key);
		if (index < 0) return { tabs };
		if (tabs[index]?.workspaceId) {
			const workspaceId = tabs[index].workspaceId;
			index = tabs.findIndex((tab) => tab.type === "workspace" && tab.id === workspaceId);
			if (index < 0) return { tabs };
		}
		const current = tabs[index];
		if (!!current.pinned === pinned) return { tabs };
		const { group } = extractMovedGroup(tabs, index);
		if (pinned) group[0].pinned = true;
		else delete group[0].pinned;
		tabs.splice(getPinnedSectionEndIndex(tabs), 0, ...group);
		return { tabs };
	});
}

function isKeepUnit(tabs: PersistedRecentTab[], index: number, keepTabKey?: string): boolean {
	if (!keepTabKey) return false;
	const range = workspaceGroupRange(tabs, index);
	return tabs.slice(range.start, range.end + 1).some((tab) => tabKey(tab) === keepTabKey);
}

export async function clearRecentTabs(
	userId: string,
	scope: "all" | "projects" | "inactive_narrators",
	keepTabKey?: string,
): Promise<RecentTabsMutationResult> {
	return userPreferencesLock.acquire(userId, async () => {
		const baseRevision = ensureMigratedLocked(userId);
		const oldRows = readRows(userId);
		const before = oldRows.map(rowToTab);
		const narratorIds = before.map(getTabNarratorId).filter((id): id is string => id !== undefined);
		const activeNarrators = new Set<string>();
		if (scope === "inactive_narrators" && narratorIds.length > 0) {
			const rows = await db
				.select({ id: narrators.id, status: narrators.status, substatus: narrators.substatus })
				.from(narrators)
				.where(inArray(narrators.id, narratorIds));
			for (const row of rows) {
				const substatus = parseSubstatus(row.substatus);
				if (
					ACTIVE_STATUSES.has(row.status) ||
					(row.status === "idle" && substatus.some((value) => ATTENTION_SUBSTATUS.has(value)))
				) {
					activeNarrators.add(row.id);
				}
			}
		}

		const after: PersistedRecentTab[] = [];
		const deferredWorkspaceIds: string[] = [];
		for (let index = 0; index < before.length; index++) {
			if (before[index]?.workspaceId) continue;
			const range = workspaceGroupRange(before, index);
			const unit = before.slice(range.start, range.end + 1);
			const keptExplicitly = isKeepUnit(before, index, keepTabKey);
			// Pinning is an explicit user intent to keep a tab around; no clear scope may
			// drop it. `pinned` only ever lives on the unit header (see `pinRecentTab`).
			let keep = keptExplicitly || unit[0].pinned === true;
			if (!keep && scope === "projects") keep = tabSection(unit[0].type) !== "projects";
			if (!keep && scope === "inactive_narrators") {
				if (unit[0].type === "project") keep = true;
				else {
					keep = unit
						.map(getTabNarratorId)
						.filter((id): id is string => id !== undefined)
						.some((id) => activeNarrators.has(id));
				}
			}
			if (keep) after.push(...unit);
			else if (scope === "inactive_narrators" && unit[0].type === "workspace") {
				deferredWorkspaceIds.push(unit[0].id);
			}
			index = range.end;
		}
		const removedCount = before.length - after.length;
		return persistMutationLocked(userId, oldRows, before, after, baseRevision, {
			removedCount,
			undoTabs: removedCount > 0 ? before : undefined,
			deferredWorkspaceIds,
		});
	});
}

export async function restoreRecentTabs(
	userId: string,
	input: { tabs?: PersistedRecentTab[]; token?: string },
): Promise<RecentTabsMutationResult> {
	if (input.token) {
		return userPreferencesLock.acquire(userId, async () => {
			const entry = undoByUser.get(userId);
			if (!entry || entry.token !== input.token || entry.expiresAt < Date.now()) {
				if (entry && entry.expiresAt < Date.now()) undoByUser.delete(userId);
				throw new ValidationError("Recent-tabs undo token is invalid or expired");
			}
			const baseRevision = ensureMigratedLocked(userId);
			if (baseRevision !== entry.revision) {
				undoByUser.delete(userId);
				throw new AppError(
					"Recent-tabs changed after clear; the undo snapshot can no longer be restored",
					409,
					RECENT_TABS_UNDO_CONFLICT_CODE,
				);
			}
			const oldRows = readRows(userId);
			const before = oldRows.map(rowToTab);
			const after = normalizeAndLimitTabs(entry.tabs.map(cloneTab)).tabs;
			const result = persistMutationLocked(userId, oldRows, before, after, baseRevision);
			undoByUser.delete(userId);
			cancelDeferredWorkspaceCleanup(entry.token);
			return result;
		});
	}
	if (!input.tabs) throw new ValidationError("tabs or token required");
	const normalized = normalizeAndLimitTabs(input.tabs.map(cloneTab)).tabs;
	return mutate(userId, () => ({ tabs: normalized }));
}

interface CursorPayload {
	s: RecentTabsSection;
	r: number;
	o: number;
	k: string;
}

function encodeCursor(row: RecentTabRow, section: RecentTabsSection, revision: number): string {
	return Buffer.from(
		JSON.stringify({ s: section, r: revision, o: row.sortOrder, k: row.tabKey }),
		"utf8",
	).toString("base64url");
}

function decodeCursor(cursor: string | undefined): CursorPayload | null {
	if (!cursor) return null;
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			(parsed?.s !== "projects" && parsed?.s !== "work") ||
			typeof parsed?.r !== "number" ||
			!Number.isInteger(parsed.r) ||
			typeof parsed?.o !== "number" ||
			!Number.isInteger(parsed.o) ||
			typeof parsed?.k !== "string"
		) {
			throw new Error("invalid cursor");
		}
		return parsed;
	} catch {
		throw new ValidationError("Invalid recent-tabs cursor");
	}
}

export async function listPage(
	userId: string,
	section: RecentTabsSection,
	cursor?: string,
	limit = RECENT_TABS_PAGE_SIZE,
): Promise<RecentTabsPageResult> {
	return userPreferencesLock.acquire(userId, async () => {
		const revision = ensureMigratedLocked(userId);
		const decoded = decodeCursor(cursor);
		if (decoded && (decoded.s !== section || decoded.r !== revision)) {
			throw new AppError(
				"Recent-tabs cursor is stale; reload the section from the first page",
				409,
				RECENT_TABS_STALE_CURSOR_CODE,
			);
		}
		const pageLimit = Math.max(1, Math.min(limit, RECENT_TABS_PAGE_SIZE));
		const baseWhere = and(
			eq(userRecentTabs.userId, userId),
			eq(userRecentTabs.section, section),
			isNull(userRecentTabs.workspaceId),
			EXCLUDE_REMOVED_TAB_TYPES,
		);
		const cursorWhere = decoded
			? or(
					gt(userRecentTabs.sortOrder, decoded.o),
					and(eq(userRecentTabs.sortOrder, decoded.o), gt(userRecentTabs.tabKey, decoded.k)),
				)
			: undefined;
		const topLevelRows = db
			.select()
			.from(userRecentTabs)
			.where(cursorWhere ? and(baseWhere, cursorWhere) : baseWhere)
			.orderBy(asc(userRecentTabs.sortOrder), asc(userRecentTabs.tabKey))
			.limit(pageLimit + 1)
			.all();
		const hasMore = topLevelRows.length > pageLimit;
		const pageTopLevelRows = topLevelRows.slice(0, pageLimit);
		const workspaceIds = pageTopLevelRows
			.filter((row) => row.type === "workspace")
			.map((row) => row.entityId);
		const children =
			workspaceIds.length > 0
				? db
						.select()
						.from(userRecentTabs)
						.where(
							and(
								eq(userRecentTabs.userId, userId),
								eq(userRecentTabs.section, section),
								inArray(userRecentTabs.workspaceId, workspaceIds),
							),
						)
						.orderBy(asc(userRecentTabs.sortOrder), asc(userRecentTabs.tabKey))
						.limit(RECENT_TABS_STORAGE_LIMIT)
						.all()
				: [];
		const childrenByWorkspace = new Map<string, RecentTabRow[]>();
		for (const child of children) {
			if (!child.workspaceId) continue;
			const workspaceChildren = childrenByWorkspace.get(child.workspaceId);
			if (workspaceChildren) workspaceChildren.push(child);
			else childrenByWorkspace.set(child.workspaceId, [child]);
		}
		const pageRows: RecentTabRow[] = [];
		for (const row of pageTopLevelRows) {
			pageRows.push(row);
			if (row.type === "workspace") {
				pageRows.push(...(childrenByWorkspace.get(row.entityId) ?? []));
			}
		}
		const lastTopLevelRow = pageTopLevelRows.at(-1);
		return {
			items: pageRows.map(rowToTab),
			revision,
			hasMore,
			nextCursor:
				hasMore && lastTopLevelRow ? encodeCursor(lastTopLevelRow, section, revision) : null,
		};
	});
}

export async function listLegacyTabs(userId: string): Promise<PersistedRecentTab[]> {
	return userPreferencesLock.acquire(userId, async () => {
		ensureMigratedLocked(userId);
		return readRows(userId).slice(0, RECENT_TABS_LEGACY_LIMIT).map(rowToTab);
	});
}

/** Bounded authoritative snapshot for server-side consumers that need global tab ordering. */
export async function listAllRecentTabs(
	userId: string,
	limit = RECENT_TABS_STORAGE_LIMIT,
): Promise<PersistedRecentTab[]> {
	return userPreferencesLock.acquire(userId, async () => {
		ensureMigratedLocked(userId);
		const boundedLimit = Math.max(1, Math.min(limit, RECENT_TABS_STORAGE_LIMIT));
		return readRows(userId).slice(0, boundedLimit).map(rowToTab);
	});
}

export async function getRuntimePatches(
	userId: string,
	keys: string[],
): Promise<RecentTabsRuntimeResult> {
	if (keys.length > RECENT_TABS_LIVE_LIMIT) {
		throw new ValidationError(`At most ${RECENT_TABS_LIVE_LIMIT} recent-tab keys are allowed`);
	}
	const uniqueKeys = [...new Set(keys)];
	const snapshot = await userPreferencesLock.acquire(userId, async () => {
		const revision = ensureMigratedLocked(userId);
		if (uniqueKeys.length === 0) return { revision, tabs: [] as PersistedRecentTab[] };
		const rows = await db
			.select()
			.from(userRecentTabs)
			.where(and(eq(userRecentTabs.userId, userId), inArray(userRecentTabs.tabKey, uniqueKeys)));
		const byKey = new Map(rows.map((row) => [row.tabKey, rowToTab(row)]));
		return {
			revision,
			tabs: uniqueKeys
				.map((key) => byKey.get(key))
				.filter((tab): tab is PersistedRecentTab => !!tab),
		};
	});
	if (snapshot.tabs.length === 0) return { revision: snapshot.revision, patches: [] };
	const tabs = snapshot.tabs;
	const { enrichTabs } = await import("./user-preferences-service");
	const enriched = await enrichTabs(
		tabs.map((tab) => ({ ...tab })) as Record<string, unknown>[],
		userId,
	);
	const patches: RecentTabRuntimePatch[] = enriched.map((tab) => ({
		key: `${String(tab.type)}:${String(tab.id)}`,
		patch: {
			status: tab.status ?? null,
			substatus: tab.substatus ?? null,
			hasDraft: tab.hasDraft ?? false,
			activeTerminalCount: tab.activeTerminalCount ?? 0,
			viewers: tab.viewers ?? [],
			viewerCount: tab.viewerCount ?? 0,
			containerStatus: tab.containerStatus ?? null,
		},
	}));
	return { revision: snapshot.revision, patches };
}

function promoteTopLevelTab(tabs: PersistedRecentTab[], index: number): PersistedRecentTab[] {
	if (index < 0) return tabs;
	if (tabs[index]?.workspaceId) {
		const workspaceId = tabs[index].workspaceId;
		index = tabs.findIndex((tab) => tab.type === "workspace" && tab.id === workspaceId);
		if (index < 0) return tabs;
	}
	if (tabs[index].pinned) return tabs;
	const { group } = extractMovedGroup(tabs, index);
	tabs.splice(getPinnedSectionEndIndex(tabs), 0, ...group);
	return tabs;
}

/** Promote the draft owner's represented tab without scanning other users' JSON preferences. */
export async function syncNarratorDraftToRecentTabs(
	userId: string,
	narratorId: string,
	options: { promote: boolean },
): Promise<void> {
	if (!options.promote) return;
	await mutate(userId, (tabs) => {
		const index = tabs.findIndex((tab) => getTabNarratorId(tab) === narratorId);
		return { tabs: promoteTopLevelTab(tabs, index) };
	});
}

export async function getRecentTabUserIds(type: RecentTabType, id: string): Promise<string[]> {
	await ensureAllRecentTabsMigrated();
	const userIds: string[] = [];
	let cursor: string | undefined;
	while (true) {
		const rows = await db
			.selectDistinct({ userId: userRecentTabs.userId })
			.from(userRecentTabs)
			.where(
				and(
					eq(userRecentTabs.type, type),
					eq(userRecentTabs.entityId, id),
					cursor ? gt(userRecentTabs.userId, cursor) : undefined,
				),
			)
			.orderBy(asc(userRecentTabs.userId))
			.limit(MIGRATION_BATCH_SIZE);
		if (rows.length === 0) break;
		userIds.push(...rows.map((row) => row.userId));
		cursor = rows.at(-1)?.userId;
		if (rows.length < MIGRATION_BATCH_SIZE) break;
	}
	return userIds;
}

export async function getRecentTabUserIdsForNarrator(narratorId: string): Promise<string[]> {
	await ensureAllRecentTabsMigrated();
	const userIds: string[] = [];
	let cursor: string | undefined;
	while (true) {
		const rows = await db
			.selectDistinct({ userId: userRecentTabs.userId })
			.from(userRecentTabs)
			.where(
				and(
					eq(userRecentTabs.representedNarratorId, narratorId),
					cursor ? gt(userRecentTabs.userId, cursor) : undefined,
				),
			)
			.orderBy(asc(userRecentTabs.userId))
			.limit(MIGRATION_BATCH_SIZE);
		if (rows.length === 0) break;
		userIds.push(...rows.map((row) => row.userId));
		cursor = rows.at(-1)?.userId;
		if (rows.length < MIGRATION_BATCH_SIZE) break;
	}
	return userIds;
}

export function hasRecentTab(userId: string, key: string): boolean {
	return (
		db
			.select({ id: userRecentTabs.id })
			.from(userRecentTabs)
			.where(and(eq(userRecentTabs.userId, userId), eq(userRecentTabs.tabKey, key)))
			.get() != null
	);
}

/** Update only users indexed as members of this narrator tab. */
export async function syncNarratorTitleToRecentTabs(
	narratorId: string,
	title: string,
): Promise<void> {
	for (const userId of await getRecentTabUserIdsForNarrator(narratorId)) {
		await mutate(userId, (tabs) => ({
			tabs: tabs.map((tab) =>
				getTabNarratorId(tab) === narratorId && tab.title !== title
					? { ...tab, title: title.slice(0, RECENT_TAB_TEXT_MAX_CHARS) }
					: tab,
			),
		}));
	}
}

/**
 * Drop the recent tabs a user may no longer open, after losing access to a project.
 *
 * Recent tabs are persisted server-side, so revoking membership otherwise leaves the
 * removed member staring at tabs for that project's chapters and sessions, each of
 * which 404s when clicked. The tab list is the one place where a stale entry survives
 * the authorization change.
 *
 * Deliberately re-checks the ACL per tab instead of matching on `projectId`:
 *   - project tabs carry the id directly, but chapter/narrator/subagent/group tabs do
 *     not, and reimplementing that resolution here would duplicate the ancestor chain;
 *   - a user removed from a project may still legitimately reach a chapter inside it
 *     (an explicit narrator grant, or a public project), and matching on the id alone
 *     would wrongly delete tabs that still work.
 *
 * Asking the gate answers "can this user still open this?", which is the actual
 * question, and stays correct as the gate gains rules. Tabs whose target has vanished
 * are left alone: that is the pre-existing dead-tab case, not this cleanup's business.
 */
export async function pruneUnreadableProjectTabs(userId: string, projectId: string): Promise<void> {
	const { resolveProjectGate } = await import("./project-acl");
	const { resolveNarratorProjectId } = await import("./narrator-project");

	const user = await db.query.users.findFirst({
		where: eq(users.id, userId),
		columns: { id: true, role: true },
	});
	// No user row → nothing to prune (the cascade already removed their tabs).
	if (!user) return;
	const principal = { userId: user.id, isAdmin: user.role === "admin" };

	// Cache per project so a user with many tabs in one project costs one gate check.
	const gateByProject = new Map<string, boolean>();
	const canStillRead = async (target: string | null): Promise<boolean> => {
		if (!target) return true;
		const cached = gateByProject.get(target);
		if (cached !== undefined) return cached;
		const gate = await resolveProjectGate(target, principal);
		gateByProject.set(target, gate.read);
		return gate.read;
	};

	const rows = readRows(userId).map(rowToTab);
	const doomed: { type: RecentTabType; id: string }[] = [];
	for (const tab of rows) {
		let owningProject: string | null = null;
		if (tab.type === "project") {
			owningProject = tab.id;
		} else if (tab.type === "chapter") {
			const chapter = await db.query.chapters.findFirst({
				where: eq(chapters.id, tab.id),
				columns: { projectId: true },
			});
			owningProject = chapter?.projectId ?? null;
		} else if (tab.type === "narrator" || tab.type === "subagent") {
			const narrator = await db.query.narrators.findFirst({
				where: eq(narrators.id, tab.id),
				columns: { chapterId: true, contextProjectId: true },
			});
			owningProject = narrator ? await resolveNarratorProjectId(narrator) : null;
		}
		// `workspace` / `group` tabs are user-scoped containers, not project resources.
		if (owningProject !== projectId) continue;
		if (!(await canStillRead(owningProject))) doomed.push({ type: tab.type, id: tab.id });
	}

	for (const tab of doomed) await removeRecentTab(userId, tab.type, tab.id);
}

/** Remove an entity only from users selected by the authoritative membership index. */
export async function removeTabFromAllUsers(
	tabType: "chapter" | "narrator" | "project",
	tabId: string,
): Promise<void> {
	for (const userId of await getRecentTabUserIds(tabType, tabId)) {
		await removeRecentTab(userId, tabType, tabId);
	}
}
