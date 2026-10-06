import { describe, expect, test } from "bun:test";
import {
	RESOURCE_DECOUPLING_BUDGET,
	type ResourceDecouplingInput,
	type ResourceDecouplingResource,
	resourceDecouplingInputSchema,
} from "../../shared/resource-decoupling-plan";
import legacyFixture from "../../tests/fixtures/resource-decoupling/legacy-runtime.json";
import ordinaryFixture from "../../tests/fixtures/resource-decoupling/ordinary.json";
import { planChapterResourceDecoupling } from "./resource-decoupling-planner";

function ordinary(): ResourceDecouplingInput {
	return resourceDecouplingInputSchema.parse(structuredClone(ordinaryFixture));
}
function legacy(): ResourceDecouplingInput {
	const input = ordinary();
	input.chapter = { ...legacyFixture.chapter, state: "active" };
	input.narrator.chapterId = input.chapter.id;
	input.narrator.projectId = input.chapter.projectId;
	if (!input.workspaceContext) throw new Error("Fixture context missing");
	input.workspaceContext.chapterId = input.chapter.id;
	input.workspaceContext.projectId = input.chapter.projectId;
	input.workspaceContext.resourceIds.push(...legacyFixture.resources.map((r) => r.id));
	for (const resource of input.resources) {
		resource.bindings.chapterId = input.chapter.id;
		resource.bindings.projectId = input.chapter.projectId;
	}
	const normalized = resourceDecouplingInputSchema.parse({
		...input,
		resources: [...input.resources, ...structuredClone(legacyFixture.resources)],
		manifest: {
			...input.manifest,
			resourceCount: input.resources.length + legacyFixture.resources.length,
		},
	});
	return normalized;
}
function resource<K extends ResourceDecouplingResource["kind"]>(
	input: ResourceDecouplingInput,
	kind: K,
): Extract<ResourceDecouplingResource, { kind: K }> {
	const result = input.resources.find((r) => r.kind === kind);
	if (!result) throw new Error(`Missing fixture resource ${kind}`);
	return result as Extract<ResourceDecouplingResource, { kind: K }>;
}
function bindExplicitPeer(
	input: ResourceDecouplingInput,
	kind: ResourceDecouplingResource["kind"],
): void {
	const r = resource(input, kind);
	if (r.kind === "legacy-binding") {
		r.metadataMappingComplete = true;
		r.legacy.mappingsComplete = true;
		r.legacy.mappingReceiptId = "fixture:legacy-receipt";
	}
	r.bindings.narratorId = "fixture:peer";
	r.ownerNarratorIds.push("fixture:peer");
	r.sharedUserIds.push("fixture:peer-user");
	r.resourceMapping = {
		deviceId: "fixture:local",
		repositoryId: r.kind === "worktree" ? r.registry.repositoryId : null,
		workdirId: "fixture:workdir",
		resourceKey: r.id,
		referenceIdentity: r.referenceIdentity,
		targetIdentity: r.targetIdentity,
	};
	r.sharedNarratorContexts = [
		{
			narratorId: "fixture:peer",
			contextId: "fixture:peer-context",
			chapterId: r.bindings.chapterId ?? input.narrator.chapterId,
			projectId: r.bindings.projectId ?? input.narrator.projectId,
			resourceIds: [r.id],
			sharedUserIds: ["fixture:peer-user"],
			aclRootId: r.aclRootId,
			known: true,
			complete: true,
			provenanceComplete: true,
			evidenceSource: "current",
			provenanceReceiptId: "fixture:peer-receipt",
			sharedAccess: "allowed",
			truncated: false,
			resourceMapping: structuredClone(r.resourceMapping),
		},
	];
}
function deletedOwnerFixture(): ResourceDecouplingInput {
	const input = ordinary();
	bindExplicitPeer(input, "worktree");
	const worktree = resource(input, "worktree");
	const peer = worktree.sharedNarratorContexts?.[0];
	if (!peer) throw new Error("Peer fixture absent");
	peer.evidenceSource = "historical-deleted";
	worktree.bindings.narratorId = input.narrator.id;
	worktree.registry.ownerNarratorId = null;
	worktree.registry.ownerDeleted = true;
	worktree.ownerNarratorIds = [];
	return input;
}
const ownerKinds = [
	"worktree",
	"terminal",
	"container",
	"port",
	"volume",
	"legacy-binding",
] as const;
type PeerEvidence = NonNullable<ResourceDecouplingResource["sharedNarratorContexts"]>[number];
type PeerMutation = (peer: PeerEvidence, resource: ResourceDecouplingResource) => void;
const ownerEvidenceCases: Array<[string, string, PeerMutation]> = [
	[
		"source none",
		"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
		(p) => {
			p.evidenceSource = "none";
		},
	],
	[
		"provenance receipt absent",
		"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
		(p) => {
			p.provenanceReceiptId = null;
		},
	],
	[
		"unknown peer",
		"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
		(p) => {
			p.known = false;
		},
	],
	[
		"incomplete context",
		"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
		(p) => {
			p.complete = false;
		},
	],
	[
		"incomplete provenance",
		"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
		(p) => {
			p.provenanceComplete = false;
		},
	],
	[
		"truncated context",
		"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
		(p) => {
			p.truncated = true;
		},
	],
	[
		"sharing denied",
		"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
		(p) => {
			p.sharedAccess = "denied";
		},
	],
	[
		"sharing unknown",
		"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
		(p) => {
			p.sharedAccess = "unknown";
		},
	],
	[
		"ACL unknown",
		"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
		(p) => {
			p.aclRootId = null;
		},
	],
	[
		"ACL mismatch",
		"SHARED_NARRATOR_EVIDENCE_MISMATCH",
		(p) => {
			p.aclRootId = "fixture:other-acl";
		},
	],
	[
		"mapping absent",
		"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
		(p) => {
			p.resourceMapping = null;
		},
	],
	[
		"source mapping absent",
		"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
		(_p, r) => {
			delete r.resourceMapping;
		},
	],
	[
		"device mismatch",
		"SHARED_NARRATOR_EVIDENCE_MISMATCH",
		(p) => {
			if (p.resourceMapping) p.resourceMapping.deviceId = "fixture:other-device";
		},
	],
	[
		"repository mismatch",
		"SHARED_NARRATOR_EVIDENCE_MISMATCH",
		(p) => {
			if (p.resourceMapping) p.resourceMapping.repositoryId = "fixture:other-repository";
		},
	],
	[
		"workdir mismatch",
		"SHARED_NARRATOR_EVIDENCE_MISMATCH",
		(p) => {
			if (p.resourceMapping) p.resourceMapping.workdirId = "fixture:other-workdir";
		},
	],
	[
		"resource key mismatch",
		"SHARED_NARRATOR_EVIDENCE_MISMATCH",
		(p) => {
			if (p.resourceMapping) p.resourceMapping.resourceKey = "fixture:other-key";
		},
	],
	[
		"reference mismatch",
		"SHARED_NARRATOR_EVIDENCE_MISMATCH",
		(p) => {
			if (p.resourceMapping) p.resourceMapping.referenceIdentity = "fixture:other-reference";
		},
	],
	[
		"target mismatch",
		"SHARED_NARRATOR_EVIDENCE_MISMATCH",
		(p) => {
			if (p.resourceMapping) p.resourceMapping.targetIdentity = "fixture:other-target";
		},
	],
	[
		"resource outside peer context",
		"SHARED_NARRATOR_EVIDENCE_MISMATCH",
		(p) => {
			p.resourceIds = [];
		},
	],
	[
		"historical evidence on live owner",
		"SHARED_NARRATOR_EVIDENCE_MISMATCH",
		(p) => {
			p.evidenceSource = "historical-deleted";
		},
	],
];
function deepFreeze(input: unknown): void {
	const queue = [input];
	const seen = new WeakSet<object>();
	for (let i = 0; i < queue.length; i++) {
		const value = queue[i];
		if (!value || typeof value !== "object" || seen.has(value)) continue;
		seen.add(value);
		queue.push(...Object.values(value));
		Object.freeze(value);
	}
}
/** Every JSON case also verifies deep-frozen input byte equality and effect emptiness. */
function plan(input: unknown) {
	const before = JSON.stringify(input);
	deepFreeze(input);
	const result = planChapterResourceDecoupling(input);
	expect(JSON.stringify(input)).toBe(before);
	expect(result.effects).toEqual([]);
	expect(Object.keys(result).sort()).toEqual([
		"blockers",
		"effects",
		"fixtureId",
		"resources",
		"verdict",
		"version",
	]);
	return result;
}
function expectBlocked(input: unknown, code: string) {
	const result = plan(input);
	expect(result.verdict).toBe("blocked");
	expect(result.blockers.some((b) => b.reasonCode === code)).toBe(true);
	return result;
}

