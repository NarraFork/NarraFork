/**
 * Standalone repair script: rebuild the plugin's canonical DB authority grants
 * from the compatibility mirror (permissions.json) and retire legacy
 * package-hash-keyed authorities.
 *
 * WHY: a plugin's `integration_authorities` row can exist (active) while its
 * `integration_capability_grants` table is EMPTY — a partial migration or a
 * crashed write. The runtime short-circuits on the existing authority and
 * returns an empty grant set, so every UI/tool/event call fails with
 * "Plugin UI capability is not granted for this scope" even though
 * permissions.json still holds the full grants.
 *
 * This script is intentionally dependency-light (bun:sqlite + one pure
 * function) so it can be run by any agent/CLI without booting the server.
 *
 * USAGE (run with the NarraFork app CLOSED):
 *   bun run server/scripts/repair-plugin-authority.ts [pluginId]
 *
 *   Defaults to com.whisent.narrator-team when no pluginId is given.
 *   --dry-run prints what would change without writing.
 *   --force-unlock takes the DB lock over a dead lock file (use only when
 *   you are certain no NarraFork instance is running).
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { adaptPluginCapability } from "../lib/integrations/capability-adapters";

const DEFAULT_PLUGIN_ID = "com.whisent.narrator-team";
const AUTHORITY_PREFIX = "plugin-installation:";
const GRANT_ROW_PREFIX = "plugin-grant:";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("base64url");
}

function pluginInstallationAuthorityId(pluginId: string, installationId: string): string {
	return `${AUTHORITY_PREFIX}${sha256(`${pluginId}\0${installationId}`)}`;
}

function grantRowPrefix(authorityId: string): string {
	return `${GRANT_ROW_PREFIX}${sha256(authorityId).slice(0, 16)}:`;
}

function pluginGrantRowId(authorityId: string, revision: number, grantId: string): string {
	return `${grantRowPrefix(authorityId)}${revision}:${grantId}`;
}

function isStableInstallationId(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function scopeKey(scope: { type: string; id?: string }): string {
	return scope.type === "global" ? "global" : `${scope.type}:${scope.id}`;
}

function hashHexOf(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

interface ParsedArgs {
	pluginId: string;
	dryRun: boolean;
	forceUnlock: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
	const args: ParsedArgs = { pluginId: DEFAULT_PLUGIN_ID, dryRun: false, forceUnlock: false };
	for (const arg of argv) {
		if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "--force-unlock") args.forceUnlock = true;
		else if (!arg.startsWith("-")) args.pluginId = arg;
	}
	return args;
}

/** Detect a live NarraFork instance from the lock file so we never write a hot DB. */
function assertNoLiveInstance(home: string, forceUnlock: boolean): void {
	const lockPath = join(home, "narrafork.lock");
	if (!existsSync(lockPath)) return;
	try {
		const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
		if (!lock.pid) return;
		const alive = Bun.spawnSync(["tasklist", "/FI", `PID eq ${lock.pid}`]).stdout.toString();
		const running = /narrafork|bun/i.test(alive) && alive.includes(String(lock.pid));
		if (running) {
			if (forceUnlock) {
				console.warn(`[repair] WARN: lock pid ${lock.pid} appears alive; --force-unlock taken (proceed at your own risk)`);
				return;
			}
			console.error(
				`[repair] ABORT: NarraFork (pid ${lock.pid}) appears to be running and holds the DB lock. ` +
					"Close the NarraFork app first, then re-run. (Use --force-unlock only if you are certain no instance is running.)",
			);
			process.exit(1);
		}
	} catch {
		// Lock unreadable; proceed (best effort).
	}
}

