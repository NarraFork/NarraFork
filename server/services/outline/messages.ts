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
	/** A revert (or bringing a task back) would have changed a lock its author may not: as it is. */
	lockKept:
		"only the person who locked it, a manager of the space or an admin may lock, unlock or change its lock: its lock was left as it is",
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
	/** The block the lease job writes under a task in progress that nobody was holding. */
	unclaimedReopened:
		"This task was in progress, but no session or person was holding it; it is open again.",
	/**
	 * Summary of the commit that starts a session's next task when nothing of it is in progress
	 * (§4.8). Written at the end of a turn whether or not a continuation follows.
	 */
	startedForSession: (address: string, narratorId: string) =>
		`started ${address} for session ${narratorId}`,
	/** Summary of a commit that only hands tasks over (their lease had run out). */
	claimTakenOver: (addresses: readonly string[]) =>
		`took over ${addresses.join(", ")} (the previous lease had run out)`,
	/** Added to the summary of a commit that ended tasks someone else was doing. */
	endedClaims: (addresses: readonly string[]) =>
		`ended work someone else was doing on ${addresses.join(", ")}`,
	/** Summary of the lease expiry job's commit. */
	leaseExpiredSummary: (n: number) =>
		n === 1 ? "lease expired: 1 task reopened" : `lease expired: ${n} tasks reopened`,
	/** Summary of the lease job's commit that reopens tasks in progress nobody was holding. */
	unclaimedReopenedSummary: (n: number) =>
		`nobody was doing it: ${n === 1 ? "1 task" : `${n} tasks`} reopened`,
	/**
	 * The block written under a task reopened because the session doing it (or the session its
	 * subagent belongs to) was archived or deleted.
	 */
	sessionEnded: {
		/** Text before the session id (which is written as code). */
		lead: (reason: "archived" | "deleted", title: string | null) =>
			`The previous executor's session was ${reason} (session ${title ? `"${title}" ` : ""}`,
		tail: "); the task is open again.",
	},
	/** Summary of the commit that reopens the tasks of a session archived or deleted. */
	sessionEndedSummary: (reason: "archived" | "deleted", n: number) =>
		`session ${reason}: ${n === 1 ? "1 task" : `${n} tasks`} reopened`,

	/** A question block given a checkbox, or a task given a question. */
	questionNotTask: (address: string) =>
		`${address} is a question (asked with Ask); it cannot be a task too. Answer it, or withdraw it with Ask`,

	/** An agent's write tried to lock or unlock (only people lock, through the page). */
	lockDenied:
		"only people lock or unlock a task (from the outline page); an agent cannot change a lock",
	/** An agent's write tried to change a plan's state (the system keeps it: plan mode, approval). */
	planStateDenied:
		"a plan's state (planning, approved) is kept by plan mode; an agent cannot set or clear it",
	/** Locking a task someone else locked. */
	lockHeld: (address: string) =>
		`${address} is locked by someone else; it has to be unlocked first (by them, a manager of the space or an admin) before anyone locks it again`,
	/** Taking a lock away (unlocking, deleting the task, its checkbox) or changing it without the right to. */
	unlockDenied: (address: string) =>
		`${address} is locked (or would be, in someone else's name); only the person who locked it, a manager of the space or an admin may unlock it, change its lock, delete it or take its checkbox away`,
	severalLockedPlans:
		"the change touches several locked plans at once; change each plan in a call of its own",
	pendingTooLarge: (ops: number, bytes: number) =>
		`the change waiting for confirmation on this plan would grow past ${ops} operations or ${bytes} bytes of text; wait until it is confirmed or rejected`,
	pendingFull: (max: number) =>
		`the page already has ${max} changes waiting for confirmation; wait until some are decided`,
	/** Summary of a commit that confirms a pending change. */
	confirmSummary: (label: string, summary: string) => `confirm ${label}: ${summary}`,

	/** Why a read or search was refused. */
	errors: {
		pageTooLarge: (pageId: string, max: number) =>
			`outline page ${pageId} has more than ${max} blocks; read a smaller part of it`,
		badSeq: (field: string) => `${field} must be a commit seq (a non-negative integer)`,
		badTime: "not a valid time",
		tooManySpaces: (max: number, got: number) =>
			`a search covers at most ${max} spaces (got ${got})`,
		/** An agent's write to the session's behavior page without the user turn's grant. */
		behaviorPageReadonly:
			"the behavior page of this session (alias behavior) holds the user's standing rules: you may write it only as the first tool call of a user turn in which the user asked you to record a rule",
		/** An agent's write giving or taking the task page's alias, moving or deleting the page. */
		tasksPageReserved:
			"the task page of this session (alias tasks) is where people add their tasks: you may add and change blocks under it, but not give or take its alias, nor move or delete the page",
	},
	/** Summary of the commit that imports a session's old behavior fence into its page. */
	behaviorImportSummary: "imported the behavior fence (spec://behavior_fence) into this page",
	/** Summary of the commit that copies the behavior page into a fork. */
	behaviorForkSummary: (from: string) => `copied the behavior page from session ${from}`,
	/** Summaries of a plugin's commits for a session (`plugin-tasks.ts`, outline P2 PR 12a). */
	pluginTaskAdded: (pluginId: string) => `plugin ${pluginId} added a task`,
	pluginTaskStatus: (pluginId: string, address: string, status: string) =>
		`plugin ${pluginId} set ${address} to ${status}`,
	pluginTasksWritten: (pluginId: string) =>
		`plugin ${pluginId} wrote its task list (spec://tasks.json)`,
	pluginIndexWritten: (pluginId: string) => `plugin ${pluginId} wrote index.md (spec://index.md)`,
	pluginRulesSet: (pluginId: string) => `plugin ${pluginId} updated its rules on this page`,
	pluginRulesCleared: (pluginId: string) => `plugin ${pluginId} cleared its rules on this page`,
	pluginSopMoved: (pluginId: string) =>
		`moved plugin ${pluginId}'s rules from the old behavior fence (spec://behavior_fence) into this page`,
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