type Mutation = (input: ResourceDecouplingInput) => void;
const globalCases: Array<[string, string, Mutation]> = [
	[
		"incomplete inventory",
		"MANIFEST_INCOMPLETE",
		(i) => {
			i.manifest.complete = false;
		},
	],
	[
		"truncated inventory",
		"MANIFEST_INCOMPLETE",
		(i) => {
			i.manifest.truncated = true;
		},
	],
	[
		"resource count mismatch",
		"MANIFEST_INCOMPLETE",
		(i) => {
			i.manifest.resourceCount++;
		},
	],
	[
		"object count mismatch",
		"MANIFEST_INCOMPLETE",
		(i) => {
			i.manifest.objectCount++;
		},
	],
	[
		"edge count mismatch",
		"MANIFEST_INCOMPLETE",
		(i) => {
			i.manifest.dependencyCount++;
		},
	],
	[
		"ACL unknown",
		"ACL_INCOMPLETE",
		(i) => {
			i.manifest.aclRootId = null;
		},
	],
	[
		"provenance unknown",
		"PROVENANCE_INCOMPLETE",
		(i) => {
			i.manifest.provenanceComplete = false;
		},
	],
	[
		"shared users unknown",
		"SHARED_USERS_INCOMPLETE",
		(i) => {
			i.manifest.sharedUsersComplete = false;
		},
	],
	[
		"narrator preparing",
		"NARRATOR_NOT_IDLE",
		(i) => {
			i.narrator.state = "preparing";
		},
	],
	[
		"narrator unknown",
		"NARRATOR_NOT_IDLE",
		(i) => {
			i.narrator.state = "unknown";
		},
	],
	[
		"narrator running",
		"NARRATOR_NOT_IDLE",
		(i) => {
			i.narrator.state = "running";
		},
	],
	[
		"active lease",
		"LEASE_NOT_RELEASED",
		(i) => {
			i.narrator.lease = "active";
		},
	],
	[
		"quarantined lease",
		"LEASE_NOT_RELEASED",
		(i) => {
			i.narrator.lease = "quarantined";
		},
	],
	[
		"unknown lease",
		"LEASE_NOT_RELEASED",
		(i) => {
			i.narrator.lease = "unknown";
		},
	],
	[
		"active run",
		"RUN_NOT_IDLE",
		(i) => {
			i.narrator.run = "active";
		},
	],
	[
		"unknown run",
		"RUN_NOT_IDLE",
		(i) => {
			i.narrator.run = "unknown";
		},
	],
	[
		"pending authorization",
		"AUTHORIZATION_PENDING",
		(i) => {
			i.narrator.authorization = "pending";
		},
	],
	[
		"approved pending authorization",
		"AUTHORIZATION_PENDING",
		(i) => {
			i.narrator.authorization = "approved-pending";
		},
	],
	[
		"unknown authorization",
		"AUTHORIZATION_PENDING",
		(i) => {
			i.narrator.authorization = "unknown";
		},
	],
	[
		"unknown mutation",
		"MUTATION_UNKNOWN",
		(i) => {
			i.narrator.mutation = "unknown";
		},
	],
	[
		"missing context with worktree",
		"CONTEXT_INCOMPLETE",
		(i) => {
			i.workspaceContext = null;
		},
	],
	[
		"incomplete context",
		"CONTEXT_INCOMPLETE",
		(i) => {
			if (i.workspaceContext) i.workspaceContext.complete = false;
		},
	],
	[
		"context owner mismatch",
		"CONTEXT_INCOMPLETE",
		(i) => {
			if (i.workspaceContext) i.workspaceContext.narratorId = "fixture:other";
		},
	],
	[
		"missing context reference",
		"CONTEXT_INCOMPLETE",
		(i) => {
			i.workspaceContext?.resourceIds.push("fixture:missing");
		},
	],
];

