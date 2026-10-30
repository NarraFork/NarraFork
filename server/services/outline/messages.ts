/**
 * Agent-facing text of the outline read, search, resolution and revert services, in one place
 * and in English. Tools and their tests use these instead of spelling their own, so wording
 * changes in one edit and nothing parses prose it did not write.
 *
 * Annotations inside a rendered outline are wrapped in `‹…›` so they read as notes, not
 * content; `render.ts` places them where the outline parser can tell them apart and strips
 * them again (`stripReadAnnotations`).
 */

function blocks(n: number): string {
	return n === 1 ? "1 block" : `${n} blocks`;
}

export const OUTLINE_TEXT = {
	/** Under a block whose further blocks did not fit the read's budget. */
	more: (n: number) => `‹… ${n} more›`,
	/** After a facts view that left process blocks out. */
	factsOnly: (n: number) =>
		`‹facts only: ${blocks(n)} under tasks not shown; read with view "all" to include them›`,
	/** After a read of a page with more blocks than one read loads. */
	pageTruncated: (n: number) =>
		`‹the page has more blocks than one read loads; only ${n} were read: read a smaller part›`,

	/** Why a revert left a block as it is. */
	revertSkipped: {
		"changed-later": "changed by a later commit",
		"parent-gone": "the block it belonged under is deleted now",
		"later-children": "blocks added under it later would be deleted with it",
		cycle: "it would end up under itself",
	} as const,
	/** A restored or reverted alias that another block holds now. */
	aliasDropped: (alias: string, holder: string) =>
		`alias ${alias} is used by ${holder} now; the block was restored without it`,
	/** A restored or moved-back block whose old place among its siblings is taken. */
	orderKeyMoved: (wanted: string) =>
		`its old position (${wanted}) is taken; it was placed right after the block holding it`,
	/** A write by no session or person left a task to do instead of in progress. */
	taskNotStarted:
		"it would be in progress with nobody doing it (a write by no session), so it was left to do",
	/** Summary of a compensating commit. */
	revertSummary: (seq: number, summary: string) => `revert #${seq}: ${summary}`,

	/**
	 * The block the lease expiry job writes under a task it reopens (design §4.5: the progress
	 * under the task stays, and this records why it is open again).
	 */
	leaseExpired: {
		/** Text before the session id (which is written as code). */
		lead: (title: string | null) =>
			`The previous executor's lease expired (session ${title ? `"${title}" ` : ""}`,
		tail: "); the task is open again.",
	},
	/** Summary of a commit that only hands tasks over (their lease had run out). */
	claimTakenOver: (addresses: readonly string[]) =>
		`took over ${addresses.join(", ")} (the previous lease had run out)`,
	/** Added to the summary of a commit that ended tasks someone else was doing. */
	endedClaims: (addresses: readonly string[]) =>
		`ended work someone else was doing on ${addresses.join(", ")}`,
	/** Summary of the lease expiry job's commit. */
	leaseExpiredSummary: (n: number) =>
		n === 1 ? "lease expired: 1 task reopened" : `lease expired: ${n} tasks reopened`,

	/** Why a read or search was refused. */
	errors: {
		pageTooLarge: (pageId: string, max: number) =>
			`outline page ${pageId} has more than ${max} blocks; read a smaller part of it`,
		badSeq: (field: string) => `${field} must be a commit seq (a non-negative integer)`,
		badTime: "not a valid time",
		tooManySpaces: (max: number, got: number) =>
			`a search covers at most ${max} spaces (got ${got})`,
	},
} as const;

export type OutlineRevertSkipReason = keyof typeof OUTLINE_TEXT.revertSkipped;

/** How a merge names the fields of a block (`agent-merge.ts`). */
const MERGE_FIELD_NAMES: Record<string, string> = {
	checkbox: "checkbox",
	assignee: "assignee",
	depends: "prerequisites (depends::)",
	due: "due date",
	alias: "alias",
	tags: "tags",
};

