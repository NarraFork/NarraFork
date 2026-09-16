/**
 * Turning a request into something applyable: validating one operation's fields, and
 * resolving a structural-or-sed address to a concrete line range.
 *
 * Both return `{ error }` rather than throwing, because every failure here is a message for
 * the model (ambiguous symbol, no match, no parser) — not an exception.
 */

import { extname } from "node:path";
import {
	AddressError,
	languageIdForExtension,
	parseAddress,
	parseSymbolSelector,
	resolveAddress,
	resolveProvider,
	type StructDocument,
	type StructKind,
} from "../../structural";
import type { LineRange, MovePlacement } from "../../structural/edit-ops";
import type { ToolResult } from "../../types";
import { COMMANDS, type Command, RELOCATION_COMMANDS } from "./commands";

/** Parse a comma-separated `kind` filter into a list, or null when absent/empty. */
export function parseKinds(raw: unknown): StructKind[] | null {
	if (typeof raw !== "string" || !raw.trim()) return null;
	const kinds = raw
		.split(",")
		.map((k) => k.trim())
		.filter(Boolean) as StructKind[];
	return kinds.length > 0 ? kinds : null;
}

/**
 * Resolve one address (structural or sed-style) to a line range.
 *
 * Shared by the source and the copy/move destination so the two cannot diverge: a
 * destination written the same way as a source must select the same lines.
 *
 * Returns `{ error }` rather than throwing, because every failure here is a message for the
 * model (ambiguous symbol, no match, no parser) rather than an exception.
 */
