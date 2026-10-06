/**
 * Parser-free modes: `print` (sed-style line/regex output) and `landmarks` (author-drawn
 * section banners, regions and TODO markers). Both work on any text file, so they need no
 * provider — only the text and the shared render/scan helpers.
 */

import {
	AddressError,
	countByTag,
	type LandmarkKind,
	parseAddress,
	resolveAddress,
	scanLandmarks,
} from "../../../structural";
import type { ToolResult } from "../../../types";
import { normalizeNumber } from "../../number-param";
import {
	LANDMARK_KINDS,
	MAX_FILE_BYTES,
	MAX_LANDMARKS,
	MAX_PRINT_BLOCKS,
	MAX_PRINT_LINES,
} from "../constants";
import { clampOutput, numberLines, withFooter } from "../render";

export function runPrint(
	filePath: string,
	text: string,
	args: Record<string, unknown>,
	truncatedRead: boolean,
): ToolResult {
	const raw = typeof args.address === "string" ? args.address : "";
	if (!raw) {
		return {
			output:
				'mode=print requires `address`, e.g. "42", "10,20", "10,$", "$", "/TODO/", or "/BEGIN/,/END/".',
			isError: true,
		};
	}

	const lines = text.split("\n");
	let resolvedBlocks: ReturnType<typeof resolveAddress>;
	try {
		resolvedBlocks = resolveAddress(parseAddress(raw), lines, { maxBlocks: MAX_PRINT_BLOCKS });
	} catch (err) {
		if (err instanceof AddressError) {
			return { output: `Invalid address: ${err.message}`, isError: true };
		}
		throw err;
	}

	if (resolvedBlocks.blocks.length === 0) {
		// A bare "matched nothing" cannot be told apart from a mistyped regex, which makes
		// the call a dead end. Naming the scan size and the likely cause makes the retry
		// informed instead of a guess.
		const isRegex = raw.trim().startsWith("/");
		const hint = isRegex
			? " The address is a regex — check escaping (backslashes, ^ and $ anchors), or run mode=outline to see the file's real structure."
			: " Line numbers are 1-based and this file may be shorter than the address.";
		return {
			output: `Address "${raw}" matched nothing · scanned ${lines.length} lines of ${filePath}.${hint}`,
			title: filePath,
			metadata: { mode: "print", blocks: 0, totalLines: lines.length },
		};
	}

	const showNumbers = args.line_numbers !== false;
	const chunks: string[] = [];
	let emittedLines = 0;
	let cappedByLines = false;

	for (const block of resolvedBlocks.blocks) {
		if (emittedLines >= MAX_PRINT_LINES) {
			cappedByLines = true;
			break;
		}
		const available = MAX_PRINT_LINES - emittedLines;
		const slice = lines.slice(block.startLine - 1, block.endLine).slice(0, available);
		emittedLines += slice.length;
		if (slice.length < block.endLine - block.startLine + 1) cappedByLines = true;
		chunks.push(showNumbers ? numberLines(slice, block.startLine) : slice.join("\n"));
	}

	const notes: string[] = [];
	if (resolvedBlocks.truncated) {
		notes.push(`Stopped after ${MAX_PRINT_BLOCKS} matching blocks; narrow the address.`);
	}
	if (cappedByLines) {
		notes.push(`Output capped at ${MAX_PRINT_LINES} lines.`);
	}
	if (truncatedRead) {
		notes.push(`File was truncated at ${MAX_FILE_BYTES / 1024 / 1024} MB before matching.`);
	}

	// A blank line between blocks; sed prints them contiguously, but a model reading
	// several disjoint regions needs to see where one ends and the next begins.
	const blockCount = resolvedBlocks.blocks.length;
	return {
		output: withFooter(
			// The scan denominator is what distinguishes "only one match exists" from
			// "my pattern was wrong and happened to hit once".
			`${filePath}  address ${raw} · ${blockCount} ${blockCount === 1 ? "match" : "matches"} in ${lines.length} lines scanned`,
			clampOutput(chunks.join("\n\n")),
			notes,
		),
		title: filePath,
		metadata: {
			mode: "print",
			blocks: resolvedBlocks.blocks.length,
			printedLines: emittedLines,
			totalLines: lines.length,
		},
	};
}

/**
 * `landmarks` — the boundaries the author wrote down.
 *
 * Reported as a flat, line-ordered list rather than grouped by kind: the value is seeing
 * where the seams fall relative to each other, and grouping would scatter a file's running
 * order across three lists.
 */
export function runLandmarks(
	filePath: string,
	text: string,
	args: Record<string, unknown>,
	truncatedRead: boolean,
): ToolResult {
	const limit = normalizeNumber(args.limit, { min: 1 }) ?? MAX_LANDMARKS;
	// `kind` is the same comma-separated string the other modes take, so "section,marker"
	// works here exactly as "function,method" does there.
	const requested =
		typeof args.kind === "string"
			? args.kind
					.split(",")
					.map((part) => part.trim().toLowerCase())
					.filter((part): part is LandmarkKind => LANDMARK_KINDS.includes(part as never))
			: null;

	const marks = scanLandmarks(text, {
		limit: limit + 1,
		...(requested && requested.length > 0 ? { kinds: requested } : {}),
	});
	const total = text.split("\n").length;
	const shown = marks.slice(0, limit);

	if (shown.length === 0) {
		return {
			output:
				`${filePath}  ${total} lines\n\n` +
				"No landmarks found: no section banners, #region blocks or TODO/FIXME markers.\n" +
				"Try mode=outline for declared structure, or mode=report for a summary.",
			title: filePath,
			metadata: { mode: "landmarks", landmarks: 0, totalLines: total },
		};
	}

	const body = shown
		.map((mark) => {
			const at = `L${String(mark.line).padEnd(6)}`;
			if (mark.kind === "marker") return `${at} ${mark.tag}  ${mark.label}`;
			const label = mark.label.length > 0 ? mark.label : "(rule)";
			return `${at} ${mark.kind === "region" ? "region" : "──────"}  ${label}`;
		})
		.join("\n");

	const tags = countByTag(shown);
	const tagSummary =
		tags.size > 0
			? ` Markers: ${[...tags]
					.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
					.map(([tag, count]) => `${tag} ${count}`)
					.join(", ")}.`
			: "";
	const sections = shown.filter((m) => m.kind !== "marker").length;
	const summary =
		`${shown.length} landmark(s) across ${total} lines; ${sections} mark section boundaries.` +
		tagSummary +
		(marks.length > shown.length ? " More exist (raise `limit`)." : "") +
		(truncatedRead ? " The file was read only in part, so later landmarks are missing." : "");

	return {
		output: `${filePath}  ${total} lines\nline    kind    label\n${body}\n\n${summary}`,
		title: filePath,
		metadata: {
			mode: "landmarks",
			landmarks: shown.length,
			sections,
			totalLines: total,
		},
	};
}
