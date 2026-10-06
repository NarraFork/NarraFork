import {
	RESOURCE_DECOUPLING_BUDGET as budget,
	type DecouplingDiagnostic,
	type ResourceDecouplingPlan,
	type ResourceDecouplingResource,
	type ResourceDisposition,
	resourceDecouplingInputSchema,
} from "../../shared/resource-decoupling-plan";

/** No database, filesystem, runtime services or archive implementation is consulted. */
const messages = {
	INVALID_INPUT: "Expected a complete, strict, fixture-only JSON DTO; values are not echoed.",
	INPUT_BUDGET_EXCEEDED: "Normalize a smaller bounded manifest before planning.",
	INPUT_CYCLE: "Input must be JSON data without cycles or aliased object instances.",
	MANIFEST_INCOMPLETE: "Supply a complete, non-truncated inventory and exact counts.",
	ACL_INCOMPLETE: "Map the authorization root; changing chapter identity is not an ACL transfer.",
	PROVENANCE_INCOMPLETE: "Supply complete ownership and creation provenance.",
	SHARED_USERS_INCOMPLETE: "Enumerate all shared users; do not infer a unique owner.",
	OWNER_UNKNOWN: "Resolve ownership or provide a complete deleted-owner registry receipt.",
	SHARED_OWNER_UNPROVEN: "Every owner needs explicit context and authorized resource evidence.",
	TARGET_IDENTITY_MISSING: "Map a stable fixture reference target without moving the resource.",
	METADATA_MAPPING_INCOMPLETE: "Map reference and restoration metadata before fixture acceptance.",
	NARRATOR_NOT_IDLE: "Preparing, running or unknown narrator state cannot be decoupled.",
	LEASE_NOT_RELEASED: "Active, quarantined or unknown write lease needs a release receipt.",
	RUN_NOT_IDLE: "Resolve the active or unknown logical run.",
	AUTHORIZATION_PENDING:
		"Pending or approved-but-unexecuted authorization remains bound to its context.",
	MUTATION_UNKNOWN: "Resolve unknown mutations before planning.",
	CONTEXT_INCOMPLETE:
		"Map WorkspaceContext and verify narrator, chapter, project and resource references.",
	CHAPTER_UNKNOWN: "Resolve chapter state; a null identifier alone is not evidence of decoupling.",
	NARRATOR_CHAPTER_NO_ACTION:
		"narrators.chapter_id is NO ACTION: retain the old binding until a verified context/ACL/ownership migration exists.",
	REGISTRY_NOT_READY:
		"Registry preparing/unknown may describe real resources; preserve inventory and resolve creation.",
	REGISTRY_OWNER_MISMATCH: "Registry owner and normalized ownership evidence disagree.",
	NARRATOR_BINDING_UNKNOWN:
		"A narrator binding is not the known narrator and has no explicit known shared context; an owner ID list is not a context receipt.",
	NARRATOR_BINDING_OWNER_MISMATCH:
		"The bound narrator is absent from the declared owners; do not guess ownership from chapter or user IDs.",
	NARRATOR_BINDING_CONTEXT_MISMATCH:
		"The bound narrator context must explicitly reference this resource and match its declared chapter/project scope.",
	SHARED_NARRATOR_EVIDENCE_INCOMPLETE:
		"Supply complete known context, provenance, shared access, ACL and resource mapping for every external or deleted owner.",
	SHARED_NARRATOR_EVIDENCE_MISMATCH:
		"Shared narrator evidence contradicts narrator/context identity, resource references, declared users or scope.",
	OWNER_DELETED_REFERENCE_RETAINED:
		"Registry owner uses SET NULL; deleting the owner must not discard the real worktree reference.",
	CONTAINER_CHAPTER_REQUIRED:
		"container_instances.chapter_id is NOT NULL and CASCADE: current schema cannot represent a detached container.",
	CONTAINER_REFERENCES_INCOMPLETE:
		"Map compose project, service, port and volume references including the chapter-based volume prefix.",
	CONTAINER_NOT_QUIESCENT:
		"Running or unknown container state requires a separate runtime migration protocol.",
	PORT_CHAPTER_CASCADE:
		"port_allocations.chapter_id cascades; retain binding and service/proxy allocation identity, including ports retained after proxy container removal.",
	PORT_REFERENCES_INCOMPLETE: "Supply all port service, expected proxy and container references.",
	TERMINAL_CHAPTER_CASCADE:
		"terminals.chapter_id cascades; terminal_view_state chapter/narrator bindings also cascade and require separate UI metadata mapping.",
	TERMINAL_NARRATOR_NO_ACTION:
		"terminals.narrator_id is NO ACTION; do not detach or delete its narrator implicitly.",
	TERMINAL_RECEIPT_MISSING:
		"Running, remote or dtach terminals require an explicit migration receipt, not a rewritten chapter ID.",
	TERMINAL_UNKNOWN: "Resolve terminal runtime and location state.",
	VOLUME_MAPPING_INCOMPLETE:
		"Map volume ownership, compose project, snapshot and snapshot application identity; no volume deletion is implied.",
	VOLUME_SNAPSHOT_CHAPTER_CASCADE:
		"Retain chapter-scoped volume metadata: volume_snapshot_applications.chapter_id is NOT NULL and CASCADE; source_chapter_id SET NULL does not preserve application identity.",
	LEGACY_BINDING_RETAINED:
		"Historical binding remains intact; map context, ACL, owner and restore metadata with a receipt in a future migration protocol.",
	REFERENCE_MISSING: "A referenced resource or object is absent from the complete manifest.",
	REFERENCE_MISMATCH: "Cross-resource identities or reciprocal references disagree.",
	DUPLICATE_IDENTITY:
		"Manifest identifiers and reference identities must be unique within their inventory.",
	OBJECT_UNAVAILABLE:
		"Tree DAG, blob, upload, binary, ignored content or lazy-fork metadata is unavailable or incomplete.",
	OBJECT_DEPENDENCY_CYCLE: "Object dependencies must form a bounded acyclic graph.",
	OBJECT_DEPENDENCY_UNRESOLVED: "A missing dependency prevents validating the reachable DAG.",
	OBJECT_DEPENDENCY_UNAVAILABLE: "A transitive object dependency is unavailable or incomplete.",
	FIXTURE_REFERENCE_STABLE:
		"Only fixture metadata is validated; no production apply or physical migration is authorized.",
} as const;
type ReasonCode = keyof typeof messages;

