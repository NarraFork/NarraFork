/**
 * `stash` — hold a range server-side so it can be written elsewhere without passing
 * through the context.
 *
 * Lives on StructView, not StructSed, and that placement is deliberate. StructSed's
 * execution routing declares `operation: "write"` for EVERY call regardless of command,
 * so a stash command there would request write permission merely to read a range — the
 * wrong semantics, and an extra approval prompt in a session that gates writes. Stashing
 * modifies nothing, so it belongs behind a read-only tool.
 *
 * Reading is also all this needs to do: the source file is left untouched, and removing
 * the original is a separate, visible `StructSed delete`. The alternative — stashing as a
 * "cut" — would leave the only copy of the text in memory, so a crash would lose code.
 * Here the worst case is a stale entry, whose cost is one re-stash.
 */

import {
	AddressError,
	formatStashSize,
	listStashes,
	parseAddress,
	parseSymbolSelector,
	putStash,
	resolveAddress,
	StashNameError,
	StashTooLargeError,
	type StructDocument,
	stashTtlRemainingMs,
} from "../../../structural";
import type { ToolResult } from "../../../types";
import type { Resolved } from "../render";
import { withFooter } from "../render";

/**
 * What the narrator is currently holding — metadata only, never the text.
 *
 * Listing the content would defeat the point of the stash (keeping big blocks out of the
 * context), so this reports where each block came from and how big it is, which is what a
 * caller needs to pick the right handle.
 */
function listHeldStashes(narratorId: string, notes: string[]): ToolResult {
	const held = listStashes(narratorId);
	if (held.length === 0) {
		return {
			output: withFooter(
				"No stashes held",
				'mode=stash with `address` (e.g. "1495,$") or `symbol` holds a range server-side and ' +
					"returns a handle for StructSed's from_stash. Called with neither, as here, it lists " +
					"what you are already holding.",
				notes,
			),
			title: "stash list",
			metadata: { mode: "stash", action: "list", count: 0 },
		};
	}
	const rows = held.map((entry) => {
		const minutes = Math.round(stashTtlRemainingMs(entry.createdAt) / 60000);
		return (
			`  ${entry.handle}  ${entry.filePath}:${entry.startLine}-${entry.endLine}  ` +
			`${entry.lineCount} line(s), ${formatStashSize(entry.bytes)}, expires in ~${minutes}m`
		);
	});
	return {
		output: withFooter(
			`${held.length} stash(es) held`,
			`${rows.join("\n")}\n\nContent is not shown — that is what keeps it out of the context. ` +
				"Write one with StructSed `from_stash`, and pass keep: true if a delete of the " +
				"original still needs the handle afterwards.",
			notes,
		),
		title: "stash list",
		metadata: { mode: "stash", action: "list", count: held.length },
	};
}

