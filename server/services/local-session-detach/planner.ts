import { boundedSnapshot, digest, type NormalizedSnapshot, snapshotDigest } from "./contract";

export interface FixtureDetachPlan {
	kind: "fixture-dry-run";
	ready: boolean;
	reasons: string[];
	snapshotDigest: string | null;
	planDigest: string | null;
	/** Dry run deliberately has no executable token and no effect ports. */
	effects: "none";
}
export function planFixtureDetach(
	snapshot: NormalizedSnapshot,
	signal?: AbortSignal,
): FixtureDetachPlan {
	const reasons: string[] = [];
	let beforeDigest: string;
	try {
		const canonical = boundedSnapshot(snapshot, signal);
		beforeDigest = digest(canonical);
		// Planning and the store see exactly the same own JSON data, not hidden metadata.
		snapshot = JSON.parse(canonical) as NormalizedSnapshot;
	} catch (error) {
		return {
			kind: "fixture-dry-run",
			ready: false,
			reasons: [error instanceof Error ? error.message : "INVALID_SNAPSHOT"],
			snapshotDigest: null,
			planDigest: null,
			effects: "none",
		};
	}
	const deny = (condition: boolean, reason: string) => {
		if (condition) reasons.push(reason);
	};
	const {
		narrator: n,
		chapter: c,
		acl,
		authority: a,
		runtime: r,
		identity: i,
		resource,
	} = snapshot;
	deny(
		!snapshot.schema ||
			!snapshot.collection.complete ||
			!snapshot.collection.currentSnapshot ||
			snapshot.collection.truncated ||
			snapshot.collection.missingObjects.length > 0,
		"COLLECTION_INCOMPLETE",
	);
	deny(
		n.type !== "primary" ||
			n.variant !== "primary" ||
			n.status !== "idle" ||
			n.chapterId !== c.id ||
			c.state !== "active" ||
			!["branch", "trunk", "exploration"].includes(c.role) ||
			n.role === "review" ||
			n.isReview === true ||
			n.isAskInPassing !== false ||
			n.isBackground !== false ||
			!["default", "acceptEdits", "bypassPermissions", "dontAsk"].includes(
				String(n.permissionMode),
			) ||
			n.readOnly === true,
		"NOT_ORDINARY_ACTIVE_PRIMARY",
	);
	deny(
		(n.contextProjectId !== null && n.contextProjectId !== c.projectId) ||
			acl.projectId !== c.projectId,
		"CROSS_PROJECT_CONTEXT",
	);
	deny(
		n.ownerUserId !== acl.ownerUserId ||
			n.oauthOwnerGrantId !== null ||
			n.oauthPolicySnapshotJson !== null,
		"NARRATOR_OWNER_OR_SOURCE_UNVERIFIED",
	);
	deny(
		!acl.ownerExists ||
			acl.ownerNarratorIds.length !== 1 ||
			acl.ownerNarratorIds[0] !== n.id ||
			acl.shared,
		"OWNER_UNVERIFIED_OR_SHARED",
	);
	deny(
		acl.source !== "local" ||
			acl.readOnly ||
			!acl.denyRulesKnown ||
			!acl.lineageComplete ||
			acl.permissionLineage.length === 0,
		"ACL_LINEAGE_UNVERIFIED",
	);
	try {
		const traits = JSON.parse(String(n.traits));
		deny(
			!Array.isArray(traits) ||
				traits.some(
					(trait) => typeof trait !== "string" || ["ask-in-passing", "background"].includes(trait),
				),
			"TRAIT_EVIDENCE_UNVERIFIED",
		);
	} catch {
		reasons.push("TRAIT_EVIDENCE_UNVERIFIED");
	}
	deny(
		acl.permissionLineage.some((row) => row.rootId !== acl.rootId),
		"ACL_ROOT_MISMATCH",
	);
	deny(
		!a.exists || !a.canDetach || (!a.admin && a.actorId !== acl.ownerUserId),
		"ACTOR_UNAUTHORIZED",
	);
	deny(
		!i.local ||
			!i.known ||
			i.cwd !== i.path ||
			i.worktree !== i.path ||
			n.cwd !== i.path ||
			i.treeBoundaryPath !== i.path ||
			i.cwdRepositoryKey !== i.repositoryKey ||
			c.snapshotShadowKey !== i.shadowKey ||
			(n.defaultDeviceId !== null && n.defaultDeviceId !== i.deviceId),
		"PHYSICAL_IDENTITY_UNVERIFIED",
	);
	try {
		const context = JSON.parse(n.workspaceContext);
		deny(
			context.cwd !== i.path ||
				context.deviceId !== i.deviceId ||
				context.contextProjectId !== c.projectId ||
				context.revision !== n.workspaceRevision ||
				context.git?.repositoryKey !== i.repositoryKey ||
				context.git?.rootPath !== i.path ||
				context.git?.workspaceKey !== i.worktree,
			"WORKSPACE_CONTEXT_UNVERIFIED",
		);
	} catch {
		reasons.push("WORKSPACE_CONTEXT_UNVERIFIED");
	}
	deny(
		!r.observationsComplete ||
			r.state !== "idle" ||
			r.quarantined ||
			r.paused ||
			r.leaseId !== null ||
			r.leases.length > 0 ||
			r.queues.length > 0 ||
			r.activeChildren.length > 0 ||
			r.waitingPermissions.length > 0,
		"RUNTIME_NOT_IDLE",
	);
	deny(
		!resource.evidenceComplete || resource.dependencies.length > 0,
		"RESOURCE_DEPENDENCIES_UNVERIFIED",
	);
	for (const row of [...resource.claims, ...resource.uses]) {
		deny(
			row.ownerNarratorId !== n.id || row.projectId !== c.projectId || row.active !== false,
			"RESOURCE_CLAIM_UNVERIFIED",
		);
	}
	if (resource.row) {
		const row = resource.row;
		deny(
			row.id !== resource.id ||
				row.ownerNarratorId !== n.id ||
				row.state !== "ready" ||
				row.scopeKind !== "project" ||
				row.scopeProjectId !== c.projectId ||
				row.scopeOwnerUserId !== acl.ownerUserId ||
				row.deviceId !== i.deviceId ||
				row.repositoryKey !== i.repositoryKey ||
				row.worktreePath !== i.path ||
				!Number.isSafeInteger(row.ownershipRevision),
			"RESOURCE_OWNER_UNVERIFIED",
		);
	}
	deny(!snapshot.closure.complete || !snapshot.closure.historicalPathsKnown, "CLOSURE_INCOMPLETE");
	const objects = new Map(snapshot.closure.objects.map((o) => [o.id, o]));
	deny(objects.size !== snapshot.closure.objects.length, "CLOSURE_DUPLICATE");
	for (const id of snapshot.closure.rootIds) deny(!objects.has(id), "CLOSURE_ROOT_MISSING");
	for (const object of objects.values()) {
		const raw = Buffer.from(object.rawBase64, "base64");
		deny(
			!object.available ||
				object.row.id !== object.id ||
				!["history", "lazy", "ref", "tool", "spec", "provenance", "blob", "tree"].includes(
					object.kind,
				) ||
				raw.toString("base64") !== object.rawBase64 ||
				digest(raw) !== object.byteDigest ||
				object.dependencies.some((id) => !objects.has(id)),
			"CLOSURE_OBJECT_MISSING_OR_CORRUPT",
		);
	}
	for (const kind of ["history", "lazy", "ref", "tool", "spec", "provenance"] as const) {
		deny(!snapshot.closure.objects.some((o) => o.kind === kind), "CLOSURE_KIND_MISSING");
	}
	return {
		kind: "fixture-dry-run",
		ready: reasons.length === 0,
		reasons: [...new Set(reasons)],
		snapshotDigest: beforeDigest,
		planDigest: digest(`fixture-detach/v1:${beforeDigest}`),
		effects: "none",
	};
}
/** Only the fixture executor calls this. Identity and all unplanned business fields are retained. */
export function detachedImage(before: NormalizedSnapshot): NormalizedSnapshot {
	// This exported fixture boundary must validate descriptors before any clone/serialization.
	const after = JSON.parse(boundedSnapshot(before)) as NormalizedSnapshot;
	const context = JSON.parse(after.narrator.workspaceContext);
	after.narrator.chapterId = null;
	after.narrator.contextProjectId = after.chapter.projectId;
	after.narrator.cwd = after.identity.path;
	after.narrator.workspaceRevision++;
	context.revision = after.narrator.workspaceRevision;
	context.contextProjectId = after.chapter.projectId;
	after.narrator.workspaceContext = JSON.stringify(context);
	if (!after.resource.row) {
		after.resource.row = {
			id: after.resource.id,
			ownerNarratorId: after.narrator.id,
			deviceId: after.identity.deviceId,
			repositoryKey: after.identity.repositoryKey,
			worktreePath: after.identity.path,
			createRequestId: "fixture:detach-request",
			state: "ready",
			scopeKind: "project",
			scopeProjectId: after.chapter.projectId,
			scopeOwnerUserId: after.acl.ownerUserId,
			ownershipRevision: 0,
			containerConfig: null,
		};
	}
	snapshotDigest(after);
	return after;
}
