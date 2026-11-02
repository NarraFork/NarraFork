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
 * A view with nothing to show is no part at all (removing it is an update too).
 *
 * Their text is their change key, so it is deterministic: fixed order, no times or leases. A
 * lease renewing changes nothing; a status, title, wait or the person's mark does.
 *
 * READS AND CACHE
 * ---------------
 * The prefix is built before every provider request, so each narrator's rendered views are
 * cached in memory. An entry is dropped when an `outline:committed` lands in a space it depends
 * on (the session space, the spaces of the tasks it lists and of their prerequisites), when one of
 * its narrators commits anywhere (the session claiming a task elsewhere), when the old fence of
 * one of its narrators changes (`spec:changed`, the plugin's SOP), and after
 * {@link OUTLINE_VIEW_LIMITS.maxAgeMs} at the latest (what changes with time alone: someone
 * else's lease running out before the expiry job commits). An entry read while no session space
 * existed yet depends on every commit. A hit costs no query; a miss is one bounded read
 * (`findContinuationCandidates` with its limits, the titles shown, the prerequisites named; or
 * the behavior page's structure and the content the budget shows, and the old fence).
 */
import { eventBus } from "@server/lib/event-bus";
import { hotOnce, hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import {
	getOutlineBehaviorViewFence,
	getOutlineBehaviorViewHeading,
	getOutlineBehaviorViewPage,
	getOutlineBehaviorViewSop,
	getOutlineBehaviorViewTruncated,
	getOutlineTasksViewHeading,
	getOutlineTasksViewMore,
	getOutlineTasksViewSection,
	getOutlineViewTaskLine,
	type Locale,
	type OutlineTasksViewSection,
	type OutlineViewTask,
} from "@server/lib/prompt-i18n";
import { blockTitle } from "@shared/outline";
import type { PromptPart } from "@shared/prefix-context";
import { loadBodiesWithin, readSubtree } from "../outline/read";
import { renderOutline } from "../outline/render";
import { outlineStore } from "../outline/store";
import { breadthFirst } from "../outline/tree";
import { findBehaviorPage, readOldBehaviorFence } from "./outline-behavior";
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
	/** How long a cached view is served without a change that drops it. */
	maxAgeMs: 60_000,
	/** Narrators' views kept, the least recently used dropped first. */
	cached: 1024,
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
	at: number;
}

/** Changes seen while a view was being read: one that hits its dependencies makes it stale. */
interface ReadTracker {
	spaces: Set<string>;
	narrators: Set<string>;
	commits: number;
}

const cache = hotSafe("narrafork.outlineViews.cache", () => new Map<string, CachedView>());
const reads = hotSafe("narrafork.outlineViews.reads", () => new Set<ReadTracker>());
const clock = hotSafe("narrafork.outlineViews.clock", () => ({ now: () => Date.now() }));

function hits(view: ViewDeps, spaceId: string | null, narratorId: string | null): boolean {
	return (
		(spaceId !== null && (view.anySpace || view.spaces.has(spaceId))) ||
		(narratorId !== null && view.narrators.has(narratorId))
	);
}

function dropWhere(spaceId: string | null, narratorId: string | null): void {
	for (const [key, view] of cache) if (hits(view, spaceId, narratorId)) cache.delete(key);
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

/** Forget every cached view (tests); `now` replaces the clock (tests of the age limit). */
export function resetOutlineViewCache(now?: () => number): void {
	cache.clear();
	clock.now = now ?? (() => Date.now());
}

async function cachedView(
	key: string,
	read: (deps: ViewDeps) => Promise<string | null>,
): Promise<string | null> {
	const hit = cache.get(key);
	if (hit && clock.now() - hit.at < OUTLINE_VIEW_LIMITS.maxAgeMs) {
		cache.delete(key);
		cache.set(key, hit);
		return hit.text;
	}
	const tracker: ReadTracker = { spaces: new Set(), narrators: new Set(), commits: 0 };
	reads.add(tracker);
	try {
		const deps: ViewDeps = { spaces: new Set(), narrators: new Set(), anySpace: false };
		const startedAt = clock.now();
		let text: string | null;
		try {
			text = await read(deps);
		} catch (error) {
			// A failing read keeps what was shown (an update that removes the view and one that
			// brings it back would both be noise); without one, the caller leaves the part out.
			if (hit) {
				logger.warn("Outline view read failed; keeping the last one", {
					key,
					error: String(error),
				});
				return hit.text;
			}
			throw error;
		}
		const stale =
			(deps.anySpace && tracker.commits > 0) ||
			[...deps.spaces].some((id) => tracker.spaces.has(id)) ||
			[...deps.narrators].some((id) => tracker.narrators.has(id));
		if (stale) cache.delete(key);
		else {
			cache.set(key, { ...deps, text, at: startedAt });
			while (cache.size > OUTLINE_VIEW_LIMITS.cached) {
				const oldest = cache.keys().next().value;
				if (oldest === undefined) break;
				cache.delete(oldest);
			}
		}
		return text;
	} finally {
		reads.delete(tracker);
	}
}

/** One line of at most `max` characters. */
function clip(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, Math.max(0, max - 1))}…` : line;
}

/** Text of at most `max` characters, its lines kept. */
function cut(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…` : trimmed;
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
): Promise<string | null> {
	const session = await readOutlineSession(narratorId);
	if (session.sessionNarratorId) deps.narrators.add(session.sessionNarratorId);
	if (session.spaceId) deps.spaces.add(session.spaceId);
	else deps.anySpace = true;
	if (session.subagent) return null;
	const read = await readOpen(session);
	for (const entry of read.entries) deps.spaces.add(entry.ref.spaceId);
	if (read.entries.length === 0) return null;

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
	for (const { section, entries } of sections) {
		if (entries.length === 0) continue;
		const sectionLine = getOutlineTasksViewSection(section, locale);
		const taskLines = entries.map((entry) => getOutlineViewTaskLine(task(entry), locale));
		const first = taskLines[0] as string;
		if (used + sectionLine.length + first.length + 2 > room) break;
		lines.push(sectionLine);
		used += sectionLine.length + 1;
		for (const line of taskLines) {
			if (used + line.length + 1 > room) break;
			lines.push(line);
			used += line.length + 1;
			shown++;
		}
	}
	const hidden = read.entries.length - shown;
	if (read.truncated) lines.push(getOutlineTasksViewMore(null, locale));
	else if (hidden > 0) lines.push(getOutlineTasksViewMore(hidden, locale));
	return lines.join("\n");
}

/**
 * The current-tasks view of an outline root session: in progress (at most five), waiting (at most
 * five, with what each waits for), the next to-do. Null when nothing is open, for a subagent (it
 * has no tasks of its own, D27c), and when the session cannot be read.
 */
export async function outlineTasksView(narratorId: string, locale: Locale): Promise<string | null> {
	return await cachedView(`tasks:${narratorId}:${locale}`, (deps) =>
		readTasksView(narratorId, locale, deps),
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Behavior boundary
// ─────────────────────────────────────────────────────────────────────────────

/** The behavior page as a markdown outline within `maxChars`, and whether all of it fit. */
async function renderBehaviorPage(
	pageId: string,
	maxChars: number,
): Promise<{ markdown: string; truncated: boolean } | null> {
	const subtree = await readSubtree(pageId);
	if (!subtree) return null;
	const { state, root } = subtree;
	// A character is at most three UTF-8 bytes in the text a page holds: load what that shows.
	let bytes = Math.max(64, maxChars * 3);
	const order = breadthFirst(root, "all", OUTLINE_VIEW_LIMITS.behaviorBlocks);
	await loadBodiesWithin(state, order, bytes);
	for (let attempt = 0; ; attempt++) {
		const rendered = renderOutline(root, {
			view: "all",
			budget: { blocks: OUTLINE_VIEW_LIMITS.behaviorBlocks, bytes },
			// The page's own `alias:: behavior` says nothing the heading does not.
			display: (node, item) => {
				if (node !== root || item.props.alias === undefined) return item;
				const { alias: _alias, ...props } = item.props;
				return { ...item, props };
			},
			truncatedRead: state.truncated ? { blocksRead: state.nodes.size } : undefined,
		});
		const markdown = rendered.markdown.trimEnd();
		const truncated = rendered.hiddenByBudget > 0 || state.truncated;
		if (markdown.length <= maxChars || bytes <= 64 || attempt >= 4) {
			return {
				markdown: markdown.length <= maxChars ? markdown : `${markdown.slice(0, maxChars - 1)}…`,
				truncated: truncated || markdown.length > maxChars,
			};
		}
		bytes = Math.max(64, Math.floor((bytes * maxChars) / markdown.length) - 8);
	}
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
	let room = OUTLINE_VIEW_LIMITS.behaviorChars - heading.length - 1;

	// The plugin's SOP: this narrator's own (a plugin's temporary worker has its own, D31 keeps
	// the page the root's). Measured first so the page gets what is left.
	const own = await readOldBehaviorFence(narratorId);
	const sopHeading = getOutlineBehaviorViewSop(locale);
	const sop = own.sop ? cut(own.sop, Math.max(0, room - sopHeading.length - 1)) : "";
	if (sop) room -= sopHeading.length + sop.length + 2;

	const page =
		session.spaceId && sessionNarratorId ? await findBehaviorPage(session.spaceId) : null;
	if (page) {
		const space = await outlineStore.getSpace(page.spaceId);
		const address = `${space?.key ?? page.spaceId}/${page.sid}`;
		const intro = getOutlineBehaviorViewPage(address, locale);
		const note = getOutlineBehaviorViewTruncated(address, locale);
		const rendered = await renderBehaviorPage(
			page.id,
			Math.max(0, room - intro.length - note.length - 2),
		);
		if (rendered?.markdown.trim()) {
			sections.push([intro, rendered.markdown, ...(rendered.truncated ? [note] : [])].join("\n"));
		}
	} else if (sessionNarratorId) {
		// No page: what the import did not move (it runs when the session starts a run and may
		// have failed) still binds the session, so it is shown from where it is.
		const fence =
			sessionNarratorId === narratorId ? own : await readOldBehaviorFence(sessionNarratorId);
		if (fence.own) {
			const intro = getOutlineBehaviorViewFence(locale);
			sections.push(`${intro}\n${cut(fence.own, Math.max(0, room - intro.length - 1))}`);
		}
	}
	if (sop) sections.push(`${sopHeading}\n${sop}`);
	if (sections.length === 0) return null;
	return [heading, ...sections].join("\n");
}

/**
 * The behavior view: the session's behavior page (a subagent's root's, D31), rendered within the
 * budget with its address, followed by the plugin SOP of the narrator's own old fence. Null when
 * there is neither.
 */
export async function outlineBehaviorView(
	narratorId: string,
	locale: Locale,
): Promise<string | null> {
	return await cachedView(`behavior:${narratorId}:${locale}`, (deps) =>
		readBehaviorView(narratorId, locale, deps),
	);
}

/** Both views as context parts, in order; a view that cannot be read is left out (logged). */
export async function outlineContextParts(
	narratorId: string,
	locale: Locale,
	options: { tasks: boolean },
): Promise<PromptPart[]> {
	const parts: PromptPart[] = [];
	const add = async (key: string, view: () => Promise<string | null>) => {
		try {
			const text = await view();
			if (text) parts.push({ key, text });
		} catch (error) {
			logger.warn("Outline view could not be read", { narratorId, key, error: String(error) });
		}
	};
	if (options.tasks) {
		await add(OUTLINE_VIEW_KEYS.tasks, () => outlineTasksView(narratorId, locale));
	}
	await add(OUTLINE_VIEW_KEYS.behavior, () => outlineBehaviorView(narratorId, locale));
	return parts;
}
