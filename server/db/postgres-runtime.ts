/**
 * Production PostgreSQL wiring: configuration, startup, and shutdown.
 *
 * Until this module existed, everything PostgreSQL in this repository was reachable only
 * through test injection — the client factory, the migration dispatch, the FTS catalog and
 * every store adapter all waited for a caller to hand them a handle. This is the caller.
 *
 * THE CONFIGURATION CONTRACT (fail closed in both directions)
 * -----------------------------------------------------------
 * The backend is chosen by an explicit selector and nothing else:
 *
 *   - `NF_DATABASE_BACKEND` (environment) or `database.backend` (settings file):
 *     exactly "sqlite" (the default) or "postgres". An unknown value is a startup ERROR,
 *     never a quiet fallback — a deployment that asked for something we do not recognise
 *     must not come up on a different database than the operator believes.
 *   - Selecting "postgres" additionally REQUIRES a connection URL from the environment
 *     (`NF_DATABASE_URL`, then `DATABASE_URL`). The URL is deliberately NOT read from
 *     settings.json: the settings object is served by `GET /api/settings` to any
 *     authenticated user, and a connection string carries credentials. Writing
 *     `database.postgres.url` into settings.json is therefore a configuration error,
 *     not a silently ignored key.
 *   - `DATABASE_URL` alone NEVER selects PostgreSQL. It is ambient in plenty of developer
 *     shells for unrelated projects (pinned by `__tests__/sqlite-backend-baseline.test.ts`);
 *     only an explicit backend selection makes it meaningful.
 *   - The read/write store selectors (`NF_READ_BACKEND` / `NF_WRITE_BACKEND`) must NOT be
 *     set when the master backend is PostgreSQL: those modules resolve at import time with
 *     no store to inject and would throw there. One process, one database, one selector.
 *
 * Secrets never enter logs or error messages: every error that could carry driver text is
 * scrubbed of the full URL and its password before it crosses a stage boundary.
 *
 * STARTUP IS FAIL-FAST, STAGED
 * ----------------------------
 * {@link startPostgresRuntime} runs connection probe → disk `drizzle-postgres` migration
 * dispatch → `ensurePgFts` → bounded existing-row FTS backfill/readiness, in that order, and a failure in any stage aborts startup with a
 * {@link PostgresStartupError} naming the stage. There is no retry-to-success and no
 * fallback to SQLite: a process that cannot reach the database it was configured for does
 * not boot. The migration dispatch reuses `runMigrationsForDriver` from `run-migrations.ts`
 * (filesystem `./drizzle-postgres`, validated journal, embedded fallback for the compiled
 * binary) with a real `drizzle-orm/bun-sql` migrator as the runner — not the psql relay the
 * test baseline uses.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It does not touch the SQLite lifecycle (WAL, clean-shutdown marker, `.recover`, upkeep
 * timers) — those concepts do not exist here and must not be faked. It does not inject the
 * business stores either: that is the single composition seam in
 * `server/services/postgres-composition.ts`, invoked from `main.ts` once this runtime
 * exists. The instance lock is acquired by the caller (`server/db/index.ts`) BEFORE this
 * module runs, unchanged from SQLite, because it guards local resources (worktrees, ports,
 * terminals), not the database file.
 */

import { migrate } from "drizzle-orm/bun-sql/migrator";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { type CapabilityResult, notApplicable } from "./backend/capability";
import type { DatabaseMaintenancePort, ReusableSpaceReport } from "./backend/maintenance-port";
import type { PgExecutor, PgFtsDriftReport } from "./pg-fts";
import { ensurePgFts, probePgFtsDrift, repairPgFts } from "./pg-fts";
import { createPostgresClient, type PostgresClient } from "./postgres-client";
import { runMigrationsForDriver } from "./run-migrations";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Environment variable that explicitly selects the database backend. */
export const DATABASE_BACKEND_ENV = "NF_DATABASE_BACKEND";
/** Primary environment variable carrying the PostgreSQL connection URL. */
export const DATABASE_URL_ENV = "NF_DATABASE_URL";
/** Ambient fallback URL variable. Never sufficient on its own to select PostgreSQL. */
export const AMBIENT_DATABASE_URL_ENV = "DATABASE_URL";

export type ConfiguredDatabaseBackend = "sqlite" | "postgres";

export interface PostgresPoolSettings {
	readonly max?: number;
	readonly idleTimeout?: number;
	readonly maxLifetime?: number;
	readonly connectTimeout?: number;
}

