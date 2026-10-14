import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CapabilityBroker,
	type HostCallContext,
	invocationPrincipalSchema,
} from "../plugin-capability-broker";
import { PluginHostServices } from "../plugin-host-services";
import { PluginStorageFactory } from "../plugin-storage";
import { PluginUiHost, type PluginUiHostRequest } from "../plugin-ui-host";
import type { PluginUiSession } from "../plugin-ui-session";
import { STEWARD_BINDING_KEY, STEWARD_PLUGIN_ID } from "../steward-narrator-constants";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function factory() {
	const root = await mkdtemp(join(tmpdir(), "narrafork-steward-storage-"));
	roots.push(root);
	return new PluginStorageFactory({ root });
}
function session(): PluginUiSession {
	return {
		pluginId: STEWARD_PLUGIN_ID,
		version: "1.0.0",
		hash: "a".repeat(64),
		installationId: "installation-1",
		authorityInstallationId: "installation-1",
		principalId: "user-1",
		contributionId: "steward-panel",
		panelInstanceId: "panel-1",
		surface: "workspace",
		surfaceScope: "narrator",
		scope: { narratorId: "steward-1" },
		sessionId: "uis_steward",
		connectNonce: "n".repeat(24),
		generation: 1,
		createdAt: "2026-10-11T12:00:00.000Z",
		expiresAt: "2026-10-11T13:00:00.000Z",
	};
}
function request(id: string, method: string, params: PluginUiHostRequest["request"]["params"]) {
	return { protocol: "narrafork.ui/1" as const, kind: "request" as const, id, method, params };
}

describe("steward storage boundaries", () => {
	test("generic UI storage cannot replace/delete host-owned binding, but ordinary keys still work", async () => {
		const storageFactory = await factory();
		const storage = storageFactory.get(STEWARD_PLUGIN_ID);
		const scope = { type: "user" as const, id: "user-1" };
		await storage.set({
			scope,
			key: STEWARD_BINDING_KEY,
			value: { stewardNarratorId: "original" },
		});
		const ui = new PluginUiHost({
			storageFactory,
			capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
		});
		for (const method of ["storage.set", "storage.delete"]) {
			const reply = await ui.dispatch({
				session: session(),
				principalId: "user-1",
				userRole: "admin",
				request: request(method, method, {
					scope,
					key: STEWARD_BINDING_KEY,
					...(method === "storage.set" ? { value: { stewardNarratorId: "forged" } } : {}),
				}),
			});
			expect(reply).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
		}
		expect((await storage.get({ scope, key: STEWARD_BINDING_KEY }))?.value).toEqual({
			stewardNarratorId: "original",
		});
		expect(
			await ui.dispatch({
				session: session(),
				principalId: "user-1",
				userRole: "user",
				request: request("ordinary", "storage.set", { scope, key: "preference", value: "ok" }),
			}),
		).toMatchObject({ result: { value: "ok" } });
	});

	test("runtime generic storage cannot change binding even when storage capability is granted", async () => {
		const storageFactory = await factory();
		const broker = new CapabilityBroker();
		const host = new PluginHostServices({ storageFactory, capabilityBroker: broker });
		const runtime = host.bindRuntime({
			pluginId: STEWARD_PLUGIN_ID,
			packageVersion: "1.0.0",
			installationId: "installation-1",
			runtimeId: "runtime-steward",
			runtimeGeneration: 1,
			grantRevision: 1,
			desiredState: "enabled",
			compatibilityState: "compatible",
			runtimeState: "active",
			manifestRequested: ["storage.write_self"],
			grants: [
				{
					pluginId: STEWARD_PLUGIN_ID,
					installationId: "installation-1",
					grantId: "write",
					capability: "storage.write_self",
					scope: { type: "global" },
					grantedBy: "admin",
					revision: 1,
				},
			],
			scope: { userId: "user-1" },
		});
		for (const method of ["storage.set", "storage.delete"]) {
			const reply = await runtime.dispatcher.dispatch({
				jsonrpc: "2.0",
				id: method,
				method,
				params: {
					scope: { type: "user", id: "user-1" },
					key: STEWARD_BINDING_KEY,
					...(method === "storage.set" ? { value: {} } : {}),
				},
			});
			expect(reply).toMatchObject({ error: { data: { code: "PERMISSION_DENIED" } } });
		}
		expect(
			await storageFactory
				.get(STEWARD_PLUGIN_ID)
				.get({ scope: { type: "user", id: "user-1" }, key: STEWARD_BINDING_KEY }),
		).toBeUndefined();
	});

	test("UI command context originates from session principal and current narrator, not input", async () => {
		let seen: HostCallContext | undefined;
		const ui = new PluginUiHost({
			capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
			pluginCommands: {
				has: () => true,
				invoke: async (_id, _plugin, _input, context) => {
					seen = context.hostContext;
					return { output: null };
				},
			},
		});
		await ui.dispatch({
			session: session(),
			principalId: "user-1",
			userRole: "user",
			request: request("bind", "commands.execute", {
				commandId: "steward.bind",
				input: { userId: "attacker", narratorId: "forged" },
			}),
		});
		expect(seen?.invocation).toMatchObject({
			kind: "user",
			userId: "user-1",
			source: "ui",
			narratorId: "steward-1",
		});
		expect(seen?.scope).toMatchObject({ userId: "user-1", narratorId: "steward-1" });
		expect(seen?.requestId).toBe("bind");
		expect(seen?.correlationId).toBe("ui:uis_steward:bind");
	});

	test("non-user invocation cannot claim a caller narrator identity", () => {
		for (const kind of ["plugin_background", "system"]) {
			expect(
				invocationPrincipalSchema.safeParse({ kind, source: "internal", narratorId: "steward-1" })
					.success,
			).toBe(false);
		}
		expect(
			invocationPrincipalSchema.safeParse({
				kind: "user",
				source: "internal",
				userId: "user-1",
				narratorId: "steward-1",
			}).success,
		).toBe(true);
	});
});
