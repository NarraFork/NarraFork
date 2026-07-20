import { describe, expect, test } from "bun:test";
import {
	AuthorizationDecisionCache,
	buildAuthorizationCacheKey,
	buildAuthorizationCacheKeyParts,
} from "@server/lib/integrations/kernel/cache";
import {
	authorizationConstraintsSchema,
	CONSTRAINT_ARRAY_MAX_ITEMS,
	CONSTRAINT_MAX_BYTES,
	digestAuthorizationConstraints,
} from "@server/lib/integrations/kernel/limits";
import type { ExecutionContext, OperationRequirement } from "@server/lib/integrations/kernel/types";

function keyInput(): { context: ExecutionContext; requirement: OperationRequirement } {
	return {
		context: {
			subject: { type: "plugin_runtime", id: "subject-1" },
			credential: { type: "runtime_credential", id: "credential-1" },
			authority: { id: "authority-1", revision: 3 },
			runtime: { type: "plugin", id: "runtime-1", generation: 5 },
			boundScopes: [{ type: "project", id: "project-1" }],
		},
		requirement: {
			operation: "project.get",
			capability: "project.read",
			resource: { type: "project", id: "project-1" },
			scope: { type: "project", id: "project-1" },
			constraints: { fields: ["id"], maxBytes: 100 },
			deadlineAt: 1_000,
		},
	};
}

function changedKey(mutator: (input: ReturnType<typeof keyInput>) => void): string {
	const input = structuredClone(keyInput());
	mutator(input);
	return buildAuthorizationCacheKey(input);
}

describe("integration authorization constraints", () => {
	test("enforces hard limits for arrays, strings, bytes, rates, and strict fields", () => {
		expect(
			authorizationConstraintsSchema.safeParse({
				topics: Array.from({ length: CONSTRAINT_ARRAY_MAX_ITEMS + 1 }, (_, index) => `t.${index}`),
			}).success,
		).toBe(false);
		expect(authorizationConstraintsSchema.safeParse({ methods: ["1get"] }).success).toBe(false);
		expect(authorizationConstraintsSchema.safeParse({ paths: ["relative"] }).success).toBe(false);
		expect(authorizationConstraintsSchema.safeParse({ fields: ["x".repeat(201)] }).success).toBe(
			false,
		);
		expect(
			authorizationConstraintsSchema.safeParse({ providerIds: ["x".repeat(129)] }).success,
		).toBe(false);
		expect(
			authorizationConstraintsSchema.safeParse({ maxBytes: CONSTRAINT_MAX_BYTES + 1 }).success,
		).toBe(false);
		expect(authorizationConstraintsSchema.safeParse({ maxRatePerSecond: 10_001 }).success).toBe(
			false,
		);
		expect(authorizationConstraintsSchema.safeParse({ extra: true }).success).toBe(false);
	});

	test("produces an order-independent constraints digest", () => {
		expect(
			digestAuthorizationConstraints({ fields: ["name", "id"], methods: ["POST", "GET"] }),
		).toBe(digestAuthorizationConstraints({ fields: ["id", "name"], methods: ["GET", "POST"] }));
	});
});

describe("integration authorization cache", () => {
	test("keys every authority, identity, runtime, operation, resource, scope, and constraint input", () => {
		const base = buildAuthorizationCacheKey(keyInput());
		const variations = [
			changedKey((input) => {
				input.context.authority.id = "authority-2";
			}),
			changedKey((input) => {
				input.context.authority.revision += 1;
			}),
			changedKey((input) => {
				if (input.context.subject.type !== "system") input.context.subject.id = "subject-2";
			}),
			changedKey((input) => {
				if (input.context.credential.type !== "system") {
					input.context.credential.id = "credential-2";
				}
			}),
			changedKey((input) => {
				input.context.runtime.generation += 1;
			}),
			changedKey((input) => {
				input.requirement.operation = "project.list";
			}),
			changedKey((input) => {
				input.requirement.capability = "chapter.read";
			}),
			changedKey((input) => {
				input.requirement.resource.id = "project-2";
			}),
			changedKey((input) => {
				input.requirement.scope = { type: "global" };
			}),
			changedKey((input) => {
				input.context.boundScopes = [{ type: "global" }];
			}),
			changedKey((input) => {
				input.requirement.constraints = { fields: ["name"], maxBytes: 100 };
			}),
		];
		expect(new Set([base, ...variations]).size).toBe(variations.length + 1);
		expect(
			changedKey((input) => {
				input.requirement.deadlineAt += 1;
			}),
		).toBe(base);

		const parts = buildAuthorizationCacheKeyParts(keyInput());
		expect(parts).toMatchObject({
			authority: "authority-1",
			revision: 3,
			subject: "plugin_runtime:subject-1",
			credential: "runtime_credential:credential-1",
			runtime: "plugin:runtime-1",
			runtimeGeneration: 5,
			operation: "project.get",
			capability: "project.read",
			resource: "project:project-1",
			scope: "project:project-1",
			deadlineAt: 1_000,
		});
		expect(parts.constraintsDigest).toHaveLength(64);
	});

	test("invalidates independently by authority, credential, and runtime identity", () => {
		let now = 10;
		const cache = new AuthorizationDecisionCache<string>({
			maxEntries: 10,
			ttlMs: 100,
			now: () => now,
		});
		const authorityEntry = keyInput();
		const credentialEntry = structuredClone(keyInput());
		credentialEntry.context.authority.id = "authority-2";
		const runtimeEntry = structuredClone(keyInput());
		runtimeEntry.context.authority.id = "authority-3";
		runtimeEntry.context.credential = { type: "runtime_credential", id: "credential-2" };
		const nextRuntimeGeneration = structuredClone(runtimeEntry);
		nextRuntimeGeneration.context.authority.id = "authority-4";
		nextRuntimeGeneration.context.credential = {
			type: "runtime_credential",
			id: "credential-3",
		};
		nextRuntimeGeneration.context.runtime.generation += 1;

		cache.set(authorityEntry, "authority");
		cache.set(credentialEntry, "credential");
		cache.set(runtimeEntry, "runtime");
		cache.set(nextRuntimeGeneration, "next-runtime");
		expect(cache.size).toBe(4);
		expect(cache.invalidateAuthority("authority-1")).toBe(1);
		expect(cache.get(authorityEntry)).toBeUndefined();
		expect(cache.invalidateCredential({ type: "runtime_credential", id: "credential-1" })).toBe(1);
		expect(cache.get(credentialEntry)).toBeUndefined();
		expect(cache.invalidateRuntime(runtimeEntry.context.runtime)).toBe(2);
		expect(cache.size).toBe(0);

		cache.set(authorityEntry, "expires");
		now = 110;
		expect(cache.get(authorityEntry)).toBeUndefined();

		now = 10;
		const deadlineEntry = keyInput();
		deadlineEntry.requirement.deadlineAt = 50;
		cache.set(deadlineEntry, "deadline");
		now = 51;
		expect(cache.get(deadlineEntry)).toBeUndefined();
	});
});
