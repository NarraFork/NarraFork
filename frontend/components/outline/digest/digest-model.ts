/**
 * What a report shows, worked out from the report API's answers without React (汇报, P2 PR 11):
 *
 *   - `digestModel`: a report's sections for one space or all of them, in full (the page) or
 *     compact (the inbox row: every section's count and its first few items, and every decision
 *     made in the person's name), with what is counted but not listed;
 *   - `itemLinks`: where an item points back to (the block now, the page as of the commit, the
 *     session);
 *   - `dayEntries`, `pickDay`, `dayNeighbors`: browsing by day (newest first, "today so far" on
 *     top), over the pages of the list loaded so far;
 *   - `undoRefusalOf`: why an undo was refused, as one of the reasons the reader is told.
 *
 * Counts follow the API: a section's count is its items plus those past the server's caps
 * (`more`, per space when filtered by one). Nothing here reads more than the detail holds, which
 * the API caps (300 items, 50 per section, 50 spaces).
 */
import type { OutlineViewMode } from "@shared/outline-api";
import {
	OUTLINE_DIGEST_SECTIONS,
	OUTLINE_DIGEST_UNDO_CODES,
	type OutlineDigestDelegatedView,
	type OutlineDigestDetailResponse,
	type OutlineDigestHead,
	type OutlineDigestKnowledgeView,
	type OutlineDigestLink,
	type OutlineDigestListResponse,
	type OutlineDigestOtherView,
	type OutlineDigestPlanView,
	type OutlineDigestQuestionView,
	type OutlineDigestSection,
	type OutlineDigestSpaceView,
	type OutlineDigestTaskView,
} from "@shared/outline-digest";
import { outlineTargetPath } from "../../../lib/outline-href";
import { type OutlineTarget, outlineBlockTarget } from "../outline-nav";

/** Items the compact view lists per section (代你做的 is listed in full). */
export const DIGEST_COMPACT_ITEMS = 3;

/** The `d` of "today so far" in the page's address. */
export const DIGEST_TODAY = "today";

interface ItemOf {
	delegated: OutlineDigestDelegatedView;
	knowledge: OutlineDigestKnowledgeView;
	tasks: OutlineDigestTaskView;
	plans: OutlineDigestPlanView;
	questions: OutlineDigestQuestionView;
	other: OutlineDigestOtherView;
}

export interface DigestSectionModel<S extends OutlineDigestSection = OutlineDigestSection> {
	section: S;
	/** Items in all: listed here, past the compact cap, or past the server's caps. */
	count: number;
	items: ItemOf[S][];
	/** Counted but not listed here. */
	hidden: number;
}

export type DigestSectionEntry = {
	[S in OutlineDigestSection]: DigestSectionModel<S>;
}[OutlineDigestSection];

/** What is counted but not listed, over the spaces shown. */
export interface DigestTallies {
	commits: number;
	ownEdits: number;
	deletedFacts: number;
	tasksCreated: number;
	tasksStarted: number;
	leaseReturned: number;
	reviewComments: number;
	/** Spaces whose day was summarized in part. */
	truncated: OutlineDigestSpaceView[];
}

export interface DigestModel {
	sections: DigestSectionEntry[];
	tallies: DigestTallies;
	/** The spaces shown (one, when filtered). */
	spaces: OutlineDigestSpaceView[];
	/** Spaces with changes past the report's cap (only when not filtered). */
	moreSpaces: number;
	/** Items in all sections. */
	total: number;
}

