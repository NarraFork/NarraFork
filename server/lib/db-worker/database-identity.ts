import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { hotSafe } from "../hot-safe";
import { DbReadError } from "./errors";

export interface ReadDatabaseIdentity {
	path: string;
	id: string;
	generation: number;
	drained: boolean;
	open: boolean;
	ready: boolean;
}
function identities() {
	return hotSafe("narrafork.dbReaders.identities", () => ({
		paths: new Map<string, ReadDatabaseIdentity>(),
		aliases: new Map<string, ReadDatabaseIdentity>(),
		connections: new WeakMap<Database, ReadDatabaseIdentity>(),
	}));
}
/** Lifecycle/dispatch boundary: verifies the filesystem now, not a permanently cached realpath. */
export function getReadDatabaseIdentity(path: string): ReadDatabaseIdentity {
	if (/^postgres(?:ql)?:/i.test(path))
		throw new DbReadError(
			"DB_READ_UNSUPPORTED",
			"PostgreSQL sources require their asynchronous driver",
		);
	let canonical: string;
	try {
		canonical = realpathSync.native(path);
	} catch {
		throw new DbReadError("DB_READ_UNAVAILABLE", "database read source is unavailable");
	}
	const all = identities();
	let identity = all.paths.get(canonical);
	if (!identity) {
		identity = {
			path: canonical,
			id: `${canonical}#1`,
			generation: 1,
			drained: false,
			open: true,
			ready: false,
		};
		all.paths.set(canonical, identity);
	}
	all.aliases.set(resolve(path), identity);
	all.aliases.set(canonical, identity);
	return identity;
}
/** Pure state lookup: no filesystem I/O, registration, worker spawn, or implicit readiness. */
export function peekReadDatabaseIdentity(path: string): ReadDatabaseIdentity | undefined {
	return identities().aliases.get(resolve(path));
}
export function invalidateReadDatabaseReadiness(): void {
	for (const identity of identities().paths.values()) identity.ready = false;
}
export function assertReadDatabaseOpen(identity: ReadDatabaseIdentity): void {
	if (!identity.open || identities().paths.get(identity.path) !== identity)
		throw new DbReadError("DB_READ_DATABASE_CLOSED", "database read admission is closed");
}
/** A source handle stays bound to its original generation across same-path replacements. */
export function bindReadDatabase(client: Database): ReadDatabaseIdentity {
	const all = identities();
	let identity = all.connections.get(client);
	if (!identity) {
		identity = getReadDatabaseIdentity(client.filename);
		all.connections.set(client, identity);
	}
	assertReadDatabaseOpen(identity);
	return identity;
}
export function closeReadDatabaseAdmission(path: string): ReadDatabaseIdentity {
	const identity = getReadDatabaseIdentity(path);
	identity.open = false;
	identity.drained = false;
	identity.ready = false;
	return identity;
}
/** Called only after the manager has closed all readers and the old owning connection. */
export function resumeReadDatabase(path: string): ReadDatabaseIdentity {
	const all = identities();
	const previous = getReadDatabaseIdentity(path);
	if (previous.open) return previous;
	if (!previous.drained)
		throw new DbReadError("DB_READ_BUSY", "database readers have not confirmed exit");
	const generation = previous.generation + 1;
	const identity = {
		path: previous.path,
		id: `${previous.path}#${generation}`,
		generation,
		drained: false,
		open: true,
		ready: false,
	};
	all.paths.set(identity.path, identity);
	// Other aliases must be re-verified at a lifecycle/probe boundary; a symlink may have moved.
	for (const [alias, target] of all.aliases) if (target === previous) all.aliases.delete(alias);
	all.aliases.set(identity.path, identity);
	all.aliases.set(resolve(path), identity);
	return identity;
}
