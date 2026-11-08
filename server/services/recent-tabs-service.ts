import {
	applyRecentTabFolderCreate,
	applyRecentTabFolderDissolve,
	applyRecentTabMove,
	applyRecentTabPin,
	applyRecentTabRemove,
	canJoinFolder,
	extractUnit,
	folderHeaderIndex,
	getPinnedSectionEndIndex,
	isFolderTab,
	promoteMemberWithinFolder,
	regroupFolders,
	tryInsertRelativeToKey,
	unitRange,
} from "@shared/recent-tab-layout";
import {
	type PersistedRecentTab,
	RECENT_TAB_FOLDER_COLORS,
	RECENT_TAB_FOLDER_ICONS,
	RECENT_TAB_FOLDER_TITLE_MAX_CHARS,
	RECENT_TABS_LEGACY_LIMIT,
	RECENT_TABS_LIVE_LIMIT,
	RECENT_TABS_PAGE_SIZE,
	RECENT_TABS_STALE_CURSOR_CODE,
	RECENT_TABS_STORAGE_LIMIT,
	RECENT_TABS_UNDO_CONFLICT_CODE,
	RECENT_TABS_WS_BATCH_SIZE,
	type RecentTabFolderColor,
	type RecentTabFolderIcon,
	type RecentTabRuntimePatch,
	type RecentTabsDelta,
	type RecentTabsMutationResult,
	type RecentTabsOperation,
	type RecentTabsPageResult,
	type RecentTabsRuntimeResult,
	type RecentTabsSection,
	type RecentTabType,
} from "@shared/recent-tabs";
import { and, asc, eq, gt, inArray, isNull, notInArray, or } from "drizzle-orm";
import { db } from "../db";
import {
	narrators,
	userPreferences,
	userRecentTabs,
	userRecentTabsMeta,
	users,
} from "../db/schema";
import { userPreferencesLock } from "../lib/async-mutex";
import { AppError, ValidationError } from "../lib/errors";
import { invalidateNarratorFolderCache } from "../lib/git-identity";
import { generateId } from "../lib/id";
import { parseSubstatus } from "../lib/narrator-utils";
import { broadcastToUser } from "../websocket/narrator-ws";

const RECENT_TAB_TEXT_MAX_CHARS = 1_000;
const UNDO_TTL_MS = 30_000;
const UNDO_MAX_ENTRIES = 1_000;
const SORT_ORDER_GAP = 1_000_000_000;
const ACTIVE_STATUSES = new Set(["working", "waiting"]);
const ATTENTION_SUBSTATUS = new Set(["unread", "error"]);
const FOLDER_ICON_SET = new Set<string>(RECENT_TAB_FOLDER_ICONS);
const FOLDER_COLOR_SET = new Set<string>(RECENT_TAB_FOLDER_COLORS);
/** Bounds a folder's preview count; a folder cannot hold more members than tabs exist. */
const FOLDER_PREVIEW_MAX = RECENT_TABS_STORAGE_LIMIT;

type RecentTabRow = typeof userRecentTabs.$inferSelect;
type RecentTabInsert = typeof userRecentTabs.$inferInsert;

interface UndoEntry {
	token: string;
	userId: string;
	expiresAt: number;
	revision: number;
	tabs: PersistedRecentTab[];
}

interface MutationOptions {
	removedCount?: number;
	undoTabs?: PersistedRecentTab[];
	/**
	 * Set `user_recent_tabs_meta.folders_migrated` in the same transaction, so the
	 * one-time workspace→folder conversion commits together with its flag.
	 */
	markFoldersMigrated?: boolean;
}

interface MutationState {
	tabs: PersistedRecentTab[];
	options?: MutationOptions;
}

const undoByUser = new Map<string, UndoEntry>();

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
	return undefined;
}

function cloneTab(tab: PersistedRecentTab): PersistedRecentTab {
	return { ...tab };
}

function normalizeLegacyTab(value: unknown): PersistedRecentTab | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const rawType = raw.type === "session" ? "narrator" : raw.type;
	// "group" (chat-group) and "chapter" tabs are dropped: both features were removed,
	// so such a tab would render without a target route. The enum itself stays so
	// historical rows still decode; they are filtered out on read (see readRows).
	if (
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

	// A legacy workspace header becomes a folder with the same id, and its children
	// become that folder's members — the same conversion `legacyRowToTab` applies to rows
	// that already reached the row store.
	const tab: PersistedRecentTab = {
		type: rawType === "workspace" ? "folder" : rawType,
		id: raw.id,
		title:
			rawType === "workspace"
				? legacyFolderTitle(raw.title)
				: raw.title.slice(0, RECENT_TAB_TEXT_MAX_CHARS),
		lastVisitedAt: Math.trunc(raw.lastVisitedAt),
	};
	if (typeof raw.narratorId === "string" && raw.narratorId.length <= 50) {
		tab.narratorId = raw.narratorId;
	}
	if (typeof raw.parentNarratorId === "string" && raw.parentNarratorId.length <= 50) {
		tab.parentNarratorId = raw.parentNarratorId;
	}
	if (rawType !== "workspace" && typeof raw.workspaceId === "string" && raw.workspaceId) {
		if (raw.workspaceId.length <= 50) tab.folderId = raw.workspaceId;
	}
	if (typeof raw.subtitle === "string") {
		tab.subtitle = raw.subtitle.slice(0, RECENT_TAB_TEXT_MAX_CHARS);
	}
	if (typeof raw.status === "string" && raw.status.length <= 50) tab.status = raw.status;
	if (raw.pinned === true) tab.pinned = true;
	if (raw.isScheduled === true) tab.isScheduled = true;
	return tab;
}

