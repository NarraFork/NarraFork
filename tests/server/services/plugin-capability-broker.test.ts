import { describe, expect, test } from "bun:test";
import type { PermissionGrant } from "@server/lib/plugins/permissions";
import {
	CapabilityBroker,
	type HostCallContext,
	invocationPrincipalSchema,
	pluginPrincipalSchema,
} from "@server/services/plugin-capability-broker";

const capability = "query.read.projects" as const;
const otherCapability = "query.read.chapters" as const;
const now = new Date("2026-07-16T12:00:00.000Z");

const principal = {
	pluginId: "com.example.broker",
	packageVersion: "1.0.0",
	runtimeId: "runtime-1",
	runtimeGeneration: 3,
	installationId: "installation-1",
} as const;

function grant(overrides: Partial<PermissionGrant> = {}): PermissionGrant {
	return {
		capability,
		scope: { type: "global" },
		...overrides,
	};
}

function makeBinding(overrides: Record<string, unknown> = {}) {
	return {
		plugin: principal,
		desiredState: "enabled" as const,
		compatibilityState: "compatible" as const,
		runtimeState: "active" as const,
		manifestRequested: [capability],
		installationGrants: [grant()],
		hostPolicy: [capability],
		currentUserAuthority: [capability],
		contributionPolicy: [capability],
		runnerEnforcement: [capability],
		grantRevision: 1,
		...overrides,
	};
}

function context(overrides: Partial<HostCallContext> = {}): HostCallContext {
	return {
		requestId: "request-1",
		correlationId: "correlation-1",
		deadlineAt: "2026-07-16T12:05:00.000Z",
		plugin: principal,
		invocation: { kind: "user", userId: "user-1", userRole: "user", source: "ui" },
		scope: { userId: "user-1", projectId: "project-1" },
		...overrides,
	};
}

function broker(binding = makeBinding(), options: Record<string, unknown> = {}) {
	return new CapabilityBroker({
		bindings: new Map([[principal.pluginId, binding]]),
		now: () => now,
		...options,
	} as never);
}

describe("CapabilityBroker principal and context contracts", () => {
	test("strictly validates principals and rejects forged/unknown fields", () => {
		expect(pluginPrincipalSchema.safeParse(principal).success).toBe(true);
		expect(
			pluginPrincipalSchema.safeParse({ ...principal, runtimeGeneration: 4, forged: "plugin" })
				.success,
		).toBe(false);
		expect(
			invocationPrincipalSchema.safeParse({
				kind: "plugin_background",
				userId: "user-1",
				source: "event",
			}).success,
		).toBe(false);
	});

	test("binds plugin/runtime/generation and rejects a forged context", async () => {
		const capabilityBroker = broker();
		expect(() =>
			capabilityBroker.withCallContext({
				plugin: { ...principal, runtimeGeneration: 4 },
				invocation: context().invocation,
				scope: context().scope,
			}),
		).toThrow(
			expect.objectContaining({
				code: "CONTEXT_UNAVAILABLE",
				reason: "PLUGIN_IDENTITY_MISMATCH",
			}),
		);
	});

	test("returns a recursively frozen host-owned context", () => {
		const capabilityBroker = broker();
		const hostContext = capabilityBroker.withCallContext({
			plugin: { ...principal },
			invocation: { kind: "user", userId: "user-1", userRole: "user", source: "ui" },
			scope: { userId: "user-1", projectId: "project-1" },
			requestId: "request-1",
			correlationId: "correlation-1",
			deadlineAt: "2026-07-16T12:05:00.000Z",
		});

		expect(Object.isFrozen(hostContext)).toBe(true);
		expect(Object.isFrozen(hostContext.plugin)).toBe(true);
		expect(Object.isFrozen(hostContext.invocation)).toBe(true);
		expect(Object.isFrozen(hostContext.scope)).toBe(true);
		expect(Reflect.set(hostContext.invocation, "userRole", "admin")).toBe(false);
		expect(hostContext.invocation.userRole).toBe("user");
		expect(Reflect.set(hostContext.scope, "projectId", "project-2")).toBe(false);
		expect(hostContext.scope.projectId).toBe("project-1");
	});
});

