/**
 * The built-in views of an outline session (outline plan PR 4, design §4.2, D27e): "current
 * tasks" (`outline.tasks`) and "behavior boundary" (`outline.behavior`).
 *
 * HOW THEY REACH THE MODEL
 * ------------------------
 * As named dynamic context parts of the request prefix, like `workspace` or `skills`: a new
 * epoch (the first turn, every successful compact, a model change) carries their values in its
 * baseline; within an epoch every provider request compares them byte for byte and appends one
 * `context_update` when they changed (`narrator-epochs.ts`). So the boundary is there on the first
 * turn and after every compact whether it changed or not, and both are injected only on change.
 * A view with nothing to show is no part at all (removing it is an update too). A view that cannot
 * be read is never "nothing to show": the last text read is served, and without one the part is
 * marked `unreadable` so the request keeps the previous value.
 *
 * Their text is their change key, so it is deterministic: fixed order, no times or leases. A
 * lease renewing changes nothing; a status, title, wait or the person's mark does.
 *
 * READS AND CACHE
 * ---------------
 * The prefix is built before every provider request, so each narrator's rendered views are
 * cached in memory. An entry goes stale (read again before it is served; kept to serve should
 * that read fail) when an `outline:committed` lands in a space it depends on, when one of its
 * narrators commits anywhere (the session claiming a task elsewhere), when the old fence of one
 * of its narrators changes (`spec:changed`, the plugin's SOP), and after
 * {@link OUTLINE_VIEW_LIMITS.maxAgeMs} at the latest. The spaces it depends on are the session
 * space, the spaces of the open tasks read, and the space of the first prerequisite of each listed
 * waiting task; anything else (a further prerequisite elsewhere, someone else's lease running out
 * before the expiry job commits) shows within the age limit. An entry read while no session
 * space existed yet depends on every commit. A hit costs no query; a miss is one bounded read
 * (`findContinuationCandidates` with its limits, the titles shown, the prerequisites named; or
 * the behavior page's structure and the content the budget shows, and the old fence, read
 * without creating anything).
 */
