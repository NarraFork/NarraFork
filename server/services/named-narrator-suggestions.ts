import {
	NAMED_SUGGESTIONS_CURSOR_CHARS,
	NAMED_SUGGESTIONS_DEFAULT_LIMIT,
	NAMED_SUGGESTIONS_MAX_BYTES,
	NAMED_SUGGESTIONS_MAX_LIMIT,
	NAMED_SUGGESTIONS_TITLE_CHARS,
	type NamedNarratorSuggestionsPage,
	normalizeNamedSuggestionQuery,
} from "@shared/named-narrator-suggestions";
import { foldHandle } from "@shared/narrator-handle";
import { and, asc, eq, gt, gte, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { readQuery } from "../db/worker-read";
import { ValidationError } from "../lib/errors";
import { type NarratorPrincipal, narratorReadableWhere } from "./narrator-acl";

interface SuggestionsOptions {
	q?: string;
	limit?: string | number;
	cursor?: string;
	signal?: AbortSignal;
}

function decodeCursor(encoded: string | undefined, q: string): string | undefined {
	if (encoded === undefined) return undefined;
	try {
		if (!encoded || encoded.length > NAMED_SUGGESTIONS_CURSOR_CHARS) throw new Error();
		if (!/^[\w-]+$/.test(encoded)) throw new Error();
		const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (
			value.v !== 1 ||
			value.q !== q ||
			typeof value.after !== "string" ||
			!value.after ||
			value.after.length > 256 ||
			foldHandle(value.after) !== value.after
		)
			throw new Error();
		return value.after;
	} catch {
		throw new ValidationError("Invalid named suggestions cursor");
	}
}

/** Indexed handle-prefix search, with ACL applied BEFORE the bounded page is read. */
export async function listNamedNarratorSuggestions(
	principal: NarratorPrincipal,
	options: SuggestionsOptions = {},
): Promise<NamedNarratorSuggestionsPage> {
	const q = normalizeNamedSuggestionQuery(options.q ?? "");
	if (q === null) throw new ValidationError("Named suggestions q exceeds 32 code points");
	const requestedLimit =
		options.limit === undefined ? NAMED_SUGGESTIONS_DEFAULT_LIMIT : Number(options.limit);
	if (!Number.isInteger(requestedLimit) || requestedLimit < 1)
		throw new ValidationError("Invalid named suggestions limit");
	const limit = Math.min(requestedLimit, NAMED_SUGGESTIONS_MAX_LIMIT);
	const after = decodeCursor(options.cursor, q);
	// All stored handle characters are letters/numbers/_/-. Increment the final
	// Unicode scalar for a binary index range; never use SQLite's ASCII-only lower().
	const chars = [...q];
	const last = chars.pop();
	const upper =
		last && last.codePointAt(0) !== 0x10ffff
			? chars.join("") + String.fromCodePoint((last.codePointAt(0) ?? 0) + 1)
			: undefined;
	const rows = await readQuery(
		db
			.select({
				id: narrators.id,
				handle: sql<string>`${narrators.handle}`,
				title: sql<string | null>`substr(${narrators.title}, 1, ${NAMED_SUGGESTIONS_TITLE_CHARS})`,
				status: narrators.status,
			})
			.from(narrators)
			.where(
				and(
					eq(narrators.type, "primary"),
					isNotNull(narrators.handle),
					gt(narrators.handleFold, ""),
					sql`cast(${narrators.traits} as text) like ${'%"named"%'}`,
					narratorReadableWhere(principal),
					q ? gte(narrators.handleFold, q) : undefined,
					upper ? lt(narrators.handleFold, upper) : undefined,
					q ? sql`substr(${narrators.handleFold}, 1, ${[...q].length}) = ${q}` : undefined,
					after ? gt(narrators.handleFold, after) : undefined,
				),
			)
			.orderBy(asc(narrators.handleFold))
			.limit(limit + 1),
		{
			signal: options.signal,
			timeoutMs: 2_000,
			executionPolicy: "worker-required",
			maxRows: limit + 1,
			diagnosticSource: "named-suggestions",
		},
	);
	const items = rows.slice(0, limit);
	const lastItem = items.at(-1);
	const page = {
		items,
		nextCursor:
			rows.length > limit && lastItem
				? Buffer.from(JSON.stringify({ v: 1, q, after: foldHandle(lastItem.handle) })).toString(
						"base64url",
					)
				: null,
	};
	if (Buffer.byteLength(JSON.stringify(page)) > NAMED_SUGGESTIONS_MAX_BYTES)
		throw new ValidationError("Named suggestions page exceeds response budget");
	return page;
}
