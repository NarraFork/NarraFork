/**
 * Windows-Explorer-style prefix selection for directory lists.
 *
 * Both directory browsers show a flat list of folders and were mouse-only: the path
 * box filters while it holds focus, but nothing reacts to typing when the list itself
 * is what the user is looking at. Keeping the rule here — instead of inline in the two
 * components — is what makes it testable without rendering a browser.
 */

/** Longest prefix kept between keystrokes; a longer one is only noise. */
const MAX_TYPEAHEAD = 32;

/**
 * Typing inside one of these belongs to that control, never to the list.
 *
 * A path box, the inline "new folder" field and any other form input live in the same
 * tree as the directory rows, so this check is what keeps type-ahead from stealing
 * keystrokes from them.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
	if (!target || typeof target !== "object") return false;
	const element = target as { tagName?: unknown; isContentEditable?: unknown };
	if (typeof element.tagName !== "string") return false;
	const tag = element.tagName.toUpperCase();
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	return element.isContentEditable === true;
}

/**
 * A bare printable character: no shortcut modifier, not an IME composition frame.
 *
 * Everything else (arrows, Escape, Tab, Space, Ctrl/Alt/Meta combos) stays with the
 * browser and the surrounding Modal.
 */
export function isTypeaheadCharacter(event: {
	key: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	isComposing?: boolean;
}): boolean {
	if (event.isComposing) return false;
	if (event.ctrlKey || event.metaKey || event.altKey) return false;
	// Space is left alone: on a focused row it activates the row, and a directory name
	// starting with a space is not something type-ahead has to serve.
	return typeof event.key === "string" && event.key.length === 1 && event.key.charCodeAt(0) > 32;
}

/**
 * Buffer update between keystrokes.
 *
 * Repeating the one character already buffered keeps the buffer at that single
 * character, so the next search starts after the cursor: that is how typing "d", "d"
 * walks from `Documents` to `Downloads` instead of searching for "dd" and finding
 * nothing.
 */
export function accumulateTypeahead(buffer: string, char: string): string {
	if (buffer.length === 1 && buffer.toLowerCase() === char.toLowerCase()) return buffer;
	return (buffer + char).slice(-MAX_TYPEAHEAD);
}

/**
 * First name starting with `prefix`, searched AFTER `from` and wrapping once.
 *
 * `from = -1` searches from the top. `from` itself is never re-matched, so a repeated
 * letter always advances instead of selecting the row the cursor already sits on.
 */
export function findTypeaheadMatch(names: readonly string[], prefix: string, from = -1): number {
	const needle = prefix.toLowerCase();
	if (!needle || names.length === 0) return -1;
	const candidates = from < 0 ? names.length : names.length - 1;
	for (let step = 1; step <= candidates; step += 1) {
		const index = (from + step + names.length) % names.length;
		if (names[index]?.toLowerCase().startsWith(needle)) return index;
	}
	return -1;
}

/**
 * One keystroke applied to the type-ahead state.
 *
 * A buffer that matches nothing restarts from the newest character ("doc" then "d"
 * must still reach `Downloads`), and `-1` means "leave the cursor where it is".
 */
export function typeaheadStep(input: {
	names: readonly string[];
	buffer: string;
	char: string;
	cursor: number;
}): { buffer: string; index: number } {
	const buffer = accumulateTypeahead(input.buffer, input.char);
	// Only a repeated single character cycles; a fresh first character searches from
	// the top so it cannot skip the row that matches it.
	const repeats = buffer === input.buffer && buffer.length === 1;
	const index = findTypeaheadMatch(input.names, buffer, repeats ? input.cursor : -1);
	if (index !== -1 || buffer.length === 1) return { buffer, index };
	const restarted = findTypeaheadMatch(input.names, input.char, -1);
	return { buffer: input.char.toLowerCase(), index: restarted };
}