import { eventBus } from "@server/lib/event-bus";
import { hotOnce, hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import {
	getOutlineBehaviorFenceTruncated,
	getOutlineBehaviorViewFence,
	getOutlineBehaviorViewHeading,
	getOutlineBehaviorViewPage,
	getOutlineBehaviorViewSop,
	getOutlineBehaviorViewTruncated,
	getOutlineTasksViewHeading,
	getOutlineTasksViewMore,
	getOutlineTasksViewSection,
	getOutlineViewTaskLine,
	getUserLanguage,
	type Locale,
	type OutlineTasksViewSection,
	type OutlineViewTask,
} from "@server/lib/prompt-i18n";
import { blockTitle } from "@shared/outline";
import type { OutlineTasksViewDisplay, OutlineTasksViewTask } from "@shared/outline-task-notice";
import type { ContextPart } from "@shared/prefix-context";
import { readNarrator } from "../outline/access-reads";
import { loadBodies, readSubtree } from "../outline/read";
import { renderOutline } from "../outline/render";
import { outlineStore } from "../outline/store";
import { breadthFirst, type OutlineNode } from "../outline/tree";
import { readTaskSession } from "./backend";
import {
	findBehaviorPage,
	graphemeBoundary,
	importLeftover,
	readOldBehaviorFence,
} from "./outline-behavior";
import {
	type OpenEntry,
	type OutlineSession,
	readOpen,
	readOutlineSession,
	titlesOf,
} from "./outline-read";

export const OUTLINE_VIEW_KEYS = {
	tasks: "outline.tasks",
	behavior: "outline.behavior",
} as const;

export const OUTLINE_VIEW_LIMITS = {
	/** Tasks in progress the current-tasks view lists. */
	doing: 5,
	/** Waiting tasks it lists. */
	waiting: 5,
	/** Characters of the current-tasks view. */
	tasksChars: 1500,
	/** Characters of a task title in a view. */
	titleChars: 120,
	/** Characters of the behavior view (page and plugin SOP together). */
	behaviorChars: 4000,
	/** Blocks of the behavior page the view reads at most. */
	behaviorBlocks: 400,
	/**
	 * Characters every block of the behavior page is shown with at least (its whole content when
	 * shorter), however long the blocks before it: no rule is hidden behind a long one.
	 */
	behaviorBlockMinChars: 80,
	/**
	 * Characters a block is shown with at most when not even every block's start fits (a page of
	 * more rules than the view holds). The share is then the length most of the page's blocks
	 * have (nine in ten), within the minimum and this, so typical rules are shown whole and the
	 * last ones are left out; but the minimum when that shows more top-level rules' starts.
	 */
	behaviorBlockMaxShare: 400,
	/**
	 * Characters and blocks of the behavior page in the spec fence while the outline is switched
	 * off: injected on the spec cadence like the whole old fence was, not in the cached prefix,
	 * and the agent has no outline tool then to read the rest.
	 */
	switchedOffChars: 30_000,
	switchedOffBlocks: 1000,
	/** How long a cached view is served without a change that drops it. */
	maxAgeMs: 60_000,
	/** Narrators' views kept, the least recently used dropped first. */
	cached: 1024,
	/**
	 * After a failed read, how long a view shown before is served without reading again, and a
	 * view never shown is read without logging its failures again.
	 */
	failureBackoffMs: 5_000,
} as const;

/** What a view's text depends on, collected while it is read. */
interface ViewDeps {
	spaces: Set<string>;
	narrators: Set<string>;
	/** Read while the session had no space yet: any commit may be the one that creates it. */
	anySpace: boolean;
}

interface CachedView extends ViewDeps {
	text: string | null;
	/** The reader's summary of the view (`ContextPart.display`), when the view has one. */
	display?: OutlineTasksViewDisplay;
	at: number;
	/**
	 * A change it depends on landed: read again before serving it, but keep it to serve should
	 * that read fail (the model keeps what it was shown instead of seeing the view removed).
	 */
	stale: boolean;
}

/** Changes seen while a view was being read: one that hits its dependencies makes it stale. */
interface ReadTracker {
	spaces: Set<string>;
	narrators: Set<string>;
	commits: number;
}

const cache = hotSafe("narrafork.outlineViews.cache", () => new Map<string, CachedView>());
/** When each view's last read failed: a view that keeps failing is read (and logged) less often. */
const failures = hotSafe("narrafork.outlineViews.failures", () => new Map<string, number>());
const reads = hotSafe("narrafork.outlineViews.reads", () => new Set<ReadTracker>());
const clock = hotSafe("narrafork.outlineViews.clock", () => ({ now: () => Date.now() }));

function hits(view: ViewDeps, spaceId: string | null, narratorId: string | null): boolean {
	return (
		(spaceId !== null && (view.anySpace || view.spaces.has(spaceId))) ||
		(narratorId !== null && view.narrators.has(narratorId))
	);
}

function dropWhere(spaceId: string | null, narratorId: string | null): void {
	for (const view of cache.values()) if (hits(view, spaceId, narratorId)) view.stale = true;
	for (const tracker of reads) {
		if (spaceId !== null) {
			tracker.spaces.add(spaceId);
			tracker.commits++;
		}
		if (narratorId !== null) tracker.narrators.add(narratorId);
	}
}

if (hotOnce("narrafork.outlineViews.listeners")) {
	eventBus.on("outline:committed", (event) => {
		dropWhere(event.spaceId, event.actorKind === "agent" ? event.actorId : null);
	});
	eventBus.on("spec:changed", (event) => {
		if (event.path === "behavior_fence") dropWhere(null, event.narratorId);
	});
	eventBus.on("narrator:deleted", (event) => {
		for (const key of cache.keys()) if (key.includes(`:${event.narratorId}:`)) cache.delete(key);
	});
}

/**
 * A view's read failed again within `failureBackoffMs` of a failure that was logged: the caller
 * marks the part unreadable without logging it again.
 */
class OutlineViewBackoffError extends Error {
	constructor(key: string, error: unknown) {
		super(`outline view ${key} still fails to read: ${String(error)}`);
		this.name = "OutlineViewBackoffError";
	}
}

/** Forget every cached view (tests); `now` replaces the clock (tests of the age limit). */
export function resetOutlineViewCache(now?: () => number): void {
	cache.clear();
	failures.clear();
	clock.now = now ?? (() => Date.now());
}

/** A view as read: its text (the change key), and the reader's summary when it has one. */
interface ViewRead {
	text: string | null;
	display?: OutlineTasksViewDisplay;
}

async function cachedView(
	key: string,
	read: (deps: ViewDeps) => Promise<string | null>,
): Promise<string | null> {
	return (await cachedViewRead(key, async (deps) => ({ text: await read(deps) }))).text;
}

async function cachedViewRead(
	key: string,
	read: (deps: ViewDeps) => Promise<ViewRead>,
): Promise<ViewRead> {
	const shown = (view: CachedView): ViewRead => ({
		text: view.text,
		...(view.display ? { display: view.display } : {}),
	});
	const hit = cache.get(key);
	if (hit && !hit.stale && clock.now() - hit.at < OUTLINE_VIEW_LIMITS.maxAgeMs) {
		cache.delete(key);
		cache.set(key, hit);
		return shown(hit);
	}
	// Within the backoff of a failed read, what was shown is served without reading again. A
	// view never shown is read on every request (the part is missing until it is), but its
	// failures are logged once per backoff.
	const failedAt = failures.get(key);
	const backingOff =
		failedAt !== undefined && clock.now() - failedAt < OUTLINE_VIEW_LIMITS.failureBackoffMs;
	if (backingOff && hit) return shown(hit);
	const tracker: ReadTracker = { spaces: new Set(), narrators: new Set(), commits: 0 };
	reads.add(tracker);
	try {
		const deps: ViewDeps = { spaces: new Set(), narrators: new Set(), anySpace: false };
		const startedAt = clock.now();
		let fresh: ViewRead;
		try {
			fresh = await read(deps);
		} catch (error) {
			if (backingOff) throw new OutlineViewBackoffError(key, error);
			failures.set(key, clock.now());
			while (failures.size > OUTLINE_VIEW_LIMITS.cached) {
				const oldest = failures.keys().next().value;
				if (oldest === undefined) break;
				failures.delete(oldest);
			}
			// A failing read keeps what was shown, stale or aged (an update that removes the view
			// and one that brings it back would both be noise); without one, the caller marks the
			// part unreadable and the request keeps its previous value.
			if (hit) {
				logger.warn("Outline view read failed; keeping the last one", {
					key,
					error: String(error),
				});
				return shown(hit);
			}
			throw error;
		}
		const stale =
			(deps.anySpace && tracker.commits > 0) ||
			[...deps.spaces].some((id) => tracker.spaces.has(id)) ||
			[...deps.narrators].some((id) => tracker.narrators.has(id));
		failures.delete(key);
		// Read while a change it depends on landed: kept (for a failing read) but read again next.
		cache.delete(key);
		cache.set(key, {
			...deps,
			text: fresh.text,
			...(fresh.display ? { display: fresh.display } : {}),
			at: startedAt,
			stale,
		});
		while (cache.size > OUTLINE_VIEW_LIMITS.cached) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
		return fresh;
	} finally {
		reads.delete(tracker);
	}
}

/** One line of at most `max` characters. */
function clip(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, Math.max(0, max - 1))}…` : line;
}

/** Text of at most `max` characters, its lines kept, never cut inside a character. */
function cut(text: string, max: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, graphemeBoundary(trimmed, Math.max(0, max - 1))).trimEnd()}…`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Current tasks
// ─────────────────────────────────────────────────────────────────────────────