export type ResolvedDatabaseConfig =
	| {
			readonly backend: "sqlite";
			/** A URL was present in the environment but the backend stayed SQLite. */
			readonly ignoredPostgresUrl: boolean;
	  }
	| {
			readonly backend: "postgres";
			readonly url: string;
			readonly urlSource: typeof DATABASE_URL_ENV | typeof AMBIENT_DATABASE_URL_ENV;
			readonly pool: PostgresPoolSettings;
	  };

/**
 * Configuration values are rejected, never corrected. Distinct from {@link PostgresStartupError}:
 * a config error means the process never tried to reach a database.
 */
export class DatabaseConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DatabaseConfigError";
	}
}

/** The settings-file `database` section, parsed defensively (the file is user-edited JSON). */
interface DatabaseSettingsSection {
	backend?: unknown;
	postgres?: unknown;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPoolSettings(raw: unknown): PostgresPoolSettings {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new DatabaseConfigError(
			'settings "database.postgres" must be an object with numeric pool options',
		);
	}
	const section = raw as Record<string, unknown>;
	if (readString(section.url)) {
		throw new DatabaseConfigError(
			'settings.json "database.postgres.url" is refused: the settings object is served by ' +
				"GET /api/settings to any authenticated user, and a connection URL carries " +
				`credentials. Set ${DATABASE_URL_ENV} (or ${AMBIENT_DATABASE_URL_ENV}) in the ` +
				"environment instead.",
		);
	}
	const pool: Record<string, number> = {};
	for (const key of ["max", "idleTimeout", "maxLifetime", "connectTimeout"] as const) {
		const value = section[key];
		if (value === undefined || value === null) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 10_000) {
			throw new DatabaseConfigError(
				`settings "database.postgres.${key}" must be a positive number (got a ${
					value === null ? "null" : typeof value
				})`,
			);
		}
		pool[key] = value;
	}
	return pool;
}

/**
 * Resolve the database backend from the explicit configuration channels.
 *
 * Pure with respect to its two parameters — both default to the process environment and the
 * loaded settings singleton, and tests pass their own. Every outcome other than a clean
 * sqlite default or a fully specified postgres selection throws {@link DatabaseConfigError}.
 */
