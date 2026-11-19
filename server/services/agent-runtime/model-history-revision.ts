import type { Database } from "bun:sqlite";
import type { SQL } from "bun";
import { ModelHistoryTimeoutError } from "../../lib/model-history-preparation";
import {
	MODEL_HISTORY_PG_TRIGGERS,
	MODEL_HISTORY_REVISION_CONTRACT,
	MODEL_HISTORY_SQLITE_TRIGGERS,
} from "./model-history-revision-sql";

const tableOf = (name: string) => {
	const kind = name.replace(/^model_history_v\d+_/, "");
	return kind.startsWith("message") || kind.startsWith("sync_message")
		? "narrator_messages"
		: kind.startsWith("tool") || kind.startsWith("sync_tool")
			? "narrator_tool_calls"
			: kind.startsWith("ref")
				? "narrator_message_refs"
				: kind.startsWith("block")
					? "narrator_blocks"
					: kind === "sender"
						? "users"
						: "narrators";
};
const sqliteTriggerPredicate = MODEL_HISTORY_SQLITE_TRIGGERS.map(
	(name) => `(name='${name}' AND tbl_name='${tableOf(name)}')`,
).join(" OR ");
const pgTriggerPredicate = MODEL_HISTORY_PG_TRIGGERS.map(
	([name, table]) => `(tgname='${name}' AND tgrelid='${table}'::regclass)`,
).join(" OR ");

export interface ModelHistorySignature {
	revision: string;
	trusted: boolean;
	/** Catalog epoch invalidates row-level deltas after trigger disable/reinstall/re-enable. */
	catalogIdentity?: string;
}

// SQLite invalidates compiled schema metadata when schema_version changes, including on
// other connections. A warm read still fetches the persisted narrator revision every time.
const sqliteContracts = new WeakMap<Database, { catalogIdentity: number; trusted: boolean }>();

export function readModelHistorySignatureTask(
	sqlite: Database,
	input: { narratorId: string },
	signal: AbortSignal,
): ModelHistorySignature {
	signal.throwIfAborted();
	return readSqliteModelHistorySignature(sqlite, input.narratorId);
}

/** A tiny, persisted signature on EVERY hit; never use a process-local epoch or WS version. */
export function readSqliteModelHistorySignature(
	sqlite: Database,
	narratorId: string,
): ModelHistorySignature {
	try {
		const row = sqlite
			.query<{ revision: number; catalogIdentity: number }, [string]>(`
			SELECT n.model_history_revision AS revision,
			 (SELECT schema_version FROM pragma_schema_version) AS "catalogIdentity"
			 FROM narrators n WHERE n.id = ? LIMIT 1`)
			.get(narratorId);
		if (!row) return { revision: "-1", trusted: false };
		let contract = sqliteContracts.get(sqlite);
		if (!contract || contract.catalogIdentity !== row.catalogIdentity) {
			const qualification = sqlite
				.query<{ contract: string | null; triggers: number }, []>(`
				SELECT
				 (SELECT installed_version FROM model_history_revision_contracts WHERE id = 'model-history') AS contract,
				 (SELECT count(*) FROM sqlite_schema WHERE type = 'trigger' AND (${sqliteTriggerPredicate})) AS triggers`)
				.get();
			contract = {
				catalogIdentity: row.catalogIdentity,
				trusted:
					qualification?.contract === MODEL_HISTORY_REVISION_CONTRACT &&
					qualification.triggers === MODEL_HISTORY_SQLITE_TRIGGERS.length,
			};
			sqliteContracts.set(sqlite, contract);
		}
		return {
			revision: String(row.revision),
			catalogIdentity: String(row.catalogIdentity),
			trusted: contract.trusted,
		};
	} catch (error) {
		// An old schema is still readable, but cannot ever admit cached source rows.
		if (!/no such (column|table)/.test(String(error))) throw error;
		return { revision: "unversioned", trusted: false };
	}
}

export async function readPostgresModelHistorySignature(
	sql: Pick<SQL, "unsafe">,
	narratorId: string,
	options: { signal?: AbortSignal; deadline?: number } = {},
): Promise<ModelHistorySignature> {
	// Only a source probe's explicit deadline is bounded here, never the complete hydration.
	const deadline = options.deadline ?? Infinity;
	options.signal?.throwIfAborted();
	if (Date.now() >= deadline) throw new ModelHistoryTimeoutError();
	try {
		const pending = sql.unsafe(
			`SELECT n.model_history_revision AS revision,
			(SELECT string_agg(oid::text || ':' || xmin::text || ':' || tgenabled::text, ',' ORDER BY tgname)
			 FROM pg_trigger WHERE NOT tgisinternal AND (${pgTriggerPredicate})) AS "catalogIdentity",
			(SELECT installed_version FROM model_history_revision_contracts WHERE id = 'model-history') AS contract,
			(SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O', 'A') AND (${pgTriggerPredicate})) AS triggers
			FROM narrators n WHERE n.id = $1 LIMIT 1`,
			[narratorId],
		);
		let abort: () => void = () => {};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stopped = new Promise<never>((_, reject) => {
			abort = () => {
				pending.cancel();
				reject(
					options.signal?.reason ??
						new DOMException("Model history preparation cancelled", "AbortError"),
				);
			};
			if (Number.isFinite(deadline))
				timer = setTimeout(
					() => {
						pending.cancel();
						reject(new ModelHistoryTimeoutError());
					},
					Math.max(1, deadline - Date.now()),
				);
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
		});
		let rows: Awaited<typeof pending>;
		try {
			rows = await Promise.race([pending, stopped]);
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
		}
		options.signal?.throwIfAborted();
		if (Date.now() >= deadline) throw new ModelHistoryTimeoutError();
		const row = rows[0];
		return {
			revision: String(row?.revision ?? -1),
			catalogIdentity: String(row?.catalogIdentity ?? "missing"),
			trusted:
				row?.contract === MODEL_HISTORY_REVISION_CONTRACT &&
				Number(row.triggers) === MODEL_HISTORY_PG_TRIGGERS.length,
		};
	} catch (error) {
		options.signal?.throwIfAborted();
		if (Date.now() >= deadline || error instanceof ModelHistoryTimeoutError)
			throw new ModelHistoryTimeoutError();
		if (error instanceof Error && error.message.startsWith("Model history preparation"))
			throw error;
		if (!["42703", "42P01"].includes(String((error as { code?: string }).code)))
			throw new Error("Model history PostgreSQL signature failed");
		return { revision: "unversioned", trusted: false };
	}
}