const resourceCases: Array<[string, string, Mutation]> = [
	[
		"registry preparing",
		"REGISTRY_NOT_READY",
		(i) => {
			resource(i, "worktree").registry.state = "preparing";
		},
	],
	[
		"registry unknown",
		"REGISTRY_NOT_READY",
		(i) => {
			resource(i, "worktree").registry.state = "unknown";
		},
	],
	[
		"registry owner mismatch",
		"REGISTRY_OWNER_MISMATCH",
		(i) => {
			resource(i, "worktree").registry.ownerNarratorId = "fixture:other";
		},
	],
	[
		"unknown worktree owner",
		"OWNER_UNKNOWN",
		(i) => {
			resource(i, "worktree").ownerNarratorIds = [];
		},
	],
	[
		"unknown shared users",
		"SHARED_USERS_INCOMPLETE",
		(i) => {
			resource(i, "worktree").sharedUsersComplete = false;
		},
	],
	[
		"multiple owners without per-narrator evidence",
		"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
		(i) => {
			resource(i, "worktree").ownerNarratorIds.push("fixture:peer");
		},
	],
	[
		"missing stable target",
		"TARGET_IDENTITY_MISSING",
		(i) => {
			resource(i, "worktree").targetIdentity = null;
		},
	],
	[
		"missing resource ACL",
		"ACL_INCOMPLETE",
		(i) => {
			resource(i, "worktree").aclRootId = null;
		},
	],
	[
		"mismatched resource ACL",
		"ACL_INCOMPLETE",
		(i) => {
			resource(i, "worktree").aclRootId = "fixture:other-acl";
		},
	],
	[
		"missing provenance",
		"PROVENANCE_INCOMPLETE",
		(i) => {
			resource(i, "worktree").provenanceComplete = false;
		},
	],
	[
		"missing metadata mapping",
		"METADATA_MAPPING_INCOMPLETE",
		(i) => {
			resource(i, "worktree").metadataMappingComplete = false;
		},
	],
	[
		"running terminal",
		"TERMINAL_RECEIPT_MISSING",
		(i) => {
			resource(i, "terminal").terminal.state = "running";
		},
	],
	[
		"remote terminal",
		"TERMINAL_RECEIPT_MISSING",
		(i) => {
			resource(i, "terminal").terminal.location = "remote";
		},
	],
	[
		"dtach terminal",
		"TERMINAL_RECEIPT_MISSING",
		(i) => {
			resource(i, "terminal").terminal.dtach = true;
		},
	],
	[
		"unknown terminal state",
		"TERMINAL_UNKNOWN",
		(i) => {
			resource(i, "terminal").terminal.state = "unknown";
		},
	],
	[
		"unknown terminal location",
		"TERMINAL_UNKNOWN",
		(i) => {
			resource(i, "terminal").terminal.location = "unknown";
		},
	],
];
const runtimeCases: Array<[string, string, Mutation]> = [
	[
		"missing compose identity",
		"CONTAINER_REFERENCES_INCOMPLETE",
		(i) => {
			resource(i, "container").container.composeProjectId = null;
		},
	],
	[
		"missing compose volume prefix",
		"CONTAINER_REFERENCES_INCOMPLETE",
		(i) => {
			resource(i, "container").container.volumePrefixMapped = false;
		},
	],
	[
		"missing container service",
		"CONTAINER_REFERENCES_INCOMPLETE",
		(i) => {
			resource(i, "container").container.serviceId = null;
		},
	],
	[
		"incomplete container references",
		"CONTAINER_REFERENCES_INCOMPLETE",
		(i) => {
			resource(i, "container").container.referencesComplete = false;
		},
	],
	[
		"running container",
		"CONTAINER_NOT_QUIESCENT",
		(i) => {
			resource(i, "container").container.state = "running";
		},
	],
	[
		"unknown container",
		"CONTAINER_NOT_QUIESCENT",
		(i) => {
			resource(i, "container").container.state = "unknown";
		},
	],
	[
		"missing container port",
		"REFERENCE_MISSING",
		(i) => {
			resource(i, "container").container.portIds.push("fixture:missing");
		},
	],
	[
		"missing container volume",
		"REFERENCE_MISSING",
		(i) => {
			resource(i, "container").container.volumeIds.push("fixture:missing");
		},
	],
	[
		"port proxy unknown",
		"PORT_REFERENCES_INCOMPLETE",
		(i) => {
			resource(i, "port").port.proxyId = null;
		},
	],
	[
		"port service unknown",
		"PORT_REFERENCES_INCOMPLETE",
		(i) => {
			resource(i, "port").port.serviceId = null;
		},
	],
	[
		"port references incomplete",
		"PORT_REFERENCES_INCOMPLETE",
		(i) => {
			resource(i, "port").port.referencesComplete = false;
		},
	],
	[
		"port container missing",
		"REFERENCE_MISSING",
		(i) => {
			resource(i, "port").port.containerId = "fixture:missing";
		},
	],
	[
		"port service mismatched",
		"REFERENCE_MISMATCH",
		(i) => {
			resource(i, "port").port.serviceId = "fixture:other-service";
		},
	],
	[
		"volume ownership unmapped",
		"VOLUME_MAPPING_INCOMPLETE",
		(i) => {
			resource(i, "volume").volume.ownershipMapped = false;
		},
	],
	[
		"volume project unmapped",
		"VOLUME_MAPPING_INCOMPLETE",
		(i) => {
			resource(i, "volume").volume.projectMapped = false;
		},
	],
	[
		"volume snapshot unmapped",
		"VOLUME_MAPPING_INCOMPLETE",
		(i) => {
			resource(i, "volume").volume.snapshotId = null;
		},
	],
	[
		"volume snapshot application unmapped",
		"VOLUME_MAPPING_INCOMPLETE",
		(i) => {
			resource(i, "volume").volume.snapshotApplicationMapped = false;
		},
	],
	[
		"volume snapshot absent",
		"REFERENCE_MISSING",
		(i) => {
			resource(i, "volume").volume.snapshotId = "fixture:missing";
		},
	],
	[
		"volume reverse link missing",
		"REFERENCE_MISMATCH",
		(i) => {
			resource(i, "volume").volume.containerIds = [];
		},
	],
];