/** Iterative preflight precedes Zod and prevents recursive parsing of hostile input. */
function preflight(input: unknown): ReasonCode | null {
	const stack = [{ value: input, depth: 0 }];
	const seen = new WeakSet<object>();
	let nodes = 0;
	let bytes = 0;
	while (stack.length) {
		const item = stack.pop();
		if (!item) break;
		const { value, depth } = item;
		if (++nodes > budget.maxNodes || depth > budget.maxDepth) return "INPUT_BUDGET_EXCEEDED";
		if (typeof value === "string") {
			if (value.length > budget.maxStringLength) return "INPUT_BUDGET_EXCEEDED";
			bytes += JSON.stringify(value).length * 3;
		} else if (value === null || typeof value === "boolean") {
			bytes += 5;
		} else if (typeof value === "number") {
			if (!Number.isFinite(value)) return "INVALID_INPUT";
			bytes += 24;
		} else if (typeof value === "object") {
			if (seen.has(value)) return "INPUT_CYCLE";
			seen.add(value);
			const array = Array.isArray(value);
			if (
				!array &&
				Object.getPrototypeOf(value) !== Object.prototype &&
				Object.getPrototypeOf(value) !== null
			)
				return "INVALID_INPUT";
			if (array && value.length > budget.maxDependencies) return "INPUT_BUDGET_EXCEEDED";
			let count = 0;
			for (const key in value) {
				if (!Object.hasOwn(value, key)) return "INVALID_INPUT";
				if (++count + nodes + stack.length > budget.maxNodes || key.length > budget.maxStringLength)
					return "INPUT_BUDGET_EXCEEDED";
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor || !("value" in descriptor)) return "INVALID_INPUT";
				bytes += key.length * 6 + 4;
				stack.push({ value: descriptor.value, depth: depth + 1 });
			}
			if (array && count !== value.length) return "INVALID_INPUT";
			if (Object.getOwnPropertySymbols(value).length) return "INVALID_INPUT";
		} else return "INVALID_INPUT";
		if (bytes > budget.maxBytes) return "INPUT_BUDGET_EXCEEDED";
	}
	return null;
}