export async function resolveToRange(input: {
	symbol: string;
	address: string;
	role: "source" | "destination";
	filePath: string;
	resolvedPath: string;
	text: string;
	kind?: unknown;
	signal?: AbortSignal;
}): Promise<{ range: LineRange; label: string } | { error: ToolResult }> {
	const { symbol, address, role, filePath, resolvedPath, text } = input;
	const field = role === "source" ? "symbol" : "to_symbol";
	const addressField = role === "source" ? "address" : "to_address";

	if (symbol) {
		const languageId = languageIdForExtension(extname(resolvedPath));
		const doc: StructDocument = {
			filePath: resolvedPath,
			text,
			languageId,
			...(input.signal ? { signal: input.signal } : {}),
		};
		const resolved = await resolveProvider(doc);
		if (!resolved) {
			return {
				error: {
					output: `No structure provider could handle ${filePath}. Use \`${addressField}\` for a line or regex range instead.`,
					isError: true,
				},
			};
		}
		const parsed = parseSymbolSelector(symbol);
		const kinds = parseKinds(input.kind);
		const matches = await resolved.provider.locate(doc, {
			symbol: parsed.symbol,
			...(parsed.nth != null ? { nth: parsed.nth } : {}),
			...(kinds ? { kinds } : {}),
		});
		if (matches.length === 0) {
			// The advice depends on WHY there was no match. With a real parse, the symbol
			// simply is not there and the outline shows what is. Without one (an unknown
			// language answered by the heuristic provider), pointing at the outline sends
			// the model to a guess — an address is the tool that actually works there.
			const advice =
				resolved.support === "full"
					? "Run StructView mode=outline to see what is there."
					: `${languageId ? `No parser is installed for ${languageId}` : "This file has no known language"}, so structural addressing is unreliable here. Use \`${addressField}\` with a line or regex range instead.`;
			return {
				error: {
					output: `No ${role} symbol matching "${symbol}" in ${filePath}. ${advice}`,
					isError: true,
					title: filePath,
				},
			};
		}
		// Ambiguity is reported, never resolved by picking: editing the wrong overload
		// looks exactly like a successful edit.
		if (matches.length > 1) {
			const list = matches
				.map((m, i) => `  #${i + 1}  L${m.startLine}-${m.endLine}  ${m.kind} ${m.symbolPath}`)
				.join("\n");
			return {
				error: {
					output: `\`${field}\` "${symbol}" matches ${matches.length} declarations in ${filePath}. Disambiguate with "${symbol}#N" or \`kind\`:\n${list}`,
					isError: true,
					title: filePath,
				},
			};
		}
		const hit = matches[0];
		if (!hit) {
			return { error: { output: `Could not resolve "${symbol}".`, isError: true } };
		}
		return {
			range: { startLine: hit.startLine, endLine: hit.endLine },
			label: `${hit.kind} ${hit.symbolPath} (L${hit.startLine}-${hit.endLine})`,
		};
	}

	const lines = text.split("\n");
	try {
		const parsed = parseAddress(address);
		const result = resolveAddress(parsed, lines, { maxBlocks: 1 });
		const block = result.blocks[0];
		if (!block) {
			return {
				error: {
					output: `${role === "source" ? "Address" : "Destination address"} "${address}" matched nothing in ${filePath}.`,
					isError: true,
					title: filePath,
				},
			};
		}
		return {
			range: { startLine: block.startLine, endLine: block.endLine },
			label: `L${block.startLine}-${block.endLine}`,
		};
	} catch (err) {
		return {
			error: {
				output:
					err instanceof AddressError
						? `Invalid ${addressField}: ${err.message}`
						: `Error resolving ${addressField}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			},
		};
	}
}

/** One operation after field-level validation, before its address is resolved. */
export interface ValidatedSpec {
	index: number;
	command: Command;
	isRelocation: boolean;
	symbol: string;
	address: string;
	toSymbol: string;
	toAddress: string;
	placement: MovePlacement;
	kind?: unknown;
	content?: string;
	pattern?: string;
	replacement?: string;
	flags?: string;
}

/**
 * Validate one operation's fields.
 *
 * Shared by the single-call and batch shapes so a batch entry cannot accept something a
 * single call rejects. `batched` only affects the wording, so an error inside a batch says
 * which entry it came from.
 */
export function validateSpec(
	spec: Record<string, unknown>,
	index: number,
	batched: boolean,
): { spec: ValidatedSpec } | { error: ToolResult } {
	const at = batched ? ` (operation ${index})` : "";
	const fail = (output: string): { error: ToolResult } => ({
		error: { output: `${output}${at}`, isError: true },
	});

	const command = spec.command as Command;
	if (!COMMANDS.includes(command)) {
		return fail(
			`Unknown command "${String(spec.command)}". Expected one of: ${COMMANDS.join(", ")}.`,
		);
	}

	const symbol = typeof spec.symbol === "string" ? spec.symbol.trim() : "";
	const address = typeof spec.address === "string" ? spec.address.trim() : "";
	// Both given is an ambiguous request, not a choice to make on the model's behalf:
	// picking one silently could delete a different range than the one it named.
	if (symbol && address) {
		return fail(
			"Give either `symbol` or `address`, not both - they select different things and there is no safe way to guess which one you meant.",
		);
	}
	if (!symbol && !address) {
		return fail(
			"An address is required: pass `symbol` for a declaration, or `address` for a line/regex range.",
		);
	}

	const isRelocation = RELOCATION_COMMANDS.has(command);
	const toSymbol = typeof spec.to_symbol === "string" ? spec.to_symbol.trim() : "";
	const toAddress = typeof spec.to_address === "string" ? spec.to_address.trim() : "";
	if (toSymbol && toAddress) {
		return fail("Give either `to_symbol` or `to_address`, not both.");
	}
	// A destination on a command that does not relocate is a misunderstanding worth naming:
	// silently ignoring it would leave the model believing the block moved.
	if (!isRelocation && (toSymbol || toAddress)) {
		return fail(
			`command=${command} does not take a destination. Use copy or move to relocate a block.`,
		);
	}
	if (!isRelocation && spec.placement !== undefined) {
		return fail(
			`command=${command} does not take \`placement\`; it only applies to copy and move.`,
		);
	}
	// `to_file` reads like the obvious way to move a symbol between files, and it is the
	// name reserved for that if it ever ships. Until then it must be REFUSED, not ignored:
	// silently dropping it resolved the destination inside the source file, which for a
	// same-line target produced "destination overlaps the source" — an error about the
	// wrong file entirely, leaving the caller to conclude the move had happened.
	if (spec.to_file !== undefined) {
		return fail(
			"StructSed cannot write two files in one call, so `to_file` is not supported. " +
				"To move a symbol across files: StructView mode=extract with line_numbers=false, " +
				"then StructSed append with create_if_missing on the target, then delete here.",
		);
	}

	return {
		spec: {
			index,
			command,
			isRelocation,
			symbol,
			address,
			toSymbol,
			toAddress,
			placement: spec.placement === "before" ? "before" : "after",
			...(spec.kind !== undefined ? { kind: spec.kind } : {}),
			...(typeof spec.content === "string" ? { content: spec.content } : {}),
			...(typeof spec.pattern === "string" ? { pattern: spec.pattern } : {}),
			...(typeof spec.replacement === "string" ? { replacement: spec.replacement } : {}),
			...(typeof spec.flags === "string" ? { flags: spec.flags } : {}),
		},
	};
}