/** What the views name a prerequisite by: its address, and its title when it may be shown. */
export interface Prerequisite {
	address: string;
	title: string | null;
}

/**
 * The prerequisites the given waiting tasks name first, by id. A title is shown only for one in
 * the session's own space: a prerequisite elsewhere may be in a space not every reader of the
 * session may read (D9), and the view is persisted and broadcast; its address is enough to read
 * it with.
 */
export async function readPrerequisites(
	entries: readonly OpenEntry[],
	session: OutlineSession,
	deps: ViewDeps = { spaces: new Set(), narrators: new Set(), anySpace: false },
): Promise<Map<string, Prerequisite>> {
	const ids = [...new Set(entries.flatMap((entry) => entry.wait?.prerequisites.slice(0, 1) ?? []))];
	const out = new Map<string, Prerequisite>();
	if (ids.length === 0) return out;
	const blocks = await outlineStore.getBlocks(ids);
	const keys = new Map<string, string>();
	for (const entry of entries) {
		const [key] = entry.ref.address.split("/");
		if (key) keys.set(entry.ref.spaceId, key);
	}
	for (const spaceId of new Set(blocks.map((block) => block.spaceId))) {
		deps.spaces.add(spaceId);
		if (keys.has(spaceId)) continue;
		const space = await outlineStore.getSpace(spaceId);
		if (space) keys.set(spaceId, space.key);
	}
	for (const block of blocks) {
		const key = keys.get(block.spaceId);
		if (!key) continue;
		out.set(block.id, {
			address: `${key}/${block.sid}`,
			title:
				block.spaceId === session.spaceId
					? clip(blockTitle(block.content) || block.sid, OUTLINE_VIEW_LIMITS.titleChars)
					: null,
		});
	}
	return out;
}

