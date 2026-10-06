import type { narratorWorktreeResources } from "../db/schema";

export type WorktreeResourceRecord = Pick<
	typeof narratorWorktreeResources.$inferSelect,
	| "id"
	| "ownerNarratorId"
	| "deviceId"
	| "repositoryKey"
	| "worktreePath"
	| "state"
	| "scopeKind"
	| "scopeProjectId"
	| "scopeOwnerUserId"
	| "ownershipRevision"
	| "createRequestId"
	| "createdAt"
>;

export type WorktreeResourceOwner =
	| { kind: "legacyChapter"; chapterId: string }
	| { kind: "legacyNarrator"; narratorId: string }
	| { kind: "legacyStandalone" }
	| { kind: "worktreeResource"; worktreeResourceId: string };

export class WorktreeResourceError extends Error {
	constructor(public readonly code: string) {
		super(code);
		this.name = "WorktreeResourceError";
	}
}

/** Explicit FK wins; malformed or mixed selectors never fall through to a legacy owner. */
export function resolveWorktreeResourceOwner(input: unknown): WorktreeResourceOwner {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new WorktreeResourceError("OWNER_SELECTOR_INVALID");
	const selector = input as Record<string, unknown>;
	const values = ["worktreeResourceId", "chapterId", "narratorId"] as const;
	for (const key of values) {
		const value = selector[key];
		if (
			value !== undefined &&
			value !== null &&
			(typeof value !== "string" || !value.trim() || value.length > 256)
		)
			throw new WorktreeResourceError("OWNER_SELECTOR_INVALID");
	}
	const { worktreeResourceId, chapterId, narratorId } = selector;
	if (values.filter((key) => selector[key] != null).length > 1)
		throw new WorktreeResourceError("OWNER_SELECTOR_MIXED");
	if (typeof worktreeResourceId === "string")
		return { kind: "worktreeResource", worktreeResourceId };
	if (typeof chapterId === "string") return { kind: "legacyChapter", chapterId };
	if (typeof narratorId === "string") return { kind: "legacyNarrator", narratorId };
	return { kind: "legacyStandalone" };
}

/** Pure guard usable by legacy adapters before any process, namespace or restore lookup. */
export function assertLegacyRuntimeOwner(
	input: unknown,
): Exclude<WorktreeResourceOwner, { kind: "worktreeResource" }> {
	const owner = resolveWorktreeResourceOwner(input);
	if (owner.kind === "worktreeResource")
		throw new WorktreeResourceError("WORKTREE_RESOURCE_RUNTIME_DISABLED");
	return owner;
}

export const RESOURCE_AUTH_TIMEOUT_MS = 5_000;

export async function withResourceDeadline<T>(
	signal: AbortSignal | undefined,
	work: (signal: AbortSignal) => Promise<T>,
	timeoutMs = RESOURCE_AUTH_TIMEOUT_MS,
): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rejectAbort: (reason: Error) => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	const abort = () => {
		controller.abort();
		rejectAbort(new WorktreeResourceError("RESOURCE_AUTH_CANCELLED"));
	};
	try {
		if (signal?.aborted) throw new WorktreeResourceError("RESOURCE_AUTH_CANCELLED");
		signal?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(
			() => {
				controller.abort();
				rejectAbort(new WorktreeResourceError("RESOURCE_AUTH_TIMEOUT"));
			},
			Math.min(timeoutMs, RESOURCE_AUTH_TIMEOUT_MS),
		);
		return await Promise.race([work(controller.signal), aborted]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		controller.abort();
	}
}

/** Only a trusted current-auth adapter may produce this evidence. Never accept it from a DTO.
 * The adapter must compose existing root ACL/session/project/device/OAuth/execution-policy
 * checks and return complete canonical Git evidence, not a partial inventory or admin override.
 */
export interface CurrentResourceAuthority {
	actorUserId: string;
	scopeOwnerUserId: string;
	contextProjectId: string | null;
	rootNarratorId: string | null;
	/** Current verified session identity, never a client-selected/fork-inherited root. */
	sessionNarratorId: string;
	sessionType: "primary" | "subagent";
	sessionAclRootNarratorId: string | null;
	sourceNarratorId: string | null;
	sourceRootNarratorId: string | null;
	basis: "sourceRoot" | "scopeOwner";
	backend: "sqlite" | "postgres";
	workspaceKind: "git" | "directory";
	workspaceMode: "normal" | "readonly";
	deviceId: string;
	canonicalWorktreePath: string;
	repositoryKey: string;
	complete: boolean;
	readAllowed: boolean;
	writeAllowed: boolean;
	projectAllowed: boolean;
	deviceAllowed: boolean;
	oauthAllowed: boolean;
	executionAllowed: boolean;
}

export interface WorktreeResourceAccessPorts {
	/** Capability is checked before ANY lookup; unsupported PG must not read SQLite. */
	backend: "sqlite" | "postgres";
	loadResource(id: string, signal: AbortSignal): Promise<WorktreeResourceRecord | null>;
	loadCurrentAuthority(
		resource: WorktreeResourceRecord,
		signal: AbortSignal,
	): Promise<CurrentResourceAuthority | null>;
}

