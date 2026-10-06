import { describe, expect, test } from "bun:test";
import { AuthorizationEvaluator } from "@server/lib/integrations/kernel/authorization";
import { CapabilityCatalog } from "@server/lib/integrations/kernel/catalog";
import {
	type AuthorizationEvaluationInput,
	BOUND_SCOPES_MAX_ITEMS,
	bindExecutionContext,
	executionContextSchema,
	wireExecutionContextSchema,
} from "@server/lib/integrations/kernel/types";
import { CANONICAL_CAPABILITY_DESCRIPTORS } from "@shared/integrations/capabilities";

function baseInput(): AuthorizationEvaluationInput {
	return {
		context: {
			subject: { type: "plugin_runtime", id: "runtime-1" },
			credential: { type: "runtime_credential", id: "credential-1" },
			authority: { id: "authority-1", revision: 7 },
			runtime: { type: "plugin", id: "runtime-1", generation: 2 },
			boundScopes: [{ type: "project", id: "project-1" }],
		},
		authority: {
			id: "authority-1",
			revision: 7,
			state: "active",
			subject: { type: "plugin_runtime", id: "runtime-1" },
			credential: { type: "runtime_credential", id: "credential-1" },
		},
		grants: [
			{
				id: "grant-1",
				authorityId: "authority-1",
				authorityRevision: 7,
				capability: "project.read",
				scope: { type: "project", id: "project-1" },
				constraints: {
					topics: ["project.updated"],
					methods: ["GET"],
					paths: ["/api/projects/project-1"],
					fields: ["id", "name"],
					providerIds: ["provider-1"],
					maxBytes: 1_024,
					maxRatePerSecond: 10,
				},
			},
		],
		requirement: {
			operation: "project.get",
			capability: "project.read",
			scope: { type: "project", id: "project-1" },
			resource: { type: "project", id: "project-1" },
			constraints: {
				topics: ["project.updated"],
				methods: ["GET"],
				paths: ["/api/projects/project-1"],
				fields: ["id"],
				providerIds: ["provider-1"],
				maxBytes: 512,
				maxRatePerSecond: 5,
			},
			deadlineAt: 200,
		},
		now: 100,
	};
}

function cloneInput(): AuthorizationEvaluationInput {
	return structuredClone(baseInput());
}

function expectDeniedAt(input: AuthorizationEvaluationInput, stage: string, code: string) {
	expect(new AuthorizationEvaluator().evaluate(input)).toMatchObject({
		allowed: false,
		stage,
		code,
	});
}

describe("integration kernel execution context", () => {
	test("rejects wire authority, runtime, extras, and oversized bound scopes", () => {
		const wire = {
			subject: { type: "oauth_grant" as const, id: "grant-1" },
			credential: { type: "oauth_token" as const, id: "token-1" },
			boundScopes: [{ type: "project" as const, id: "project-1" }],
		};
		expect(wireExecutionContextSchema.parse(wire)).toEqual(wire);
		expect(
			wireExecutionContextSchema.safeParse({ ...wire, authority: { id: "a", revision: 1 } })
				.success,
		).toBe(false);
		expect(
			wireExecutionContextSchema.safeParse({
				...wire,
				runtime: { type: "server", id: "server", generation: 1 },
			}).success,
		).toBe(false);
		expect(wireExecutionContextSchema.safeParse({ ...wire, role: "admin" }).success).toBe(false);
		expect(
			wireExecutionContextSchema.safeParse({
				...wire,
				boundScopes: Array.from({ length: BOUND_SCOPES_MAX_ITEMS + 1 }, (_, index) => ({
					type: "project",
					id: `project-${index}`,
				})),
			}).success,
		).toBe(false);

		const context = bindExecutionContext(
			wire,
			{ id: "authority-1", revision: 1 },
			{ type: "server", id: "server-1", generation: 4 },
		);
		expect(executionContextSchema.safeParse({ ...context, injected: true }).success).toBe(false);
	});
});

