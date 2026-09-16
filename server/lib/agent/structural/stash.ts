/**
 * In-memory relay for text moved between files.
 *
 * The problem it solves: moving a range from one file to another used to require the
 * text to travel THROUGH the model. `mode=print` is the only way to read a line range as
 * raw text, and its output carries a header line, so the model had to read the block,
 * strip the header, and retype the body verbatim into the next call's `content`. That
 * puts the same code in the context twice and asks the model to transcribe hundreds of
 * lines without altering a character — the one thing it is least suited to.
 *
 * A stash entry holds the text server-side and hands back a short handle. The content
 * never enters the context, so the move becomes a reference instead of a transcription.
 * Two consequences fall out of that, both previously impossible:
 *   - blocks larger than StructView's 60k output cap can be moved at all (a truncated
 *     block written to a file is a corrupted file);
 *   - the range is fixed at stash time, so the follow-up delete cannot drift if lines
 *     above it changed.
 *
 * NOT persisted, by design. This is a within-turn relay, not a clipboard that survives
 * restarts: durable cross-file state is what the write pipeline would have to own, and
 * that is exactly the change being deferred. Losing an entry costs one re-stash, because
 * stashing never modifies the source file.
 */

import { hotSafe } from "../../hot-safe";
import { generateShortId } from "../../id";

/** Largest single entry. Matches the tool's own file ceiling. */
export const MAX_STASH_BYTES = 2_000_000;

/** Entries kept per narrator before the oldest is evicted. */
export const MAX_STASH_ENTRIES_PER_NARRATOR = 16;

/** Total bytes kept per narrator before the oldest entries are evicted. */
export const MAX_STASH_TOTAL_BYTES_PER_NARRATOR = 8_000_000;

/**
 * How long an unused entry survives.
 *
 * A move that spans more than this was almost certainly abandoned. The bound matters
 * because nothing else reclaims these: the Bash tool's process map can go uncapped since
 * process exit removes its entries, but a stash has no such natural terminus, so without
 * a TTL a forgotten handle would occupy memory for the life of the server.
 */
export const STASH_TTL_MS = 30 * 60 * 1000;

export interface StashEntry {
	handle: string;
	narratorId: string;
	/** Decoded text of the stashed range. */
	text: string;
	/** Source file, for the summary line and for explaining a stale handle. */
	filePath: string;
	startLine: number;
	endLine: number;
	/** Source encoding, so a caller can decide how to re-encode on write. */
	encoding: string;
	lineCount: number;
	bytes: number;
	createdAt: number;
}

/** Why a handle could not be used. Each maps to a message the model can act on. */
export type StashFailure = "unknown" | "expired" | "wrong_narrator";

const store = hotSafe("narrafork:structuralStash", () => new Map<string, StashEntry>());

/** Test seam: a stable clock beats sleeping 30 minutes to check expiry. */
let now = (): number => Date.now();

/** @internal Testing only. */
export function setStashClock(clock: () => number): void {
	now = clock;
}

/** @internal Testing only. */
export function resetStash(): void {
	store.clear();
	now = () => Date.now();
}

export interface StashInput {
	narratorId: string;
	text: string;
	filePath: string;
	startLine: number;
	endLine: number;
	encoding?: string;
}

export class StashTooLargeError extends Error {}

/**
 * Store a range and return its entry.
 *
 * Throws only for an oversized entry: that is a caller error with a clear remedy (stash a
 * narrower range), unlike eviction, which is silent housekeeping.
 */
export function putStash(input: StashInput): StashEntry {
	const bytes = Buffer.byteLength(input.text, "utf8");
	if (bytes > MAX_STASH_BYTES) {
		throw new StashTooLargeError(
			`Range is ${bytes} bytes; the stash limit is ${MAX_STASH_BYTES}. Stash a narrower range.`,
		);
	}
	const entry: StashEntry = {
		handle: `stash_${generateShortId()}`,
		narratorId: input.narratorId,
		text: input.text,
		filePath: input.filePath,
		startLine: input.startLine,
		endLine: input.endLine,
		encoding: input.encoding ?? "utf-8",
		// A range is at least one line even when empty, matching how addresses count.
		lineCount: input.text.length === 0 ? 0 : input.text.split("\n").length,
		bytes,
		createdAt: now(),
	};
	store.set(entry.handle, entry);
	evict(input.narratorId);
	return entry;
}

/**
 * Read an entry without consuming it.
 *
 * Separate from `takeStash` so a dry run can preview a write without spending the handle:
 * consuming on preview would mean the first real call always failed.
 */
export function peekStash(
	handle: string,
	narratorId: string,
): { entry: StashEntry } | { failure: StashFailure } {
	const entry = store.get(handle);
	if (!entry) return { failure: "unknown" };
	// Ownership is checked before expiry: "not yours" is the more precise answer, and
	// reporting another narrator's entry as merely expired would leak that it exists.
	if (entry.narratorId !== narratorId) return { failure: "wrong_narrator" };
	if (now() - entry.createdAt > STASH_TTL_MS) {
		store.delete(handle);
		return { failure: "expired" };
	}
	return { entry };
}

