import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCallContext } from "@server/services/plugin-capability-broker";
import {
	PluginSecretBroker,
	PluginSecretBrokerError,
	type SecretProviderReadInput,
} from "@server/services/plugin-secret-broker";

const roots: string[] = [];
const principal = {
	pluginId: "com.example.secret",
	packageVersion: "1.0.0",
	runtimeId: "runtime-1",
	runtimeGeneration: 1,
	installationId: "installation-1",
} as const;

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-secret-"));
	roots.push(root);
	return root;
}

function context(overrides: Partial<HostCallContext> = {}): HostCallContext {
	return {
		requestId: "request-1",
		correlationId: "correlation-1",
		deadlineAt: "2099-01-01T00:00:00.000Z",
		plugin: principal,
		invocation: { kind: "user", userId: "user-1", userRole: "user", source: "provider" },
		scope: { userId: "user-1" },
		...overrides,
	};
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("PluginSecretBroker", () => {
	test("configures only fingerprint/ref metadata, validates capability, and reads through a provider lease", async () => {
		await makeRoot();
		const providerInputs: SecretProviderReadInput[] = [];
		const audits: unknown[] = [];
		const broker = new PluginSecretBroker({
			provider: {
				isAvailable: () => true,
				read: async (input) => {
					providerInputs.push(input);
					return "top-secret-value";
				},
			},
			authorize: (input) => input.capability === "secret.use_self",
			isPluginEnabled: () => true,
			auditSink: (summary) => {
				audits.push(summary);
			},
		});
		const configured = broker.configure({
			pluginId: principal.pluginId,
			secretId: "provider-key",
			scope: { type: "user", id: "user-1" },
			opaqueRef: "vault://secret/top-secret-value",
			fingerprint: "sha256:fingerprint-only",
		});
		expect(configured).toMatchObject({
			configured: true,
			fingerprint: "sha256:fingerprint-only",
			revision: 1,
		});
		expect(JSON.stringify(configured)).not.toContain("vault://secret");
		expect(
			JSON.stringify(
				broker.getConfiguration({
					pluginId: principal.pluginId,
					secretId: "provider-key",
					scope: { type: "user", id: "user-1" },
				}),
			),
		).not.toContain("vault://secret");

		const lease = await broker.acquireLease({
			secretId: "provider-key",
			scope: { type: "user", id: "user-1" },
			context: context(),
			purpose: "provider-call",
		});
		expect(lease.leaseId).toMatch(/^secret_lease_/);
		expect(JSON.stringify(lease)).not.toContain("top-secret-value");
		expect(JSON.stringify(lease)).not.toContain("vault://secret");
		expect(await broker.readLease({ leaseId: lease.leaseId, context: context() })).toBe(
			"top-secret-value",
		);
		expect(providerInputs[0]).toMatchObject({
			pluginId: principal.pluginId,
			secretId: "provider-key",
			requestId: "request-1",
			runtimeGeneration: 1,
		});
		expect(providerInputs[0].opaqueRef).toBe("vault://secret/top-secret-value");
		expect(JSON.stringify([...audits, ...broker.getAuditSummaries()])).not.toContain(
			"top-secret-value",
		);
		expect(JSON.stringify([...audits, ...broker.getAuditSummaries()])).not.toContain(
			"vault://secret",
		);
	});

	test("expires, revokes, and binds leases to request and runtime generation", async () => {
		let now = new Date("2026-07-16T12:00:00.000Z");
		const broker = new PluginSecretBroker({
			provider: { read: () => "secret" },
			authorize: () => true,
			now: () => now,
			defaultLeaseTtlMs: 1_000,
			maxLeaseTtlMs: 2_000,
		});
		broker.configure({
			pluginId: principal.pluginId,
			secretId: "key",
			scope: { type: "user", id: "user-1" },
			opaqueRef: "opaque-ref",
		});
		const lease = await broker.acquireLease({
			secretId: "key",
			context: { ...context(), deadlineAt: "2026-07-16T12:00:10.000Z" },
		});
		now = new Date("2026-07-16T12:00:01.001Z");
		await expect(
			broker.readLease({
				leaseId: lease.leaseId,
				context: { ...context(), deadlineAt: "2026-07-16T12:00:10.000Z" },
			}),
		).rejects.toMatchObject({
			reason: "LEASE_EXPIRED",
		});

		now = new Date("2026-07-16T12:00:02.000Z");
		const revoked = await broker.acquireLease({
			secretId: "key",
			context: { ...context(), requestId: "request-2", deadlineAt: "2026-07-16T12:00:10.000Z" },
		});
		expect(broker.revokeLease(revoked.leaseId)).toBe(true);
		await expect(
			broker.readLease({
				leaseId: revoked.leaseId,
				context: { ...context(), requestId: "request-2", deadlineAt: "2026-07-16T12:00:10.000Z" },
			}),
		).rejects.toMatchObject({
			reason: "LEASE_REVOKED",
		});

		const generationLease = await broker.acquireLease({
			secretId: "key",
			context: { ...context(), requestId: "request-3", deadlineAt: "2026-07-16T12:00:10.000Z" },
		});
		await expect(
			broker.readLease({
				leaseId: generationLease.leaseId,
				context: {
					...context(),
					requestId: "request-3",
					deadlineAt: "2026-07-16T12:00:10.000Z",
					plugin: { ...principal, runtimeGeneration: 2 },
				},
			}),
		).rejects.toMatchObject({ reason: "RUNTIME_GENERATION_MISMATCH" });
		await expect(
			broker.readLease({
				leaseId: generationLease.leaseId,
				context: {
					...context(),
					requestId: "different-request",
					deadlineAt: "2026-07-16T12:00:10.000Z",
				},
			}),
		).rejects.toMatchObject({ reason: "REQUEST_MISMATCH" });
	});

	test("revokes all leases when a plugin is disabled and supports reconfiguration invalidation", async () => {
		const broker = new PluginSecretBroker({
			provider: { read: () => "secret" },
			authorize: () => true,
		});
		broker.configure({
			pluginId: principal.pluginId,
			secretId: "key",
			scope: { type: "user", id: "user-1" },
			opaqueRef: "ref-v1",
		});
		const first = await broker.acquireLease({ secretId: "key", context: context() });
		broker.configure({
			pluginId: principal.pluginId,
			secretId: "key",
			scope: { type: "user", id: "user-1" },
			opaqueRef: "ref-v2",
		});
		await expect(
			broker.readLease({ leaseId: first.leaseId, context: context() }),
		).rejects.toMatchObject({ reason: "LEASE_REVOKED" });

		const second = await broker.acquireLease({
			secretId: "key",
			context: { ...context(), requestId: "request-2" },
		});
		expect(broker.revokePlugin(principal.pluginId)).toBe(1);
		await expect(
			broker.readLease({
				leaseId: second.leaseId,
				context: { ...context(), requestId: "request-2" },
			}),
		).rejects.toMatchObject({ reason: "LEASE_REVOKED" });
		await expect(
			broker.acquireLease({ secretId: "key", context: context() }),
		).rejects.toMatchObject({ reason: "PLUGIN_DISABLED" });
		broker.restorePlugin(principal.pluginId);
	});

	test("fails closed when provider or capability validation is unavailable", async () => {
		const unavailable = new PluginSecretBroker({ authorize: () => true });
		unavailable.configure({
			pluginId: principal.pluginId,
			secretId: "key",
			scope: { type: "global" },
			opaqueRef: "ref",
		});
		await expect(
			unavailable.acquireLease({ secretId: "key", context: { ...context(), scope: {} } }),
		).rejects.toMatchObject({
			reason: "PROVIDER_UNAVAILABLE",
		});

		const denied = new PluginSecretBroker({ provider: { read: () => "secret" } });
		denied.configure({
			pluginId: principal.pluginId,
			secretId: "key",
			scope: { type: "global" },
			opaqueRef: "ref",
		});
		await expect(
			denied.acquireLease({ secretId: "key", context: { ...context(), scope: {} } }),
		).rejects.toMatchObject({
			reason: "PERMISSION_DENIED",
		});
	});

	test("does not persist plaintext secret material and rejects plaintext configuration fields", async () => {
		const root = await makeRoot();
		const broker = new PluginSecretBroker({
			provider: { read: () => "never-read" },
			authorize: () => true,
		});
		expect(() =>
			broker.configure({
				pluginId: principal.pluginId,
				secretId: "key",
				scope: { type: "global" },
				opaqueRef: "opaque",
				secret: "plaintext-secret",
			} as never),
		).toThrow(PluginSecretBrokerError);
		expect(await readdir(root)).toEqual([]);
		expect(JSON.stringify(broker.getAuditSummaries())).not.toContain("plaintext-secret");
	});
});