/** A report's sections for `spaceId` (null: every space), in full or compact. */
export function digestModel(
	detail: OutlineDigestDetailResponse,
	options: { spaceId?: string | null; compact?: boolean } = {},
): DigestModel {
	const spaceId = options.spaceId ?? null;
	const inSpace = (link: OutlineDigestLink) => spaceId === null || link.spaceId === spaceId;
	const spaces = spaceId === null ? detail.spaces : detail.spaces.filter((s) => s.id === spaceId);
	const past = (section: OutlineDigestSection) =>
		spaceId === null
			? (detail.more[section] ?? 0)
			: spaces.reduce((n, s) => n + (s.more?.[section] ?? 0), 0);
	const section = <S extends OutlineDigestSection>(name: S): DigestSectionModel<S> => {
		const all = (detail[name] as ItemOf[S][]).filter((item) => inSpace(item.link));
		const items =
			options.compact && name !== "delegated" ? all.slice(0, DIGEST_COMPACT_ITEMS) : all;
		const count = all.length + past(name);
		return { section: name, count, items, hidden: count - items.length };
	};
	const sections = OUTLINE_DIGEST_SECTIONS.map((name) => section(name)) as DigestSectionEntry[];
	const sum = (pick: (s: OutlineDigestSpaceView) => number) =>
		spaces.reduce((n, s) => n + pick(s), 0);
	return {
		sections,
		tallies: {
			commits: sum((s) => s.commits),
			ownEdits: sum((s) => s.ownEdits),
			deletedFacts: sum((s) => s.deletedFacts),
			tasksCreated: sum((s) => s.tasksCreated),
			tasksStarted: sum((s) => s.tasksStarted),
			leaseReturned: sum((s) => s.leaseReturned),
			reviewComments: sum((s) => s.reviewComments),
			truncated: spaces.filter((s) => s.truncated),
		},
		spaces,
		moreSpaces: spaceId === null ? detail.moreSpaces : 0,
		total: sections.reduce((n, s) => n + s.count, 0),
	};
}

/** The reports page's path (no mount prefix): a day (`d`) and a space. */
export function reportPath(search: { d?: string | null; space?: string | null } = {}): string {
	const query = new URLSearchParams();
	if (search.d) query.set("d", search.d);
	if (search.space) query.set("space", search.space);
	const text = query.toString();
	return `/outline/digest${text ? `?${text}` : ""}`;
}

/** A session's path. */
export function sessionPath(narratorId: string): string {
	return `/narrators/${encodeURIComponent(narratorId)}`;
}

/** The page a commit changed, as of it: the reference route's path, as tool cards link it. */
export function commitPath(commit: { space: string; seq: number }): string {
	return outlineTargetPath({ kind: "commit", space: commit.space, seq: commit.seq });
}

/** Where an item points back to. */
export interface DigestItemLinks {
	/** The block as it is now; deleted since, as of the item's commit. */
	block: OutlineTarget | null;
	/** The page the commit changed, as of the commit (`/outline/ref?space=&commit=`). */
	commit: { space: string; seq: number } | null;
	/** The session, when the reader may read it. */
	session: string | null;
}

/**
 * The links of an item. Tasks, plans, questions and decisions are folded away in the facts view,
 * so they open in the view of everything (`view: "all"`); knowledge opens as facts.
 */
export function itemLinks(
	link: OutlineDigestLink,
	options: { view?: OutlineViewMode; deleted?: boolean } = {},
): DigestItemLinks {
	const view = options.deleted ? "all" : options.view;
	const asOf = options.deleted && link.seq !== null ? link.seq : undefined;
	return {
		block: link.blockId ? outlineBlockTarget(link.spaceId, link.blockId, view, asOf) : null,
		commit: link.seq !== null ? { space: link.spaceKey, seq: link.seq } : null,
		session: link.narratorId,
	};
}

/** One day to browse to: a daily report, or "today so far" (`key` {@link DIGEST_TODAY}). */
export interface DigestDayEntry {
	key: string;
	head: OutlineDigestHead;
}

/** The days loaded so far, newest first: "today so far" (when there is one), then the days. */
export function dayEntries(
	pages: readonly OutlineDigestListResponse[] | undefined,
): DigestDayEntry[] {
	if (!pages || pages.length === 0) return [];
	const seen = new Set<string>();
	const entries: DigestDayEntry[] = [];
	const preview = pages[0]?.preview ?? null;
	if (preview) entries.push({ key: DIGEST_TODAY, head: preview });
	for (const page of pages)
		for (const head of page.digests) {
			if (seen.has(head.periodKey)) continue;
			seen.add(head.periodKey);
			entries.push({ key: head.periodKey, head });
		}
	return entries;
}