/** Items a list in a message names; the rest are counted. */
export const OUTLINE_LISTED_NAMES = 6;

function list(items: readonly string[], max = OUTLINE_LISTED_NAMES): string {
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
		'the outline spaces of this session and their pages; read one with OutlineRead { address: "<id>" }; address "*" gives an overview of every space this session can read',
	spaceSection: (space: string, isDefault: boolean) =>
		`space ${space}${isDefault ? "; bare ids and titles are looked up here first" : ""}`,
	noPages: "no pages yet",
	morePages: "more pages not listed; find them with OutlineSearch",
	writeHint:
		"to write, use OutlineEdit (if it is not in your tool list, load it with /load OutlineEdit)",

	allSpacesHeader: (n: number) =>
		`overview of ${n === 1 ? "the 1 space" : `${n} spaces`} this session can read, its own first: each space's pages, expanded level by level within the budget. Blocks of its own spaces are labeled with their id, blocks of other spaces with key/id; read one with OutlineRead { address: "<id or key/id>" }`,
	allSpacesNone:
		'This session can read no outline space yet. OutlineEdit creates its own on the first write: { add: "/", markdown: "- A page" }.',
	moreSpaces:
		'this session can read more spaces than the overview lists: read one by its key (key/), or search them all with OutlineSearch { spaces: ["*"] }',
	spacesUnchecked:
		"the overview stops after checking a number of spaces, so a space this session can read may be missing from it: name it by its key (key/) to read it",
	/** Pages of a space the overview leaves out; never shorter as `n` grows. */
	morePagesOf: (key: string, n: number, more: boolean) =>
		`${n === 0 ? "more pages" : `${n}${more ? "+" : ""} more ${n === 1 && !more ? "page" : "pages"}`} not shown; OutlineRead { address: "${key}/" } lists them`,
	taskPagesHidden: (n: number) =>
		`facts only: ${n === 1 ? "1 page that is a task" : `${n} pages that are tasks`} not shown; read with view "all" to include them`,
	notExpandedLarge: (labels: readonly string[]) =>
		`shown without what is under them, each has more blocks than one read of the overview takes: read ${list(labels)} on their own`,
	notExpandedLimit: (labels: readonly string[]) =>
		`shown without what is under them, past the blocks one overview reads in all: read ${list(labels)} on their own`,
	accessChanged:
		"Who may read this session kept changing while the outline was being read, so nothing is shown. Read it again.",
	overviewNotAsOf:
		'asOf reads one block as it was; the overview ("*") shows the spaces as they are now. Read a block with asOf instead.',
	otherSessionPages: (n: number, more: boolean) =>
		`${more ? `more than ${n} pages` : n === 1 ? "1 page" : `${n} pages`}, not listed: another session's notes are process; read them with view "all", or by address (key/ lists them)`,
	noSpaces:
		'This session has no outline pages yet. OutlineEdit creates its space on the first write: { add: "/", markdown: "- A page" } writes to the project\'s space (or, where this turn may not write it, to this session\'s notes); add: "session/" writes to the session\'s notes.',
	noSuchSpace: (name: string) =>
		`No outline space ${quoted(name)} that this session can read. Name a space by its key, or project/, session/ or personal/.`,
	notFound: (ref: string) =>
		`Nothing this session can read matches ${quoted(ref)}. An address is key/id (Kx81mPqa/Ab3dEf9Q), an id, an alias such as Q17, or a block's title; ids, aliases and titles alone are looked up in this session's own spaces. Find blocks with OutlineSearch, or list the spaces with OutlineRead (no address: this session's own; "*": every space it can read).`,
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
	searchedSome: (n: number) =>
		`searched the first ${n} spaces this session can read; there are more: name them in spaces to search them`,
	searchUnchecked:
		"searched the spaces found within what one search checks, so a space this session can read may be missing: name it in spaces to search it",
	spacesNotSearched: (names: readonly string[]) =>
		`not searched (no readable space by that name): ${list(names)}`,
	inPath: (titles: readonly string[]) => `in ${titles.join(" › ")}`,
	underTask: (address: string, title: string) => `under task [${address}] ${title}`,
	isTask: "a task",
	sessionNotes: "in a session's notes",
	noResults: "No blocks match. Try other words, or fewer of them.",
	noResultsOwn:
		'No blocks match in this session\'s own spaces. Try other words, or fewer of them, or spaces: ["*"] to search every space this session can read.',

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
		/**
		 * The note rules (`@shared/outline-note-structure`): what a call writes under a task. A
		 * block is named `[id]` once written, and by its edit and first words when nothing was.
		 */
		noteRules: {
			warnHeader:
				"Note format: written, but under a task write conclusion → evidence → detail (a task folds to its title and one line). Restructure these with OutlineEdit:",
			refusedHeader:
				"Nothing was written: what this call writes under a task is far over the note limits. Under a task write conclusion → evidence → detail (a task folds to its title and one line):",
			written: (id: string) => `[${id}]`,
			unwritten: (n: number, excerpt: string) => `edit ${n}, the block starting «${excerpt}»`,
			longTitle: (at: string, chars: number, lines: number, limit: number) =>
				`${at} (a task's title) has ${chars} characters${lines > 1 ? ` on ${lines} lines` : ""}: a title is one line (at most ${limit} characters) saying what done means; put the rest in blocks under it.`,
			longNote: (at: string, chars: number, limit: number) =>
				`${at} has ${chars} characters directly under a task: that level holds one-line conclusions (at most ${limit} characters). Keep the conclusion as the block's text and put the evidence and details in blocks under it (indented items).`,
			longDetail: (at: string, chars: number, limit: number) =>
				`${at} has ${chars} characters: evidence or a detail is at most ${limit} characters; split it into several blocks, or put the finer parts under it.`,
			flat: (at: string, children: number, limit: number, task: boolean) =>
				`${at} gets ${children} blocks directly under it in this call: at most ${limit} on one level; ${task ? "group them under a few conclusions (subtasks under phases)" : "group them"}.`,
			more: (n: number) => `${n} more like these.`,
			/** The refusal's last line: what else was fine, and what to do. */
			refusedRecover:
				"Send the call again with those blocks restructured; the rest of the call was fine and was not written either.",
			headingsDropped: (ids: readonly string[]) =>
				`heading marks (#) were dropped from ${ids.length === 1 ? "1 block" : `${ids.length} blocks`} under tasks (${list(ids.map((id) => `[${id}]`))}): under a task, levels are what the indentation says`,
			/** A task ticked done or cancelled with no note under it. */
			noResult: (id: string, cancelled: boolean, before: string | null) =>
				`[${id}] is ${cancelled ? "cancelled" : "done"} with no result under it, so folded it shows only its title: add one line saying ${cancelled ? "why it was cancelled" : "what came of it"} as its first block ({ add: "${id}", markdown: "- …"${before ? `, before: "${before}"` : ""} }).`,
			tidyLong: (id: string, blocks: readonly string[], more: number, limit: number) =>
				`under the finished task [${id}], ${blocks.join(", ")}${more > 0 ? ` and ${more} more` : ""} ${blocks.length + more === 1 ? "is" : "are"} longer than a conclusion (at most ${limit} characters): compress each into one line with its evidence in blocks under it, and delete what only records the process.`,
			tidyBlock: (id: string, chars: number | null) =>
				chars === null ? `[${id}]` : `[${id}] (${chars} characters)`,
			tidyFlat: (id: string, notes: number, more: boolean, limit: number) =>
				`the finished task [${id}] has ${more ? `more than ${notes}` : notes} notes directly under it (at most ${limit} on one level): gather them under a few conclusions, the result first.`,
		},
		/** An edit some of whose operations were held for confirmation. */
		heldEdit: (n: number, what: string, all: boolean) =>
			`${n}. ${all ? "held for confirmation" : "held in part for confirmation"}: ${what}`,
		nothingWrittenDirectly:
			"Nothing was written directly: the change waits for confirmation (below).",
		mixedDecisions: "confirm and reject go in a call of their own, without block edits",
		pendingNewBlock: (ref: string, label: string, decider: string) =>
			`${ref} is a block ${label} adds; it exists once ${decider} confirms ${label}, so nothing can be written under it or to it before`,
	},

	/** Changes to locked plans waiting for confirmation (design §2.6). */
	pending: {
		/** The decider, as marks and results name them. */
		deciderPerson: (name: string | null, id: string) => (name ? name : `the person ${id}`),
		deciderSession: (title: string | null, id: string) =>
			title ? `the session ${quoted(title)} (${id})` : `the session ${id}`,
		deciderEither: (person: string, delegate: string) =>
			`${person} (or ${delegate} on their behalf)`,
		markOwn: (label: string, _decider: string) =>
			`pending ${label}: your proposed change, not confirmed yet`,
		markOwnDeleted: (label: string, _decider: string, n: number) =>
			`pending ${label}: you proposed deleting ${n === 1 ? "1 block" : `${n} blocks`} here, not confirmed yet`,
		markOther: (label: string, _decider: string) =>
			`pending ${label}: a change proposed here waits for confirmation`,
		markOwnMerged: (label: string, _decider: string) =>
			`pending ${label}: your proposed change, merged over changes made here since you proposed it; not confirmed yet`,
		markOwnConflict: (label: string, _decider: string, detail: string) =>
			`pending ${label}: changed since you proposed it, your change no longer applies here (${detail}); shown as it is now`,
		/** After a read: this session's own open changes on the page. */
		yours: (label: string, decider: string, since: "none" | "merged" | "conflict") =>
			since === "conflict"
				? `${label} is your change to this plan; blocks it changes were changed since you proposed it and part of it no longer applies (marked above, shown as they are now): it cannot be confirmed as it is. Propose those blocks again from the text as it is now (they merge into ${label}), or reject ${label} to withdraw it. It waits for ${decider}`
				: since === "merged"
					? `${label} is your change to this plan, shown above merged over changes made since you proposed it (marked); it waits for ${decider} to confirm (blocks it adds exist once confirmed)`
					: `${label} is your change to this plan, shown above as you proposed it; it waits for ${decider} to confirm (blocks it adds exist once confirmed)`,
		/** A change its proposer said nothing about, by its size. */
		summaryOf: (n: number) => (n === 1 ? "1 change" : `${n} changes`),
		/** After a read: changes waiting for this session's confirmation. */
		forYou: (label: string, summary: string, by: string) =>
			`${label} waits for your confirmation: ${summary} (proposed by ${by}); confirm with OutlineEdit { edits: [{ confirm: "${label}" }] }, or reject with { reject: "${label}", reason }`,
		reportConfirmed: (label: string, by: string, seq: number | null) =>
			`${label} was confirmed by ${by}${seq === null ? "" : ` (commit #${seq})`}: its changes are in the outline now`,
		reportRejected: (label: string, by: string, reason: string | null) =>
			`${label} was rejected by ${by}${reason ? `: ${reason}` : ""}`,
		reportWithdrawn: (label: string, why: string) => `${label} was withdrawn: ${why}`,
		whyUnlocked: "the plan was unlocked",
		whyDeleted: "the locked task was deleted",
		/** The result of an edit that was held. */
		held: (label: string, n: number, root: string, decider: string, merged: boolean) =>
			`Held for confirmation as ${label}: ${n === 1 ? "1 change" : `${n} changes`} to the locked plan ${root}, waiting for ${decider} to confirm${merged ? " (merged into the change this session had already proposed there)" : ""}.`,
		heldWaiting: (tasks: readonly string[]) =>
			`Tasks that wait for it: ${list(tasks, 10)}. Do not start them; carry on with work it does not affect.`,
		heldCarryOn: "Carry on with work it does not affect.",
		heldRead:
			"Reading the plan shows your proposed version, marked ‹pending›. Blocks it adds exist once confirmed: write under them after that.",
		confirmed: (label: string, seq: number | null, by: string) =>
			seq === null
				? `Confirmed ${label} (proposed by ${by}); the outline already read as it proposes, so no commit was written.`
				: `Confirmed ${label} (proposed by ${by}): committed #${seq}.`,
		rejected: (label: string) => `Rejected ${label}; its proposer is told on its next read.`,
		withdrew: (label: string) => `Withdrew ${label}, which this session had proposed.`,
		badLabel: (ref: string) =>
			`${quoted(ref)} is not a pending change: name it as a read shows it, P and 8 characters (P1a2B3c4D)`,
	},
} as const;
