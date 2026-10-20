import { SQLiteBunSession } from "drizzle-orm/bun-sqlite/session";
import {
	type SqlExecutionDiagnostics,
	sqlExecutionDiagnostics,
} from "../lib/sql-execution-diagnostics";

const installed = Symbol.for("narrafork.sqlite-session-diagnostics.v1");
const methods = ["all", "get", "values", "run"] as const;

/** Only fixed structural categories escape preparation; SQL/binds are never retained here. */
function classify(sql: string): string {
	const prefix = sql.slice(0, 32).trimStart().toLowerCase();
	const operation =
		["select", "insert", "update", "delete", "savepoint", "release", "rollback"].find((name) =>
			prefix.startsWith(`${name} `),
		) ?? "other";
	// Bounded inspection at prepare time only. Emit an allowlisted table, never a captured name.
	const table = /\b(?:from|into|update)\s+"?([a-z_]+)"?/i.exec(sql.slice(0, 65536))?.[1];
	const allowed = [
		"narrators",
		"narrator_messages",
		"narrator_message_refs",
		"narrator_tool_calls",
		"background_tasks",
		"narrator_questions",
		"chapters",
		"projects",
	];
	return `${operation}:${allowed.find((name) => name === table) ?? "other"}`;
}

/** Local instance hook, never a prototype/native connection patch. PG is deliberately untouched. */
export function installSqliteExecutionDiagnostics<T>(
	database: T,
	diagnostics: SqlExecutionDiagnostics = sqlExecutionDiagnostics,
): T {
	const session = (database as { session?: unknown }).session;
	if (!(session instanceof SQLiteBunSession)) return database;
	const existing = Reflect.get(session, installed) as
		| { diagnostics: SqlExecutionDiagnostics }
		| undefined;
	if (existing) {
		existing.diagnostics = diagnostics;
		return database;
	}
	const state = { diagnostics };
	const client = Reflect.get(session, "client") as { readonly inTransaction?: boolean } | undefined;
	const prepare = session.prepareQuery;
	const prepareWithDiagnostics = function (
		this: typeof session,
		...args: Parameters<typeof prepare>
	) {
		const prepared = prepare.apply(this, args);
		const operation = classify(args[0].sql);
		// all() calls values() internally; count only the outer synchronous execution.
		let depth = 0;
		for (const method of methods) {
			const original = prepared[method];
			const execute = function (this: typeof prepared, ...values: Parameters<typeof original>) {
				if (depth) return original.apply(this, values);
				depth++;
				try {
					const inTransaction = client?.inTransaction;
					return state.diagnostics.execute(
						operation,
						method,
						() => original.apply(this, values),
						inTransaction === true
							? "transaction"
							: inTransaction === false
								? "independent"
								: "unknown",
					);
				} finally {
					depth--;
				}
			};
			Object.defineProperty(prepared, method, {
				value: execute,
				configurable: true,
				writable: true,
			});
		}
		return prepared;
	};
	// Preserve the public generic signature: the exact original prepared object is returned.
	Object.defineProperty(session, "prepareQuery", {
		value: prepareWithDiagnostics,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(session, installed, { value: state });
	return database;
}
