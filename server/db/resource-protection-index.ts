import type { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";

/** Startup only, under the instance lock: no legacy namespace means no files to import.
 * Any existing namespace or ambiguous filesystem error leaves compatibility maintenance pending.
 * Durable dirty receipts still require retry; existing indexed pins are never removed.
 */
export function initializeAbsentReceiptProtectionSource(
	database: Database,
	receiptDirectory: string,
): void {
	try {
		lstatSync(receiptDirectory);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
	}
	database
		.query(`UPDATE resource_protection_sources
		SET cursor = 'eof', complete = 1, revision = revision + 1
		WHERE source = 'receipt' AND source_id = '' AND complete = 0
		AND (cursor IS NULL OR cursor NOT LIKE ?)
		AND NOT EXISTS (SELECT 1 FROM resource_protection_sources
			WHERE dirty = 1 AND source = 'receipt' AND source_id != '' LIMIT 1)`)
		.run(`${receiptProjectionPrefix}%`);
}

/** Bump when persisted paths/claims need reprojecting, independently of business schema. */
export const protectionProjectionVersion = "resource-protection-projection:v2";
export const receiptProjectionPrefix = `${protectionProjectionVersion}:`;
export type ReceiptProjectionProgress = {
	after: string;
	cursor: string | null;
	complete: number;
};

export const protectionSources = ["narrator", "registry", "receipt"] as const;
export type ProtectionSource = (typeof protectionSources)[number];
export const protectionTables = {
	narrator: {
		table: "narrators",
		fields: ["id", "cwd", "default_device_id", "workspace_context", "workspace_revision"],
	},
	registry: {
		table: "narrator_worktree_resources",
		fields: ["id", "device_id", "worktree_path", "repository_key", "scope_project_id", "state"],
	},
} as const;

/** Constant-size installation. No historical business rows are scanned on the startup thread. */
export function installResourceProtectionTriggers(database: Database): void {
	database.transaction(() => {
		const previous = database
			.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
			.get("resource_protection_narrator_insert") as { sql: string } | null;
		const receipt = database
			.query(`SELECT cursor, complete FROM resource_protection_sources
				WHERE source = 'receipt' AND source_id = ''`)
			.get() as { cursor: string | null; complete: number } | null;
		const upgrade = !previous?.sql.includes(protectionProjectionVersion);
		for (const source of protectionSources) {
			database
				.query(`INSERT INTO resource_protection_sources
				(source, source_id, dirty) VALUES (?, '', 0) ON CONFLICT DO NOTHING`)
				.run(source);
		}
		if (upgrade) {
			// Only fixed-size heads change at startup. Maintenance revisits historical
			// business rows in bounded bootstrap pages, including already-clean claims.
			for (const source of ["narrator", "registry"])
				database
					.query(`UPDATE resource_protection_sources
					SET cursor = NULL, complete = 0, revision = revision + 1
					WHERE source = ? AND source_id = '' AND (cursor IS NOT NULL OR complete != 0)`)
					.run(source);
			if (receipt && !receipt.cursor?.startsWith(receiptProjectionPrefix)) {
				const progress: ReceiptProjectionProgress = { after: "", ...receipt };
				database
					.query(`UPDATE resource_protection_sources
					SET cursor = ?, complete = 0, revision = revision + 1
					WHERE source = 'receipt' AND source_id = ''`)
					.run(receiptProjectionPrefix + JSON.stringify(progress));
			}
		}
		for (const [source, { table, fields }] of Object.entries(protectionTables)) {
			const mark = (record: "OLD" | "NEW") => `INSERT INTO resource_protection_sources
				(source, source_id, revision, dirty) VALUES ('${source}', ${record}.id, 1, 1)
				ON CONFLICT(source, source_id) DO UPDATE SET revision = revision + 1, dirty = 1;`;
			for (const action of ["INSERT", "DELETE", "UPDATE"] as const) {
				const when =
					action === "UPDATE"
						? `WHEN ${fields.map((field) => `OLD.${field} IS NOT NEW.${field}`).join(" OR ")}`
						: "";
				// Replace the fixed definitions atomically so upgrades can add tracked
				// fields without retaining an older trigger's invalidation predicate.
				const name = `resource_protection_${source}_${action.toLowerCase()}`;
				database.exec(`DROP TRIGGER IF EXISTS ${name}`);
				database.exec(`CREATE TRIGGER ${name}
					AFTER ${action} ON ${table} ${when} BEGIN
					/* ${protectionProjectionVersion} */
					${action === "INSERT" ? "" : mark("OLD")}
					${action === "DELETE" ? "" : mark("NEW")}
					UPDATE resource_protection_sources SET revision = revision + 1
					WHERE source = '${source}' AND source_id = '';
					END`);
			}
		}
	})();
}
