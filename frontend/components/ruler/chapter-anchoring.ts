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
}

export interface AnchorResolution<T extends AnchorableChapter> {
	/** Chapters grouped by the backbone SHA they resolved to, input order preserved. */
	byStartSha: Map<string, T[]>;
	/** Chapters with no reachable backbone anchor — these cannot be drawn. */
	unanchored: T[];
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
	if (chapters.length === 0) return { byStartSha, unanchored };

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
		if (!sha) {
			unanchored.push(chapter);
			continue;
		}
		const list = byStartSha.get(sha) ?? [];
		list.push(chapter);
		byStartSha.set(sha, list);
	}

	return { byStartSha, unanchored };
}
