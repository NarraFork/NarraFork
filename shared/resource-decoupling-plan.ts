import { z } from "zod";

/** Fixture-only protocol. Identifiers are opaque labels, never host paths or real IDs. */
export const RESOURCE_DECOUPLING_BUDGET = {
	maxResources: 128,
	maxObjects: 512,
	maxDependencies: 2048,
	maxNodes: 24000,
	maxDepth: 12,
	maxBytes: 262144,
	maxStringLength: 160,
} as const;

const id = z.string().regex(/^fixture:[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/);
const nullableId = id.nullable();
const ids = z.array(id).max(RESOURCE_DECOUPLING_BUDGET.maxObjects);
// Only terminals have a narrator FK. Other optional fields are normalized scope evidence,
// not claims that container_instances/port_allocations/physical volumes have these columns.
const scopeFields = {
	chapterId: nullableId.optional(),
	narratorId: nullableId.optional(),
	projectId: nullableId.optional(),
};
const scopeBindings = z.strictObject(scopeFields);
const chapterBindings = z.strictObject({ ...scopeFields, chapterId: nullableId });
const terminalBindings = z.strictObject({
	...scopeFields,
	chapterId: nullableId,
	narratorId: nullableId,
});
/** Opaque normalized location labels; never actual filesystem paths or runtime handles. */
const resourceMapping = z.strictObject({
	deviceId: id,
	repositoryId: nullableId,
	workdirId: id,
	resourceKey: id,
	referenceIdentity: id,
	targetIdentity: nullableId,
});
const sharedNarratorContexts = z
	.array(
		z.strictObject({
			narratorId: id,
			contextId: id,
			chapterId: nullableId,
			projectId: nullableId,
			resourceIds: z.array(id).max(RESOURCE_DECOUPLING_BUDGET.maxResources),
			sharedUserIds: ids,
			aclRootId: nullableId,
			known: z.boolean(),
			complete: z.boolean(),
			provenanceComplete: z.boolean(),
			/** Trusted normalized DTO provenance, not inferred from owner/user cardinality. */
			evidenceSource: z.enum(["current", "historical-deleted", "none"]),
			provenanceReceiptId: nullableId,
			sharedAccess: z.enum(["allowed", "denied", "unknown"]),
			truncated: z.boolean(),
			resourceMapping: resourceMapping.nullable(),
		}),
	)
	.max(RESOURCE_DECOUPLING_BUDGET.maxResources);
const common = {
	id,
	referenceIdentity: id,
	targetIdentity: nullableId,
	/** Optional bounded evidence; owner/user ID lists alone never establish a peer context. */
	sharedNarratorContexts: sharedNarratorContexts.optional(),
	/** Required when external/historical owner evidence is used; root-owned DTOs stay supported. */
	resourceMapping: resourceMapping.optional(),
	ownerNarratorIds: ids,
	sharedUserIds: ids,
	sharedUsersComplete: z.boolean(),
	provenanceComplete: z.boolean(),
	aclRootId: nullableId,
	metadataMappingComplete: z.boolean(),
};
const resource = z.discriminatedUnion("kind", [
	z.strictObject({
		...common,
		kind: z.literal("worktree"),
		bindings: scopeBindings,
		/** Normalized snapshot roots, not columns claimed to exist in the registry. */
		rootObjectIds: ids,
		registry: z.strictObject({
			ownerNarratorId: nullableId,
			ownerDeleted: z.boolean(),
			state: z.enum(["preparing", "ready", "unknown"]),
			deviceId: id,
			repositoryId: id,
			createRequestId: id,
		}),
	}),
	z.strictObject({
		...common,
		kind: z.literal("container"),
		bindings: chapterBindings,
		container: z.strictObject({
			state: z.enum(["created", "running", "paused", "stopped", "removed", "unknown"]),
			serviceId: nullableId,
			composeProjectId: nullableId,
			volumePrefixMapped: z.boolean(),
			portIds: ids,
			volumeIds: ids,
			referencesComplete: z.boolean(),
		}),
	}),
	z.strictObject({
		...common,
		kind: z.literal("port"),
		bindings: chapterBindings,
		port: z.strictObject({
			serviceId: nullableId,
			proxyId: nullableId,
			proxyExpected: z.boolean(),
			containerId: nullableId,
			referencesComplete: z.boolean(),
		}),
	}),
	z.strictObject({
		...common,
		kind: z.literal("terminal"),
		bindings: terminalBindings,
		terminal: z.strictObject({
			state: z.enum(["running", "exited", "unknown"]),
			location: z.enum(["local", "remote", "unknown"]),
			dtach: z.boolean(),
			migrationReceiptId: nullableId,
		}),
	}),
	z.strictObject({
		...common,
		kind: z.literal("volume"),
		bindings: scopeBindings,
		volume: z.strictObject({
			ownershipMapped: z.boolean(),
			projectMapped: z.boolean(),
			snapshotId: nullableId,
			snapshotApplicationMapped: z.boolean(),
			containerIds: ids,
		}),
	}),
	z.strictObject({
		...common,
		kind: z.literal("legacy-binding"),
		bindings: scopeBindings,
		legacy: z.strictObject({ mappingsComplete: z.boolean(), mappingReceiptId: nullableId }),
	}),
]);

export const resourceDecouplingInputSchema = z.strictObject({
	version: z.literal(1),
	fixtureId: id,
	narrator: z.strictObject({
		id,
		chapterId: nullableId,
		projectId: nullableId,
		state: z.enum(["idle", "preparing", "running", "unknown"]),
		lease: z.enum(["none", "released", "active", "quarantined", "unknown"]),
		run: z.enum(["idle", "active", "unknown"]),
		authorization: z.enum(["clear", "pending", "approved-pending", "unknown"]),
		mutation: z.enum(["none", "unknown"]),
	}),
	chapter: z
		.strictObject({ id, projectId: id, state: z.enum(["active", "dormant", "merged", "unknown"]) })
		.nullable(),
	workspaceContext: z
		.strictObject({
			id,
			narratorId: id,
			chapterId: nullableId,
			projectId: nullableId,
			resourceIds: ids,
			complete: z.boolean(),
		})
		.nullable(),
	manifest: z.strictObject({
		complete: z.boolean(),
		truncated: z.boolean(),
		resourceCount: z.number().int().nonnegative().max(RESOURCE_DECOUPLING_BUDGET.maxResources),
		objectCount: z.number().int().nonnegative().max(RESOURCE_DECOUPLING_BUDGET.maxObjects),
		dependencyCount: z.number().int().nonnegative().max(RESOURCE_DECOUPLING_BUDGET.maxDependencies),
		aclRootId: nullableId,
		provenanceComplete: z.boolean(),
		sharedUsersComplete: z.boolean(),
	}),
	resources: z.array(resource).max(RESOURCE_DECOUPLING_BUDGET.maxResources),
	objectDependencies: z
		.array(
			z.strictObject({
				id,
				kind: z.enum(["tree", "blob", "upload", "binary", "ignored", "lazy-fork-metadata"]),
				dependencies: ids,
				available: z.boolean(),
				complete: z.boolean(),
				referenceIdentity: id,
				targetIdentity: nullableId,
			}),
		)
		.max(RESOURCE_DECOUPLING_BUDGET.maxObjects),
});

export type ResourceDecouplingInput = z.infer<typeof resourceDecouplingInputSchema>;
export type ResourceDecouplingResource = ResourceDecouplingInput["resources"][number];
export type DecouplingDisposition = "preserve-reference" | "retain-legacy-binding" | "blocked";
export interface DecouplingDiagnostic {
	resourceId: string;
	reasonCode: string;
	diagnostic: string;
}
export interface ResourceDisposition {
	resourceId: string;
	kind: ResourceDecouplingResource["kind"] | "narrator" | "object";
	disposition: DecouplingDisposition;
	referenceIdentity: string;
	targetIdentity: string | null;
	reasonCodes: string[];
	/** Actual current schema constraints; no statement here authorizes detaching them. */
	bindingConstraints: string[];
	diagnostics: string[];
}
export interface ResourceDecouplingPlan {
	version: 1;
	fixtureId: string;
	verdict: "ready-for-fixture" | "blocked";
	resources: ResourceDisposition[];
	blockers: DecouplingDiagnostic[];
	/** Deliberately uninhabited: this protocol cannot represent executable effects. */
	effects: never[];
}