/** A task as the views (and the compact context) name it. */
export function viewTaskOf(
	entry: OpenEntry,
	titles: ReadonlyMap<string, string>,
	prerequisites: ReadonlyMap<string, Prerequisite>,
): OutlineViewTask {
	const first = entry.wait?.prerequisites[0];
	return {
		text: clip(titles.get(entry.ref.blockId) ?? entry.ref.sid, OUTLINE_VIEW_LIMITS.titleChars),
		address: entry.ref.address,
		humanCreated: entry.ref.taskJson.humanCreated === true,
		checkbox: entry.ref.status,
		wait: entry.wait
			? {
					prerequisite: first ? (prerequisites.get(first) ?? null) : null,
					prerequisites: entry.wait.prerequisites.length,
					people: entry.wait.people,
				}
			: null,
	};
}

async function readTasksView(
	narratorId: string,
	locale: Locale,
	deps: ViewDeps,
): Promise<ViewRead> {
	const session = await readOutlineSession(narratorId);
	if (session.sessionNarratorId) deps.narrators.add(session.sessionNarratorId);
	if (session.spaceId) deps.spaces.add(session.spaceId);
	else deps.anySpace = true;
	if (session.subagent) return { text: null };
	const read = await readOpen(session);
	for (const entry of read.entries) deps.spaces.add(entry.ref.spaceId);
	if (read.entries.length === 0) return { text: null };

	const doing = read.entries
		.filter((entry) => entry.status === "doing")
		.slice(0, OUTLINE_VIEW_LIMITS.doing);
	const waiting = read.entries
		.filter((entry) => entry.status === "blocked")
		.slice(0, OUTLINE_VIEW_LIMITS.waiting);
	const next = read.entries.find((entry) => entry.status === "todo");
	const sections: Array<{ section: OutlineTasksViewSection; entries: OpenEntry[] }> = [
		{ section: "doing", entries: doing },
		{ section: "waiting", entries: waiting },
		{ section: "next", entries: next ? [next] : [] },
	];
	const listed = sections.flatMap((s) => s.entries);
	const titles = await titlesOf(listed);
	const prerequisites = await readPrerequisites(waiting, session, deps);
	const task = (entry: OpenEntry) => viewTaskOf(entry, titles, prerequisites);

	// Sections in order; lines that do not fit the budget are counted in the last line instead.
	const heading = getOutlineTasksViewHeading(locale);
	const lines: string[] = [heading];
	let used = heading.length;
	let shown = 0;
	const room = OUTLINE_VIEW_LIMITS.tasksChars - getOutlineTasksViewMore(99, locale).length - 1;
	// The entries whose lines the text holds: the reader's summary names these and no others.
	const printed = new Set<OpenEntry>();
	for (const { section, entries } of sections) {
		if (entries.length === 0) continue;
		const sectionLine = getOutlineTasksViewSection(section, locale);
		const taskLines = entries.map((entry) => getOutlineViewTaskLine(task(entry), locale));
		const first = taskLines[0] as string;
		if (used + sectionLine.length + first.length + 2 > room) break;
		lines.push(sectionLine);
		used += sectionLine.length + 1;
		for (const [index, line] of taskLines.entries()) {
			if (used + line.length + 1 > room) break;
			lines.push(line);
			used += line.length + 1;
			shown++;
			printed.add(entries[index] as OpenEntry);
		}
	}
	const hidden = read.entries.length - shown;
	if (read.truncated) lines.push(getOutlineTasksViewMore(null, locale));
	else if (hidden > 0) lines.push(getOutlineTasksViewMore(hidden, locale));
	// The reader's summary of the same read: the tasks the text lists, per section and titled (never
	// one the budget left out of the text), and how many are open of each kind. Prerequisites are
	// left out (D9: their space may not be readable by every reader of the session).
	const viewTask = (entry: OpenEntry): OutlineTasksViewTask => {
		const named = task(entry);
		return {
			address: named.address ?? entry.ref.address,
			title: named.text,
			...(named.humanCreated ? { humanCreated: true as const } : {}),
		};
	};
	const counted = (status: OpenEntry["status"]) =>
		read.entries.filter((entry) => entry.status === status).length;
	const inText = (entries: readonly OpenEntry[]) =>
		entries.filter((entry) => printed.has(entry)).map(viewTask);
	const display: OutlineTasksViewDisplay = {
		doing: inText(doing),
		waiting: inText(waiting),
		next: inText(next ? [next] : []),
		counts: { doing: counted("doing"), waiting: counted("blocked"), todo: counted("todo") },
		...(read.truncated ? { more: true as const } : {}),
	};
	return { text: lines.join("\n"), display };
}

