import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as yieldToEventLoop } from "node:timers/promises";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "../db";
import { legacyProjectMigrations, legacyProjectSyncTombstones, projects } from "../db/schema";
import { AppError, NotFoundError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";

interface Operation {
	projectId: string;
	path: string | null;
	controller: AbortController;
	done: Promise<void>;
}
interface CoordinatorState {
	blockedIds: Set<string>;
	blockedPaths: Set<string>;
	operations: Set<Operation>;
	stopListeners: Map<
		string | symbol,
		{ listener: (projectId: string) => void; onReplace?: () => void }
	>;
	restoredDisabledAliases?: Promise<void>;
}
/** One-way gate and active writer registry survive Bun --hot module re-evaluations. */
const state = hotSafe<CoordinatorState>("narrafork:legacy-project-sync-coordinator", () => ({
	blockedIds: new Set(),
	blockedPaths: new Set(),
	operations: new Set(),
	stopListeners: new Map(),
}));
const { blockedIds, blockedPaths, operations, stopListeners } = state;

function archiveKey(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export function onLegacySyncDisabled(
	listener: (projectId: string) => void,
	key: string | symbol = Symbol(),
	onReplace?: () => void,
): () => void {
	stopListeners.get(key)?.onReplace?.();
	const registration = { listener, onReplace };
	stopListeners.set(key, registration);
	return () => {
		if (stopListeners.get(key) === registration) stopListeners.delete(key);
	};
}

/** Include sibling IDs using the same physical archive when a root is available. */
export function legacySyncInFlight(projectId: string, gitPath?: string | null): boolean {
	const path = gitPath ? archiveKey(gitPath) : null;
	for (const operation of operations) {
		if (operation.projectId === projectId || (path !== null && operation.path === path))
			return true;
	}
	return false;
}

/** One bounded startup restoration; production disable calls synchronously update the latch. */
function restoreDisabledAliases(): Promise<void> {
	if (state.restoredDisabledAliases) return state.restoredDisabledAliases;
	state.restoredDisabledAliases = (async () => {
		let after = "";
		let examined = 0;
		const deadline = Date.now() + 5_000;
		for (;;) {
			const page = await db
				.select({ id: projects.id, gitPath: projects.gitPath })
				.from(projects)
				.where(and(eq(projects.legacySyncDisabled, true), gt(projects.id, after)))
				.orderBy(projects.id)
				.limit(100);
			for (const row of page) {
				blockedIds.add(row.id);
				if (row.gitPath) blockedPaths.add(archiveKey(row.gitPath));
			}
			if (page.length < 100) return;
			examined += page.length;
			if (examined >= 10_000 || Date.now() > deadline) {
				throw new AppError(
					"Legacy sync admission scan exceeded its budget",
					503,
					"LEGACY_SYNC_GATE_BUDGET",
				);
			}
			after = page.at(-1)?.id ?? after;
			await yieldToEventLoop(0);
		}
	})();
	return state.restoredDisabledAliases;
}

async function projectGate(
	projectId: string,
	targetGitPath?: string,
): Promise<{ allowed: boolean; path: string | null }> {
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
		columns: { gitPath: true, legacySyncDisabled: true },
	});
	const path = project?.gitPath ? archiveKey(project.gitPath) : null;
	if (targetGitPath && path !== archiveKey(targetGitPath)) return { allowed: false, path };
	if (!project || blockedIds.has(projectId) || project.legacySyncDisabled) {
		if (project?.legacySyncDisabled) {
			blockedIds.add(projectId);
			if (path) blockedPaths.add(path);
		}
		return { allowed: false, path };
	}
	// Never cache an allow decision: receipts survive deletion, and new receipts must
	// immediately block a recreated ID or a new project using the retired physical path.
	const idReceipt = await db.query.legacyProjectMigrations.findFirst({
		where: eq(legacyProjectMigrations.projectId, projectId),
		columns: { archivePath: true },
	});
	if (idReceipt) {
		blockedIds.add(projectId);
		if (idReceipt.archivePath) blockedPaths.add(idReceipt.archivePath);
		return { allowed: false, path };
	}
	if (path && !blockedPaths.has(path)) {
		// A standalone disable has no migration receipt. Its root tombstone must outlive
		// later gitPath changes and unrelated project deletion, with no allow-cache window.
		const rootTombstone = await db.query.legacyProjectSyncTombstones.findFirst({
			where: eq(legacyProjectSyncTombstones.canonicalRoot, path),
			columns: { canonicalRoot: true },
		});
		if (rootTombstone) {
			blockedPaths.add(path);
			return { allowed: false, path };
		}
		const pathReceipt = await db.query.legacyProjectMigrations.findFirst({
			where: eq(legacyProjectMigrations.archivePath, path),
			columns: { projectId: true },
		});
		if (pathReceipt) {
			blockedPaths.add(path);
			blockedIds.add(pathReceipt.projectId);
			return { allowed: false, path };
		}
		await restoreDisabledAliases();
		// Indexed exact-path check also sees freshly persisted flags without an allow cache.
		// Symlink aliases from older records are restored once; live disables latch realpaths.
		const disabledAlias = await db.query.projects.findFirst({
			where: and(
				eq(projects.legacySyncDisabled, true),
				inArray(projects.gitPath, [project.gitPath ?? path, path]),
			),
			columns: { id: true },
		});
		if (disabledAlias) {
			blockedPaths.add(path);
			blockedIds.add(disabledAlias.id);
		}
	}
	return { allowed: !blockedIds.has(projectId) && (!path || !blockedPaths.has(path)), path };
}