function list(items: readonly string[], max = 6): string {
	const shown = items.slice(0, max).join(", ");
	return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

function quoted(text: string): string {
	return JSON.stringify(text);
}

/**
 * Agent-facing text of the outline tools (`OutlineRead`, `OutlineSearch`, `OutlineEdit`). Lines a
 * read may hand back in `‹…›` are notes; `stripReadAnnotations` drops them when an edit copies a
 * read back, so they may say anything.
 */
export const OUTLINE_TOOL_TEXT = {
	disabled: "The outline is turned off on this server (setting outline.enabled).",
	untitled: "(untitled)",
	pageMark: " (page)",
	aliasMark: (alias: string) => ` (alias ${alias})`,

	spaceName: {
		project: (name: string | null, main: boolean) =>
			`${main ? "this session's project" : "project"}${name ? ` ${quoted(name)}` : ""}`,
		ownSession: "this session's notes",
		session: (title: string | null) => `session${title ? ` ${quoted(title)}` : ""}`,
		ownPersonal: "your personal space",
		personal: "a personal space",
	},

	overviewHeader:
		'the outline spaces of this session and their pages; read one with OutlineRead { address: "<id>" }',
	spaceSection: (space: string, isDefault: boolean) =>
		`space ${space}${isDefault ? "; bare ids and titles are looked up here first" : ""}`,
	noPages: "no pages yet",
	morePages: "more pages not listed; find them with OutlineSearch",
	writeHint:
		"to write, use OutlineEdit (if it is not in your tool list, load it with /load OutlineEdit)",
	noSpaces:
		'This session has no outline pages yet. OutlineEdit creates its space on the first write: { add: "/", markdown: "- A page" } writes to the project\'s space (or, where this turn may not write it, to this session\'s notes); add: "session/" writes to the session\'s notes.',
	noSuchSpace: (name: string) =>
		`No outline space ${quoted(name)} that this session can read. Name a space by its key, or project/, session/ or personal/.`,
	notFound: (ref: string) =>
		`Nothing this session can read matches ${quoted(ref)}. An address is key/id (Kx81mPqa/Ab3dEf9Q), an id, an alias such as Q17, or a block's title. Find blocks with OutlineSearch, or list the session's spaces with OutlineRead and no address.`,
	ambiguous: (ref: string) => `${quoted(ref)} matches several blocks; read one by its address`,
	deleted: (address: string) =>
		`${address} is deleted. Read it as it was with asOf (a commit number or a time before it was deleted).`,
	notAtSeq: (address: string, seq: number) => `${address} did not exist as of commit #${seq}.`,
	badAsOf: "asOf must be a commit number or a time (such as 2026-10-26T09:00:00Z).",
	readHeader: (space: string, path: readonly string[], asOf: number | null) =>
		`space ${space}${path.length > 0 ? ` · in ${path.join(" › ")}` : ""}${
			asOf === null ? "" : ` · as of commit #${asOf}`
		}`,

	searchHeader: (n: number, query: string, spaces: readonly string[]) =>
		`${n === 1 ? "1 result" : `${n} results`} for ${quoted(query)} in ${list(spaces)}`,
	spacesNotSearched: (names: readonly string[]) =>
		`not searched (no readable space by that name): ${list(names)}`,
	inPath: (titles: readonly string[]) => `in ${titles.join(" › ")}`,
	underTask: (address: string, title: string) => `under task [${address}] ${title}`,
	isTask: "a task",
	sessionNotes: "in a session's notes",
	noResults: "No blocks match. Try other words, or fewer of them.",

	textTooLarge: (bytes: number, max: number) =>
		`The edit carries ${bytes} bytes of text; one call takes at most ${max}. Split it into several calls.`,
	textBusy: "The outline is processing other large edits; try again in a moment.",
	textTimeout: (ms: number) =>
		`Processing the text took longer than ${Math.round(ms / 1000)} s and was stopped. Split it into smaller edits or simplify its formatting.`,
	textCancelled: "The edit was cancelled.",

	edit: {
		label: (n: number, kind: string, target: string) => `edit ${n} (${kind} ${quoted(target)})`,
		nothingWritten: "Nothing was written.",
		noPerson:
			"this turn runs without a person behind it (a routine or system turn), so it cannot write the outline",
		sessionOnly:
			"in read-only and plan mode OutlineEdit writes only this session's own space (session/); write there, or leave plan mode",
		noPermission: (space: string) => `the person running this turn may not write ${space}`,
		defaultToSession:
			"this turn may not write the project's space, so new pages went to this session's notes (session/)",
		ambiguous: (ref: string, candidates: readonly string[]) =>
			`${quoted(ref)} matches several blocks (${list(candidates)}); use an address`,
		deletedBlock: (address: string) => `${address} is deleted`,
		/** Setting a task to in progress claims it; someone else is doing it. */
		taskClaimed: (address: string, holder: string) =>
			`${address} is already being done by ${holder}; nothing was written. Pick another task, or ask them`,
		claimHolderSession: (title: string | null, id: string) =>
			title ? `the session ${quoted(title)} (${id})` : `the session ${id}`,
		claimHolderPerson: (name: string | null, id: string) => (name ? `${name}` : `the person ${id}`),
		oneSpace: (keys: readonly string[]) =>
			`the edits touch several spaces (${list(keys)}); one OutlineEdit call writes one space, so split it into one call per space (blocks never move between spaces)`,
		parseNote: (n: number, line: number, message: string) => `edit ${n}, line ${line}: ${message}`,
		nothingToAdd: "the markdown holds no blocks",
		replaceOneBlock: (count: number) =>
			`replace takes the text of one block (got ${count}); add more blocks with add`,
		labelsIgnored: (n: number, labels: readonly string[]) =>
			`edit ${n}: the ids copied from a read (${list(labels.map((l) => `[${l}]`))}) were dropped; add always creates new blocks; change existing ones with replace, move them with move`,
		linkToDeleted: (ref: string, address: string) =>
			`[[${ref}]] links to ${address}, which is deleted`,
		linkAmbiguous: (ref: string, candidates: readonly string[]) =>
			`[[${ref}]] matches several blocks (${list(candidates)}); kept as written, write an address to link one`,
		linkNotFound: (ref: string) =>
			`[[${ref}]] matches nothing this session can read; kept as a text link`,
		tooManyLinks: (n: number) =>
			`${n} more link targets were kept as written without resolving them`,
		tooManyAliases: (prefix: string) =>
			`the space has too many aliases starting with ${prefix} to number the next one; give the alias explicitly`,
		taskPropsIgnored: (n: number) =>
			`edit ${n}: depends:: and due:: belong to tasks and were left out on a block without a checkbox`,
		samePageTitle: (title: string, addresses: readonly string[]) =>
			`a page titled ${quoted(title)} already existed: ${list(addresses.map((a) => `[[${a}]]`))}; merge them if they are the same`,
		busy: "the space kept changing while the edit was written; nothing was written, try again",
		conflictHeader:
			"Nothing was written: blocks you are changing (or deleting with what is under them) changed after you last read them, or you have not read them, and your edits could not be merged with those changes.",
		someone: "someone",
		aPerson: "a person",
		anotherAgent: "another agent",
		theSystem: "the system",
		conflict: (sid: string, who: string, now: number, seen: number) =>
			`[${sid}] was changed by ${who} in commit #${now} (you read it as of #${seen})`,
		notRead: (sid: string, who: string, now: number) =>
			`[${sid}] was last written by ${who} in commit #${now}, and you have not read it`,
		readFirst:
			"Read a block before you replace or delete what anyone but this session wrote in it (another session or a subagent counts as someone else); what you read is forgotten when the server restarts. Read it, then make the edit.",
		underDeleted: (sid: string) => `it is under [${sid}], which you are deleting with it`,
		tooLargeToDelete: (sid: string, limit: number, max: number) =>
			limit >= max
				? `[${sid}] has more than ${max} blocks under it, too many to check what changed in them since you read them; delete it in smaller parts, the blocks under it first`
				: `[${sid}] has more than ${limit} blocks under it, which is what was left to check after the other blocks this call deletes (at most ${max} in all); delete it in a call of its own`,
		shownBelow: "its current text is shown in full below",
		shownHeader:
			"They read as follows now. Shown here, they count as read: redo the edit on this text, or make the same edit again if it still holds:",
		moreConflicts: (n: number) =>
			`… and ${n === 1 ? "1 more block" : `${n} more blocks`} like these, not listed`,
		nowReads: (text: string) => `it now reads: ${text}`,
		notMerged:
			"only a block's one replace is merged with later changes; a move, delete or set (or several edits of one block) needs the block as you read it",
		overlaps: (excerpts: readonly string[]) =>
			`your change and theirs overlap at ${list(excerpts.map((e) => `«${e}»`))}`,
		bothChanged: (fields: readonly string[]) =>
			`you and they both changed its ${list(fields.map((f) => MERGE_FIELD_NAMES[f] ?? f))}`,
		mergeUnstable:
			"your change and theirs meet in the same formatting, so the merged text would not read as either of you wrote it",
		noBase: "the version you read is no longer in its history, so there is nothing to merge from",
		mergeBodyTooLarge: (bytes: number, max: number) =>
			`a replace carries ${bytes} bytes of text for one block; one block takes at most ${max}`,
		mergeTooLarge: (bytes: number, max: number) =>
			`the blocks to merge your edits into hold ${bytes} bytes of text, more than the ${max} one call can merge and write besides its other text; split the call`,
		mergeTooSlow: (ms: number) =>
			`merging your edits with the changes made since you read the blocks took longer than ${Math.round(ms / 1000)} s and was stopped; split the call into smaller ones`,
		nowDeleted: "it is deleted now",
		conflictRecover: (key: string) =>
			`Read those blocks again with OutlineRead (${key}/<id>), then redo the edit on what they say now.`,
		noChange: "Nothing changed: the edits leave the outline as it was. No commit was written.",
		committed: (seq: number, space: string, edits: number) =>
			`Committed #${seq} to ${space} (${edits === 1 ? "1 edit" : `${edits} edits`}; it can be reverted as one commit).`,
		topLevel: "the top level (it is a page now)",
		added: (where: string | null) => (where ? `added under ${where}:` : "added new pages:"),
		replaced: (sid: string) => `replaced [${sid}]`,
		replacedMerged: (sid: string) =>
			`replaced [${sid}], merged with changes made after you read it (shown below)`,
		replacedMergedUnshown: (sid: string) =>
			`replaced [${sid}], merged with changes made after you read it; not shown: read it before changing it again`,
		mergedHeader:
			"Merged: these blocks had been changed by someone else after you read them. Your edits were applied on top of those changes where they did not overlap; they now read as follows (build further edits on this text):",
		mergedBlock: (sid: string, who: string, now: number, seen: number) =>
			`[${sid}] changed by ${who} in commit #${now} after you read it as of #${seen}; merged:`,
		mergedNotShown: (sids: readonly string[]) =>
			`also merged, not shown here: ${list(sids, 20)}; read them before changing them again`,
		moved: (sid: string, where: string) => `moved [${sid}] under ${where}`,
		deleted: (sid: string) => `deleted [${sid}] and everything under it`,
		noCheckbox: "no checkbox",
		noAssignee: "no assignee",
		noAlias: "no alias",
		set: (sid: string, parts: readonly string[]) => `set [${sid}]: ${parts.join(", ")}`,
		notesHeader: "Notes:",
		hintsHeader: "Hints:",
	},
} as const;
