/**
 * Every catalog message code must actually be thrown by the server.
 *
 * The gap this closes is specific and was real: `AUTH_REQUIRED`, `ADMIN_REQUIRED` and
 * `SESSION_REVOKED` were added to `shared/error-catalog.ts` AND to both `errors.json`
 * bundles, and the locale parity test confirmed all three were present — yet no throw
 * site used them. `middleware/auth.ts` still constructed raw `AppError`s, so those
 * responses arrived with `code: "UNAUTHORIZED"` / `"FORBIDDEN"` and no `messageCode`.
 * The frontend fell through to showing the server's English prose, in a Chinese UI,
 * for the most common failures in the app.
 *
 * The parity test cannot see this: it compares the catalog against the locale files,
 * and both sides were complete. Only the third side — who throws — was missing, so
 * this test looks at the source.
 *
 * A textual scan rather than runtime coverage: these errors are thrown from
 * middleware and services whose preconditions are awkward to reach, and the failure
 * being guarded against is "nobody references the key at all", which a grep answers
 * exactly. `catalogError("X")` and `messageCode: "X"` are the only two ways a code
 * reaches the wire, so both spellings count.
 *
 * Run: bun test server/lib/__tests__/error-catalog-reachability.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CATALOG } from "@shared/error-catalog";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
/** Directories that produce error responses. Tests and generated code are excluded. */
const SCANNED_ROOTS = ["server", "shared"];
const SKIPPED_DIRS = new Set(["node_modules", "generated", "__tests__", "dist", "drizzle"]);

function collectSources(dir: string, out: string[]): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIPPED_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			collectSources(full, out);
			continue;
		}
		if (!entry.endsWith(".ts")) continue;
		if (entry.endsWith(".test.ts")) continue;
		// The catalog itself lists every key by definition; counting it would make this
		// test pass unconditionally.
		if (full.endsWith(join("shared", "error-catalog.ts"))) continue;
		out.push(full);
	}
	return out;
}

const sources = SCANNED_ROOTS.flatMap((root) => collectSources(join(REPO_ROOT, root), []));
const corpus = sources.map((file) => readFileSync(file, "utf8")).join("\n");

describe("catalog reachability", () => {
	test("the scan found a plausible number of server sources", () => {
		// Guards the test itself: a broken path would make every assertion below vacuous.
		expect(sources.length).toBeGreaterThan(200);
		expect(corpus).toContain('catalogError("AUTH_REQUIRED")');
	});

	for (const messageCode of Object.keys(ERROR_CATALOG)) {
		test(`${messageCode} is thrown somewhere`, () => {
			const referenced =
				corpus.includes(`catalogError("${messageCode}")`) ||
				corpus.includes(`catalogError("${messageCode}",`) ||
				corpus.includes(`messageCode: "${messageCode}"`);
			expect(
				referenced,
				`${messageCode} exists in the catalog and in both locale bundles, but no server ` +
					`code path emits it — responses that should carry it arrive with only a coarse ` +
					`code, so the UI shows English prose instead of the localized wording.`,
			).toBe(true);
		});
	}
});

/**
 * `NotFoundError`'s first argument is not free-form prose — it is interpolated into the
 * translated template `RESOURCE_NOT_FOUND` ("{entity} not found: {id}" / "未找到{{entity}}
 * ：{{id}}"). A noun phrase survives that; a sentence does not.
 *
 * Six call sites passed whole sentences ("Can only edit user messages", "Preview not
 * supported for this file type"), which used to be harmless because the English was
 * concatenated and shown verbatim. Once the catalog rendered them through a Chinese
 * template they became "未找到Can only edit user messages：<id>" — mixed-script and
 * semantically backwards. Those were all cases where the resource HAD been found and the
 * request was the problem, so they are `ValidationError`s now.
 *
 * This is the side neither of the other tests can see: locale parity compares the catalog
 * to the bundles, reachability checks that codes are thrown, and neither looks at what is
 * substituted INTO a template.
 */
describe("NotFoundError entity labels are noun phrases", () => {
	/** Every distinct first argument to `new NotFoundError("…")` in the scanned sources. */
	const entities = [...corpus.matchAll(/new NotFoundError\(\s*"([^"]+)"/g)].map(
		(match) => match[1],
	);

	/**
	 * Sentence markers, chosen to be things a legitimate label never contains rather than
	 * a grammar check: a leading verb phrase ("Can only …", "No …", "Preview not …"), or
	 * sentence punctuation. Multi-word labels are fine and common ("Global skill", "Chat
	 * attachment", "Root chapter for project").
	 */
	const SENTENCE_PREFIXES = ["Can ", "Cannot ", "No ", "Not ", "Only ", "Must ", "Failed "];
	const SENTENCE_MARKERS = [".", "!", "?", " is ", " are ", " has ", " have ", " supported"];

	test("the scan found the entity labels", () => {
		// Guards against a regex that silently matches nothing.
		expect(entities.length).toBeGreaterThan(50);
		expect(entities).toContain("Narrator");
	});

	test("no entity label is a sentence", () => {
		const offenders = entities.filter(
			(entity) =>
				SENTENCE_PREFIXES.some((prefix) => entity.startsWith(prefix)) ||
				SENTENCE_MARKERS.some((marker) => entity.includes(marker)),
		);
		expect(
			offenders,
			`These NotFoundError labels read as sentences, but they are interpolated into the ` +
				`translated "{entity} not found: {id}" template. If the condition means "found it, ` +
				`but the request is wrong", throw a ValidationError instead.`,
		).toEqual([]);
	});
});
