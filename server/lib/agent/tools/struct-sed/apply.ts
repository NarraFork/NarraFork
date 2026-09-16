/**
 * Pure text transforms behind StructSed: applying one command, and building the previews
 * and card diffs from before/after text.
 *
 * Nothing here touches IO or the tool context, so it is unit-tested directly and shared by
 * both the dry-run preview and the applied write.
 */

import {
	appendAfter,
	deleteRange,
	EditOpError,
	insertBefore,
	type LineRange,
	type MovePlacement,
	relocateRange,
	replaceRange,
	substituteInRange,
} from "../../structural/edit-ops";
import { normalizeLineEndings } from "../encoding";
import {
	type Command,
	DIFF_CONTEXT_LINES,
	MAX_DIFF_SPAN_LINES,
	MAX_PREVIEW_LINES,
} from "./commands";

/** Apply the command to LF-normalized text. Throws `EditOpError` on an invalid request. */
export function applyCommand(
	command: Command,
	text: string,
	range: LineRange,
	args: {
		content?: string;
		pattern?: string;
		replacement?: string;
		flags?: string;
		/** Resolved destination for copy/move; absent means end of file. */
		anchor?: LineRange;
		placement?: MovePlacement;
	},
): { text: string; replacements?: number } {
	switch (command) {
		case "delete":
			return { text: deleteRange(text, range) };
		case "copy":
		case "move":
			return {
				text: relocateRange(text, range, {
					...(args.anchor ? { anchor: args.anchor } : {}),
					placement: args.placement ?? "after",
					removeSource: command === "move",
				}),
			};
		case "replace": {
			if (typeof args.content !== "string") {
				throw new EditOpError("command=replace requires `content`.");
			}
			return { text: replaceRange(text, range, normalizeLineEndings(args.content)) };
		}
		case "insert": {
			if (typeof args.content !== "string") {
				throw new EditOpError("command=insert requires `content`.");
			}
			return { text: insertBefore(text, range, normalizeLineEndings(args.content)) };
		}
		case "append": {
			if (typeof args.content !== "string") {
				throw new EditOpError("command=append requires `content`.");
			}
			return { text: appendAfter(text, range, normalizeLineEndings(args.content)) };
		}
		case "substitute": {
			if (typeof args.pattern !== "string" || !args.pattern) {
				throw new EditOpError("command=substitute requires `pattern`.");
			}
			if (typeof args.replacement !== "string") {
				throw new EditOpError("command=substitute requires `replacement`.");
			}
			const result = substituteInRange(text, range, args.pattern, args.replacement, {
				...(args.flags ? { flags: args.flags } : {}),
			});
			return { text: result.text, replacements: result.replacements };
		}
	}
}

/**
 * The window that actually changed between two texts, for the card's before/after diff.
 *
 * Computed by comparing the texts directly rather than from the command's range, so it is
 * correct for every command uniformly — including move/copy (two edited regions) and a
 * batch (many) — without reasoning about where each one writes. Returns null when nothing
 * changed or when the change is too large to show as a diff.
 */
export function diffWindow(
	before: string,
	after: string,
): { oldText: string; newText: string; startLine: number } | null {
	const b = before.split("\n");
	const a = after.split("\n");

	let first = 0;
	while (first < b.length && first < a.length && b[first] === a[first]) first++;

	let bEnd = b.length - 1;
	let aEnd = a.length - 1;
	while (bEnd >= first && aEnd >= first && b[bEnd] === a[aEnd]) {
		bEnd--;
		aEnd--;
	}

	// No divergence: identical texts are handled by the caller before this runs.
	if (bEnd < first && aEnd < first) return null;

	const span = Math.max(bEnd, aEnd) - first;
	if (span > MAX_DIFF_SPAN_LINES) return null;

	const winStart = Math.max(0, first - DIFF_CONTEXT_LINES);
	const bWinEnd = Math.min(b.length - 1, bEnd + DIFF_CONTEXT_LINES);
	const aWinEnd = Math.min(a.length - 1, aEnd + DIFF_CONTEXT_LINES);
	return {
		oldText: b.slice(winStart, bWinEnd + 1).join("\n"),
		newText: a.slice(winStart, aWinEnd + 1).join("\n"),
		startLine: winStart + 1,
	};
}

/**
 * The card's diff metadata for a change, or `{}` when it should not carry one.
 *
 * Shared by the preview and the applied write so BOTH show a diff. Before this, only the
 * dry run carried diff fields, so a preview rendered a rich red/green diff while the actual
 * write showed a one-line summary — the preview looked more "done" than the real edit. Now
 * the two differ only by the preview banner, not by whether a diff appears at all.
 */
export function diffMetadata(before: string, after: string): Record<string, string | number> {
	const window = diffWindow(before, after);
	if (!window) return {};
	return {
		diffBefore: window.oldText,
		diffAfter: window.newText,
		diffStartLine: window.startLine,
	};
}

/** A bounded excerpt of the changed region, so a preview cannot flood the context. */
export function previewRegion(text: string, range: LineRange): string {
	const lines = normalizeLineEndings(text).split("\n");
	const start = Math.max(1, range.startLine);
	const end = Math.min(lines.length, range.endLine);
	const shown = lines.slice(start - 1, Math.min(end, start - 1 + MAX_PREVIEW_LINES));
	const numbered = shown.map(
		(line: string, i: number) => `${String(start + i).padStart(6)}│${line}`,
	);
	const omitted = end - start + 1 - shown.length;
	if (omitted > 0) numbered.push(`       … ${omitted} more line${omitted === 1 ? "" : "s"}`);
	return numbered.join("\n");
}
