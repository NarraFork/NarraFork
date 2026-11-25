/**
 * Fill `narrators.title_slug` and `narrators.alias_selector` for rows written
 * before those columns existed.
 *
 * The slug is the same JS function the resolver uses (`slugifyTaskAlias`), so a
 * title computed earlier is an index hit afterwards. Idempotent: a row leaves
 * the page query once both columns are non-null. Empty string means "checked,
 * nothing to store" and is distinct from a not-yet-backfilled NULL.
 */
import type { Database } from "bun:sqlite";
import { logger } from "../lib/logger";
import { getPersistedSubagentAliases, slugifyTaskAlias } from "../services/subagent-alias";

const PAGE = 200;
const MAX_PAGES = 100_000;

interface SelectorRow {
	id: string;
	title: string | null;
	traits: string | null;
	title_slug: string | null;
	alias_selector: string | null;
}

export function backfillNarratorAliasSelectors(
	sqlite: Database,
	options: { ownTransaction?: boolean } = {},
): void {
	const ownTransaction = options.ownTransaction !== false;
	let select: ReturnType<Database["prepare"]>;
	let update: ReturnType<Database["prepare"]>;
	try {
		select = sqlite.prepare(
			`SELECT id, title, traits, title_slug, alias_selector
			 FROM narrators
			 WHERE (title_slug IS NULL AND title IS NOT NULL AND title != '')
			    OR (alias_selector IS NULL AND parent_narrator_id IS NOT NULL)
			 ORDER BY id
			 LIMIT ${PAGE}`,
		);
		update = sqlite.prepare(
			`UPDATE narrators
			 SET title_slug = CASE WHEN title_slug IS NULL THEN ? ELSE title_slug END,
			     alias_selector = CASE WHEN alias_selector IS NULL THEN ? ELSE alias_selector END
			 WHERE id = ?
			   AND (title_slug IS NULL OR alias_selector IS NULL)`,
		);
	} catch (error) {
		logger.warn("Alias selector backfill skipped", { error: String(error) });
		return;
	}
	let updated = 0;
	for (let page = 0; page < MAX_PAGES; page++) {
		const rows = select.all() as SelectorRow[];
		if (rows.length === 0) break;
		const write = () => {
			for (const row of rows) {
				const titleSlug = row.title ? slugifyTaskAlias(row.title) || "" : "";
				let alias = "";
				if (typeof row.traits === "string" && row.traits.includes("subagent-alias:")) {
					try {
						alias = getPersistedSubagentAliases(JSON.parse(row.traits))[0] ?? "";
					} catch {
						alias = "";
					}
				}
				updated += update.run(titleSlug, alias, row.id).changes;
			}
		};
		if (ownTransaction) sqlite.transaction(write)();
		else write();
		if (rows.length < PAGE) break;
	}
	if (updated > 0) logger.info("Backfilled narrator alias selectors", { updated });
}