describe("integration kernel authorization evaluator", () => {
	test("allows an in-memory snapshot only when every stage passes", () => {
		expect(new AuthorizationEvaluator().evaluate(baseInput())).toEqual({
			allowed: true,
			grantId: "grant-1",
		});
	});

	test("fails closed in deadline/state/revision/capability/scope/resource/constraints order", () => {
		const deadline = cloneInput();
		deadline.now = 201;
		deadline.authority.state = "revoked";
		deadline.context.authority.revision = 8;
		expectDeniedAt(deadline, "deadline", "deadline_exceeded");

		const state = cloneInput();
		state.authority.state = "suspended";
		state.context.authority.revision = 8;
		state.requirement.capability = "missing.read";
		expectDeniedAt(state, "state", "authority_inactive");

		const revision = cloneInput();
		revision.context.authority.revision = 8;
		revision.requirement.capability = "missing.read";
		expectDeniedAt(revision, "revision", "authority_revision_mismatch");

		const capability = cloneInput();
		capability.requirement.capability = "missing.read";
		capability.grants[0].capability = "missing.read";
		expectDeniedAt(capability, "capability", "unknown_capability");

		const scope = cloneInput();
		scope.requirement.scope = { type: "project", id: "project-2" };
		scope.requirement.resource = { type: "project", id: "project-2" };
		expectDeniedAt(scope, "scope", "scope_not_bound");

		const resource = cloneInput();
		resource.context.boundScopes = [{ type: "global" }];
		resource.grants[0].scope = { type: "global" };
		resource.requirement.scope = { type: "global" };
		resource.requirement.resource = { type: "chapter", id: "chapter-1" };
		expectDeniedAt(resource, "resource", "resource_type_mismatch");

		const constraints = cloneInput();
		if (!constraints.requirement.constraints) throw new Error("fixture constraints missing");
		constraints.requirement.constraints.maxBytes = 2_048;
		expectDeniedAt(constraints, "constraints", "constraints_not_satisfied");
	});

	test("requires constrained operations to declare every bounded dimension", () => {
		const input = cloneInput();
		input.requirement.constraints = { maxBytes: 512 };
		expect(new AuthorizationEvaluator().evaluate(input)).toMatchObject({
			allowed: false,
			stage: "constraints",
			failedConstraint: "topics",
		});
	});

	test("treats unknown cross-type resource relations as denial", () => {
		const input = cloneInput();
		input.context.boundScopes = [{ type: "project", id: "project-1" }];
		input.grants = [
			{
				id: "grant-1",
				authorityId: "authority-1",
				authorityRevision: 7,
				capability: "chapter.read",
				scope: { type: "project", id: "project-1" },
			},
		];
		input.requirement = {
			operation: "chapter.get",
			capability: "chapter.read",
			scope: { type: "chapter", id: "chapter-1" },
			resource: { type: "chapter", id: "chapter-1" },
			deadlineAt: 200,
		};
		expectDeniedAt(input, "scope", "scope_relation_unknown");

		input.relationResolver = {
			resolve: (container, candidate) =>
				container.type === "project" && candidate.type === "chapter" ? "contains" : "not_contains",
		};
		expect(new AuthorizationEvaluator().evaluate(input)).toEqual({
			allowed: true,
			grantId: "grant-1",
		});
	});

	test("enforces descriptor allowedSubjects through an injectable catalog", () => {
		const descriptor = {
			...CANONICAL_CAPABILITY_DESCRIPTORS["project.read"],
			id: "project.runtime_read",
			i18nKey: "integrations.capabilities.project.runtime_read",
			allowedSubjects: ["plugin_runtime" as const],
		};
		const evaluator = new AuthorizationEvaluator(new CapabilityCatalog([descriptor]));
		const input = cloneInput();
		input.context.subject = { type: "oauth_grant", id: "oauth-grant-1" };
		input.authority.subject = { type: "oauth_grant", id: "oauth-grant-1" };
		input.grants[0].capability = descriptor.id;
		input.requirement.capability = descriptor.id;
		expect(evaluator.evaluate(input)).toMatchObject({
			allowed: false,
			stage: "capability",
			code: "subject_not_allowed",
		});
	});
});