function folderTitle(title: string): string {
	return title.trim().slice(0, RECENT_TAB_FOLDER_TITLE_MAX_CHARS);
}

/**
 * Title for a folder converted from a legacy workspace group. A workspace title may be
 * blank, which a folder may not be. A workspace header with no session members (only
 * terminal panels, say) converts to an empty folder and is dropped; the workspace itself
 * is untouched and stays reachable from the header switcher.
 */
function legacyFolderTitle(title: string): string {
	return folderTitle(title) || "Workspace";
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
	if (tab.folderId && canJoinFolder(tab)) normalized.folderId = tab.folderId;
	if (tab.subtitle !== undefined) {
		normalized.subtitle = tab.subtitle.slice(0, RECENT_TAB_TEXT_MAX_CHARS);
	}
	if (tab.status !== undefined) normalized.status = tab.status;
	if (tab.pinned) normalized.pinned = true;
	if (tab.isScheduled) normalized.isScheduled = true;
	if (isFolderTab(tab)) {
		if (tab.folderIcon && FOLDER_ICON_SET.has(tab.folderIcon)) {
			normalized.folderIcon = tab.folderIcon;
		}
		if (tab.folderColor && FOLDER_COLOR_SET.has(tab.folderColor)) {
			normalized.folderColor = tab.folderColor;
		}
		if (
			tab.folderPreviewCount !== undefined &&
			Number.isInteger(tab.folderPreviewCount) &&
			tab.folderPreviewCount >= 0
		) {
			normalized.folderPreviewCount = Math.min(tab.folderPreviewCount, FOLDER_PREVIEW_MAX);
		}
	}
	return normalized;
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
	return regroupFolders(result, { prune: true });
}

/**
 * Cap the list at `limit` rows, removing one row (or one lone unit) at a time from the
 * bottom, the least recently placed end.
 *
 * A folder is a structure the user built by hand, so it shrinks member by member instead
 * of disappearing whole: each step drops the folder's least recently visited member, and
 * the header goes only with its last member. Steps, each taking the bottom-most match:
 *   1. a loose, non-pinned subagent tab;
 *   2. a loose, non-pinned tab, or a non-pinned member of a non-pinned folder that keeps
 *      at least one member;
 *   3. the same, even a folder's last member;
 *   4. anything, pinned or not, still a member at a time.
 * The unit holding `protectedKey` (the tab being written) is never touched.
 */
function trimTabsAtomic(
	input: PersistedRecentTab[],
	limit: number,
	protectedKey?: string,
): { tabs: PersistedRecentTab[]; protectedGroupTooLarge: boolean } {
	// A copy: the shared regroup hands back `input` itself when it is already in shape,
	// and the loop below splices.
	const tabs = [...regroupFolders(input, { prune: true })];
	if (tabs.length <= limit) return { tabs, protectedGroupTooLarge: false };

	const protectedIndex = protectedKey
		? tabs.findIndex((candidate) => tabKey(candidate) === protectedKey)
		: -1;
	// The head (lone tab or folder header) of the protected unit; heads are what the
	// victim search visits, and object identity survives the splices below.
	const protectedHead =
		protectedIndex >= 0 ? tabs[unitRange(tabs, protectedIndex).start] : undefined;
	const isProtected = (head: PersistedRecentTab): boolean => head === protectedHead;

	while (tabs.length > limit) {
		const victim =
			findEvictionVictim(tabs, 1, isProtected) ??
			findEvictionVictim(tabs, 2, isProtected) ??
			findEvictionVictim(tabs, 3, isProtected) ??
			findEvictionVictim(tabs, 4, isProtected);
		if (victim == null) return { tabs: input, protectedGroupTooLarge: true };
		const { folderId } = tabs[victim];
		tabs.splice(victim, 1);
		if (folderId && !tabs.some((tab) => tab.folderId === folderId)) {
			tabs.splice(folderHeaderIndex(tabs, folderId), 1);
		}
	}
	return { tabs, protectedGroupTooLarge: false };
}