/** Read and consume an entry. */
export function takeStash(
	handle: string,
	narratorId: string,
): { entry: StashEntry } | { failure: StashFailure } {
	const result = peekStash(handle, narratorId);
	if ("entry" in result) store.delete(handle);
	return result;
}

/** Drop an entry if it exists. Idempotent. */
export function dropStash(handle: string, narratorId: string): boolean {
	const entry = store.get(handle);
	if (!entry || entry.narratorId !== narratorId) return false;
	return store.delete(handle);
}

/** Oldest-first eviction once a narrator exceeds either ceiling. */
function evict(narratorId: string): void {
	const mine = [...store.values()]
		.filter((e) => e.narratorId === narratorId)
		.sort((a, b) => a.createdAt - b.createdAt);
	let count = mine.length;
	let total = mine.reduce((n, e) => n + e.bytes, 0);
	for (const entry of mine) {
		if (count <= MAX_STASH_ENTRIES_PER_NARRATOR && total <= MAX_STASH_TOTAL_BYTES_PER_NARRATOR) {
			break;
		}
		store.delete(entry.handle);
		count--;
		total -= entry.bytes;
	}
}

/** Human-readable size for the summary line. */
export function formatStashSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Where a stashed range sits in the file NOW. */
export type StashLocation =
	| { kind: "exact"; startLine: number; endLine: number }
	| {
			kind: "relocated";
			startLine: number;
			endLine: number;
			fromStartLine: number;
			fromEndLine: number;
	  }
	| { kind: "ambiguous"; candidates: number[] }
	| { kind: "missing" };

/**
 * Locate a stashed range in the file's current content.
 *
 * The line numbers recorded at stash time go stale the moment anything above the range is
 * edited, and acting on a stale range is not a harmless miss — it deletes whatever moved
 * into those lines. So the recorded position is a HINT, verified against the stashed text
 * before it is used:
 *
 *   1. still there → `exact`
 *   2. found exactly once elsewhere → `relocated`, and the caller is told it moved. This
 *      is the common drift (lines added or removed above) and is fully recoverable, so
 *      refusing here would force a pointless re-stash.
 *   3. found several times → `ambiguous`. With duplicate text there is no way to tell
 *      which occurrence was the stashed one, and guessing is how the wrong copy gets
 *      deleted.
 *   4. not found → `missing`. The range was rewritten or already removed.
 *
 * Matching is LINE-WISE, for two reasons. A substring search could match half a line,
 * which cannot serve as a delete range. And a naive string compare would break on CRLF
 * files: a stash of `L2\r\nL3\r\n` sliced by line keeps a trailing lone `\r`, which
 * `normalizeLineEndings` does not remove (it only rewrites `\r\n`), so the texts would
 * never be equal and every CRLF file would fall through to `missing` — reported as "the
 * content changed" when nothing had.
 */
export function locateStashRange(
	fileText: string,
	entry: Pick<StashEntry, "text" | "startLine" | "endLine">,
): StashLocation {
	const fileLines = splitNormalized(fileText);
	const needle = splitNormalized(entry.text);
	if (needle.length === 0) return { kind: "missing" };

	const matchesAt = (start: number): boolean => {
		if (start < 0 || start + needle.length > fileLines.length) return false;
		for (let i = 0; i < needle.length; i++) {
			if (fileLines[start + i] !== needle[i]) return false;
		}
		return true;
	};

	// The recorded position first: an unchanged file must not pay for a whole-file scan.
	if (matchesAt(entry.startLine - 1)) {
		return {
			kind: "exact",
			startLine: entry.startLine,
			endLine: entry.startLine + needle.length - 1,
		};
	}

	const candidates: number[] = [];
	for (let i = 0; i + needle.length <= fileLines.length; i++) {
		if (matchesAt(i)) candidates.push(i + 1);
		// Two is enough to know it is ambiguous; scanning on would only lengthen the report.
		if (candidates.length > 1) break;
	}
	if (candidates.length === 0) return { kind: "missing" };
	if (candidates.length > 1) return { kind: "ambiguous", candidates };

	const start = candidates[0] as number;
	return {
		kind: "relocated",
		startLine: start,
		endLine: start + needle.length - 1,
		fromStartLine: entry.startLine,
		fromEndLine: entry.endLine,
	};
}

/**
 * Split into lines with line endings neutralized.
 *
 * Handles `\r\n` and a trailing lone `\r`, which is what a line-sliced stash of a CRLF
 * file ends with.
 */
function splitNormalized(text: string): string[] {
	return text.split(/\r?\n/).map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}