function readJson(path: string): Record<string, unknown> {
	if (!existsSync(path)) throw new Error(`Missing file: ${path}`);
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

interface MirrorGrant {
	capability: string;
	scope: { type: string; id?: string };
	constraints?: Record<string, unknown>;
	expiresAt?: string;
	grantId?: string;
	grantedBy?: string;
}

interface Plan {
	pluginId: string;
	installationId?: string;
	stateHash?: string;
	authorityId?: string;
	authorityExists: boolean;
	authorityState?: string;
	authorityRevision: number;
	existingUnrevokedGrants: number;
	existingCapabilities: string[];
	grantsToWrite: MirrorGrant[];
	legacyToRevoke: Array<{ authorityId: string; installationId: string }>;
}

function buildPlan(home: string, pluginId: string): Plan {
	const state = readJson(join(home, "plugins", "state.json")) as {
		plugins?: Record<string, { installationId?: string | null; current?: { hash?: string }; grants?: { count?: number; capabilities?: string[] } }>;
	};
	const perms = readJson(join(home, "plugins", "permissions.json")) as {
		plugins?: Record<string, Record<string, { grants?: MirrorGrant[] }>>;
	};
	const pluginState = state.plugins?.[pluginId];
	if (!pluginState) throw new Error(`Plugin ${pluginId} has no state record`);
	const installationId = pluginState.installationId ?? undefined;
	const stateHash = pluginState.current?.hash;
	const summaryCaps = pluginState.grants?.capabilities ?? [];

	// Mirror grants for the canonical installation id (the authoritative copy of
	// scope/constraints/expiry). Falls back to the state summary (global scope).
	let mirrorGrants: MirrorGrant[] = [];
	if (installationId) {
		mirrorGrants = perms.plugins?.[pluginId]?.[installationId]?.grants ?? [];
	}
	const canonicalCaps = new Set(
		mirrorGrants.length > 0
			? mirrorGrants.map((g) => g.capability)
			: summaryCaps,
	);
	if (mirrorGrants.length === 0) {
		mirrorGrants = [...canonicalCaps].map((capability) => ({
			capability,
			scope: { type: "global" },
		}));
	}
	// Drop capabilities that have no canonical adapter (they were never grantable).
	mirrorGrants = mirrorGrants.filter((g) => adaptPluginCapability(g.capability) !== undefined);
	// De-duplicate by (capability, scopeKey).
	const seen = new Set<string>();
	mirrorGrants = mirrorGrants.filter((g) => {
		const key = `${g.capability}\0${scopeKey(g.scope)}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	const db = new Database(join(home, "narrafork.db"), { readonly: true });
	const authorityRows = db
		.query(
			"SELECT id, state, revision, metadata_json FROM integration_authorities WHERE integration_type='plugin' AND integration_id=? ORDER BY created_at",
		)
		.all(pluginId) as Array<{ id: string; state: string; revision: number; metadata_json: string | null }>;
	db.close();

	let authorityId: string | undefined;
	let authorityExists = false;
	let authorityState: string | undefined;
	let authorityRevision = 0;
	let existingUnrevokedGrants = 0;
	let existingCapabilities: string[] = [];
	if (installationId) {
		authorityId = pluginInstallationAuthorityId(pluginId, installationId);
		const mine = authorityRows.find((r) => r.id === authorityId);
		authorityExists = !!mine;
		authorityState = mine?.state;
		authorityRevision = mine?.revision ?? 0;
	}
	const legacyToRevoke = authorityRows
		.filter((r) => {
			if (r.state !== "active") return false;
			if (r.id === authorityId) return false;
			let metaInstallationId: string | undefined;
			try {
				metaInstallationId = r.metadata_json ? (JSON.parse(r.metadata_json) as { installationId?: string }).installationId : undefined;
			} catch {
				metaInstallationId = undefined;
			}
			return metaInstallationId !== undefined && !isStableInstallationId(metaInstallationId);
		})
		.map((r) => ({ authorityId: r.id, installationId: "" }));

	// Count the canonical authority's current un-revoked grants so the script
	// never rewrites a healthy authority (idempotent / minimal-touch).
	if (authorityId) {
		const grantsDb = new Database(join(home, "narrafork.db"), { readonly: true });
		const rows = grantsDb
			.query(
				"SELECT capability_id, revoked_at FROM integration_capability_grants WHERE authority_id=?",
			)
			.all(authorityId) as Array<{ capability_id: string; revoked_at: string | null }>;
		grantsDb.close();
		const activeRows = rows.filter((r) => !r.revoked_at);
		existingUnrevokedGrants = activeRows.length;
		existingCapabilities = activeRows.map((r) => r.capability_id);
	}

	return {
		pluginId,
		installationId,
		stateHash,
		authorityId,
		authorityExists,
		authorityState,
		authorityRevision,
		existingUnrevokedGrants,
		existingCapabilities,
		grantsToWrite: mirrorGrants,
		legacyToRevoke,
	};
}

function executePlan(home: string, plan: Plan, dryRun: boolean): void {
	if (!plan.installationId || !plan.authorityId) {
		throw new Error("Plugin has no canonical installation id — nothing to repair");
	}
	const installationId = plan.installationId;
	const authorityId = plan.authorityId;
	if (plan.authorityExists && plan.authorityState !== "active") {
		throw new Error(
			`Canonical authority is ${plan.authorityState}, not active. This needs a full authorization reset, not a repair.`,
		);
	}
	const now = new Date().toISOString();
	const nextRevision = plan.authorityRevision + 1;
	const db = new Database(join(home, "narrafork.db"));
	const write = db.transaction(() => {
		// 1. Canonical authority row.
		if (!plan.authorityExists) {
			db.query(
				"INSERT INTO integration_authorities (id, kind, integration_type, integration_id, state, revision, policy_json, metadata_json, expires_at, created_at, updated_at) VALUES (?, 'plugin_installation', 'plugin', ?, 'active', ?, NULL, ?, NULL, ?, ?)",
			).run(
				authorityId,
				plan.pluginId,
				nextRevision,
				JSON.stringify({ installationId }),
				now,
				now,
			);
		} else {
			db.query(
				"UPDATE integration_authorities SET revision=?, updated_at=? WHERE id=? AND revision=?",
			).run(nextRevision, now, authorityId, plan.authorityRevision);
		}
		// 2. Soft-revoke the old grant rows of the canonical authority.
		db.query(
			"UPDATE integration_capability_grants SET revoked_at=?, updated_at=? WHERE authority_id=? AND revoked_at IS NULL",
		).run(now, now, authorityId);
		// 3. Insert the rebuilt grant rows (un-revoked).
		for (const grant of plan.grantsToWrite) {
			const adapted = adaptPluginCapability(grant.capability);
			if (!adapted) continue;
			const grantId = grant.grantId ?? `legacy-${plan.pluginId}-${grant.capability}`.slice(0, 128);
			const grantedBy = grant.grantedBy ?? "legacy-api";
			const constraintsJson = grant.constraints && Object.keys(grant.constraints).length > 0
				? JSON.stringify(grant.constraints)
				: null;
			db.query(
				"INSERT INTO integration_capability_grants (id, authority_id, capability_id, scope_type, scope_id, scope_key, constraints_json, expires_at, revoked_at, created_by_type, created_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)",
			).run(
				pluginGrantRowId(authorityId, nextRevision, grantId),
				authorityId,
				adapted.id,
				grant.scope.type,
				grant.scope.type === "global" ? null : (grant.scope.id ?? null),
				scopeKey(grant.scope),
				constraintsJson,
				grant.expiresAt ?? null,
				grantedBy === "system" ? "system" : "user",
				grantedBy === "system" ? null : grantedBy,
				now,
				now,
			);
		}
		// 4. Retire legacy hash-keyed authorities (soft-revoke grants + revoke row).
		for (const legacy of plan.legacyToRevoke) {
			db.query(
				"UPDATE integration_capability_grants SET revoked_at=?, updated_at=? WHERE authority_id=? AND revoked_at IS NULL",
			).run(now, now, legacy.authorityId);
			db.query(
				"UPDATE integration_authorities SET state='revoked', revision=revision+1, revoked_at=?, revoked_reason=?, updated_at=? WHERE id=? AND state='active'",
			).run(now, "migrated-to-stable-installation-id", now, legacy.authorityId);
		}
	});
	if (dryRun) {
		console.log("[repair] DRY-RUN — no changes written.");
	} else if (plan.authorityExists && plan.existingUnrevokedGrants > 0) {
		// The canonical authority already carries grants: only retire the legacy
		// hash-keyed authorities, do not rewrite a healthy authority.
		console.log(
			`[repair] canonical authority is healthy (${plan.existingUnrevokedGrants} unrevoked grants) — skipping grant rebuild`,
		);
		const retireOnly = db.transaction(() => {
			for (const legacy of plan.legacyToRevoke) {
				db.query(
					"UPDATE integration_capability_grants SET revoked_at=?, updated_at=? WHERE authority_id=? AND revoked_at IS NULL",
				).run(now, now, legacy.authorityId);
				db.query(
					"UPDATE integration_authorities SET state='revoked', revision=revision+1, revoked_at=?, revoked_reason=?, updated_at=? WHERE id=? AND state='active'",
				).run(now, "migrated-to-stable-installation-id", now, legacy.authorityId);
			}
		});
		retireOnly();
	} else {
		write();
	}
	db.close();
}

function verify(home: string, plan: Plan): void {
	const db = new Database(join(home, "narrafork.db"), { readonly: true });
	if (plan.authorityId) {
		const row = db
			.query(
				"SELECT state, revision FROM integration_authorities WHERE id=?",
			)
			.get(plan.authorityId) as { state: string; revision: number } | undefined;
		const grants = db
			.query(
				"SELECT capability_id FROM integration_capability_grants WHERE authority_id=? AND revoked_at IS NULL ORDER BY capability_id",
			)
			.all(plan.authorityId) as Array<{ capability_id: string }>;
		console.log(`[repair] canonical authority: state=${row?.state} revision=${row?.revision}`);
		console.log(`[repair] active grants: ${grants.length}`);
		console.log(`[repair] ui.panel granted: ${grants.some((g) => g.capability_id === "ui.panel")}`);
		console.log(`[repair] capabilities: ${grants.map((g) => g.capability_id).join(", ")}`);
	}
	const remainingActive = db
		.query(
			"SELECT id, metadata_json FROM integration_authorities WHERE integration_type='plugin' AND integration_id=? AND state='active'",
		)
		.all(plan.pluginId) as Array<{ id: string; metadata_json: string | null }>;
	const nonUuidActive = remainingActive.filter((r) => {
		try {
			const meta = r.metadata_json ? (JSON.parse(r.metadata_json) as { installationId?: string }) : undefined;
			return meta?.installationId === undefined || !isStableInstallationId(meta.installationId);
		} catch {
			return true;
		}
	});
	console.log(`[repair] remaining active authorities: ${remainingActive.length} (non-UUID: ${nonUuidActive.length})`);
	db.close();
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	const home = process.env.NARRATEFORK_HOME ?? join(homedir(), ".narrafork");
	assertNoLiveInstance(home, args.forceUnlock);
	const plan = buildPlan(home, args.pluginId);
	console.log(`[repair] plugin: ${plan.pluginId}`);
	console.log(`[repair] installationId (UUID): ${plan.installationId ?? "(none)"}`);
	console.log(`[repair] package hash: ${plan.stateHash?.slice(0, 16) ?? "(none)"}`);
	console.log(`[repair] canonical authority exists: ${plan.authorityExists} (state=${plan.authorityState ?? "n/a"}, revision=${plan.authorityRevision})`);
	console.log(`[repair] grants to write: ${plan.grantsToWrite.length}`);
	console.log(`[repair] legacy authorities to retire: ${plan.legacyToRevoke.length}`);
	executePlan(home, plan, args.dryRun);
	verify(home, plan);
	console.log("[repair] DONE");
}

main();
