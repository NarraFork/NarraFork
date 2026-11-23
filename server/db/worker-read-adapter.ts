/** Drizzle-private adaptation is confined to this module; never prepares on a live connection. */
import type { Database } from "bun:sqlite";
import * as drizzle from "drizzle-orm";
import { PgDatabase, PgDialect, PgSelectBase } from "drizzle-orm/pg-core";
import { PgRelationalQuery } from "drizzle-orm/pg-core/query-builders/query";
import { SQLiteSelectBase } from "drizzle-orm/sqlite-core";
import { SQLiteRelationalQuery } from "drizzle-orm/sqlite-core/query-builders/query";
import { DbReadError } from "../lib/db-worker/errors";

interface Session {
	client?: Database;
}
interface SelectInternals {
	config: { fields: Record<string, unknown> };
	joinsNotNullableMap: Record<string, boolean>;
	session: Session;
}
const { mapResultRow, orderSelectedFields } = drizzle as unknown as {
	orderSelectedFields(fields: Record<string, unknown>): unknown[];
	mapResultRow(fields: unknown[], row: unknown[], joins: Record<string, boolean>): unknown;
};
export function isPostgresQuery(query: unknown): boolean {
	return drizzle.is(query, PgSelectBase) || drizzle.is(query, PgRelationalQuery);
}
export interface ReadAdapter {
	client?: Database;
	compile(): { sql: string; params: unknown[] };
	map(rows: unknown[][]): unknown;
}
export function adaptReadQuery(query: unknown): ReadAdapter | undefined {
	if (drizzle.is(query, SQLiteSelectBase)) {
		const internals = query as unknown as SelectInternals;
		let fields: unknown[] | undefined;
		return {
			client: internals.session.client,
			compile: () => query.toSQL(),
			map: (rows) => {
				fields ??= orderSelectedFields(internals.config.fields);
				const selectedFields = fields;
				return rows.map((row) => mapResultRow(selectedFields, row, internals.joinsNotNullableMap));
			},
		};
	}
	if (!drizzle.is(query, SQLiteRelationalQuery)) return;
	const relational = query as unknown as { session: Session; _prepare(): unknown };
	type PreparedRead = {
		compiled: { sql: string; params: unknown[] };
		mapper: (rows: unknown[][]) => unknown;
	};
	let prepared: PreparedRead | undefined;
	const prepare = (): PreparedRead => {
		if (prepared) return prepared;
		// One isolated preparation captures matching SQL, binds and the native mapper. The real
		// session is never modified or asked to prepare SQL; each adapter owns its own capture.
		let compiled: PreparedRead["compiled"] | undefined;
		let mapper: PreparedRead["mapper"] | undefined;
		const capture = (...args: unknown[]) => {
			compiled = args[0] as typeof compiled;
			mapper = args[4] as typeof mapper;
			return {};
		};
		const isolated = Object.assign(Object.create(Object.getPrototypeOf(query)), query, {
			session: { prepareQuery: capture, prepareOneTimeQuery: capture },
		});
		isolated._prepare();
		if (
			!compiled ||
			typeof compiled.sql !== "string" ||
			!Array.isArray(compiled.params) ||
			typeof mapper !== "function"
		)
			throw new DbReadError("DB_READ_UNSUPPORTED", "Unsupported relational query mapper");
		prepared = { compiled, mapper };
		return prepared;
	};
	return {
		client: relational.session.client,
		compile: () => prepare().compiled,
		map: (rows) => prepare().mapper(rows),
	};
}

export interface SqlReadSource {
	$client?: unknown;
	all?(query: drizzle.SQLWrapper): unknown;
	execute?(query: drizzle.SQLWrapper): unknown;
}
export function isPostgresSource(source: SqlReadSource): boolean {
	return (
		drizzle.is(source, PgDatabase) ||
		drizzle.is((source as unknown as { dialect?: unknown }).dialect, PgDialect)
	);
}
export function getSourceClient(source: Database | SqlReadSource): Database | undefined {
	if ("filename" in source && typeof source.filename === "string") return source as Database;
	const client = (source as SqlReadSource).$client;
	return client && typeof client === "object" && "filename" in client
		? (client as Database)
		: undefined;
}
export function compileDbAll(
	source: SqlReadSource,
	query: drizzle.SQLWrapper,
): { sql: string; params: unknown[] } {
	const dialect = (
		source as unknown as {
			dialect: { sqlToQuery(sql: drizzle.SQL): { sql: string; params: unknown[] } };
		}
	).dialect;
	if (!dialect?.sqlToQuery) throw new DbReadError("DB_READ_UNSUPPORTED", "Unsupported SQL wrapper");
	return dialect.sqlToQuery(query.getSQL());
}