export function validateResourceAuthority(
	resource: WorktreeResourceRecord,
	auth: CurrentResourceAuthority | null,
	need: "read" | "write",
): void {
	if (resource.state !== "ready") throw new WorktreeResourceError("RESOURCE_NOT_READY");
	if (
		!["standalone", "project"].includes(resource.scopeKind) ||
		!resource.scopeOwnerUserId ||
		(resource.scopeKind === "project" && !resource.scopeProjectId) ||
		(resource.scopeKind !== "project" && resource.scopeProjectId !== null)
	)
		throw new WorktreeResourceError("RESOURCE_SCOPE_UNVERIFIED");
	if (
		!auth?.actorUserId ||
		auth.complete !== true ||
		auth.readAllowed !== true ||
		(need === "write" && (auth.writeAllowed !== true || auth.workspaceMode !== "normal")) ||
		auth.projectAllowed !== true ||
		auth.deviceAllowed !== true ||
		auth.oauthAllowed !== true ||
		auth.executionAllowed !== true
	)
		throw new WorktreeResourceError("RESOURCE_ACCESS_DENIED");
	if (
		auth.backend !== "sqlite" ||
		resource.deviceId !== "local" ||
		auth.deviceId !== "local" ||
		auth.workspaceKind !== "git" ||
		!["normal", "readonly"].includes(auth.workspaceMode)
	)
		throw new WorktreeResourceError("RESOURCE_CAPABILITY_UNSUPPORTED");
	if (
		auth.sourceNarratorId !== resource.ownerNarratorId ||
		auth.scopeOwnerUserId !== resource.scopeOwnerUserId ||
		auth.contextProjectId !== resource.scopeProjectId ||
		auth.canonicalWorktreePath !== resource.worktreePath ||
		auth.repositoryKey !== resource.repositoryKey
	)
		throw new WorktreeResourceError("RESOURCE_IDENTITY_MISMATCH");
	if (resource.ownerNarratorId !== null) {
		if (
			!auth.sessionNarratorId ||
			(auth.sessionType === "primary"
				? auth.sessionNarratorId !== auth.rootNarratorId
				: auth.sessionType !== "subagent" ||
					!auth.sessionAclRootNarratorId ||
					auth.sessionAclRootNarratorId !== auth.rootNarratorId)
		)
			throw new WorktreeResourceError("RESOURCE_SESSION_UNVERIFIED");
		// Same cwd, ordinary forks and unrelated primary sessions are not lineage proof.
		if (
			auth.basis !== "sourceRoot" ||
			!auth.rootNarratorId ||
			auth.rootNarratorId !== auth.sourceRootNarratorId
		)
			throw new WorktreeResourceError("RESOURCE_ROOT_MISMATCH");
	} else if (
		auth.basis !== "scopeOwner" ||
		auth.actorUserId !== resource.scopeOwnerUserId ||
		auth.sourceRootNarratorId !== null
	) {
		// Origin deletion cannot promote a private resource to inherited public permissions.
		throw new WorktreeResourceError("RESOURCE_ORIGIN_UNVERIFIED");
	}
}

export interface WorktreeResourceAuthorization {
	resource: WorktreeResourceRecord;
	authority: CurrentResourceAuthority;
}

/** Injection only: no production database/auth/filesystem/process adapter is installed. */
export function createWorktreeResourceAccess(ports: WorktreeResourceAccessPorts) {
	const authorizeSnapshot = async (
		selector: unknown,
		expectedRevision: number,
		need: "read" | "write",
		signal?: AbortSignal,
	): Promise<WorktreeResourceAuthorization> => {
		const owner = resolveWorktreeResourceOwner(selector);
		if (owner.kind !== "worktreeResource") throw new WorktreeResourceError("RESOURCE_REQUIRED");
		if (ports.backend !== "sqlite")
			throw new WorktreeResourceError("RESOURCE_CAPABILITY_UNSUPPORTED");
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
			throw new WorktreeResourceError("RESOURCE_REVISION_STALE");
		return withResourceDeadline(signal, async (boundedSignal) => {
			const loaded = await ports.loadResource(owner.worktreeResourceId, boundedSignal);
			if (!loaded) throw new WorktreeResourceError("RESOURCE_NOT_FOUND");
			// Freeze value evidence before awaiting authority; providers cannot mutate the snapshot.
			const resource = { ...loaded };
			if (resource.id !== owner.worktreeResourceId)
				throw new WorktreeResourceError("RESOURCE_IDENTITY_MISMATCH");
			if (resource.ownershipRevision !== expectedRevision)
				throw new WorktreeResourceError("RESOURCE_REVISION_STALE");
			const current = await ports.loadCurrentAuthority({ ...resource }, boundedSignal);
			const authority = current ? { ...current } : null;
			validateResourceAuthority(resource, authority, need);
			if (!authority) throw new WorktreeResourceError("RESOURCE_ACCESS_DENIED");
			if (boundedSignal.aborted) throw new WorktreeResourceError("RESOURCE_AUTH_CANCELLED");
			return { resource, authority };
		});
	};
	return {
		authorizeSnapshot,
		async authorize(
			selector: unknown,
			expectedRevision: number,
			need: "read" | "write",
			signal?: AbortSignal,
		): Promise<WorktreeResourceRecord> {
			return (await authorizeSnapshot(selector, expectedRevision, need, signal)).resource;
		},
	};
}
