/**
 * Resolving a chapter to the backbone tick it hangs from.
 *
 * A chapter is drawn at the position of the commit it started from. When that commit
 * is not itself on the ruler — it belongs to a sub-branch, or it is older than the
 * loaded window — the chapter attaches to the nearest ancestor chapter whose start
 * commit IS on the ruler.
 *
 * Extracted from RulerFlow because the failure case needs to be reportable: a chapter
 * that resolves to nothing used to be skipped by a bare `continue`, so it vanished
 * from the view with no indication that it existed. Pure so both outcomes can be
 * tested without a canvas.
 */

export interface AnchorableChapter {
	id: string;
	title: string;
	parentChapterId?: string | null;
	startCommitSha?: string | null;
	/**
	 * Trunk commit the server found for a chapter its own start commit cannot place —
	 * `merge-base <startCommitSha> <branch>`. See the server's `resolveAnchorFallbacks`.
	 *
	 * Used only after the parent-chain walk fails, so a chapter that can be placed
	 * exactly is never moved to an approximate position.
	 */
	anchorFallbackSha?: string | null;
	/**
	 * Whether `startCommitSha` is still reachable from the trunk.
	 *
	 * `false` means history was rewritten under the chapter (rebase, squash-merge,
	 * amend) and its start commit will never appear on the timeline no matter how much
	 * is paged in — the difference between "load older commits" being the fix and being
	 * a dead end. Only sent when the server had to fall back.
	 */
	startCommitOnBranch?: boolean | null;
}

export interface AnchorResolution<T extends AnchorableChapter> {
	/** Chapters grouped by the backbone SHA they resolved to, input order preserved. */
	byStartSha: Map<string, T[]>;
	/** Chapters with no reachable backbone anchor — these cannot be drawn. */
	unanchored: T[];
	/**
	 * Chapters drawn at an approximate position because their real start commit is gone
	 * from the trunk. They ARE in `byStartSha` and do render; this list exists so the view
	 * can say the position is the fork point rather than the commit, instead of silently
	 * implying the chapter started somewhere it did not.
	 */
	rewrittenAnchors: T[];
}

/**
 * Group chapters by the backbone SHA they should be drawn at.
 *
 * `hasTick` decides membership of the backbone, which is the loaded commit window
 * rather than the repository: paging in older commits turns unanchored chapters into
 * anchored ones without anything else changing.
 */
export function resolveChapterAnchors<T extends AnchorableChapter>(
	chapters: T[],
	hasTick: (sha: string) => boolean,
): AnchorResolution<T> {
	const byStartSha = new Map<string, T[]>();
	const unanchored: T[] = [];
	const rewrittenAnchors: T[] = [];
	if (chapters.length === 0) return { byStartSha, unanchored, rewrittenAnchors };

	const chapterById = new Map<string, T>();
	for (const chapter of chapters) chapterById.set(chapter.id, chapter);

	const resolve = (chapter: T): string | null => {
		if (chapter.startCommitSha && hasTick(chapter.startCommitSha)) return chapter.startCommitSha;
		// `visited` guards a parent cycle: the data allows one, and without this the walk
		// would not terminate.
		const visited = new Set<string>([chapter.id]);
		let cur: T = chapter;
		while (cur.parentChapterId && !visited.has(cur.parentChapterId)) {
			visited.add(cur.parentChapterId);
			const parent = chapterById.get(cur.parentChapterId);
			if (!parent) break;
			if (parent.startCommitSha && hasTick(parent.startCommitSha)) return parent.startCommitSha;
			cur = parent;
		}
		return null;
	};

	for (const chapter of chapters) {
		const sha = resolve(chapter);
		if (sha) {
			const list = byStartSha.get(sha) ?? [];
			list.push(chapter);
			byStartSha.set(sha, list);
			continue;
		}

		// Nothing on the loaded backbone places this chapter. Before reporting it as
		// undrawable, try the server's fork-point fallback: for a chapter whose start
		// commit was rewritten out of the trunk, this is the ONLY position it will ever
		// have, and the alternative is a card that never appears again.
		const fallback = chapter.anchorFallbackSha;
		if (fallback && hasTick(fallback)) {
			const list = byStartSha.get(fallback) ?? [];
			list.push(chapter);
			byStartSha.set(fallback, list);
			// `startCommitOnBranch === false` is the rewritten case. When it is true the
			// fallback equals the start commit, which means the commit is a legitimate
			// ancestor that just happened to page in — an exact position, not an approximation.
			if (chapter.startCommitOnBranch === false) rewrittenAnchors.push(chapter);
			continue;
		}
		unanchored.push(chapter);
	}

	return { byStartSha, unanchored, rewrittenAnchors };
}