/** Index of the row step `step` of `trimTabsAtomic` would drop, or null. */
function findEvictionVictim(
	tabs: PersistedRecentTab[],
	step: 1 | 2 | 3 | 4,
	isProtected: (head: PersistedRecentTab) => boolean,
): number | null {
	for (let index = tabs.length - 1; index >= 0; index--) {
		if (tabs[index].folderId) continue;
		const range = unitRange(tabs, index);
		const head = tabs[range.start];
		index = range.start;
		if (isProtected(head)) continue;
		if (!isFolderTab(head)) {
			if (step === 1 && (head.type !== "subagent" || head.pinned)) continue;
			if ((step === 2 || step === 3) && head.pinned) continue;
			return range.start;
		}
		if (step === 1 || (step !== 4 && head.pinned)) continue;
		const members = tabs.slice(range.start + 1, range.end + 1);
		const candidates = members.filter((member) => step === 4 || !member.pinned);
		if (candidates.length === 0) continue;
		if (step === 2 && members.length < 2) continue;
		// Least recently visited; on a tie, the lowest one in the folder.
		const oldest = candidates.reduce((best, member) =>
			member.lastVisitedAt <= best.lastVisitedAt ? member : best,
		);
		return range.start + 1 + members.indexOf(oldest);
	}
	return null;
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
	if (row.folderId) tab.folderId = row.folderId;
	if (row.subtitle != null) tab.subtitle = row.subtitle;
	if (row.status != null) tab.status = row.status;
	if (row.pinned) tab.pinned = true;
	if (row.isScheduled) tab.isScheduled = true;
	if (row.folderIcon) tab.folderIcon = row.folderIcon as RecentTabFolderIcon;
	if (row.folderColor) tab.folderColor = row.folderColor as RecentTabFolderColor;
	if (row.folderPreviewCount != null) tab.folderPreviewCount = row.folderPreviewCount;
	return tab;
}

/**
 * Read a row written before folders existed, converting the sidebar's workspace grouping:
 * a `workspace` header becomes a `folder` with the SAME id (so no id mapping is needed),
 * and a child's `workspace_id` becomes its `folder_id`. The workspace entity itself is
 * untouched — it stays reachable from the header's workspace switcher.
 */
function legacyRowToTab(row: RecentTabRow): PersistedRecentTab {
	const tab = rowToTab(row);
	if (row.type === "workspace") {
		tab.type = "folder";
		tab.title = legacyFolderTitle(row.title);
		delete tab.folderId;
	} else if (!tab.folderId && row.workspaceId) {
		tab.folderId = row.workspaceId;
	}
	return tab;
}

/**
 * Chat groups and chapters were removed, but historical `type = "group"` / `"chapter"`
 * rows are still in the table (the enum is kept so they decode). They have no route to
 * open, so every read path excludes them at the SQL level — inside the query, so
 * cursor/hasMore math on the paginated path stays consistent.
 */
const EXCLUDE_REMOVED_TAB_TYPES = notInArray(userRecentTabs.type, ["group", "chapter"]);