function failed(reasonCode: ReasonCode): ResourceDecouplingPlan {
	return {
		version: 1,
		fixtureId: "fixture:invalid",
		verdict: "blocked",
		resources: [],
		blockers: [{ resourceId: "fixture:input", reasonCode, diagnostic: messages[reasonCode] }],
		effects: [],
	};
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const unique = (values: readonly string[]) => new Set(values).size === values.length;

/** Pure analysis only: even complete receipts cannot make chapter-linked SQL rows detachable. */
export function planChapterResourceDecoupling(input: unknown): ResourceDecouplingPlan {
	let parsed: ReturnType<typeof resourceDecouplingInputSchema.safeParse>;
	try {
		const reason = preflight(input);
		if (reason) return failed(reason);
		parsed = resourceDecouplingInputSchema.safeParse(input);
	} catch {
		return failed("INVALID_INPUT");
	}
	if (!parsed.success) return failed("INVALID_INPUT");
	const data = parsed.data;
	const resources: ResourceDisposition[] = [];
	const blockers: DecouplingDiagnostic[] = [];
	const addBlocker = (resourceId: string, code: ReasonCode) => {
		if (!blockers.some((b) => b.resourceId === resourceId && b.reasonCode === code))
			blockers.push({ resourceId, reasonCode: code, diagnostic: messages[code] });
	};
	const globalCodes: ReasonCode[] = [];
	const global = (condition: boolean, code: ReasonCode) => {
		if (condition) {
			globalCodes.push(code);
			addBlocker(data.narrator.id, code);
		}
	};
	const m = data.manifest;
	const dependencyCount = data.objectDependencies.reduce((n, o) => n + o.dependencies.length, 0);
	if (dependencyCount > budget.maxDependencies) return failed("INPUT_BUDGET_EXCEEDED");
	global(
		!m.complete ||
			m.truncated ||
			m.resourceCount !== data.resources.length ||
			m.objectCount !== data.objectDependencies.length ||
			m.dependencyCount !== dependencyCount,
		"MANIFEST_INCOMPLETE",
	);
	global(m.aclRootId === null, "ACL_INCOMPLETE");
	global(!m.provenanceComplete, "PROVENANCE_INCOMPLETE");
	global(!m.sharedUsersComplete, "SHARED_USERS_INCOMPLETE");
	global(data.narrator.state !== "idle", "NARRATOR_NOT_IDLE");
	global(!["none", "released"].includes(data.narrator.lease), "LEASE_NOT_RELEASED");
	global(data.narrator.run !== "idle", "RUN_NOT_IDLE");
	global(data.narrator.authorization !== "clear", "AUTHORIZATION_PENDING");
	global(data.narrator.mutation !== "none", "MUTATION_UNKNOWN");
	global(data.chapter?.state === "unknown", "CHAPTER_UNKNOWN");
	const resourceMap = new Map(data.resources.map((r) => [r.id, r]));
	const objectMap = new Map(data.objectDependencies.map((o) => [o.id, o]));
	if (
		resourceMap.size !== data.resources.length ||
		objectMap.size !== data.objectDependencies.length ||
		!unique(data.resources.map((r) => r.referenceIdentity)) ||
		!unique(data.objectDependencies.map((o) => o.referenceIdentity)) ||
		data.resources.some((r) => objectMap.has(r.id)) ||
		resourceMap.has(data.narrator.id) ||
		objectMap.has(data.narrator.id)
	)
		return failed("DUPLICATE_IDENTITY");
	const context = data.workspaceContext;
	global(
		(data.narrator.chapterId !== null && data.narrator.chapterId !== data.chapter?.id) ||
			(data.chapter !== null && data.narrator.projectId !== data.chapter.projectId) ||
			(context !== null &&
				(!context.complete ||
					context.narratorId !== data.narrator.id ||
					context.chapterId !== data.narrator.chapterId ||
					context.projectId !== data.narrator.projectId ||
					!unique(context.resourceIds) ||
					context.resourceIds.some((id) => !resourceMap.has(id)))) ||
			(context === null && data.resources.some((r) => r.kind === "worktree")) ||
			(context !== null &&
				data.resources.some((r) => r.kind === "worktree" && !context.resourceIds.includes(r.id))),
		"CONTEXT_INCOMPLETE",
	);

	const narratorCodes: ReasonCode[] = [...globalCodes];
	if (data.narrator.chapterId !== null) {
		narratorCodes.push("NARRATOR_CHAPTER_NO_ACTION");
		addBlocker(data.narrator.id, "NARRATOR_CHAPTER_NO_ACTION");
	}
	resources.push({
		resourceId: data.narrator.id,
		kind: "narrator",
		disposition: globalCodes.length
			? "blocked"
			: data.narrator.chapterId !== null
				? "retain-legacy-binding"
				: "preserve-reference",
		referenceIdentity: data.narrator.id,
		targetIdentity: context?.id ?? data.narrator.id,
		reasonCodes: narratorCodes.length
			? [...new Set(narratorCodes)].sort(compare)
			: ["FIXTURE_REFERENCE_STABLE"],
		bindingConstraints: ["narrators.chapter_id: nullable, NO ACTION"],
		diagnostics: narratorCodes.length
			? [...new Set(narratorCodes)].sort(compare).map((c) => messages[c])
			: [messages.FIXTURE_REFERENCE_STABLE],
	});

	for (const r of data.resources) {
		const codes = new Set<ReasonCode>(globalCodes);
		const constraints: string[] = [];
		let retain = false;
		const issue = (condition: boolean, code: ReasonCode, legacy = false) => {
			if (condition) {
				codes.add(code);
				addBlocker(r.id, code);
				if (legacy) retain = true;
			}
		};
		issue(!r.sharedUsersComplete || r.sharedUserIds.length === 0, "SHARED_USERS_INCOMPLETE");
		issue(!r.provenanceComplete, "PROVENANCE_INCOMPLETE");
		issue(r.aclRootId === null || r.aclRootId !== m.aclRootId, "ACL_INCOMPLETE");
		issue(!unique(r.ownerNarratorIds) || !unique(r.sharedUserIds), "DUPLICATE_IDENTITY");
		issue(r.targetIdentity === null, "TARGET_IDENTITY_MISSING");
		issue(!r.metadataMappingComplete, "METADATA_MAPPING_INCOMPLETE");
		issue(
			r.ownerNarratorIds.length === 0 &&
				!(
					r.kind === "worktree" &&
					r.registry.ownerDeleted &&
					r.registry.ownerNarratorId === null &&
					r.sharedUsersComplete &&
					r.sharedUserIds.length > 0
				),
			"OWNER_UNKNOWN",
		);
		issue(
			r.ownerNarratorIds.length > 1 && (!r.sharedUsersComplete || r.sharedUserIds.length === 0),
			"SHARED_OWNER_UNPROVEN",
		);
		issue(
			(typeof r.bindings.chapterId === "string" && r.bindings.chapterId !== data.chapter?.id) ||
				(typeof r.bindings.projectId === "string" &&
					r.bindings.projectId !== data.narrator.projectId),
			"REFERENCE_MISMATCH",
		);
		const peers = r.sharedNarratorContexts ?? [];
		const deletedOwner =
			r.kind === "worktree" && r.registry.ownerDeleted && r.registry.ownerNarratorId === null;
		const mapping = r.resourceMapping;
		issue(
			mapping !== undefined &&
				(mapping.referenceIdentity !== r.referenceIdentity ||
					mapping.targetIdentity !== r.targetIdentity ||
					(r.kind === "worktree" &&
						(mapping.deviceId !== r.registry.deviceId ||
							mapping.repositoryId !== r.registry.repositoryId))),
			"SHARED_NARRATOR_EVIDENCE_MISMATCH",
		);
		issue(
			!unique(peers.map((p) => p.narratorId)) || !unique(peers.map((p) => p.contextId)),
			"SHARED_NARRATOR_EVIDENCE_MISMATCH",
		);
		for (const peer of peers) {
			issue(
				!peer.known ||
					!peer.complete ||
					!peer.provenanceComplete ||
					peer.evidenceSource === "none" ||
					peer.provenanceReceiptId === null ||
					peer.sharedAccess !== "allowed" ||
					peer.truncated ||
					peer.resourceMapping === null ||
					mapping === undefined ||
					peer.aclRootId === null ||
					peer.sharedUserIds.length === 0 ||
					!r.sharedUsersComplete,
				"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
			);
			issue(
				peer.narratorId === data.narrator.id ||
					peer.contextId === context?.id ||
					(peer.evidenceSource === "historical-deleted"
						? !deletedOwner || r.ownerNarratorIds.length !== 0
						: !r.ownerNarratorIds.includes(peer.narratorId)) ||
					(peer.evidenceSource === "current" && deletedOwner) ||
					(peer.resourceMapping !== null &&
						mapping !== undefined &&
						(Object.keys(mapping) as Array<keyof typeof mapping>).some(
							(key) => peer.resourceMapping?.[key] !== mapping[key],
						)) ||
					peer.aclRootId !== r.aclRootId ||
					!unique(peer.sharedUserIds) ||
					!unique(peer.resourceIds) ||
					!peer.resourceIds.includes(r.id) ||
					peer.resourceIds.some((id) => !resourceMap.has(id)) ||
					peer.sharedUserIds.some((id) => !r.sharedUserIds.includes(id)) ||
					(data.chapter !== null &&
						peer.chapterId === data.chapter.id &&
						peer.projectId !== data.chapter.projectId) ||
					(r.bindings.chapterId !== undefined && peer.chapterId !== r.bindings.chapterId) ||
					(r.bindings.projectId !== undefined && peer.projectId !== r.bindings.projectId),
				"SHARED_NARRATOR_EVIDENCE_MISMATCH",
			);
		}
		const validateNarratorBinding = (
			narratorId: string | null | undefined,
			registryOwner = false,
		) => {
			if (typeof narratorId !== "string") return;
			// Deleted-owner worktrees may still be observed by a known narrator. This is a
			// scope reference, not an inference that the observer has become the registry owner.
			const deletedOwnerObservation =
				!registryOwner &&
				r.kind === "worktree" &&
				r.registry.ownerDeleted &&
				r.registry.ownerNarratorId === null &&
				r.ownerNarratorIds.length === 0 &&
				narratorId === data.narrator.id;
			issue(
				!r.ownerNarratorIds.includes(narratorId) && !deletedOwnerObservation,
				"NARRATOR_BINDING_OWNER_MISMATCH",
			);
			if (narratorId === data.narrator.id) {
				issue(
					context === null ||
						!context.complete ||
						!context.resourceIds.includes(r.id) ||
						(r.bindings.chapterId !== undefined && context.chapterId !== r.bindings.chapterId) ||
						(r.bindings.projectId !== undefined && context.projectId !== r.bindings.projectId),
					"NARRATOR_BINDING_CONTEXT_MISMATCH",
				);
				return;
			}
			const matchingPeers = peers.filter((p) => p.narratorId === narratorId);
			issue(matchingPeers.length !== 1 || !matchingPeers[0]?.known, "NARRATOR_BINDING_UNKNOWN");
			issue(matchingPeers.length !== 1, "SHARED_NARRATOR_EVIDENCE_INCOMPLETE");
		};
		// Validate every narrator owner, even when neither binding nor registry names it.
		// Several narrators may belong to the same user; user counts prove nothing here.
		for (const ownerId of r.ownerNarratorIds) validateNarratorBinding(ownerId);
		validateNarratorBinding(r.bindings.narratorId);
		if (r.kind === "worktree") validateNarratorBinding(r.registry.ownerNarratorId, true);
		issue(
			deletedOwner && (peers.length !== 1 || peers[0]?.evidenceSource !== "historical-deleted"),
			"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
		);
		const referenced = (ids: string[], kind: ResourceDecouplingResource["kind"]) => {
			issue(!unique(ids), "DUPLICATE_IDENTITY");
			for (const id of ids) issue(resourceMap.get(id)?.kind !== kind, "REFERENCE_MISSING");
		};
		switch (r.kind) {
			case "worktree":
				constraints.push(
					"narrator_worktree_resources.owner_narrator_id: nullable, SET NULL; resource inventory survives owner deletion",
					"chapters.worktree_path: lifecycle reference, not resource ownership",
				);
				issue(r.registry.state !== "ready", "REGISTRY_NOT_READY");
				issue(r.rootObjectIds.length === 0, "OBJECT_UNAVAILABLE");
				issue(!unique(r.rootObjectIds), "DUPLICATE_IDENTITY");
				issue(
					r.rootObjectIds.some((id) => objectMap.get(id)?.kind !== "tree"),
					"REFERENCE_MISSING",
				);
				issue(
					(r.registry.ownerDeleted &&
						(r.registry.ownerNarratorId !== null || r.ownerNarratorIds.length !== 0)) ||
						(!r.registry.ownerDeleted &&
							(r.registry.ownerNarratorId === null ||
								!r.ownerNarratorIds.includes(r.registry.ownerNarratorId))),
					"REGISTRY_OWNER_MISMATCH",
				);
				if (r.registry.ownerDeleted) codes.add("OWNER_DELETED_REFERENCE_RETAINED");
				break;
			case "container":
				constraints.push("container_instances.chapter_id: NOT NULL, CASCADE");
				issue(true, "CONTAINER_CHAPTER_REQUIRED", true);
				issue(
					!r.container.referencesComplete ||
						!r.container.volumePrefixMapped ||
						r.container.serviceId === null ||
						r.container.composeProjectId === null,
					"CONTAINER_REFERENCES_INCOMPLETE",
				);
				issue(
					r.container.state === "running" || r.container.state === "unknown",
					"CONTAINER_NOT_QUIESCENT",
				);
				referenced(r.container.portIds, "port");
				referenced(r.container.volumeIds, "volume");
				for (const id of r.container.portIds) {
					const port = resourceMap.get(id);
					issue(
						port?.kind === "port" &&
							(port.port.containerId !== r.id || port.port.serviceId !== r.container.serviceId),
						"REFERENCE_MISMATCH",
					);
				}
				for (const id of r.container.volumeIds) {
					const volume = resourceMap.get(id);
					issue(
						volume?.kind === "volume" && !volume.volume.containerIds.includes(r.id),
						"REFERENCE_MISMATCH",
					);
				}
				break;
			case "port":
				constraints.push("port_allocations.chapter_id: nullable, CASCADE");
				issue(r.bindings.chapterId !== null, "PORT_CHAPTER_CASCADE", true);
				issue(
					!r.port.referencesComplete ||
						r.port.serviceId === null ||
						r.port.containerId === null ||
						(r.port.proxyExpected && r.port.proxyId === null),
					"PORT_REFERENCES_INCOMPLETE",
				);
				if (r.port.containerId !== null) {
					referenced([r.port.containerId], "container");
					const container = resourceMap.get(r.port.containerId);
					issue(
						container?.kind === "container" &&
							(!container.container.portIds.includes(r.id) ||
								container.container.serviceId !== r.port.serviceId),
						"REFERENCE_MISMATCH",
					);
				}
				break;
			case "terminal":
				constraints.push(
					"terminals.chapter_id: nullable, CASCADE",
					"terminals.narrator_id: nullable, NO ACTION",
					"terminal_view_state.chapter_id/narrator_id/user_id: CASCADE (not a terminal FK)",
				);
				issue(r.bindings.chapterId !== null, "TERMINAL_CHAPTER_CASCADE", true);
				if (r.bindings.narratorId !== null) codes.add("TERMINAL_NARRATOR_NO_ACTION");
				issue(
					r.terminal.state === "unknown" || r.terminal.location === "unknown",
					"TERMINAL_UNKNOWN",
				);
				issue(
					(r.terminal.state === "running" ||
						r.terminal.location === "remote" ||
						r.terminal.dtach) &&
						r.terminal.migrationReceiptId === null,
					"TERMINAL_RECEIPT_MISSING",
				);
				break;
			case "volume":
				constraints.push(
					"physical volume ownership/compose prefix: lifecycle metadata, not a detachable chapter FK",
					"volume_snapshots.project_id: NOT NULL, CASCADE; source_chapter_id: nullable, SET NULL",
					"volume_snapshot_applications.chapter_id/snapshot_id: NOT NULL, CASCADE",
				);
				issue(typeof r.bindings.chapterId === "string", "VOLUME_SNAPSHOT_CHAPTER_CASCADE", true);
				issue(
					!r.volume.ownershipMapped ||
						!r.volume.projectMapped ||
						r.volume.snapshotId === null ||
						!r.volume.snapshotApplicationMapped,
					"VOLUME_MAPPING_INCOMPLETE",
				);
				if (r.volume.snapshotId !== null)
					issue(!objectMap.has(r.volume.snapshotId), "REFERENCE_MISSING");
				referenced(r.volume.containerIds, "container");
				for (const id of r.volume.containerIds) {
					const container = resourceMap.get(id);
					issue(
						container?.kind === "container" && !container.container.volumeIds.includes(r.id),
						"REFERENCE_MISMATCH",
					);
				}
				break;
			case "legacy-binding":
				constraints.push(
					"historical chapter/workspace references: retained; no generic SET NULL migration",
				);
				issue(true, "LEGACY_BINDING_RETAINED", true);
				issue(
					!r.legacy.mappingsComplete || r.legacy.mappingReceiptId === null,
					"METADATA_MAPPING_INCOMPLETE",
				);
				break;
		}
		const reasonCodes = [...codes].sort(compare);
		const hardCodes = reasonCodes.filter(
			(c) =>
				![
					"CONTAINER_CHAPTER_REQUIRED",
					"PORT_CHAPTER_CASCADE",
					"TERMINAL_CHAPTER_CASCADE",
					"VOLUME_SNAPSHOT_CHAPTER_CASCADE",
					"LEGACY_BINDING_RETAINED",
					"OWNER_DELETED_REFERENCE_RETAINED",
					"TERMINAL_NARRATOR_NO_ACTION",
				].includes(c),
		);
		resources.push({
			resourceId: r.id,
			kind: r.kind,
			disposition: hardCodes.length
				? "blocked"
				: retain
					? "retain-legacy-binding"
					: "preserve-reference",
			referenceIdentity: r.referenceIdentity,
			targetIdentity: r.targetIdentity,
			reasonCodes: reasonCodes.length ? reasonCodes : ["FIXTURE_REFERENCE_STABLE"],
			bindingConstraints: constraints.sort(compare),
			diagnostics: reasonCodes.length
				? reasonCodes.map((c) => messages[c])
				: [messages.FIXTURE_REFERENCE_STABLE],
		});
	}

	// Kahn's algorithm uses O(nodes + edges) memory, without recursive DAG traversal.
	const indegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const o of data.objectDependencies) {
		indegree.set(o.id, o.dependencies.length);
		if (!unique(o.dependencies)) addBlocker(o.id, "DUPLICATE_IDENTITY");
		for (const id of o.dependencies) {
			if (!objectMap.has(id)) addBlocker(o.id, "REFERENCE_MISSING");
			const list = dependents.get(id) ?? [];
			list.push(o.id);
			dependents.set(id, list);
		}
	}
	const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
	const visited = new Set<string>();
	for (let i = 0; i < queue.length; i++) {
		const id = queue[i];
		if (id === undefined) continue;
		visited.add(id);
		for (const dependent of dependents.get(id) ?? []) {
			const remaining = (indegree.get(dependent) ?? 1) - 1;
			indegree.set(dependent, remaining);
			if (remaining === 0) queue.push(dependent);
		}
	}
	const missingGraph = data.objectDependencies.some((o) =>
		o.dependencies.some((id) => !objectMap.has(id)),
	);
	const unavailable = new Set(
		data.objectDependencies
			.filter(
				(o) =>
					!o.available ||
					!o.complete ||
					o.targetIdentity === null ||
					!unique(o.dependencies) ||
					!visited.has(o.id),
			)
			.map((o) => o.id),
	);
	const unavailableQueue = [...unavailable];
	for (let i = 0; i < unavailableQueue.length; i++) {
		const id = unavailableQueue[i];
		if (id === undefined) continue;
		for (const dependent of dependents.get(id) ?? []) {
			if (!unavailable.has(dependent)) {
				unavailable.add(dependent);
				unavailableQueue.push(dependent);
			}
		}
	}
	for (const o of data.objectDependencies) {
		const codes = new Set<ReasonCode>(globalCodes);
		if (unavailable.has(o.id) && o.available && o.complete)
			codes.add("OBJECT_DEPENDENCY_UNAVAILABLE");
		if (!o.available || !o.complete) codes.add("OBJECT_UNAVAILABLE");
		if (o.targetIdentity === null) codes.add("TARGET_IDENTITY_MISSING");
		if (o.dependencies.some((id) => !objectMap.has(id))) codes.add("REFERENCE_MISSING");
		if (!unique(o.dependencies)) codes.add("DUPLICATE_IDENTITY");
		if (!visited.has(o.id))
			codes.add(missingGraph ? "OBJECT_DEPENDENCY_UNRESOLVED" : "OBJECT_DEPENDENCY_CYCLE");
		for (const code of codes) addBlocker(o.id, code);
		const sorted = [...codes].sort(compare);
		resources.push({
			resourceId: o.id,
			kind: "object",
			disposition: sorted.length ? "blocked" : "preserve-reference",
			referenceIdentity: o.referenceIdentity,
			targetIdentity: o.targetIdentity,
			reasonCodes: sorted.length ? sorted : ["FIXTURE_REFERENCE_STABLE"],
			bindingConstraints: [
				"tree/blob/upload/ignored/lazy-fork references require a complete dependency manifest, not chapter_id rewriting",
			],
			diagnostics: sorted.length
				? sorted.map((c) => messages[c])
				: [messages.FIXTURE_REFERENCE_STABLE],
		});
	}
	// Snapshot-root failures affect dependent resource dispositions, not only the plan verdict.
	const objectResults = new Map(
		resources.filter((r) => r.kind === "object").map((r) => [r.resourceId, r]),
	);
	const resourceResults = new Map(
		resources.filter((r) => r.kind !== "object").map((r) => [r.resourceId, r]),
	);
	for (const r of data.resources) {
		const roots =
			r.kind === "worktree"
				? r.rootObjectIds
				: r.kind === "volume" && r.volume.snapshotId !== null
					? [r.volume.snapshotId]
					: [];
		if (!roots.some((id) => objectResults.get(id)?.disposition === "blocked")) continue;
		const result = resourceResults.get(r.id);
		if (!result) continue;
		const code: ReasonCode = "OBJECT_DEPENDENCY_UNAVAILABLE";
		addBlocker(r.id, code);
		result.disposition = "blocked";
		const reasonCodes = new Set(result.reasonCodes as ReasonCode[]);
		reasonCodes.delete("FIXTURE_REFERENCE_STABLE");
		reasonCodes.add(code);
		result.reasonCodes = [...reasonCodes].sort(compare);
		result.diagnostics = result.reasonCodes.map((c) => messages[c as ReasonCode]);
	}
	resources.sort((a, b) => compare(a.resourceId, b.resourceId));
	blockers.sort(
		(a, b) => compare(a.resourceId, b.resourceId) || compare(a.reasonCode, b.reasonCode),
	);
	return {
		version: 1,
		fixtureId: data.fixtureId,
		verdict: blockers.length ? "blocked" : "ready-for-fixture",
		resources,
		blockers,
		effects: [],
	};
}