describe("CapabilityBroker authorization", () => {
	test("computes the seven-way intersection and fails closed when a source is missing", async () => {
		const allowed = await broker().authorize(context(), capability);
		expect(allowed.allowed).toBe(true);

		const denied = await broker(makeBinding({ hostPolicy: [] })).authorize(context(), capability);
		expect(denied.allowed).toBe(false);
		if (!denied.allowed) expect(denied.error.code).toBe("PERMISSION_DENIED");

		const missing = await broker(makeBinding(), {
			resolveRunnerEnforcement: () => undefined,
		});
		const result = await missing.authorize(context(), capability);
		expect(result.allowed).toBe(false);
		if (!result.allowed) expect(result.error.reason).toBe("MISSING_SOURCE");
	});

	test("allows only narrowed scope and uses an injectable ownership resolver", async () => {
		const capabilityBroker = broker();
		const narrowed = await capabilityBroker.authorize({
			context: context(),
			capability,
			scope: { projectId: "project-1" },
		});
		expect(narrowed.allowed).toBe(true);

		const escalated = await capabilityBroker.authorize({
			context: context(),
			capability,
			scope: { projectId: "project-2" },
		});
		expect(escalated.allowed).toBe(false);
		if (!escalated.allowed) expect(escalated.error.reason).toBe("SCOPE_ESCALATION");

		const ownership = broker(
			makeBinding({ installationGrants: [grant({ scope: { type: "project", id: "project-1" } })] }),
			{
				scopeResolver: {
					belongs: (child: { type: string; id: string }, parent: { type: string; id: string }) =>
						child.type === "chapter" &&
						child.id === "chapter-1" &&
						parent.type === "project" &&
						parent.id === "project-1",
				},
			},
		);
		const child = await ownership.authorize({
			context: context({ scope: {} }),
			capability,
			resource: { type: "chapter", id: "chapter-1" },
		});
		expect(child.allowed).toBe(true);
	});

	test("rejects expired grants and lifecycle failures", async () => {
		const expired = await broker(
			makeBinding({ installationGrants: [grant({ expiresAt: "2026-07-16T11:59:59.000Z" })] }),
		).authorize(context(), capability);
		expect(expired.allowed).toBe(false);
		if (!expired.allowed) expect(expired.error.reason).toBe("GRANT_EXPIRED");

		for (const overrides of [
			{ desiredState: "disabled" as const },
			{ compatibilityState: "incompatible" as const },
			{ runtimeState: "quarantine" as const },
		]) {
			const result = await broker(makeBinding(overrides)).authorize(context(), capability);
			expect(result.allowed).toBe(false);
		}
	});

	test("enforces topic/path/rate/byte constraints", async () => {
		const constrained = broker(
			makeBinding({
				installationGrants: [
					grant({
						constraints: {
							topics: ["narrafork.project.changed"],
							paths: ["workspace/src"],
							maxRatePerSecond: 5,
							maxBytes: 1024,
						},
					}),
				],
			}),
		);
		const allowed = await constrained.authorize({
			context: context(),
			capability,
			constraints: {
				topic: "narrafork.project.changed",
				path: "workspace/src/index.ts",
				ratePerSecond: 5,
				maxBytes: 1024,
			},
		});
		expect(allowed.allowed).toBe(true);

		const denied = await constrained.authorize({
			context: context(),
			capability,
			constraints: { topic: "narrafork.chapter.created" },
		});
		expect(denied.allowed).toBe(false);
		if (!denied.allowed) expect(denied.error.reason).toBe("CONSTRAINT_MISMATCH");

		const rate = await constrained.authorize({
			context: context(),
			capability,
			constraints: { topic: "narrafork.project.changed", ratePerSecond: 6, maxBytes: 1024 },
		});
		expect(rate.allowed).toBe(false);
		if (!rate.allowed) expect(rate.error.code).toBe("RATE_LIMITED");
	});

	test("does not share cached decisions across plugin and invocation identities", async () => {
		const capabilityBroker = new CapabilityBroker({
			resolveBinding: (_pluginId, receivedContext) =>
				makeBinding({ plugin: receivedContext.plugin }),
			now: () => now,
		});
		const first = await capabilityBroker.authorize(context(), capability);
		expect(first.allowed).toBe(true);
		const repeatedContext = context({
			requestId: "request-2",
			correlationId: "correlation-2",
		});
		const repeated = await capabilityBroker.authorize(repeatedContext, capability);
		expect(repeated.allowed).toBe(true);
		if (repeated.allowed) {
			expect(repeated.cacheHit).toBe(true);
			expect(repeated.context).toEqual(repeatedContext);
		}

		const variants = [
			context({ plugin: { ...principal, contributionId: "contribution-2" } }),
			context({ plugin: { ...principal, packageVersion: "2.0.0" } }),
			context({ plugin: { ...principal, installationId: "installation-2" } }),
			context({
				invocation: { kind: "user", userId: "user-1", userRole: "user", source: "command" },
			}),
			context({
				invocation: { kind: "user", userId: "user-1", userRole: "admin", source: "ui" },
			}),
		];

		for (const variant of variants) {
			const result = await capabilityBroker.authorize(variant, capability);
			expect(result.allowed).toBe(true);
			if (result.allowed) {
				expect(result.cacheHit).toBe(false);
				expect(result.context).toEqual(variant);
			}
		}
	});
});

