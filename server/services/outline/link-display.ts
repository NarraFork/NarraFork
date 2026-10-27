/**
 * Links as an agent reads them.
 *
 * Content stores links as `[[key/sid]]`, which says nothing to a reader. A read shows each one
 * with its target's current title, `[[key/sid|Title]]`, when the session may read the target;
 * otherwise the link stays as stored, so a read tells nothing about a block it may not read, not
 * even whether it exists. When an agent copies such a link back into an edit, a display text
 * equal to the target's current title is dropped again (`edit-text.ts`), so stored content keeps
 * `[[key/sid]]` and never carries a title that goes stale; a display text the agent chose stays.
 *
 * The titles are filled in as text: stored content is canonical, so a link to `key/sid` is
 * spelled exactly `refSource("key/sid")` wherever it is a link. The same text inside a code span,
 * after an escaping backslash or in a code block is literal and left alone, and only targets the
 * block's link rows name are touched. No block is lexed again for a read.
 */
import { blockTitle, codeSpans, refSource } from "@shared/outline";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";

export const LINK_DISPLAY_LIMITS = {
	/** Characters of a title shown in a link. */
	maxTitleChars: 80,
	/** Link rows one read looks at. */
	maxLinkRows: 2000,
	/** Distinct targets one read titles. */
	maxTargets: 500,
} as const;

/**
 * The display text of a link to a block titled `title`: one line, square brackets (which a
 * display text cannot hold) turned into parentheses, at most 80 characters. Null when empty.
 */
export function linkDisplayTitle(title: string): string | null {
	const flat = title.replace(/\s+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").trim();
	if (!flat) return null;
	const chars = Array.from(flat);
	return chars.length <= LINK_DISPLAY_LIMITS.maxTitleChars
		? flat
		: `${chars.slice(0, LINK_DISPLAY_LIMITS.maxTitleChars - 1).join("")}…`;
}

function escaped(text: string, at: number): boolean {
	let slashes = 0;
	for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
	return slashes % 2 === 1;
}

/**
 * `content` with links to the given targets (`key/sid`) shown with their display titles. Pure.
 * Targets missing from `titles` stay as they are.
 */
export function withLinkTitles(
	content: string,
	targets: Iterable<string>,
	titles: ReadonlyMap<string, string>,
): string {
	if (/^(?:`{3,}|~{3,})/.test(content)) return content;
	const table = content.startsWith("|");
	let spans: Array<[number, number]> | null = null;
	const edits: Array<{ at: number; length: number; text: string }> = [];
	for (const target of new Set(targets)) {
		const title = titles.get(target);
		if (!title) continue;
		const plain = refSource(target, null, table);
		const titled = refSource(target, title, table);
		for (let at = content.indexOf(plain); at >= 0; at = content.indexOf(plain, at + plain.length)) {
			if (escaped(content, at)) continue;
			spans ??= codeSpans(content);
			if (spans.some(([start, end]) => at >= start && at < end)) continue;
			edits.push({ at, length: plain.length, text: titled });
		}
	}
	if (edits.length === 0) return content;
	edits.sort((a, b) => a.at - b.at);
	let out = "";
	let from = 0;
	for (const edit of edits) {
		out += content.slice(from, edit.at) + edit.text;
		from = edit.at + edit.length;
	}
	return out + content.slice(from);
}

/**
 * Display titles of link targets written as block addresses (`key/sid`, or `key/alias`):
 * only targets in spaces `canRead` admits, live blocks only. At most
 * {@link LINK_DISPLAY_LIMITS.maxTargets} targets are looked up.
 */
export async function linkTitles(
	targets: Iterable<string>,
	options: {
		store: OutlineStore;
		canRead: (space: OutlineSpaceRow) => Promise<boolean>;
		spaceByKey: (key: string) => Promise<OutlineSpaceRow | null>;
	},
): Promise<Map<string, string>> {
	const byKey = new Map<string, Set<string>>();
	let count = 0;
	for (const target of targets) {
		const slash = target.indexOf("/");
		if (slash <= 0) continue;
		const key = target.slice(0, slash);
		const names = byKey.get(key) ?? new Set<string>();
		if (!names.has(target.slice(slash + 1))) {
			if (count >= LINK_DISPLAY_LIMITS.maxTargets) break;
			count++;
			names.add(target.slice(slash + 1));
		}
		byKey.set(key, names);
	}
	const out = new Map<string, string>();
	for (const [key, names] of byKey) {
		const space = await options.spaceByKey(key);
		if (!space || !(await options.canRead(space))) continue;
		const metas = await options.store.getBlockMetas(space.id, { sids: [...names] });
		const live = metas.filter((meta) => !meta.deleted).map((meta) => meta.id);
		const blocks = await options.store.getBlocks(live);
		const found = new Set<string>();
		for (const block of blocks) {
			const title = linkDisplayTitle(blockTitle(block.content));
			found.add(block.sid);
			if (title) out.set(`${key}/${block.sid}`, title);
		}
		// `key/alias` is stored as a block address too.
		for (const name of names) {
			if (found.has(name) || metas.some((meta) => meta.sid === name)) continue;
			const [block, second] = await options.store.findLiveBlocks([space.id], { alias: name }, 2);
			if (!block || second) continue;
			const title = linkDisplayTitle(blockTitle(block.content));
			if (title) out.set(`${key}/${name}`, title);
		}
	}
	return out;
}