function readRows(userId: string): RecentTabRow[] {
	return db
		.select()
		.from(userRecentTabs)
		.where(and(eq(userRecentTabs.userId, userId), EXCLUDE_REMOVED_TAB_TYPES))
		.orderBy(asc(userRecentTabs.sortOrder), asc(userRecentTabs.tabKey))
		.limit(RECENT_TABS_STORAGE_LIMIT + 1)
		.all();
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
		// Retired columns. New rows never get a `workspace_id`; existing values are left
		// alone (updates do not write the column) because `workspace-panel-service` reads
		// them once to backfill a legacy workspace, then clears them.
		workspaceId: null,
		dirSortOrder: null,
		folderId: tab.folderId ?? null,
		folderIcon: tab.folderIcon ?? null,
		folderColor: tab.folderColor ?? null,
		folderPreviewCount: tab.folderPreviewCount ?? null,
		title: tab.title,
		subtitle: tab.subtitle ?? null,
		status: tab.status ?? null,
		lastVisitedAt: tab.lastVisitedAt,
		pinned: tab.pinned ?? false,
		isScheduled: tab.isScheduled ?? false,
		sortOrder,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
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
	// Nullable columns are normalized on both sides: the desired value may be
	// `undefined` from a partially built insert, and `null !== undefined` would
	// otherwise report a change on every write.
	return (
		row.section !== desired.section ||
		row.type !== desired.type ||
		row.entityId !== desired.entityId ||
		row.narratorId !== desired.narratorId ||
		row.representedNarratorId !== desired.representedNarratorId ||
		row.parentNarratorId !== desired.parentNarratorId ||
		(row.dirSortOrder ?? null) !== (desired.dirSortOrder ?? null) ||
		(row.folderId ?? null) !== (desired.folderId ?? null) ||
		(row.folderIcon ?? null) !== (desired.folderIcon ?? null) ||
		(row.folderColor ?? null) !== (desired.folderColor ?? null) ||
		(row.folderPreviewCount ?? null) !== (desired.folderPreviewCount ?? null) ||
		row.title !== desired.title ||
		row.subtitle !== desired.subtitle ||
		row.status !== desired.status ||
		row.lastVisitedAt !== desired.lastVisitedAt ||
		row.pinned !== desired.pinned ||
		row.isScheduled !== desired.isScheduled ||
		row.sortOrder !== desired.sortOrder
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
				dirSortOrder: null,
				folderId: desired.folderId ?? null,
				folderIcon: desired.folderIcon ?? null,
				folderColor: desired.folderColor ?? null,
				folderPreviewCount: desired.folderPreviewCount ?? null,
				title: desired.title,
				subtitle: desired.subtitle,
				status: desired.status,
				lastVisitedAt: desired.lastVisitedAt,
				pinned: desired.pinned,
				isScheduled: desired.isScheduled,
				sortOrder: desired.sortOrder,
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

function readMeta(userId: string): { revision: number; foldersMigrated: boolean } | undefined {
	return db
		.select({
			revision: userRecentTabsMeta.revision,
			foldersMigrated: userRecentTabsMeta.foldersMigrated,
		})
		.from(userRecentTabsMeta)
		.where(eq(userRecentTabsMeta.userId, userId))
		.get();
}

/**
 * One-time conversion of a migrated user's workspace groups into folders.
 *
 * Runs under the user's lock, from `ensureMigratedLocked`, so every reader and writer
 * sees the converted list. The rewrite and the `folders_migrated` flag commit in ONE
 * transaction (`markFoldersMigrated`), so a crash leaves either the old shape with the
 * flag unset (retried next time) or the new shape with it set — never a half state.
 *
 * Bounded: one user holds at most RECENT_TABS_STORAGE_LIMIT rows, read by an indexed query.
 */
function convertLegacyWorkspaceRowsLocked(userId: string, revision: number): number {
	const oldRows = readRows(userId);
	const before = oldRows.map(rowToTab);
	const after = normalizeAndLimitTabs(oldRows.map(legacyRowToTab)).tabs;
	return persistMutationLocked(userId, oldRows, before, after, revision, {
		markFoldersMigrated: true,
	}).revision;
}

function ensureMigratedLocked(userId: string): number {
	const meta = readMeta(userId);
	if (meta) {
		if (meta.foldersMigrated) return meta.revision;
		return convertLegacyWorkspaceRowsLocked(userId, meta.revision);
	}

	const legacy = db
		.select({ recentTabs: userPreferences.recentTabs })
		.from(userPreferences)
		.where(eq(userPreferences.userId, userId))
		.get();
	// `parseLegacyTabs` already converts workspace groups, so the flag starts set.
	const tabs = parseLegacyTabs(legacy?.recentTabs);
	const now = new Date().toISOString();

	db.transaction((tx) => {
		insertRowsInTransaction(tx, userId, tabs, [], now);
		tx.insert(userRecentTabsMeta)
			.values({
				userId,
				revision: 0,
				foldersMigrated: true,
				migratedAt: now,
				createdAt: now,
				updatedAt: now,
			})
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
	const beforeByKey = new Map(before.map((tab) => [tabKey(tab), tab]));
	const afterKeys = new Set(after.map(tabKey));
	const operations: RecentTabsOperation[] = [];
	for (const tab of before) {
		const key = tabKey(tab);
		if (!afterKeys.has(key)) operations.push({ type: "remove", key });
	}
	// Each section is a separate paginated client window. Cross-section neighbors
	// cannot position a row in that window, even when every page is loaded.
	for (const section of ["projects", "work"] as const) {
		const sectionTabs = after.filter((tab) => tabSection(tab.type) === section);
		const currentKeys = before
			.filter((tab) => tabSection(tab.type) === section && afterKeys.has(tabKey(tab)))
			.map(tabKey);
		for (let index = 0; index < sectionTabs.length; index++) {
			const tab = sectionTabs[index];
			const key = tabKey(tab);
			const previous = beforeByKey.get(key);
			const anchors = operationAnchors(sectionTabs, index);
			if (!previous || JSON.stringify(previous) !== JSON.stringify(tab)) {
				operations.push({ type: "upsert", key, tab, ...anchors });
			} else if (currentKeys[index] !== key) {
				operations.push({ type: "move", key, ...anchors });
			}
			// Compare with the order AFTER earlier operations, not the original list:
			// moving a block's head also displaces neighbors whose old predecessor did
			// not change. Omitting those moves makes replay diverge from persisted order.
			if (currentKeys[index] !== key) {
				const previousIndex = currentKeys.indexOf(key);
				if (previousIndex >= 0) currentKeys.splice(previousIndex, 1);
				currentKeys.splice(index, 0, key);
			}
		}
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
	const now = new Date().toISOString();
	if (tabsEqual(before, after)) {
		// Nothing visible changed, but the one-time folder conversion still has to record
		// that it ran — otherwise a user with no workspace groups would re-run it forever.
		if (options.markFoldersMigrated) {
			db.update(userRecentTabsMeta)
				.set({ foldersMigrated: true, updatedAt: now })
				.where(eq(userRecentTabsMeta.userId, userId))
				.run();
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
	db.transaction((tx) => {
		applyRowDiffInTransaction(tx, userId, after, oldRows, now);
		tx.update(userRecentTabsMeta)
			.set({
				revision,
				updatedAt: now,
				...(options.markFoldersMigrated ? { foldersMigrated: true } : {}),
			})
			.where(eq(userRecentTabsMeta.userId, userId))
			.run();
		writeLegacyShadowInTransaction(tx, userId, after, now);
	});

	const result: RecentTabsMutationResult = {
		changed: true,
		baseRevision,
		revision,
		operations: diffOperations(before, after),
		removedCount: options.removedCount,
	};
	// Moves, folder removal/dissolve and reordering can all change which folder's identity
	// a narrator inherits. Invalidate centrally so every layout mutation is covered.
	invalidateNarratorFolderCache(userId);
	if (options.undoTabs && options.undoTabs.length > 0) {
		const token = generateId();
		storeUndo({
			token,
			userId,
			expiresAt: Date.now() + UNDO_TTL_MS,
			revision,
			tabs: options.undoTabs.map(cloneTab),
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
 * Fields a client may set through the generic upsert. Folder structure (membership, and
 * a folder's own metadata) only changes through the folder endpoints, so an upsert can
 * neither create a folder nor move a tab between folders.
 */
function stripStructuralFields(tab: PersistedRecentTab): PersistedRecentTab {
	const next = cloneTab(tab);
	delete next.folderId;
	delete next.folderIcon;
	delete next.folderColor;
	delete next.folderPreviewCount;
	return next;
}

function applyRecentTabUpsert(
	current: PersistedRecentTab[],
	input: RecentTabUpsertInput,
): PersistedRecentTab[] {
	const { updateOnly, beforeKey, afterKey, ...tabInput } = input;
	if (tabInput.type === "folder" || tabInput.type === "workspace") return current;
	const tab = normalizeTab(stripStructuralFields(tabInput));
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
		const existing = tabs[index];
		if (updateOnly) {
			const patch: Partial<PersistedRecentTab> = {};
			for (const [field, value] of Object.entries(tab)) {
				if (field === "type" || field === "id") continue;
				if (value !== "" && value !== undefined) {
					(patch as Record<string, unknown>)[field] = value;
				}
			}
			tabs[index] = normalizeTab({ ...existing, ...patch, folderId: existing.folderId });
		} else {
			// Re-visiting a normal tab updates metadata in place. Only explicit move/pin changes
			// order. Pinned state and folder membership belong to the stored tab.
			tabs[index] = normalizeTab({
				...existing,
				...tab,
				pinned: existing.pinned,
				folderId: existing.folderId,
			});
		}
		// An anchor on an already-present tab repositions it, so dropping a tab that
		// happens to be in the sidebar already lands where it was aimed instead of
		// silently doing nothing. A folder member is taken out to the top level first.
		if (anchor) {
			const [updated] = tabs.splice(index, 1);
			const moved = cloneTab(updated);
			if (moved.folderId) {
				delete moved.folderId;
				delete moved.pinned;
			}
			if (!tryInsertRelativeToKey(tabs, [moved], anchor.key, anchor.position)) {
				// Anchor gone: leave the (updated) tab exactly where it was.
				tabs.splice(index, 0, updated);
			}
		}
	} else if (!updateOnly) {
		insertNewTab(tabs, tab, anchor);
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

/** 列表里看不见的叙述者（ModelTrace 舱）也不进侧边栏。 */
function withoutHiddenNarratorTabs(inputs: RecentTabUpsertInput[]): RecentTabUpsertInput[] {
	const narratorIds = inputs
		.filter((input) => input.type === "narrator" || input.type === "subagent")
		.map((input) => input.id);
	if (narratorIds.length === 0) return inputs;
	const hidden = new Set(
		db
			.select({ id: narrators.id })
			.from(narrators)
			.where(and(inArray(narrators.id, narratorIds), eq(narrators.hiddenFromLists, true)))
			.all()
			.map((row) => row.id),
	);
	if (hidden.size === 0) return inputs;
	return inputs.filter(
		(input) => (input.type !== "narrator" && input.type !== "subagent") || !hidden.has(input.id),
	);
}

export async function upsertRecentTabsBatch(
	userId: string,
	inputs: RecentTabUpsertInput[],
): Promise<RecentTabsMutationResult> {
	if (inputs.length === 0 || inputs.length > RECENT_TABS_WS_BATCH_SIZE) {
		throw new ValidationError(`Recent-tabs batch must contain 1-${RECENT_TABS_WS_BATCH_SIZE} tabs`);
	}
	const visible = withoutHiddenNarratorTabs(inputs);
	return userPreferencesLock.acquire(userId, async () => {
		const baseRevision = ensureMigratedLocked(userId);
		if (visible.length === 0) {
			return { changed: false, baseRevision, revision: baseRevision, operations: [] };
		}
		const oldRows = readRows(userId);
		const before = oldRows.map(rowToTab);
		let after = before.map(cloneTab);
		for (const input of visible) after = applyRecentTabUpsert(after, input);
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
 * Remove one recent tab.
 *
 * Removing a folder removes the folder AND its members (the "close" of a folder unit).
 * Use `dissolveRecentTabFolder` to keep the members. Removing the last member of a folder
 * removes the folder too.
 *
 * `storeUndo` is opt-in and must only be set for a user-initiated close (the
 * DELETE route behind swipe / context-menu / middle-click). Cascade cleanups
 * (`removeTabFromAllUsers`, unreadable-project purge, archive) must leave it
 * false: they would otherwise overwrite the user's pending undo token with a
 * snapshot that points at already-deleted entities.
 */
export async function removeRecentTab(
	userId: string,
	type: RecentTabType,
	id: string,
	options: { storeUndo?: boolean } = {},
): Promise<RecentTabsMutationResult> {
	return mutate(userId, (tabs) => {
		const key = `${type}:${id}`;
		const index = tabs.findIndex((tab) => tabKey(tab) === key);
		if (index < 0) return { tabs };
		// Snapshot BEFORE the splice — after it the removed tab is gone and the undo
		// entry would restore an already-empty slot.
		const undoTabs = options.storeUndo ? tabs.map(cloneTab) : undefined;
		const next = applyRecentTabRemove(tabs, key);
		// An emptied folder header goes with its last member but is not counted as closed.
		const removedCount = isFolderTab(tabs[index]) ? tabs.length - next.length : 1;
		return { tabs: next, options: { removedCount, ...(undoTabs ? { undoTabs } : {}) } };
	});
}

export interface MoveRecentTabInput {
	key: string;
	toIndex?: number;
	position?: "top" | "above_idle";
	beforeKey?: string;
	afterKey?: string;
	/**
	 * Folder membership for this move:
	 *   - undefined: unchanged (a member moves within its folder, a top-level tab stays
	 *     top-level);
	 *   - null: leave the folder and land at the top level next to the anchor;
	 *   - a folder id: join that folder, next to the anchor (which must be a member of
	 *     it) or at its end when no anchor is given.
	 */
	folderId?: string | null;
	/** A top-level unit dragged across the pin divider takes this pinned state. */
	pinned?: boolean;
}

export async function moveRecentTab(
	userId: string,
	input: MoveRecentTabInput,
): Promise<RecentTabsMutationResult> {
	return mutate(userId, async (tabs) => {
		if (input.position !== "above_idle") {
			return { tabs: applyRecentTabMove(tabs, input.key, input) };
		}
		// `above_idle` needs live narrator status, so it is the one move the shared layout
		// cannot run. Membership never changes: a member is promoted inside its folder and
		// the folder is the unit that moves.
		const found = tabs.findIndex((tab) => tabKey(tab) === input.key);
		if (found < 0) return { tabs };
		const index = promoteMemberWithinFolder(tabs, found);
		if (index < 0) return { tabs };
		// A pinned unit already sits where the user put it; only its inside may move.
		if (tabs[index].pinned) return { tabs };
		const { group } = extractUnit(tabs, index);
		tabs.splice(await firstIdleUnitIndex(tabs), 0, ...group);
		return { tabs };
	});
}

/** First non-pinned top-level unit whose narrators are all idle, or the end of the list. */
async function firstIdleUnitIndex(tabs: PersistedRecentTab[]): Promise<number> {
	const narratorIds = tabs.map(getTabNarratorId).filter((id): id is string => id !== undefined);
	const statusByNarrator = new Map<string, string>();
	if (narratorIds.length > 0) {
		const rows = await db
			.select({ id: narrators.id, status: narrators.status })
			.from(narrators)
			.where(inArray(narrators.id, narratorIds));
		for (const row of rows) statusByNarrator.set(row.id, row.status);
	}
	for (let candidateIndex = 0; candidateIndex < tabs.length; candidateIndex++) {
		const candidate = tabs[candidateIndex];
		if (candidate.folderId) continue;
		const range = unitRange(tabs, candidateIndex);
		if (!candidate.pinned) {
			const represented = tabs
				.slice(range.start, range.end + 1)
				.map(getTabNarratorId)
				.filter((id): id is string => id !== undefined);
			if (
				represented.length > 0 &&
				represented.every((id) => statusByNarrator.get(id) === "idle")
			) {
				return range.start;
			}
		}
		candidateIndex = range.end;
	}
	return tabs.length;
}

/**
 * Pin or unpin a tab.
 *
 * A top-level tab or folder pins to the top of the list; a folder member pins to the
 * top of its folder.
 */
export async function pinRecentTab(
	userId: string,
	key: string,
	pinned: boolean,
): Promise<RecentTabsMutationResult> {
	return mutate(userId, (tabs) => ({ tabs: applyRecentTabPin(tabs, key, pinned) }));
}

// ── Folders ──────────────────────────────────────────────────────────────────

export interface CreateRecentTabFolderInput {
	/** The tab dropped ONTO: the folder takes its position and pinned state. */
	targetKey: string;
	/** The tab being dragged; becomes the second member. */
	sourceKey: string;
	title: string;
}

/**
 * Create a folder by dropping `source` onto `target` (a top-level session tab).
 *
 * The folder occupies the target's slot and inherits its pinned state, so the list does
 * not visibly jump; members are [target, source]. The source may come out of another
 * folder (dragging a member onto a loose tab).
 */
export async function createRecentTabFolder(
	userId: string,
	input: CreateRecentTabFolderInput,
): Promise<RecentTabsMutationResult & { folderId?: string }> {
	const folderId = generateId();
	const title = folderTitle(input.title);
	if (!title) throw new ValidationError("Folder title is required");
	let created = false;
	const result = await mutate(userId, (tabs) => {
		if (input.targetKey === input.sourceKey) return { tabs };
		const next = applyRecentTabFolderCreate(tabs, input.targetKey, input.sourceKey, {
			type: "folder",
			id: folderId,
			title,
			lastVisitedAt: Date.now(),
		});
		if (!next) {
			const bothExist = [input.targetKey, input.sourceKey].every((key) =>
				tabs.some((tab) => tabKey(tab) === key),
			);
			throw new ValidationError(
				bothExist
					? "A folder is made by dropping a session onto a loose session"
					: "Both tabs must exist to create a folder",
			);
		}
		created = true;
		return { tabs: next };
	});
	return created ? { ...result, folderId } : result;
}

export interface UpdateRecentTabFolderInput {
	title?: string;
	icon?: RecentTabFolderIcon | null;
	color?: RecentTabFolderColor | null;
	previewCount?: number | null;
}

export async function updateRecentTabFolder(
	userId: string,
	folderId: string,
	input: UpdateRecentTabFolderInput,
): Promise<RecentTabsMutationResult> {
	return mutate(userId, (tabs) => {
		const folder = tabs.find((tab) => isFolderTab(tab) && tab.id === folderId);
		if (!folder) throw new AppError("Folder not found", 404, "NOT_FOUND");
		if (input.title !== undefined) {
			const title = folderTitle(input.title);
			if (!title) throw new ValidationError("Folder title is required");
			folder.title = title;
		}
		if (input.icon !== undefined) {
			if (input.icon === null) delete folder.folderIcon;
			else folder.folderIcon = input.icon;
		}
		if (input.color !== undefined) {
			if (input.color === null) delete folder.folderColor;
			else folder.folderColor = input.color;
		}
		if (input.previewCount !== undefined) {
			if (input.previewCount === null) delete folder.folderPreviewCount;
			else folder.folderPreviewCount = input.previewCount;
		}
		return { tabs };
	});
}

/**
 * Remove a folder but keep its members, in order, at the folder's position.
 *
 * The folder structure is hand-built, so dissolving it is undoable like a close: the
 * snapshot is taken before the header goes.
 */
export async function dissolveRecentTabFolder(
	userId: string,
	folderId: string,
): Promise<RecentTabsMutationResult> {
	return mutate(userId, (tabs) => {
		if (folderHeaderIndex(tabs, folderId) < 0) return { tabs };
		return {
			tabs: applyRecentTabFolderDissolve(tabs, folderId),
			options: { undoTabs: tabs.map(cloneTab) },
		};
	});
}

function isKeepUnit(tabs: PersistedRecentTab[], index: number, keepTabKey?: string): boolean {
	if (!keepTabKey) return false;
	const range = unitRange(tabs, index);
	return tabs.slice(range.start, range.end + 1).some((tab) => tabKey(tab) === keepTabKey);
}

/**
 * Bulk-close tabs.
 *
 * Folders are kept whole by every scope: like pinning, a folder is a structure the user
 * built by hand, and silently emptying it would destroy that work.
 */
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
		for (let index = 0; index < before.length; index++) {
			if (before[index]?.folderId) continue;
			const range = unitRange(before, index);
			const unit = before.slice(range.start, range.end + 1);
			let keep =
				isKeepUnit(before, index, keepTabKey) || unit[0].pinned === true || isFolderTab(unit[0]);
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
			index = range.end;
		}
		const removedCount = before.length - after.length;
		return persistMutationLocked(userId, oldRows, before, after, baseRevision, {
			removedCount,
			undoTabs: removedCount > 0 ? before : undefined,
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
					"Recent-tabs changed after the removal; the undo snapshot can no longer be restored",
					409,
					RECENT_TABS_UNDO_CONFLICT_CODE,
				);
			}
			const oldRows = readRows(userId);
			const before = oldRows.map(rowToTab);
			const after = normalizeAndLimitTabs(entry.tabs.map(cloneTab)).tabs;
			const result = persistMutationLocked(userId, oldRows, before, after, baseRevision);
			undoByUser.delete(userId);
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
			isNull(userRecentTabs.folderId),
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
		// A page always carries its folders' members, so a folder is never split across pages.
		const folderIds = pageTopLevelRows
			.filter((row) => row.type === "folder")
			.map((row) => row.entityId);
		const members =
			folderIds.length > 0
				? db
						.select()
						.from(userRecentTabs)
						.where(
							and(
								eq(userRecentTabs.userId, userId),
								eq(userRecentTabs.section, section),
								inArray(userRecentTabs.folderId, folderIds),
							),
						)
						.orderBy(asc(userRecentTabs.sortOrder), asc(userRecentTabs.tabKey))
						.limit(RECENT_TABS_STORAGE_LIMIT)
						.all()
				: [];
		const membersByFolder = new Map<string, RecentTabRow[]>();
		for (const member of members) {
			if (!member.folderId) continue;
			const folderMembers = membersByFolder.get(member.folderId);
			if (folderMembers) folderMembers.push(member);
			else membersByFolder.set(member.folderId, [member]);
		}
		const pageRows: RecentTabRow[] = [];
		for (const row of pageTopLevelRows) {
			if (row.type !== "folder") {
				pageRows.push(row);
				continue;
			}
			// A folder emptied outside this service (a direct narrator delete) is not shown;
			// the next write removes it for good.
			const folderMembers = membersByFolder.get(row.entityId) ?? [];
			if (folderMembers.length === 0) continue;
			pageRows.push(row, ...folderMembers);
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
			activeBackgroundTaskCount: tab.activeBackgroundTaskCount ?? 0,
			activeBackgroundWorkCount: tab.activeBackgroundWorkCount ?? 0,
			activeBackgroundServiceCount: tab.activeBackgroundServiceCount ?? 0,
			viewers: tab.viewers ?? [],
			viewerCount: tab.viewerCount ?? 0,
			containerStatus: tab.containerStatus ?? null,
		},
	}));
	return { revision: snapshot.revision, patches };
}

/** Move the unit containing `index` to the top of the non-pinned section. */
function promoteTopLevelTab(tabs: PersistedRecentTab[], index: number): PersistedRecentTab[] {
	if (index < 0) return tabs;
	const folderId = tabs[index]?.folderId;
	if (folderId) {
		index = folderHeaderIndex(tabs, folderId);
		if (index < 0) return tabs;
	}
	if (tabs[index].pinned) return tabs;
	const { group } = extractUnit(tabs, index);
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

export async function getRecentTabUserIdsForNarrator(
	narratorId: string,
	/** Notification consumers use a fixed budget; access-change broadcasts still visit everyone. */
	limit = Number.POSITIVE_INFINITY,
): Promise<string[]> {
	await ensureAllRecentTabsMigrated();
	const userIds: string[] = [];
	let cursor: string | undefined;
	while (userIds.length < limit) {
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
			.limit(Math.min(MIGRATION_BATCH_SIZE, limit - userIds.length));
		if (rows.length === 0) break;
		userIds.push(...rows.map((row) => row.userId));
		cursor = rows.at(-1)?.userId;
		if (rows.length < MIGRATION_BATCH_SIZE) break;
	}
	return userIds;
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
 * removed member staring at tabs for that project's sessions, each of
 * which 404s when clicked. The tab list is the one place where a stale entry survives
 * the authorization change.
 *
 * Deliberately re-checks the ACL per tab instead of matching on `projectId`:
 *   - project tabs carry the id directly, but narrator/subagent tabs do not, and
 *     reimplementing that resolution here would duplicate the ancestor chain;
 *   - a user removed from a project may still legitimately reach a session inside it
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
		} else if (tab.type === "narrator" || tab.type === "subagent") {
			const narrator = await db.query.narrators.findFirst({
				where: eq(narrators.id, tab.id),
				columns: { id: true, contextProjectId: true },
			});
			owningProject = narrator ? await resolveNarratorProjectId(narrator) : null;
		}
		// `folder` tabs are user-scoped containers, not project resources.
		if (owningProject !== projectId) continue;
		if (!(await canStillRead(owningProject))) doomed.push({ type: tab.type, id: tab.id });
	}

	for (const tab of doomed) await removeRecentTab(userId, tab.type, tab.id);
}

/** Remove an entity only from users selected by the authoritative membership index. */
export async function removeTabFromAllUsers(
	tabType: "narrator" | "project",
	tabId: string,
): Promise<void> {
	for (const userId of await getRecentTabUserIds(tabType, tabId)) {
		await removeRecentTab(userId, tabType, tabId);
	}
}