/**
 * The current-tasks view of an outline root session: in progress (at most five), waiting (at most
 * five, with what each waits for), the next to-do. Null when nothing is open, for a subagent (it
 * has no tasks of its own, D27c), and when the session cannot be read.
 */
export async function outlineTasksView(narratorId: string, locale: Locale): Promise<string | null> {
	return (await outlineTasksViewRead(narratorId, locale)).text;
}

/** The current-tasks view with its reader summary (`ContextPart.display`). */
async function outlineTasksViewRead(narratorId: string, locale: Locale): Promise<ViewRead> {
	return await cachedViewRead(`tasks:${narratorId}:${locale}`, (deps) =>
		readTasksView(narratorId, locale, deps),
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Behavior boundary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A block's content shown with at most `max` characters: whole when it fits, else its start (cut
 * at a space or line break in the second half when there is one, else at a grapheme boundary)
 * and `…`. A code fence left open by the cut is cut off before it, or closed when it opens the
 * block, so the blocks after it are not read as code.
 */
function clipContent(content: string, max: number): string {
	if (content.length <= max) return content;
	let end = graphemeBoundary(content, Math.max(1, max - 1));
	const soft = Math.max(content.lastIndexOf("\n", end - 1), content.lastIndexOf(" ", end - 1));
	if (soft >= end / 2) end = soft;
	const kept = content.slice(0, end).trimEnd();
	const fences = [...kept.matchAll(/^[ \t]*(`{3,}|~{3,})/gm)];
	const open = fences.length % 2 === 1 ? fences[fences.length - 1] : undefined;
	if (!open) return `${kept}…`;
	const before = kept.slice(0, open.index).trimEnd();
	return before ? `${before}…` : `${kept}…\n${open[1]}`;
}

/**
 * The share of characters each block is shown with (a block shorter than it is shown whole): the
 * largest one that lets all of `blocks` fit `room`, at least `min`. When not even `min` lets them
 * all fit, the render leaves out the last ones (breadth first). The share is then the length nine
 * in ten blocks do not exceed (within `min` and `cap`), so typical rules are shown whole rather
 * than every one cut short, unless that shows fewer top-level blocks' starts than `min` does:
 * then `min`, since a rule's start matters more than the rest of a few (round 4, N-R4-1).
 */
function fairShare(
	blocks: ReadonlyArray<{ length: number; overhead: number; top: boolean }>,
	room: number,
	min: number,
	cap: number,
): { share: number; all: boolean } {
	const total = (share: number) => {
		let sum = 0;
		for (const block of blocks) sum += Math.min(block.length, share) + block.overhead;
		return sum;
	};
	let longest = min;
	for (const block of blocks) longest = Math.max(longest, block.length);
	if (total(longest) <= room) return { share: longest, all: true };
	if (total(min) > room) {
		const lengths = blocks.map((block) => block.length).sort((a, b) => a - b);
		const typical = lengths[Math.floor(0.9 * (lengths.length - 1))] ?? min;
		const share = Math.min(Math.max(min, typical), Math.max(min, cap));
		// Top-level blocks whose start a share shows: blocks go in breadth first while they fit.
		const starts = (each: number) => {
			let used = 0;
			let tops = 0;
			for (const block of blocks) {
				used += Math.min(block.length, each) + block.overhead;
				if (used > room) break;
				if (block.top) tops++;
			}
			return tops;
		};
		return { share: share > min && starts(share) < starts(min) ? min : share, all: false };
	}
	let fits = min;
	let over = longest;
	while (over - fits > 1) {
		const mid = Math.floor((fits + over) / 2);
		if (total(mid) <= room) fits = mid;
		else over = mid;
	}
	return { share: fits, all: true };
}

/** Load the bodies `order` may show: until even their fair minimum would overrun `maxBytes`. */
async function loadBehaviorBodies(
	state: Parameters<typeof loadBodies>[0],
	order: readonly OutlineNode[],
	maxBytes: number,
	minBytes: number,
): Promise<void> {
	let counted = 0;
	for (let i = 0; i < order.length && counted <= maxBytes; ) {
		const chunk = order.slice(i, i + OUTLINE_BEHAVIOR_BODY_CHUNK);
		await loadBodies(state, chunk);
		for (const node of chunk) {
			counted += Math.min(Buffer.byteLength(node.content ?? "", "utf8"), minBytes) + 4;
			i++;
			if (counted > maxBytes) break;
		}
	}
}

/** Blocks whose bodies one statement of the behavior render loads. */
const OUTLINE_BEHAVIOR_BODY_CHUNK = 25;

interface BehaviorPageRender {
	markdown: string;
	/**
	 * Blocks shown with only their start or left out by the budget (at least one when the page
	 * was read cut short: it has more blocks than one read loads).
	 */
	notInFull: number;
	truncated: boolean;
}

/**
 * The behavior page as a markdown outline within `maxChars`, fair to every block: each is shown
 * with the same share of the budget (whole when shorter), the largest share that lets all of them
 * fit, never less than `behaviorBlockMinChars`. So one long block (a paragraph of prose an old
 * fence opened with, a 15 KiB piece of an oversize item) shows its start and the rules after it
 * still show, and what the short ones leave goes to the long ones. Only when not even every
 * block's start fits are the last ones (breadth first) left out, with the share that shows the
 * most top-level rules' starts (see `fairShare`). `notInFull` counts what is not shown in full.
 */
async function renderBehaviorPage(
	pageId: string,
	maxChars: number,
	maxBlocks: number = OUTLINE_VIEW_LIMITS.behaviorBlocks,
): Promise<BehaviorPageRender | null> {
	if (maxChars <= 0) return null;
	const subtree = await readSubtree(pageId);
	if (!subtree) return null;
	const { state, root } = subtree;
	const min = OUTLINE_VIEW_LIMITS.behaviorBlockMinChars;
	const order = breadthFirst(root, "all", maxBlocks);
	// A character is at most three UTF-8 bytes in the text a page holds.
	await loadBehaviorBodies(state, order, maxChars * 3, min * 3);

	// What each loaded block costs besides its content: the bullet, the indentation of each of
	// its lines, the line break and the `…` of a shortened one.
	const depth = new Map<OutlineNode, number>([[root, 0]]);
	const blocks: Array<{ length: number; overhead: number; top: boolean }> = [];
	for (const node of order) {
		if (node.content === null) break;
		const level = node.parent ? (depth.get(node.parent) ?? 0) + 1 : 0;
		depth.set(node, level);
		const lines = 1 + (node.content.match(/\n/g)?.length ?? 0);
		blocks.push({
			length: node.content.length,
			overhead: lines * (2 * level + 3) + 1,
			top: level === 1,
		});
	}

	const fair = fairShare(blocks, maxChars, min, OUTLINE_VIEW_LIMITS.behaviorBlockMaxShare);
	let share = fair.share;
	let bytes = maxChars * 3;
	let last: { markdown: string; notInFull: number } | null = null;
	for (let attempt = 0; attempt < 8; attempt++) {
		const shortened = new Set<string>();
		const rendered = renderOutline(root, {
			view: "all",
			budget: { blocks: maxBlocks, bytes },
			display: (node, item) => {
				let shown = item;
				// The page's own `alias:: behavior` says nothing the heading does not.
				if (node === root && item.props.alias !== undefined) {
					const { alias: _alias, ...props } = item.props;
					shown = { ...item, props };
				}
				const content = clipContent(shown.content, share);
				if (content === shown.content) return shown;
				shortened.add(node.id);
				return { ...shown, content };
			},
			truncatedRead: state.truncated ? { blocksRead: state.nodes.size } : undefined,
		});
		const markdown = rendered.markdown.trimEnd();
		const shownShortened = rendered.blockIds.filter((id) => shortened.has(id)).length;
		last = {
			markdown,
			notInFull: Math.max(shownShortened + rendered.hiddenByBudget, state.truncated ? 1 : 0),
		};
		if (markdown.length <= maxChars) return { ...last, truncated: last.notInFull > 0 };
		// Over: when every block was to fit (the cost estimate is close, not exact), a smaller
		// share first; else, or at the minimum, fewer blocks.
		if (fair.all && share > min) {
			share = Math.max(min, Math.floor((share * maxChars) / markdown.length) - 8);
		} else {
			// From what this render took, not the budget it had: a budget far above what the page
			// holds would take many rounds to bind.
			const took = Math.min(bytes, rendered.bytes);
			bytes = Math.max(64, Math.floor((took * maxChars) / markdown.length) - 8);
		}
	}
	if (!last) return null;
	return {
		markdown: cut(last.markdown, maxChars),
		notInFull: Math.max(1, last.notInFull),
		truncated: true,
	};
}

/**
 * One section of the behavior view, its first line then `text`, within `room` characters; null
 * when there is no text, or not even its first line and a few characters fit.
 */
function section(intro: string, text: string, room: number): string | null {
	const left = room - intro.length - 1;
	if (left < 16 || !text.trim()) return null;
	return `${intro}\n${cut(text, left)}`;
}

async function readBehaviorView(
	narratorId: string,
	locale: Locale,
	deps: ViewDeps,
): Promise<string | null> {
	const session = await readOutlineSession(narratorId);
	const sessionNarratorId = session.sessionNarratorId;
	deps.narrators.add(narratorId);
	if (sessionNarratorId) deps.narrators.add(sessionNarratorId);
	if (session.spaceId) deps.spaces.add(session.spaceId);
	else deps.anySpace = true;

	const heading = getOutlineBehaviorViewHeading(locale);
	const sections: string[] = [];
	// What is left of the budget; every section costs its length and the line break before it.
	let room = OUTLINE_VIEW_LIMITS.behaviorChars - heading.length;
	const take = (text: string | null) => {
		if (!text) return;
		sections.push(text);
		room -= text.length + 1;
	};

	// 1. The person's page comes first and gets the budget it needs.
	const page =
		session.spaceId && sessionNarratorId ? await findBehaviorPage(session.spaceId) : null;
	if (page) {
		const space = await outlineStore.getSpace(page.spaceId);
		const address = `${space?.key ?? page.spaceId}/${page.sid}`;
		const intro = getOutlineBehaviorViewPage(address, locale);
		// Room for the note with the largest count it can carry.
		const longestNote = getOutlineBehaviorViewTruncated(address, 99_999, locale);
		const rendered = await renderBehaviorPage(
			page.id,
			room - 1 - intro.length - 1 - longestNote.length - 1,
		);
		if (rendered?.markdown.trim()) {
			const note = getOutlineBehaviorViewTruncated(address, rendered.notInFull, locale);
			take([intro, rendered.markdown, ...(rendered.truncated ? [note] : [])].join("\n"));
		}
	}

	// 2. Old fence text the import has not moved yet (it runs when the session starts a run and
	// may fail, page or no page): it still binds the session, so it is shown from where it is.
	// After an import cut short only what did not reach the page is shown, not the fence from
	// its top again.
	const own = await readOldBehaviorFence(narratorId);
	if (sessionNarratorId) {
		const fence =
			sessionNarratorId === narratorId ? own : await readOldBehaviorFence(sessionNarratorId);
		const left = fence.own ? (importLeftover(sessionNarratorId, fence.own) ?? fence.own) : "";
		take(section(getOutlineBehaviorViewFence(locale), left, room - 1));
	}

	// 3. The plugin's SOP gets what is left: this narrator's own (a plugin's temporary worker has
	// its own; D31 keeps the page the root's).
	take(section(getOutlineBehaviorViewSop(locale), own.sop, room - 1));

	if (sections.length === 0) return null;
	return [heading, ...sections].join("\n");
}

/**
 * The behavior view: the session's behavior page (a subagent's root's, D31), first and with the
 * budget it needs, with its address; then old fence text not moved to the page yet; then the
 * plugin SOP of the narrator's own old fence with what is left. Null when there is none of them.
 */
export async function outlineBehaviorView(
	narratorId: string,
	locale: Locale,
): Promise<string | null> {
	return await cachedView(`behavior:${narratorId}:${locale}`, (deps) =>
		readBehaviorView(narratorId, locale, deps),
	);
}

/**
 * Both views as context parts, in order. A view that cannot be read and was never read in this
 * process is marked `unreadable`, so the request keeps whatever the model was shown before; only
 * a view that is really empty is left out.
 */
export async function outlineContextParts(
	narratorId: string,
	locale: Locale,
	options: { tasks: boolean },
): Promise<ContextPart[]> {
	const parts: ContextPart[] = [];
	const add = async (key: string, view: () => Promise<ViewRead>) => {
		try {
			const { text, display } = await view();
			if (text) parts.push({ key, text, ...(display ? { display } : {}) });
		} catch (error) {
			// Logged when a read failed, not again for each failure within its backoff.
			if (!(error instanceof OutlineViewBackoffError)) {
				logger.warn("Outline view could not be read", { narratorId, key, error: String(error) });
			}
			parts.push({ key, text: "", unreadable: true });
		}
	};
	if (options.tasks) {
		await add(OUTLINE_VIEW_KEYS.tasks, () => outlineTasksViewRead(narratorId, locale));
	}
	await add(OUTLINE_VIEW_KEYS.behavior, async () => ({
		text: await outlineBehaviorView(narratorId, locale),
	}));
	return parts;
}

/** Both views marked unreadable: the session itself could not be resolved for this request. */
export function unreadableOutlineContextParts(): ContextPart[] {
	return [
		{ key: OUTLINE_VIEW_KEYS.tasks, text: "", unreadable: true },
		{ key: OUTLINE_VIEW_KEYS.behavior, text: "", unreadable: true },
	];
}

/**
 * The behavior page's text for a session whose tasks live in the outline while the outline is
 * switched off (it then runs as a spec session): the spec fence reader puts it ahead of the old
 * fence, which after the import holds only the plugin SOP, so the person's rules never drop out.
 * Null for any other narrator. A subagent gets its session's page, as under the outline (D31).
 */
export async function behaviorPageForSpecFence(narratorId: string): Promise<string | null> {
	const session = await readTaskSession(narratorId);
	if (!session || session.backend !== "outline" || !session.sessionNarratorId) return null;
	const space = await outlineStore.findSpace({
		kind: "session",
		narratorId: session.sessionNarratorId,
	});
	const page = space ? await findBehaviorPage(space.id) : null;
	if (!space || !page) return null;
	// Worded in the session owner's language: the spec fence reader knows no locale.
	const owner = (await readNarrator(session.sessionNarratorId))?.ownerUserId ?? null;
	const locale: Locale = owner ? await getUserLanguage(owner) : "en";
	const address = `${space.key}/${page.sid}`;
	const intro = getOutlineBehaviorViewPage(address, locale);
	const longestNote = getOutlineBehaviorFenceTruncated(99_999, locale);
	const rendered = await renderBehaviorPage(
		page.id,
		OUTLINE_VIEW_LIMITS.switchedOffChars - intro.length - 1 - longestNote.length - 1,
		OUTLINE_VIEW_LIMITS.switchedOffBlocks,
	);
	if (!rendered?.markdown.trim()) return null;
	const note = getOutlineBehaviorFenceTruncated(rendered.notInFull, locale);
	return [intro, rendered.markdown, ...(rendered.truncated ? [note] : [])].join("\n");
}