export async function runStash(
	filePath: string,
	text: string,
	doc: StructDocument,
	resolved: Resolved | null,
	args: Record<string, unknown>,
	narratorId: string,
	encoding: string,
	notes: string[],
): Promise<ToolResult> {
	const rawAddress = typeof args.address === "string" ? args.address.trim() : "";
	const rawSymbol = typeof args.symbol === "string" ? args.symbol.trim() : "";

	if (rawAddress && rawSymbol) {
		return {
			output:
				"Give either `address` or `symbol`, not both — they select different things and " +
				"guessing which one was meant could stash the wrong range.",
			isError: true,
			title: filePath,
		};
	}
	// No range asked for means "tell me what I am already holding". A handle is otherwise
	// opaque, so this is the only way to recover which one holds what after a compaction or
	// an interruption — previously that record existed only in conversation notes.
	if (!rawAddress && !rawSymbol) {
		return listHeldStashes(narratorId, notes);
	}

	const lines = text.split("\n");
	let startLine: number;
	let endLine: number;
	let label: string;

	if (rawAddress) {
		try {
			// maxBlocks: 1 — a stash is one contiguous block. A regex matching many lines
			// would otherwise silently stash only the first.
			const result = resolveAddress(parseAddress(rawAddress), lines, { maxBlocks: 1 });
			const block = result.blocks[0];
			if (!block) {
				return {
					output: `Address "${rawAddress}" matched nothing in ${filePath}.`,
					isError: true,
					title: filePath,
				};
			}
			startLine = block.startLine;
			endLine = block.endLine;
			label = `L${startLine}-${endLine}`;
		} catch (err) {
			if (err instanceof AddressError) {
				return { output: `Invalid address: ${err.message}`, isError: true, title: filePath };
			}
			throw err;
		}
	} else {
		if (!resolved) {
			return {
				output:
					`No structure provider could handle ${filePath}, so \`symbol\` cannot be resolved. ` +
					'Use `address` instead (e.g. "1495,$"), which needs no parser.',
				isError: true,
				title: filePath,
			};
		}
		const parsed = parseSymbolSelector(rawSymbol);
		const matches = await resolved.provider.locate(doc, {
			symbol: parsed.symbol,
			...(parsed.nth != null ? { nth: parsed.nth } : {}),
		});
		if (matches.length === 0) {
			return {
				output: `No symbol matching "${rawSymbol}" in ${filePath}. Run mode=outline to see what exists.`,
				isError: true,
				title: filePath,
			};
		}
		if (matches.length > 1) {
			// Same reasoning as extract: stashing the wrong overload looks like success.
			const list = matches
				.map((m, i) => `  #${i + 1}  L${m.startLine}-${m.endLine}  ${m.kind} ${m.symbolPath}`)
				.join("\n");
			return {
				output:
					`"${rawSymbol}" matches ${matches.length} declarations in ${filePath}:\n${list}\n\n` +
					`Re-run with symbol="${parsed.symbol}#N" to pick one.`,
				isError: true,
				title: filePath,
			};
		}
		const node = matches[0];
		if (!node) {
			return { output: `Could not resolve "${rawSymbol}".`, isError: true, title: filePath };
		}
		startLine = node.startLine;
		endLine = node.endLine;
		label = `${node.kind} ${node.symbolPath} (L${startLine}-${endLine})`;
	}

	// Sliced by line so the stored text matches what an address names, and so the follow-up
	// `StructSed delete` on the same address removes exactly what was stashed.
	const body = lines.slice(startLine - 1, endLine).join("\n");

	let entry: ReturnType<typeof putStash>;
	try {
		entry = putStash({
			narratorId,
			text: body,
			filePath,
			startLine,
			endLine,
			encoding,
			// A caller-chosen name makes the handle self-describing, which matters as soon as
			// two are in flight: `stash_scroll-fns` cannot be mixed up the way `stash_9nmlswfx`
			// can. Collisions are rejected inside putStash rather than silently overwritten.
			...(typeof args.name === "string" && args.name.trim() ? { name: args.name.trim() } : {}),
		});
	} catch (err) {
		if (err instanceof StashNameError) {
			return { output: err.message, isError: true, title: filePath };
		}
		if (err instanceof StashTooLargeError) {
			return { output: err.message, isError: true, title: filePath };
		}
		throw err;
	}

	// The output deliberately carries NO content. Echoing the block would put it in the
	// context, which is the cost this whole mode exists to avoid.
	return {
		output: withFooter(
			`stashed ${entry.handle}`,
			`${filePath}  ${label}\n` +
				`${entry.lineCount} line(s), ${formatStashSize(entry.bytes)} held server-side (content not shown).\n\n` +
				`Write it with StructSed: from_stash: "${entry.handle}" on replace/insert/append.\n` +
				`To MOVE it, pass keep: true on that write, then StructSed command=delete ` +
				`from_stash: "${entry.handle}" — delete takes its range from the stash and checks the ` +
				"text is still there, so a file that shifted cannot lose the wrong lines.\n" +
				"A dry run does not consume the handle. Stashing left the source file untouched.",
			notes,
		),
		title: `stash ${filePath}`,
		metadata: {
			mode: "stash",
			handle: entry.handle,
			startLine,
			endLine,
			lines: entry.lineCount,
			bytes: entry.bytes,
		},
	};
}