describe("CapabilityBroker audit and invalidation", () => {
	test("writes bounded, redacted audit summaries and invalidates revoked grants", async () => {
		const sink: unknown[] = [];
		const capabilityBroker = broker(makeBinding({ grantRevision: 2 }), {
			maxAuditEntries: 2,
			auditSink: (summary: unknown) => {
				sink.push(summary);
			},
		});
		await capabilityBroker.authorize({
			context: context(),
			capability,
			constraints: { path: "secret/payload.txt" },
		});
		await capabilityBroker.authorize(context(), otherCapability);
		await capabilityBroker.authorize(context(), capability);
		const audits = capabilityBroker.getAuditSummaries();
		expect(audits).toHaveLength(2);
		expect(sink).toHaveLength(3);
		expect(JSON.stringify(audits)).not.toContain("payload.txt");
		expect(JSON.stringify(audits)).not.toContain("secret");
		expect(audits.every((entry) => entry.requestBytes === 0 && entry.responseBytes === 0)).toBe(
			true,
		);

		capabilityBroker.revoke(principal.pluginId);
		const denied = await capabilityBroker.authorize(context(), capability);
		expect(denied.allowed).toBe(false);
		if (!denied.allowed) expect(denied.error.reason).toBe("GRANT_REVOKED");
	});

	test("require throws the structured broker error", async () => {
		await expect(
			broker(makeBinding({ runnerEnforcement: [] })).require(context(), capability),
		).rejects.toMatchObject({
			name: "CapabilityBrokerError",
			code: "PERMISSION_DENIED",
		});
	});
});

describe("CapabilityBroker per-runtime binding isolation", () => {
	function uiPrincipal(sessionId: string, generation: number) {
		return { ...principal, runtimeId: `ui:${sessionId}`, runtimeGeneration: generation };
	}

	test("concurrent UI sessions of one plugin do not overwrite each other's binding", async () => {
		const capabilityBroker = new CapabilityBroker({ now: () => now });
		const sessionA = uiPrincipal("uis_A", 1);
		const sessionB = uiPrincipal("uis_B", 1);
		capabilityBroker.setBinding(principal.pluginId, makeBinding({ plugin: sessionA }));
		capabilityBroker.setBinding(principal.pluginId, makeBinding({ plugin: sessionB }));

		const contextA = context({ plugin: sessionA });
		const contextB = context({ plugin: sessionB });
		const [resultA, resultB] = await Promise.all([
			capabilityBroker.authorize(contextA, capability),
			capabilityBroker.authorize(contextB, capability),
		]);
		// Before the fix, session B's setBinding overwrote session A's binding (keyed by
		// pluginId), so session A failed with RUNTIME_IDENTITY_MISMATCH. Both must pass now.
		expect(resultA.allowed).toBe(true);
		expect(resultB.allowed).toBe(true);
	});

	test("clearing one session's binding leaves the sibling session intact", async () => {
		const capabilityBroker = new CapabilityBroker({ now: () => now });
		const sessionA = uiPrincipal("uis_A", 1);
		const sessionB = uiPrincipal("uis_B", 1);
		capabilityBroker.setBinding(principal.pluginId, makeBinding({ plugin: sessionA }));
		capabilityBroker.setBinding(principal.pluginId, makeBinding({ plugin: sessionB }));

		capabilityBroker.clearBinding(principal.pluginId, sessionA.runtimeId);

		const deniedA = await capabilityBroker.authorize(context({ plugin: sessionA }), capability);
		expect(deniedA.allowed).toBe(false);
		if (!deniedA.allowed) expect(deniedA.error.reason).toBe("INVALID_CONTEXT");

		const allowedB = await capabilityBroker.authorize(context({ plugin: sessionB }), capability);
		expect(allowedB.allowed).toBe(true);
	});

	test("clearBindingsForPlugin removes every session binding for the plugin", async () => {
		const capabilityBroker = new CapabilityBroker({ now: () => now });
		capabilityBroker.setBinding(
			principal.pluginId,
			makeBinding({ plugin: uiPrincipal("uis_A", 1) }),
		);
		capabilityBroker.setBinding(
			principal.pluginId,
			makeBinding({ plugin: uiPrincipal("uis_B", 1) }),
		);

		capabilityBroker.clearBindingsForPlugin(principal.pluginId);

		for (const sessionId of ["uis_A", "uis_B"]) {
			const result = await capabilityBroker.authorize(
				context({ plugin: uiPrincipal(sessionId, 1) }),
				capability,
			);
			expect(result.allowed).toBe(false);
			if (!result.allowed) expect(result.error.reason).toBe("INVALID_CONTEXT");
		}
	});
});