export function resolveDatabaseBackendConfig(
	env: Record<string, string | undefined> = process.env,
	section?: unknown,
): ResolvedDatabaseConfig {
	const settingsSection = (section ?? settings.database) as DatabaseSettingsSection | undefined;
	const backendRaw =
		readString(env[DATABASE_BACKEND_ENV]) ?? readString(settingsSection?.backend) ?? "sqlite";
	const backendNormalized = backendRaw.toLowerCase();

	if (backendNormalized !== "sqlite" && backendNormalized !== "postgres") {
		throw new DatabaseConfigError(
			`Unknown database backend "${backendRaw.slice(0, 64)}": expected exactly "sqlite" or ` +
				`"postgres" (set via ${DATABASE_BACKEND_ENV} or settings "database.backend"). ` +
				"Refusing to boot on an unrecognized selection.",
		);
	}

	if (backendNormalized === "sqlite") {
		return {
			backend: "sqlite",
			ignoredPostgresUrl: Boolean(
				readString(env[DATABASE_URL_ENV]) ?? readString(env[AMBIENT_DATABASE_URL_ENV]),
			),
		};
	}

	// PostgreSQL is selected explicitly. The read/write store selectors resolve at import time
	// with no store to inject, so in this mode they must be absent — the master selector above
	// is the one switch, and the composition seam injects every store from the same runtime.
	for (const selectorEnv of ["NF_READ_BACKEND", "NF_WRITE_BACKEND"] as const) {
		if (readString(env[selectorEnv])) {
			throw new DatabaseConfigError(
				`${selectorEnv} must not be set when ${DATABASE_BACKEND_ENV}=postgres: backend ` +
					"selection is owned by the master switch and the composition seam injects every " +
					`store from one runtime. Unset ${selectorEnv}.`,
			);
		}
	}

	const urlFromPrimary = readString(env[DATABASE_URL_ENV]);
	const urlFromAmbient = readString(env[AMBIENT_DATABASE_URL_ENV]);
	const url = urlFromPrimary ?? urlFromAmbient;
	if (!url) {
		// Fail closed: an explicit PostgreSQL selection without a connection URL is a startup
		// error, never a silent SQLite fallback.
		throw new DatabaseConfigError(
			`PostgreSQL backend selected but no connection URL was provided. Set ` +
				`${DATABASE_URL_ENV} (preferred) or ${AMBIENT_DATABASE_URL_ENV}.`,
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new DatabaseConfigError(
			"The PostgreSQL connection URL is not a valid URL (its value is deliberately not " +
				"echoed here — it carries credentials).",
		);
	}
	if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
		throw new DatabaseConfigError(
			`The PostgreSQL connection URL must use the postgres:// or postgresql:// scheme, not ` +
				`"${parsed.protocol.slice(0, 32)}".`,
		);
	}

	return {
		backend: "postgres",
		url,
		urlSource: urlFromPrimary ? DATABASE_URL_ENV : AMBIENT_DATABASE_URL_ENV,
		pool: readPoolSettings(settingsSection?.postgres),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

/** The startup stage a failure belongs to. Log/alert on this, not on driver text. */
export type PostgresStartupStage = "connection" | "migration" | "fts";

export class PostgresStartupError extends Error {
	readonly stage: PostgresStartupStage;
	constructor(stage: PostgresStartupStage, message: string, cause?: unknown) {
		super(`PostgreSQL startup failed at stage "${stage}": ${message}`, { cause });
		this.name = "PostgresStartupError";
		this.stage = stage;
	}
}

/** Thrown by the runtime executor once shutdown has begun. */
export class PostgresRuntimeClosedError extends Error {
	constructor() {
		super("PostgreSQL runtime is shutting down; new operations are no longer accepted");
		this.name = "PostgresRuntimeClosedError";
	}
}

/** Credentials that must never survive into a log line or an error message. */
function secretsFromUrl(url: string): string[] {
	const secrets = [url];
	try {
		const parsed = new URL(url);
		const password = decodeURIComponent(parsed.password);
		if (password) secrets.push(password);
		const username = decodeURIComponent(parsed.username);
		if (username) secrets.push(username);
	} catch {
		// Unparsable URLs were already rejected during config resolution; scrub the whole value.
	}
	return secrets;
}

/** Scrub credentials and bound the length of any driver-produced message. */
function sanitizeMessage(raw: string, secrets: readonly string[]): string {
	let out = raw;
	for (const secret of secrets) {
		if (secret) out = out.split(secret).join("[redacted]");
	}
	const collapsed = out.replace(/\s+/g, " ").trim();
	return collapsed.length > 500 ? `${collapsed.slice(0, 500)}…` : collapsed;
}

function errorMessage(error: unknown, secrets: readonly string[]): string {
	if (error instanceof Error) return sanitizeMessage(error.message, secrets);
	return sanitizeMessage(String(error), secrets);
}

export interface PostgresRuntime {
	readonly backend: "postgres";
	/** The live client. Owned by this runtime; {@link close} closes it. */
	readonly client: PostgresClient;
	/**
	 * The executor stores and FTS probes should use: identical to `client.sql.unsafe` while
	 * running, and rejecting with {@link PostgresRuntimeClosedError} the moment shutdown begins
	 * — "stop accepting new PG operations" is enforced here, not by each caller.
	 */
	readonly executor: PgExecutor;
	/** Provenance of the applied migrations, for the startup log and health reporting. */
	readonly migration: { readonly folder: string };
	/** Catalog + content drift probe. Startup/maintenance-window work, never a request path. */
	probeFtsDrift(): Promise<PgFtsDriftReport>;
	/** Read the drizzle migration ledger (bounded), e.g. to report the applied version. */
	readMigrationState(): Promise<
		ReadonlyArray<{ id: number; hash: string; created_at: number | string }>
	>;
	/** True once shutdown has begun. */
	readonly closed: boolean;
	close(): Promise<void>;
}

/** Test seam: every stage's IO is injectable so failure classification needs no container. */
export interface PostgresRuntimeDeps {
	createClient?: (options: { url: string; pool: PostgresPoolSettings }) => PostgresClient;
	connectProbe?: (client: PostgresClient) => Promise<void>;
	runMigrations?: (run: (folder: string) => Promise<void>) => Promise<void>;
	migrateFolder?: (client: PostgresClient, folder: string) => Promise<void>;
	ensureFts?: (executor: PgExecutor) => Promise<void>;
	/** Test seam for the bounded existing-data repair after catalog installation. */
	repairFts?: (executor: PgExecutor) => Promise<unknown>;
}

type PostgresConfig = Extract<ResolvedDatabaseConfig, { backend: "postgres" }>;

export type { PostgresConfig as ResolvedPostgresConfig };

async function startPostgresRuntimeWithDeps(
	config: PostgresConfig,
	deps: PostgresRuntimeDeps,
): Promise<PostgresRuntime> {
	const secrets = secretsFromUrl(config.url);

	let client: PostgresClient;
	try {
		client = (
			deps.createClient ??
			((options) =>
				createPostgresClient({
					driver: "bun-sql",
					url: options.url,
					max: options.pool.max,
					idleTimeout: options.pool.idleTimeout,
					maxLifetime: options.pool.maxLifetime,
					connectTimeout: options.pool.connectTimeout,
				}))
		)({ url: config.url, pool: config.pool });
	} catch (error) {
		throw new PostgresStartupError("connection", errorMessage(error, secrets), error);
	}

	// The executor is constructed before the probe so a failure at ANY later point still
	// closes through the same gate.
	let closed = false;
	const executor: PgExecutor = {
		unsafe: (query, params) => {
			if (closed) return Promise.reject(new PostgresRuntimeClosedError());
			return client.sql.unsafe(query, params) as Promise<Record<string, unknown>[]>;
		},
	};
	const close = async () => {
		if (closed) return;
		closed = true;
		await client.close();
	};

	try {
		await (deps.connectProbe ?? ((c) => c.sql.unsafe("SELECT 1") as Promise<unknown>))(client);
	} catch (error) {
		await close().catch(() => {});
		throw new PostgresStartupError("connection", errorMessage(error, secrets), error);
	}

	let migrationFolder = "";
	try {
		const runMigrations =
			deps.runMigrations ??
			((run: (folder: string) => Promise<void>) =>
				runMigrationsForDriver({ driver: "postgresql", run }));
		await runMigrations(async (folder) => {
			migrationFolder = folder;
			await (deps.migrateFolder ?? ((c, f) => migrate(c.db, { migrationsFolder: f })))(
				client,
				folder,
			);
		});
	} catch (error) {
		await close().catch(() => {});
		throw new PostgresStartupError("migration", errorMessage(error, secrets), error);
	}

	try {
		await (deps.ensureFts ?? ensurePgFts)(executor);
		// Production startup also repairs rows written before a trigger/catalog install. The
		// repair is bounded per invocation and restart-safe; a later startup resumes any remaining
		// batches instead of holding one unbounded transaction or silently serving stale search.
		if (deps.ensureFts === undefined) {
			const repair = await (
				deps.repairFts ?? ((e) => repairPgFts(e, { batchSize: 500, timeBudgetMs: 30_000 }))
			)(executor);
			if (
				repair &&
				typeof repair === "object" &&
				"complete" in repair &&
				(repair as { complete?: unknown }).complete === false
			) {
				throw new Error(
					"PostgreSQL FTS backfill is incomplete; restart after the bounded repair window to resume",
				);
			}
		}
	} catch (error) {
		await close().catch(() => {});
		throw new PostgresStartupError("fts", errorMessage(error, secrets), error);
	}

	return {
		backend: "postgres",
		client,
		executor,
		migration: { folder: migrationFolder },
		probeFtsDrift: () => probePgFtsDrift(executor),
		async readMigrationState() {
			// Bounded read of the drizzle ledger; the migrator created this table, so a
			// missing table here means something outside the dispatch wrote the schema.
			const rows = await executor.unsafe(
				`SELECT id, hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY id LIMIT 1000`,
			);
			return rows.map((row) => ({
				id: Number(row.id),
				hash: String(row.hash),
				created_at: row.created_at as number | string,
			}));
		},
		get closed() {
			return closed;
		},
		close,
	};
}

/**
 * Create the production PostgreSQL runtime: connect, migrate, install the search catalog.
 * Any failure rejects with {@link PostgresStartupError} — the caller (module top-level of
 * `server/db/index.ts`) lets that abort startup; there is no SQLite fallback.
 */
export function startPostgresRuntime(
	config: PostgresConfig,
	deps: PostgresRuntimeDeps = {},
): Promise<PostgresRuntime> {
	return startPostgresRuntimeWithDeps(config, deps);
}

/**
 * The `db:migrate` entry point's PostgreSQL branch: apply migrations and the search catalog,
 * then close. Shares the stage wrappers with server startup so a failure reads identically
 * from either path.
 */
export async function runPostgresMigrationsOnce(
	config: PostgresConfig,
	deps: PostgresRuntimeDeps = {},
): Promise<{ folder: string }> {
	const runtime = await startPostgresRuntimeWithDeps(config, deps);
	try {
		return { folder: runtime.migration.folder };
	} finally {
		await runtime.close();
	}
}

/** Log-safe view of a resolved configuration: never contains the URL or credentials. */
export function describeDatabaseConfig(config: ResolvedDatabaseConfig): Record<string, unknown> {
	if (config.backend === "sqlite") return { backend: "sqlite" };
	return {
		backend: "postgres",
		urlSource: config.urlSource,
		pool: { ...config.pool },
	};
}

/** Health-endpoint view of the active backend. */
export function databaseBackendDescriptor(backend: ConfiguredDatabaseBackend): {
	backend: ConfiguredDatabaseBackend;
} {
	return { backend };
}

/**
 * The PG branch's engine-level maintenance port: every concept is `notApplicable`.
 *
 * This is how "no SQLite connection" stays honest in PG mode — WAL checkpoints, planner
 * statistics, freelist measurement and the VACUUM window are SQLite file maintenance, and
 * faking them (a zero, a no-op "ok") would report confidence about work that never ran.
 * `database-cleanup-service` already degrades gracefully on `notApplicable` (501 for the
 * admin window, quiet skip for best-effort steps).
 */
export function createPostgresMaintenanceRefusals(): DatabaseMaintenancePort {
	return {
		backendId: "postgres",
		checkpoint(): CapabilityResult<{ ok: boolean }> {
			return notApplicable("PostgreSQL has no WAL checkpoint for NarraFork to run");
		},
		refreshPlannerStatistics(): CapabilityResult<{ ok: boolean }> {
			return notApplicable("PostgreSQL maintains planner statistics itself (autovacuum/analyze)");
		},
		measureReusableSpace(): CapabilityResult<ReusableSpaceReport> {
			return notApplicable("a server-managed engine exposes no page freelist to measure");
		},
		reclaimSpace(): CapabilityResult<void> {
			return notApplicable(
				"space reclamation on PostgreSQL is operator tooling (server-side vacuum/pg_repack), not a NarraFork window",
			);
		},
		classifyFailure(error: unknown) {
			return { kind: "error", message: error instanceof Error ? error.message : String(error) };
		},
	};
}

/** Log line for a successful startup, emitted by the caller. */
export function logPostgresStartup(runtime: PostgresRuntime, config: PostgresConfig): void {
	logger.info("PostgreSQL database backend active", {
		...describeDatabaseConfig(config),
		migrationsFolder: runtime.migration.folder,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Process-wide pinning (Bun --hot reload safety)
// ─────────────────────────────────────────────────────────────────────────────

// Bun `--hot` re-evaluates modules inside a live process. Without pinning, the second
// evaluation of `server/db/index.ts` would open a SECOND client (leaking the first pool)
// and re-run the migration dispatch. The pin survives re-evaluation; close clears it.
const HOT_RUNTIME_KEY = Symbol.for("narrafork.postgresRuntime");

interface PinnedRuntime {
	runtime: PostgresRuntime;
}

function pinnedRuntime(): PinnedRuntime | undefined {
	// biome-ignore lint/suspicious/noExplicitAny: global symbol storage survives hot reload
	return (globalThis as any)[HOT_RUNTIME_KEY];
}

/**
 * Start the runtime, or reuse the one a hot-reload predecessor already started.
 * `isHotReload: true` means nothing was done — no second client, no second migration pass.
 */
export async function getOrStartPostgresRuntime(
	config: PostgresConfig,
	deps: PostgresRuntimeDeps = {},
): Promise<{ runtime: PostgresRuntime; isHotReload: boolean }> {
	const existing = pinnedRuntime();
	if (existing) return { runtime: existing.runtime, isHotReload: true };
	const runtime = await startPostgresRuntime(config, deps);
	// biome-ignore lint/suspicious/noExplicitAny: global symbol storage survives hot reload
	(globalThis as any)[HOT_RUNTIME_KEY] = { runtime } satisfies PinnedRuntime;
	return { runtime, isHotReload: false };
}

/**
 * Close the pinned runtime exactly once. Safe to call when nothing was started (SQLite
 * backend) and safe to call twice — the pin is cleared before closing so a concurrent caller
 * cannot double-close through a stale reference.
 */
export async function closePostgresRuntime(): Promise<void> {
	const existing = pinnedRuntime();
	if (!existing) return;
	// biome-ignore lint/suspicious/noExplicitAny: global symbol storage survives hot reload
	(globalThis as any)[HOT_RUNTIME_KEY] = undefined;
	await existing.runtime.close();
}
