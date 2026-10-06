import { and, asc, eq, gt, gte, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import { fileAttributions, narrators } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { type AttributionActor, EXTERNAL_ACTOR } from "./attribution-actors";
import type { GitWorkspaceTarget } from "./git-workspace";
import { normalizeWorkspacePath, probeLocalGitWorkspace } from "./git-workspace";
import { canReadNarrator, NARRATOR_ACL_COLUMNS, type NarratorPrincipal } from "./narrator-acl";
import { createRemoteGitService } from "./remote-git-service";
import type {
	WorkspaceAttributionScope,
	WorkspaceModificationView,
} from "./workspace-modification-view";

const MAX_ATTRIBUTION_SCOPES = 32;
const MAX_ATTRIBUTION_SCOPE_CANDIDATES = 64;
const ATTRIBUTION_SCOPE_PROBE_BUDGET_MS = 5_000;

function storedWorkspacePath(target: GitWorkspaceTarget, path: string): string {
	return target.workspace.deviceId === LOCAL_DEVICE_ID
		? normalizeWorkspacePath(path)
		: (target.backend?.paths.identityKey(path) ?? path);
}

function scopeFor(
	target: GitWorkspaceTarget,
	workspacePath: string,
	cwd: string,
): WorkspaceAttributionScope | null {
	const root = target.workspace.rootPath;
	const paths = target.backend?.paths;
	if (!root || !paths?.contains(root, cwd)) return null;
	const relative = paths.relative(root, cwd);
	if (paths.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) return null;
	return {
		workspacePath,
		prefix: relative.split(/[\\/]/).filter(Boolean).join("/"),
		...(target.backend?.kind === "remote"
			? {
					absoluteGitRoot: paths.identityKey(root),
					absoluteSeparator:
						target.backend.pathFlavor === "windows" ? ("\\" as const) : ("/" as const),
				}
			: {}),
	};
}

/**
 * Attribution writers key legacy rows by their trusted execution cwd rather than by
 * the Git root. Discover those cwd keys through the leading device/workspace index,
 * then independently prove that each candidate still resolves to this exact worktree.
 * The keyset/probe budgets keep a hostile or very busy device from turning one route
 * request into an all-history scan or an unbounded series of remote RPCs.
 */
export async function collectGitAttributionScopes(
	target: GitWorkspaceTarget,
	signal?: AbortSignal,
): Promise<{ scopes: WorkspaceAttributionScope[]; truncated: boolean }> {
	const { backend, workspace } = target;
	const root = workspace.rootPath;
	if (!backend || !root) return { scopes: [], truncated: false };
	const paths = backend.paths;
	const scopes = new Map<string, WorkspaceAttributionScope>();
	let truncated = false;
	const addKnown = (cwd: string, workspacePath = storedWorkspacePath(target, cwd)) => {
		const scope = scopeFor(target, workspacePath, cwd);
		if (!scope || scopes.has(scope.workspacePath)) return;
		if (scopes.size >= MAX_ATTRIBUTION_SCOPES) {
			truncated = true;
			return;
		}
		scopes.set(scope.workspacePath, scope);
	};

	// The already-authorized probe proves these without another filesystem/RPC round trip.
	addKnown(workspace.cwd);
	if (backend.kind === "remote") addKnown(root);

	const rootKey = storedWorkspacePath(target, root);
	const separator =
		workspace.deviceId === LOCAL_DEVICE_ID || backend.pathFlavor !== "windows" ? "/" : "\\";
	const descendantPrefix = `${rootKey.replace(/[\\/]$/, "")}${separator}`;
	const upperBound = `${descendantPrefix}\uffff`;
	const candidates: string[] = [];
	let cursor: string | undefined;
	while (candidates.length <= MAX_ATTRIBUTION_SCOPE_CANDIDATES) {
		signal?.throwIfAborted();
		const conditions = [
			eq(fileAttributions.deviceId, workspace.deviceId),
			gte(fileAttributions.workspacePath, descendantPrefix),
			lt(fileAttributions.workspacePath, upperBound),
		];
		if (cursor) conditions.push(gt(fileAttributions.workspacePath, cursor));
		const row = await db
			.select({ workspacePath: fileAttributions.workspacePath })
			.from(fileAttributions)
			.where(and(...conditions))
			.orderBy(asc(fileAttributions.workspacePath))
			.limit(1)
			.then((rows) => rows[0]);
		if (!row) break;
		cursor = row.workspacePath;
		candidates.push(row.workspacePath);
	}
	if (candidates.length > MAX_ATTRIBUTION_SCOPE_CANDIDATES) {
		candidates.length = MAX_ATTRIBUTION_SCOPE_CANDIDATES;
		truncated = true;
	}

	const budgetSignal = AbortSignal.timeout(ATTRIBUTION_SCOPE_PROBE_BUDGET_MS);
	const probeSignal = signal ? AbortSignal.any([signal, budgetSignal]) : budgetSignal;
	const remote = backend.kind === "remote" ? createRemoteGitService(backend, probeSignal) : null;
	for (const candidate of candidates) {
		if (scopes.has(candidate)) continue;
		try {
			probeSignal.throwIfAborted();
			const probe = remote
				? await remote.probe(candidate)
				: await probeLocalGitWorkspace(candidate, probeSignal);
			if (probe.state !== "ready" || !probe.rootPath) {
				truncated = true;
				continue;
			}
			if (!paths.equals(probe.rootPath, root)) continue;
			addKnown(candidate, candidate);
		} catch {
			signal?.throwIfAborted();
			truncated = true;
			if (probeSignal.aborted) break;
		}
	}
	return { scopes: [...scopes.values()], truncated };
}

/** Redaction never filters workspace changes down to the current narrator. */
export function redactGitActors(
	view: WorkspaceModificationView,
	readable: ReadonlySet<string>,
): WorkspaceModificationView {
	const permitted = (actor: AttributionActor) =>
		!actor.narratorId
			? actor.kind === "human" || actor.kind === "external_unknown"
			: readable.has(actor.narratorId);
	const actor = (value: AttributionActor): AttributionActor =>
		permitted(value)
			? { ...value, parentTitle: null }
			: { ...EXTERNAL_ACTOR, kind: "narrator_unknown", deleted: null };
	return {
		...view,
		actors: view.actors.map(actor),
		timeline: view.timeline?.map((event) => ({
			...event,
			actor: actor(event.actor),
			...(permitted(event.actor)
				? {}
				: { toolUseId: null, treeHashAfter: null, preciseAttribution: false }),
		})),
		byFile: view.byFile.map((file) => ({
			...file,
			lastActor: actor(file.lastActor),
			actors: file.actors.map(actor),
			recentEvents: file.recentEvents.map((event) => ({ ...event, actor: actor(event.actor) })),
		})),
		currentDiff: view.currentDiff
			? {
					...view.currentDiff,
					byFile: view.currentDiff.byFile.map((file) => {
						const redact = (target: typeof file.index) =>
							target.actor && !permitted(target.actor)
								? {
										...target,
										status: "unknown" as const,
										actor: null,
										effectId: null,
										reason: "no_evidence" as const,
									}
								: { ...target, actor: target.actor ? actor(target.actor) : null };
						return { ...file, index: redact(file.index), worktree: redact(file.worktree) };
					}),
				}
			: undefined,
	};
}

export async function redactGitModificationView(
	view: WorkspaceModificationView,
	principal: NarratorPrincipal,
): Promise<WorkspaceModificationView> {
	const ids = new Set<string>();
	const add = (actor: AttributionActor | null) => {
		if (actor?.narratorId) ids.add(actor.narratorId);
	};
	for (const actor of view.actors) add(actor);
	for (const file of view.byFile) {
		add(file.lastActor);
		for (const actor of file.actors) add(actor);
		for (const event of file.recentEvents) add(event.actor);
	}
	for (const event of view.timeline ?? []) add(event.actor);
	for (const file of view.currentDiff?.byFile ?? []) {
		add(file.index.actor);
		add(file.worktree.actor);
	}
	const readable = new Set<string>();
	// Bounded pages, with no messages, titles or snapshot contents loaded for ACL checks.
	const all = [...ids];
	for (let start = 0; start < all.length; start += 200) {
		const rows = await db.query.narrators.findMany({
			where: inArray(narrators.id, all.slice(start, start + 200)),
			columns: NARRATOR_ACL_COLUMNS,
			limit: 200,
		});
		for (const row of rows) if (await canReadNarrator(row, principal)) readable.add(row.id);
	}
	return redactGitActors(view, readable);
}
