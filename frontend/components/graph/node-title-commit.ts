/**
 * What committing a node-header title edit should DO.
 *
 * Split out of `NodeTitleEditor` because the decision has three outcomes that all
 * look identical from the outside — the editor closes either way — and one of them
 * (writing an unintended value) is a data change. Keeping it a pure function means
 * the rules are tested directly, rather than through a DOM harness where React's
 * change-event path does not run at all (linkedom delivers no `input`/`change`
 * events to React's synthetic system, so a typed value cannot be simulated).
 */

export type TitleCommit =
	/** Write this title to the chapter. */
	| { action: "save"; title: string }
	/** Close the editor without writing: the value is empty or unchanged. */
	| { action: "discard"; reason: "empty" | "unchanged" }
	/**
	 * Already committed once. Enter both saves AND blurs the field, so the blur
	 * handler runs immediately after — without this the same edit is submitted twice.
	 */
	| { action: "ignore"; reason: "already-committed" };

export function resolveTitleCommit(input: {
	draft: string;
	currentTitle: string;
	alreadyCommitted: boolean;
}): TitleCommit {
	if (input.alreadyCommitted) return { action: "ignore", reason: "already-committed" };
	// Trim first: a title of only whitespace is not a title, and saving it would make
	// the node header render as blank with no way to tell it apart from a bug.
	const trimmed = input.draft.trim();
	if (!trimmed) return { action: "discard", reason: "empty" };
	if (trimmed === input.currentTitle) return { action: "discard", reason: "unchanged" };
	return { action: "save", title: trimmed };
}