/** Simulate restart in isolated gate tests; never clears an active operation. */
export const __testing = {
	resetGateForRestart() {
		if (operations.size) throw new Error("Cannot reset an active legacy sync coordinator");
		blockedIds.clear();
		blockedPaths.clear();
		state.restoredDisabledAliases = undefined;
	},
};

export function isLegacySyncBlocked(projectId: string, gitPath?: string): boolean {
	return blockedIds.has(projectId) || (!!gitPath && blockedPaths.has(archiveKey(gitPath)));
}

export async function isLegacyProjectSyncAllowed(
	projectId: string,
	gitPath?: string,
): Promise<boolean> {
	return (await projectGate(projectId, gitPath)).allowed;
}

/** Register before invoking work; removal occurs only after its finally blocks settle. */
export async function trackedLegacyProjectSync<T>(
	projectId: string,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
	const gate = await projectGate(projectId);
	if (!gate.allowed || blockedIds.has(projectId) || (gate.path && blockedPaths.has(gate.path)))
		return undefined;
	let finish = () => {};
	const operation: Operation = {
		projectId,
		path: gate.path,
		controller: new AbortController(),
		done: new Promise<void>((resolveDone) => {
			finish = resolveDone;
		}),
	};
	operations.add(operation);
	try {
		return await work(operation.controller.signal);
	} finally {
		operations.delete(operation);
		finish();
	}
}

export function legacySyncDisabledError(): AppError {
	return new AppError("Legacy project sync is disabled", 409, "LEGACY_PROJECT_SYNC_DISABLED");
}

/** Persist first; abort and drain all users of the physical archive, then close idle handles. */
export async function disableLegacyProjectSync(
	projectId: string,
	timeoutMs = 5_000,
): Promise<{ syncDisabled: true; drained: boolean }> {
	// SQLite-only callers: one row read and at most two writes, no async work inside
	// the transaction. A failure cannot persist the flag without its original root.
	const { project, path } = db.transaction((tx) => {
		const project = tx
			.select({ id: projects.id, gitPath: projects.gitPath })
			.from(projects)
			.where(eq(projects.id, projectId))
			.get();
		if (!project) throw new NotFoundError("Project", projectId);
		const path = project.gitPath ? archiveKey(project.gitPath) : null;
		tx.update(projects).set({ legacySyncDisabled: true }).where(eq(projects.id, projectId)).run();
		if (path) {
			tx.insert(legacyProjectSyncTombstones)
				.values({
					canonicalRoot: path,
					projectId,
					disabledAt: new Date().toISOString(),
				})
				.onConflictDoNothing({ target: legacyProjectSyncTombstones.canonicalRoot })
				.run();
		}
		return { project, path };
	});
	blockedIds.add(projectId);
	if (path) blockedPaths.add(path);
	for (const { listener } of stopListeners.values()) listener(projectId);
	const active = [...operations].filter(
		(operation) => operation.projectId === projectId || (path !== null && operation.path === path),
	);
	for (const operation of active) operation.controller.abort(legacySyncDisabledError());
	let timer: ReturnType<typeof setTimeout> | undefined;
	const drained = await Promise.race([
		Promise.all(active.map((operation) => operation.done)).then(() => true),
		new Promise<false>((resolveTimeout) => {
			timer = setTimeout(() => resolveTimeout(false), timeoutMs);
		}),
	]);
	clearTimeout(timer);
	if (drained) {
		const { projectDbManager } = await import("../lib/project-db");
		projectDbManager.closeLegacyArchive(projectId, project.gitPath);
	}
	return { syncDisabled: true, drained };
}