describe("fixture-only chapter resource decoupling planner", () => {
	test("complete idle plain-local manifest accepts fixture only", () => {
		const result = plan(ordinary());
		expect(result.verdict).toBe("ready-for-fixture");
		expect(result.blockers).toEqual([]);
		expect(result.resources.every((r) => r.disposition === "preserve-reference")).toBe(true);
	});
	test("ordinary null project/context/chapter without runtime inventory", () => {
		const input = ordinary();
		input.resources = [];
		input.workspaceContext = null;
		input.manifest.resourceCount = 0;
		expect(plan(input).verdict).toBe("ready-for-fixture");
	});
	test("project-scoped ordinary narrator needs no fake chapter", () => {
		const input = ordinary();
		input.narrator.projectId = "fixture:project";
		if (input.workspaceContext) input.workspaceContext.projectId = "fixture:project";
		for (const r of input.resources) r.bindings.projectId = "fixture:project";
		expect(plan(input).verdict).toBe("ready-for-fixture");
	});
	test.each([
		"active",
		"dormant",
		"merged",
	] as const)("%s chapter retains actual SQL constraints", (state) => {
		const input = legacy();
		if (input.chapter) input.chapter.state = state;
		const result = plan(input);
		expect(result.verdict).toBe("blocked");
		for (const id of [
			"fixture:narrator",
			"fixture:container",
			"fixture:port",
			"fixture:terminal",
			"fixture:volume",
		])
			expect(result.resources.find((r) => r.resourceId === id)?.disposition).toBe(
				"retain-legacy-binding",
			);
		expect(
			result.resources.find((r) => r.resourceId === "fixture:container")?.bindingConstraints,
		).toContain("container_instances.chapter_id: NOT NULL, CASCADE");
	});
	test.each(globalCases)("fails closed: %s", (_name, code, mutate) => {
		const input = ordinary();
		mutate(input);
		expectBlocked(input, code);
	});
	test.each(resourceCases)("resource evidence: %s", (_name, code, mutate) => {
		const input = ordinary();
		mutate(input);
		expectBlocked(input, code);
	});
	test.each(runtimeCases)("runtime metadata: %s", (_name, code, mutate) => {
		const input = legacy();
		mutate(input);
		expectBlocked(input, code);
	});
	test("unknown chapter", () => {
		const input = legacy();
		if (input.chapter) input.chapter.state = "unknown";
		expectBlocked(input, "CHAPTER_UNKNOWN");
	});
	test("volume snapshot source SET NULL cannot stand in for application CASCADE migration", () => {
		const result = expectBlocked(legacy(), "VOLUME_SNAPSHOT_CHAPTER_CASCADE");
		const volume = result.resources.find((r) => r.resourceId === "fixture:volume");
		expect(volume?.disposition).toBe("retain-legacy-binding");
		expect(volume?.bindingConstraints).toContain(
			"volume_snapshots.project_id: NOT NULL, CASCADE; source_chapter_id: nullable, SET NULL",
		);
		expect(volume?.bindingConstraints).toContain(
			"volume_snapshot_applications.chapter_id/snapshot_id: NOT NULL, CASCADE",
		);
	});
	test("chapterId null is not a container detach", () => {
		const input = legacy();
		resource(input, "container").bindings.chapterId = null;
		expectBlocked(input, "CONTAINER_CHAPTER_REQUIRED");
	});
	test.each([
		"worktree",
		"terminal",
		"container",
		"port",
		"volume",
		"legacy-binding",
	] as const)("unknown narrator binding is rejected for %s", (kind) => {
		const input = kind === "worktree" || kind === "terminal" ? ordinary() : legacy();
		const r = resource(input, kind);
		r.bindings.narratorId = "fixture:missing";
		const result = expectBlocked(input, "NARRATOR_BINDING_UNKNOWN");
		expect(result.resources.find((d) => d.resourceId === r.id)?.disposition).toBe("blocked");
	});
	test.each([
		"worktree",
		"terminal",
		"container",
		"port",
		"volume",
		"legacy-binding",
	] as const)("owner list alone does not certify an external %s narrator", (kind) => {
		const input = kind === "worktree" || kind === "terminal" ? ordinary() : legacy();
		const r = resource(input, kind);
		r.bindings.narratorId = "fixture:peer";
		r.ownerNarratorIds = ["fixture:peer"];
		const result = expectBlocked(input, "SHARED_NARRATOR_EVIDENCE_INCOMPLETE");
		expect(result.resources.find((d) => d.resourceId === r.id)?.disposition).toBe("blocked");
	});
	test.each([
		"worktree",
		"terminal",
		"container",
		"port",
		"volume",
		"legacy-binding",
	] as const)("known owner binding needs context resource mapping for %s", (kind) => {
		const input = kind === "worktree" || kind === "terminal" ? ordinary() : legacy();
		const r = resource(input, kind);
		if (input.workspaceContext)
			input.workspaceContext.resourceIds = input.workspaceContext.resourceIds.filter(
				(id) => id !== r.id,
			);
		const result = expectBlocked(input, "NARRATOR_BINDING_CONTEXT_MISMATCH");
		expect(result.resources.find((d) => d.resourceId === r.id)?.disposition).toBe("blocked");
	});
	test.each([
		"worktree",
		"terminal",
		"container",
		"port",
		"volume",
		"legacy-binding",
	] as const)("known context cannot guess a conflicting %s owner", (kind) => {
		const input = kind === "worktree" || kind === "terminal" ? ordinary() : legacy();
		const r = resource(input, kind);
		r.ownerNarratorIds = ["fixture:other-owner"];
		expectBlocked(input, "NARRATOR_BINDING_OWNER_MISMATCH");
	});
	test.each([
		"worktree",
		"terminal",
		"container",
		"port",
		"volume",
		"legacy-binding",
	] as const)("explicit peer context mapping preserves existing %s constraints", (kind) => {
		const input = kind === "worktree" || kind === "terminal" ? ordinary() : legacy();
		bindExplicitPeer(input, kind);
		const result = plan(input);
		const r = resource(input, kind);
		expect(
			result.blockers.filter(
				(b) =>
					b.resourceId === r.id &&
					(b.reasonCode.startsWith("NARRATOR_BINDING_") ||
						b.reasonCode.startsWith("SHARED_NARRATOR_")),
			),
		).toEqual([]);
		if (kind === "worktree" || kind === "terminal")
			expect(result.verdict).toBe("ready-for-fixture");
	});
	test.each([
		[
			"unknown peer",
			"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
			(p) => {
				p.known = false;
			},
		],
		[
			"incomplete peer",
			"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
			(p) => {
				p.complete = false;
			},
		],
		[
			"missing peer provenance",
			"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
			(p) => {
				p.provenanceComplete = false;
			},
		],
		[
			"missing peer ACL",
			"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
			(p) => {
				p.aclRootId = null;
			},
		],
		[
			"conflicting peer ACL",
			"SHARED_NARRATOR_EVIDENCE_MISMATCH",
			(p) => {
				p.aclRootId = "fixture:other-acl";
			},
		],
		[
			"resource not in peer context",
			"SHARED_NARRATOR_EVIDENCE_MISMATCH",
			(p) => {
				p.resourceIds = [];
			},
		],
		[
			"unknown resource in peer context",
			"SHARED_NARRATOR_EVIDENCE_MISMATCH",
			(p) => {
				p.resourceIds.push("fixture:missing");
			},
		],
		[
			"missing peer users",
			"SHARED_NARRATOR_EVIDENCE_INCOMPLETE",
			(p) => {
				p.sharedUserIds = [];
			},
		],
		[
			"undeclared peer user",
			"SHARED_NARRATOR_EVIDENCE_MISMATCH",
			(p) => {
				p.sharedUserIds = ["fixture:missing-user"];
			},
		],
		[
			"contradictory peer chapter",
			"SHARED_NARRATOR_EVIDENCE_MISMATCH",
			(p) => {
				p.chapterId = "fixture:missing-chapter";
			},
		],
		[
			"contradictory peer project",
			"SHARED_NARRATOR_EVIDENCE_MISMATCH",
			(p) => {
				p.projectId = "fixture:missing-project";
			},
		],
		[
			"contradictory peer context identity",
			"SHARED_NARRATOR_EVIDENCE_MISMATCH",
			(p) => {
				p.contextId = "fixture:context";
			},
		],
		[
			"duplicate peer users",
			"SHARED_NARRATOR_EVIDENCE_MISMATCH",
			(p) => {
				p.sharedUserIds.push("fixture:peer-user");
			},
		],
		[
			"duplicate peer resource refs",
			"SHARED_NARRATOR_EVIDENCE_MISMATCH",
			(p) => {
				p.resourceIds.push("fixture:terminal");
			},
		],
	] satisfies Array<
		[
			string,
			string,
			(p: NonNullable<ResourceDecouplingResource["sharedNarratorContexts"]>[number]) => void,
		]
	>)("external sharing fails closed: %s", (_name, code, mutate) => {
		const input = ordinary();
		bindExplicitPeer(input, "terminal");
		const terminal = resource(input, "terminal");
		const peer = terminal.sharedNarratorContexts?.[0];
		if (!peer) throw new Error("Peer fixture absent");
		mutate(peer);
		const result = expectBlocked(input, code);
		expect(result.resources.find((d) => d.resourceId === terminal.id)?.disposition).toBe("blocked");
	});
	test("duplicate peer evidence is deterministic and cannot select the first trusted entry", () => {
		const input = ordinary();
		bindExplicitPeer(input, "terminal");
		const terminal = resource(input, "terminal");
		const peers = terminal.sharedNarratorContexts;
		if (!peers?.[0]) throw new Error("Peer fixture absent");
		peers.push({
			...structuredClone(peers[0]),
			contextId: "fixture:other-peer-context",
			known: false,
		});
		const expected = expectBlocked(input, "NARRATOR_BINDING_UNKNOWN");
		const reversed = structuredClone(input);
		resource(reversed, "terminal").sharedNarratorContexts?.reverse();
		expect(plan(reversed)).toEqual(expected);
	});
	test("shared evidence count is bounded", () => {
		const input = ordinary();
		bindExplicitPeer(input, "terminal");
		const terminal = resource(input, "terminal");
		const peer = terminal.sharedNarratorContexts?.[0];
		if (!peer) throw new Error("Peer fixture absent");
		terminal.sharedNarratorContexts = Array.from(
			{ length: RESOURCE_DECOUPLING_BUDGET.maxResources + 1 },
			() => ({
				...structuredClone(peer),
				resourceMapping: null,
				resourceIds: [],
				sharedUserIds: [],
			}),
		);
		expectBlocked(input, "INVALID_INPUT");
	});
	test("external registry owner needs explicit peer context, not merely a registry/owner match", () => {
		const input = ordinary();
		const worktree = resource(input, "worktree");
		worktree.registry.ownerNarratorId = "fixture:peer";
		worktree.ownerNarratorIds = ["fixture:narrator", "fixture:peer"];
		worktree.sharedUserIds.push("fixture:peer-user");
		expectBlocked(input, "NARRATOR_BINDING_UNKNOWN");
	});
	test("explicit peer registry ownership retains owner identity instead of transferring it", () => {
		const input = ordinary();
		bindExplicitPeer(input, "worktree");
		const worktree = resource(input, "worktree");
		worktree.registry.ownerNarratorId = "fixture:peer";
		expect(plan(input).verdict).toBe("ready-for-fixture");
		expect(worktree.registry.ownerNarratorId).toBe("fixture:peer");
	});
	test("missing actual terminal narrator FK field is invalid, while explicit null is supported", () => {
		const invalid = ordinary();
		Reflect.deleteProperty(resource(invalid, "terminal").bindings, "narratorId");
		expectBlocked(invalid, "INVALID_INPUT");
		const nullable = ordinary();
		resource(nullable, "terminal").bindings.narratorId = null;
		expect(plan(nullable).verdict).toBe("ready-for-fixture");
	});
	test("real FK-shaped DTOs do not invent narrator/project columns on containers, ports or physical volumes", () => {
		const input = legacy();
		for (const kind of ["container", "port", "volume"] as const) {
			const r = resource(input, kind);
			Reflect.deleteProperty(r.bindings, "narratorId");
			Reflect.deleteProperty(r.bindings, "projectId");
		}
		Reflect.deleteProperty(resource(input, "terminal").bindings, "projectId");
		const result = plan(input);
		expect(result.blockers.some((b) => b.reasonCode.startsWith("NARRATOR_BINDING_"))).toBe(false);
		for (const kind of ["container", "port", "volume", "terminal"] as const)
			expect(result.resources.find((d) => d.kind === kind)?.disposition).toBe(
				"retain-legacy-binding",
			);
	});
	test("worktree owner FK is in registry, not synthetic chapter/narrator/project columns", () => {
		const input = ordinary();
		resource(input, "worktree").bindings = {};
		expect(plan(input).verdict).toBe("ready-for-fixture");
	});
	test("unbound peer owner with two users is blocked without guessing context", () => {
		const input = ordinary();
		const worktree = resource(input, "worktree");
		worktree.ownerNarratorIds.push("fixture:peer");
		worktree.sharedUserIds.push("fixture:peer-user");
		const result = expectBlocked(input, "SHARED_NARRATOR_EVIDENCE_INCOMPLETE");
		expect(result.resources.find((r) => r.resourceId === worktree.id)?.disposition).toBe("blocked");
		expect(result.resources.find((r) => r.resourceId === worktree.id)?.targetIdentity).toBe(
			worktree.referenceIdentity,
		);
	});
	test("owner deletion without historical owner evidence blocks but preserves inventory", () => {
		const input = ordinary();
		const worktree = resource(input, "worktree");
		worktree.registry.ownerNarratorId = null;
		worktree.registry.ownerDeleted = true;
		worktree.ownerNarratorIds = [];
		const result = expectBlocked(input, "SHARED_NARRATOR_EVIDENCE_INCOMPLETE");
		expect(result.resources.find((r) => r.resourceId === worktree.id)?.reasonCodes).toContain(
			"OWNER_DELETED_REFERENCE_RETAINED",
		);
		expect(result.resources.find((r) => r.resourceId === worktree.id)?.disposition).toBe("blocked");
	});
	test("historical deleted-owner receipt preserves reference without assigning a live owner", () => {
		const input = deletedOwnerFixture();
		const worktree = resource(input, "worktree");
		const result = plan(input);
		expect(result.verdict).toBe("ready-for-fixture");
		expect(result.resources.find((r) => r.resourceId === worktree.id)?.disposition).toBe(
			"preserve-reference",
		);
		expect(worktree.ownerNarratorIds).toEqual([]);
	});
	for (const kind of ownerKinds) {
		test(`${kind}: every unbound owner needs evidence despite many users`, () => {
			const input = kind === "worktree" || kind === "terminal" ? ordinary() : legacy();
			const r = resource(input, kind);
			r.ownerNarratorIds.push("fixture:unknown-peer");
			r.sharedUserIds.push("fixture:peer-user", "fixture:third-user");
			const result = expectBlocked(input, "SHARED_NARRATOR_EVIDENCE_INCOMPLETE");
			expect(result.resources.find((d) => d.resourceId === r.id)?.disposition).toBe("blocked");
		});
		test(`${kind}: complete unbound shared owner preserves reference and SQL constraints`, () => {
			const input = kind === "worktree" || kind === "terminal" ? ordinary() : legacy();
			bindExplicitPeer(input, kind);
			const r = resource(input, kind);
			r.bindings.narratorId = input.narrator.id;
			const result = plan(input);
			const d = result.resources.find((d) => d.resourceId === r.id);
			expect(
				d?.reasonCodes.some(
					(c) => c.startsWith("SHARED_NARRATOR_") || c.startsWith("NARRATOR_BINDING_"),
				),
			).toBe(false);
			expect(d?.referenceIdentity).toBe(r.referenceIdentity);
			if (kind === "worktree" || kind === "terminal")
				expect(result.verdict).toBe("ready-for-fixture");
			else expect(d?.disposition).toBe("retain-legacy-binding");
		});
		test(`${kind}: two narrators sharing one user still need each owner's evidence`, () => {
			const input = kind === "worktree" || kind === "terminal" ? ordinary() : legacy();
			bindExplicitPeer(input, kind);
			const r = resource(input, kind);
			r.bindings.narratorId = input.narrator.id;
			r.sharedUserIds = ["fixture:user"];
			const peer = r.sharedNarratorContexts?.[0];
			if (!peer) throw new Error("Peer fixture absent");
			peer.sharedUserIds = ["fixture:user"];
			const result = plan(input);
			expect(result.resources.find((d) => d.resourceId === r.id)?.disposition).not.toBe("blocked");
			const missing = structuredClone(input);
			delete resource(missing, kind).sharedNarratorContexts;
			expectBlocked(missing, "SHARED_NARRATOR_EVIDENCE_INCOMPLETE");
		});
		test(`${kind}: one missing owner among three cannot borrow another peer proof`, () => {
			const input = kind === "worktree" || kind === "terminal" ? ordinary() : legacy();
			bindExplicitPeer(input, kind);
			const r = resource(input, kind);
			r.bindings.narratorId = input.narrator.id;
			r.ownerNarratorIds.push("fixture:unproven-third");
			const result = expectBlocked(input, "SHARED_NARRATOR_EVIDENCE_INCOMPLETE");
			expect(result.resources.find((d) => d.resourceId === r.id)?.disposition).toBe("blocked");
		});
		test.each(
			ownerEvidenceCases,
		)(`${kind}: unbound owner fails closed on %s`, (_name, code, mutate) => {
			const input = kind === "worktree" || kind === "terminal" ? ordinary() : legacy();
			bindExplicitPeer(input, kind);
			const r = resource(input, kind);
			r.bindings.narratorId = input.narrator.id;
			const peer = r.sharedNarratorContexts?.[0];
			if (!peer) throw new Error("Peer fixture absent");
			mutate(peer, r);
			const result = expectBlocked(input, code);
			expect(result.resources.find((d) => d.resourceId === r.id)?.disposition).toBe("blocked");
		});
	}
	test("three complete owners on one device/workdir remain ready and order-independent", () => {
		const input = ordinary();
		bindExplicitPeer(input, "worktree");
		const worktree = resource(input, "worktree");
		const peer = worktree.sharedNarratorContexts?.[0];
		if (!peer || !worktree.sharedNarratorContexts) throw new Error("Peer fixture absent");
		worktree.bindings.narratorId = input.narrator.id;
		worktree.ownerNarratorIds.push("fixture:third");
		worktree.sharedUserIds.push("fixture:third-user");
		worktree.sharedNarratorContexts.push({
			...structuredClone(peer),
			narratorId: "fixture:third",
			contextId: "fixture:third-context",
			provenanceReceiptId: "fixture:third-receipt",
			sharedUserIds: ["fixture:third-user"],
		});
		const expected = plan(input);
		expect(expected.verdict).toBe("ready-for-fixture");
		const reversed = structuredClone(input);
		const reversedWorktree = resource(reversed, "worktree");
		reversedWorktree.ownerNarratorIds.reverse();
		reversedWorktree.sharedUserIds.reverse();
		reversedWorktree.sharedNarratorContexts?.reverse();
		expect(plan(reversed)).toEqual(expected);
	});
	test.each(
		ownerEvidenceCases.filter(([name]) => name !== "historical evidence on live owner"),
	)("historical deleted owner fails closed on %s", (_name, code, mutate) => {
		const input = deletedOwnerFixture();
		const worktree = resource(input, "worktree");
		const peer = worktree.sharedNarratorContexts?.[0];
		if (!peer) throw new Error("Peer fixture absent");
		mutate(peer, worktree);
		const result = expectBlocked(input, code);
		expect(result.resources.find((d) => d.resourceId === worktree.id)?.disposition).toBe("blocked");
	});
	test("current peer receipt cannot substitute for historical deleted-owner provenance", () => {
		const input = deletedOwnerFixture();
		const peer = resource(input, "worktree").sharedNarratorContexts?.[0];
		if (!peer) throw new Error("Peer fixture absent");
		peer.evidenceSource = "current";
		expectBlocked(input, "SHARED_NARRATOR_EVIDENCE_MISMATCH");
	});
	test.each([
		"preparing",
		"unknown",
	] as const)("historical owner cannot accept %s registry", (state) => {
		const input = deletedOwnerFixture();
		resource(input, "worktree").registry.state = state;
		expectBlocked(input, "REGISTRY_NOT_READY");
	});
	test("missing root context cannot be replaced by complete peer evidence", () => {
		const input = ordinary();
		bindExplicitPeer(input, "worktree");
		input.workspaceContext = null;
		expectBlocked(input, "NARRATOR_BINDING_CONTEXT_MISMATCH");
	});
	test.each([
		"preparing",
		"unknown",
	] as const)("shared owner proof cannot accept %s registry", (state) => {
		const input = ordinary();
		bindExplicitPeer(input, "worktree");
		resource(input, "worktree").registry.state = state;
		expectBlocked(input, "REGISTRY_NOT_READY");
	});
	test.each([
		"deviceId",
		"repositoryId",
	] as const)("peer/source agreement cannot contradict registry %s", (key) => {
		const input = ordinary();
		bindExplicitPeer(input, "worktree");
		const worktree = resource(input, "worktree");
		const mapping = worktree.resourceMapping;
		const peerMapping = worktree.sharedNarratorContexts?.[0]?.resourceMapping;
		if (!mapping || !peerMapping) throw new Error("Mapping fixture absent");
		mapping[key] = "fixture:other";
		peerMapping[key] = "fixture:other";
		expectBlocked(input, "SHARED_NARRATOR_EVIDENCE_MISMATCH");
	});
	test("peer mapping rejects unexpected fields instead of accepting an unnormalized receipt", () => {
		const input = ordinary();
		bindExplicitPeer(input, "worktree");
		const mapping = resource(input, "worktree").sharedNarratorContexts?.[0]?.resourceMapping;
		if (!mapping) throw new Error("Mapping fixture absent");
		Reflect.set(mapping, "actualPath", "/must-not-use");
		expectBlocked(input, "INVALID_INPUT");
	});
	test("deleted owner cannot silently retain contradictory live ownership", () => {
		const input = ordinary();
		const worktree = resource(input, "worktree");
		worktree.registry.ownerNarratorId = null;
		worktree.registry.ownerDeleted = true;
		expectBlocked(input, "REGISTRY_OWNER_MISMATCH");
	});
	test("owner null without deletion provenance is not cleanup evidence", () => {
		const input = ordinary();
		const worktree = resource(input, "worktree");
		worktree.registry.ownerNarratorId = null;
		worktree.ownerNarratorIds = [];
		expectBlocked(input, "OWNER_UNKNOWN");
	});
	test("deleted owner incomplete sharing is blocked", () => {
		const input = ordinary();
		const worktree = resource(input, "worktree");
		worktree.registry.ownerNarratorId = null;
		worktree.registry.ownerDeleted = true;
		worktree.ownerNarratorIds = [];
		worktree.sharedUserIds = [];
		expectBlocked(input, "OWNER_UNKNOWN");
	});
	test.each([
		"binary",
		"ignored",
		"tree",
		"blob",
		"upload",
		"lazy-fork-metadata",
	] as const)("missing %s object blocks transitive tree refs", (kind) => {
		const input = ordinary();
		const object = input.objectDependencies.find((o) => o.kind === kind);
		if (!object) throw new Error("Fixture object absent");
		object.available = false;
		const result = expectBlocked(input, "OBJECT_UNAVAILABLE");
		expect(result.resources.find((r) => r.resourceId === "fixture:tree")?.disposition).toBe(
			"blocked",
		);
		expect(result.resources.find((r) => r.resourceId === "fixture:worktree")?.disposition).toBe(
			"blocked",
		);
	});
	test("empty snapshot roots cannot certify a worktree", () => {
		const input = ordinary();
		resource(input, "worktree").rootObjectIds = [];
		expectBlocked(input, "OBJECT_UNAVAILABLE");
	});
	test("missing tree root mapping is blocked", () => {
		const input = ordinary();
		resource(input, "worktree").rootObjectIds = ["fixture:missing-tree"];
		expectBlocked(input, "REFERENCE_MISSING");
	});
	test("missing snapshot target mapping propagates to parent and worktree", () => {
		const input = ordinary();
		const upload = input.objectDependencies.find((o) => o.kind === "upload");
		if (!upload) throw new Error("Fixture upload missing");
		upload.targetIdentity = null;
		const result = expectBlocked(input, "TARGET_IDENTITY_MISSING");
		for (const id of ["fixture:fork", "fixture:tree", "fixture:worktree"])
			expect(result.resources.find((r) => r.resourceId === id)?.disposition).toBe("blocked");
	});
	test("unavailable snapshot blocks dependent volume disposition", () => {
		const input = legacy();
		const binary = input.objectDependencies.find((o) => o.kind === "binary");
		if (!binary) throw new Error("Fixture binary missing");
		binary.complete = false;
		const result = expectBlocked(input, "OBJECT_UNAVAILABLE");
		expect(result.resources.find((r) => r.resourceId === "fixture:volume")?.disposition).toBe(
			"blocked",
		);
	});
	test("missing object dependency is not silently dropped", () => {
		const input = ordinary();
		input.objectDependencies[0]?.dependencies.push("fixture:missing");
		input.manifest.dependencyCount++;
		expectBlocked(input, "REFERENCE_MISSING");
	});
	test("cyclic object DAG is blocked", () => {
		const input = ordinary();
		input.objectDependencies[1]?.dependencies.push("fixture:tree");
		input.manifest.dependencyCount++;
		expectBlocked(input, "OBJECT_DEPENDENCY_CYCLE");
	});
	test("duplicate dependency is blocked", () => {
		const input = ordinary();
		input.objectDependencies[0]?.dependencies.push("fixture:blob");
		input.manifest.dependencyCount++;
		expectBlocked(input, "DUPLICATE_IDENTITY");
	});
	test("duplicate resource identity is blocked", () => {
		const input = ordinary();
		input.resources.push(structuredClone(input.resources[0]));
		input.manifest.resourceCount++;
		expectBlocked(input, "DUPLICATE_IDENTITY");
	});
	test("receipt maps remote/dtach metadata but cannot detach chapter FK", () => {
		const input = legacy();
		const terminal = resource(input, "terminal");
		terminal.terminal.state = "running";
		terminal.terminal.location = "remote";
		terminal.terminal.dtach = true;
		terminal.terminal.migrationReceiptId = "fixture:receipt";
		const result = plan(input);
		const disposition = result.resources.find((r) => r.resourceId === terminal.id);
		expect(disposition?.disposition).toBe("retain-legacy-binding");
		expect(disposition?.reasonCodes).not.toContain("TERMINAL_RECEIPT_MISSING");
	});
	test("historical mapping receipt retains legacy references, not production apply", () => {
		const input = legacy();
		const historical = resource(input, "legacy-binding");
		historical.metadataMappingComplete = true;
		historical.legacy.mappingsComplete = true;
		historical.legacy.mappingReceiptId = "fixture:receipt";
		const result = plan(input);
		const disposition = result.resources.find((r) => r.resourceId === historical.id);
		expect(disposition?.disposition).toBe("retain-legacy-binding");
		expect(disposition?.diagnostics.join(" ")).toContain("restore metadata");
	});
	test("fixture metadata detach/restore preserves container/volume/port refs and failure leaves baseline unchanged", () => {
		const baseline = legacy();
		const bytes = JSON.stringify(baseline);
		const expected = plan(baseline);
		const detached = structuredClone(baseline);
		detached.narrator.chapterId = null;
		if (detached.workspaceContext) detached.workspaceContext.chapterId = null;
		const staged = plan(detached);
		expect(staged.verdict).toBe("blocked");
		for (const kind of ["container", "volume", "port"] as const) {
			expect(resource(detached, kind)).toEqual(resource(baseline, kind));
			expect(staged.resources.find((r) => r.kind === kind)?.referenceIdentity).toBe(
				resource(baseline, kind).referenceIdentity,
			);
		}
		// Simulated rollback discards staged DTO, never restores real runtime resources.
		const restored = structuredClone(detached);
		restored.narrator.chapterId = baseline.narrator.chapterId;
		if (restored.workspaceContext)
			restored.workspaceContext.chapterId = baseline.workspaceContext?.chapterId ?? null;
		expect(plan(restored)).toEqual(expected);
		expect(JSON.stringify(baseline)).toBe(bytes);
	});
	test("stable deterministic ordering independent of manifest ordering", () => {
		const input = legacy();
		const expected = plan(input);
		const reversed = structuredClone(input);
		reversed.resources.reverse();
		reversed.objectDependencies.reverse();
		for (const object of reversed.objectDependencies) object.dependencies.reverse();
		const result = plan(reversed);
		expect(result).toEqual(expected);
		expect(plan(structuredClone(reversed))).toEqual(expected);
		expect(result.resources.map((r) => r.resourceId)).toEqual(
			result.resources.map((r) => r.resourceId).sort(),
		);
	});
	test.each([
		null,
		1,
		"fixture:input",
		{},
		{ version: 2 },
		{ ...ordinaryFixture, unexpected: true },
		{ ...ordinaryFixture, narrator: { ...ordinaryFixture.narrator, state: "invented" } },
	])("invalid/missing/unknown DTO: %j", (input) => {
		expectBlocked(input, "INVALID_INPUT");
	});
	test.each([
		"real-user-id",
		"/home/private-account/worktree",
		"fixture:/host-path",
	])("nonfixture IDs do not leak diagnostics: %s", (value) => {
		const input = ordinary();
		input.fixtureId = value;
		const result = expectBlocked(input, "INVALID_INPUT");
		expect(JSON.stringify(result)).not.toContain(value);
		expect(result.fixtureId).toBe("fixture:invalid");
	});
	test("nonfixture nested resource ID is rejected", () => {
		const input = ordinary();
		resource(input, "worktree").registry.repositoryId = "/real/repository";
		const result = expectBlocked(input, "INVALID_INPUT");
		expect(JSON.stringify(result)).not.toContain("/real/repository");
	});
	test.each([Number.MAX_SAFE_INTEGER, -1, Infinity, NaN])("invalid/unbounded count %s", (count) => {
		const input = ordinary();
		input.manifest.dependencyCount = count;
		const result = plan(input);
		expect(result.verdict).toBe("blocked");
	});
	test("oversized array refused before recursive parser", () => {
		const input = {
			...ordinaryFixture,
			resources: new Array(RESOURCE_DECOUPLING_BUDGET.maxDependencies + 1).fill(null),
		};
		expectBlocked(input, "INPUT_BUDGET_EXCEEDED");
	});
	test("overlong string refused without echo", () => {
		const input = ordinary();
		input.fixtureId = "x".repeat(161);
		expectBlocked(input, "INPUT_BUDGET_EXCEEDED");
	});
	test("deep hostile input refused without recursive traversal", () => {
		const input: Record<string, unknown> = {};
		let current = input;
		for (let i = 0; i < 10000; i++) {
			const next = {};
			current.next = next;
			current = next;
		}
		const result = planChapterResourceDecoupling(input);
		expect(result.verdict).toBe("blocked");
		expect(result.blockers[0]?.reasonCode).toBe("INPUT_BUDGET_EXCEEDED");
		expect(result.effects).toEqual([]);
	});
	test("input cycle refused without serialization or mutation", () => {
		const input: Record<string, unknown> = {};
		input.self = input;
		Object.freeze(input);
		const result = planChapterResourceDecoupling(input);
		expect(result.blockers[0]?.reasonCode).toBe("INPUT_CYCLE");
		expect(result.effects).toEqual([]);
		expect(input.self).toBe(input);
	});
	test("getter cannot execute while normalizing DTO", () => {
		let reads = 0;
		const input = { ...ordinaryFixture };
		Object.defineProperty(input, "fixtureId", {
			enumerable: true,
			get() {
				reads++;
				return "fixture:unsafe";
			},
		});
		const result = planChapterResourceDecoupling(input);
		expect(result.verdict).toBe("blocked");
		expect(reads).toBe(0);
		expect(result.effects).toEqual([]);
	});
	test("bounded linear DAG uses iterative planning", () => {
		const input = ordinary();
		input.objectDependencies = Array.from({ length: 100 }, (_, n) => ({
			id: `fixture:node-${n}`,
			kind: "tree",
			dependencies: n ? [`fixture:node-${n - 1}`] : [],
			available: true,
			complete: true,
			referenceIdentity: `fixture:ref-${n}`,
			targetIdentity: `fixture:ref-${n}`,
		}));
		input.manifest.objectCount = 100;
		input.manifest.dependencyCount = 99;
		resource(input, "worktree").rootObjectIds = ["fixture:node-99"];
		expect(plan(input).verdict).toBe("ready-for-fixture");
	});
	test("maximum aggregate dependency budget enforced before graph work", () => {
		const input = ordinary();
		input.objectDependencies = Array.from({ length: 60 }, (_, n) => ({
			id: `fixture:n${n}`,
			kind: "tree",
			dependencies: Array.from({ length: 35 }, (_, d) => `fixture:n${d}`),
			available: true,
			complete: true,
			referenceIdentity: `fixture:r${n}`,
			targetIdentity: `fixture:r${n}`,
		}));
		input.manifest.objectCount = 60;
		input.manifest.dependencyCount = 2048;
		expectBlocked(input, "INPUT_BUDGET_EXCEEDED");
	});
});