/** What the address's day (`d`) opens. */
export interface DigestDayPick {
	entry: DigestDayEntry | null;
	/** A day the list does not have (nor any page after it). */
	missing: boolean;
	/** The day may be on a page of the list not read yet. */
	searching: boolean;
	/** `d=today` and no "so far" report has been made. */
	noPreview: boolean;
}

/**
 * The day the address names (`d`), or the latest day when it names none. A date that is the
 * preview's own day (today, before that day's report exists) opens the preview. Nothing is said
 * to be missing until the list has loaded (`loaded`).
 */
export function pickDay(
	entries: readonly DigestDayEntry[],
	d: string | undefined,
	options: { more: boolean; loaded: boolean },
): DigestDayPick {
	const none = { entry: null, missing: false, searching: false, noPreview: false };
	if (!options.loaded) return none;
	if (!d) {
		const entry = entries.find((e) => e.key !== DIGEST_TODAY) ?? entries[0] ?? null;
		return { ...none, entry };
	}
	const entry =
		entries.find((e) => e.key === d) ??
		entries.find((e) => e.key === DIGEST_TODAY && e.head.periodKey === d) ??
		null;
	if (entry) return { ...none, entry };
	if (d === DIGEST_TODAY) return { ...none, noPreview: true };
	// An older day may be on a later page.
	return options.more ? { ...none, searching: true } : { ...none, missing: true };
}

/** Whether a day (`YYYY-MM-DD`) is today in `timeZone`. */
export function isTodayIn(periodKey: string, timeZone: string, now: Date = new Date()): boolean {
	return dayIn(now, timeZone) === periodKey;
}

/** The calendar day (`YYYY-MM-DD`) of an instant in `timeZone` (UTC when the zone is unknown). */
export function dayIn(at: Date, timeZone: string): string {
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(at);
	} catch {
		return at.toISOString().slice(0, 10);
	}
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)?.value ?? "";
	return `${part("year").padStart(4, "0")}-${part("month").padStart(2, "0")}-${part("day").padStart(2, "0")}`;
}

/**
 * The days next to `key`: `newer` and `older` among those loaded. `olderOnNextPage`: `key` is the
 * oldest loaded and the list has more (the next page holds the day before).
 */
export function dayNeighbors(
	entries: readonly DigestDayEntry[],
	key: string,
	more: boolean,
): { newer: string | null; older: string | null; olderOnNextPage: boolean } {
	const i = entries.findIndex((e) => e.key === key);
	if (i < 0) return { newer: null, older: null, olderOnNextPage: false };
	const older = entries[i + 1]?.key ?? null;
	return {
		newer: entries[i - 1]?.key ?? null,
		older,
		olderOnNextPage: older === null && more,
	};
}

export type DigestUndoRefusal = "gone" | "notYours" | "readOnly" | "missing" | "failed";

/** Why the server refused an undo (its status and code), as a reason the reader is told. */
export function undoRefusalOf(error: unknown): DigestUndoRefusal {
	const status =
		typeof error === "object" && error !== null && "status" in error
			? (error as { status: unknown }).status
			: null;
	const data =
		typeof error === "object" && error !== null && "data" in error
			? (error as { data?: { code?: unknown } }).data
			: undefined;
	const code = typeof data?.code === "string" ? data.code : null;
	if (status === 409 || code === OUTLINE_DIGEST_UNDO_CODES.gone) return "gone";
	if (code === OUTLINE_DIGEST_UNDO_CODES.readOnly) return "readOnly";
	if (status === 403) return "notYours";
	if (status === 404) return "missing";
	return "failed";
}
