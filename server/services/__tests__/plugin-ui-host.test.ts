import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, UiRpcRequest } from "../../../frontend/components/plugins/protocol";
import { PluginEventGateway } from "../plugin-event-gateway";
import { PluginStorage } from "../plugin-storage";
import { PluginUiHost } from "../plugin-ui-host";
import type { PluginUiSession } from "../plugin-ui-session";

const roots: string[] = [];

function makeSession(): PluginUiSession {
	return {
		pluginId: "com.example.host",
		version: "1.0.0",
		hash: "c".repeat(64),
		principalId: "user-1",
		contributionId: "panel",
		panelInstanceId: "panel-1",
		surface: "workspace",
		surfaceScope: "workspace",
		scope: { workspaceId: "workspace-1" },
		sessionId: "uis_host",
		connectNonce: "n".repeat(24),
		generation: 1,
		createdAt: "2026-07-16T12:00:00.000Z",
		expiresAt: "2026-07-16T13:00:00.000Z",
	};
}

function allowedHost(): PluginUiHost {
	return new PluginUiHost({
		capabilityBroker: {
			authorize: async () => ({ allowed: true }) as never,
		},
		storageFactory: (pluginId) => new PluginStorage({ pluginId, root: roots[0] }),
	});
}

function request(id: string, method: string, params?: JsonValue): UiRpcRequest {
	return {
		protocol: "narrafork.ui/1" as const,
		kind: "request" as const,
		id,
		method,
		...(params === undefined ? {} : { params }),
	};
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PluginUiHost", () => {
	test("serves context and storage through the session-bound principal", async () => {
		roots.push(await mkdtemp(join(tmpdir(), "narrafork-plugin-ui-host-")));
		const host = allowedHost();
		const session = makeSession();
		const context = await host.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("context", "context.get"),
		});
		expect(context).toMatchObject({ result: { plugin: { id: session.pluginId } } });

		const stored = await host.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("set", "storage.set", {
				scope: { type: "workspace", id: "workspace-1" },
				key: "theme",
				value: "dark",
			}),
		});
		expect(stored).toMatchObject({ result: { key: "theme", value: "dark" } });

		const loaded = await host.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("get", "storage.get", {
				scope: { type: "workspace", id: "workspace-1" },
				key: "theme",
			}),
		});
		expect(loaded).toMatchObject({ result: { key: "theme", value: "dark" } });
	});

	test("rejects storage access outside the session scope", async () => {
		const host = allowedHost();
		const response = await host.dispatch({
			session: makeSession(),
			principalId: "user-1",
			userRole: "user",
			request: request("outside", "storage.get", {
				scope: { type: "workspace", id: "workspace-2" },
				key: "theme",
			}),
		});
		expect(response).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
	});

	test("maps UI session identity into the event gateway subscription schema", async () => {
		const gateway = new PluginEventGateway({
			registerListener: false,
			capabilityBroker: {
				authorize: () => true,
				isRuntimeActive: () => true,
			},
		});
		try {
			const host = new PluginUiHost({
				capabilityBroker: {
					authorize: async () => ({ allowed: true }) as never,
				},
				eventGateway: gateway,
			});
			const session = makeSession();
			const response = await host.dispatch({
				session,
				principalId: "user-1",
				userRole: "user",
				request: request("subscribe", "events.subscribe", {
					topics: ["narrafork.chapter.created"],
				}),
			});

			expect(response).toMatchObject({
				result: {
					subscriptionId: expect.any(String),
					mode: "live",
				},
			});
			const [subscription] = gateway.getSubscriptionDiagnostics();
			expect(subscription).toMatchObject({
				pluginId: session.pluginId,
				runtimeId: `ui:${session.sessionId}`,
				generation: session.generation,
			});
		} finally {
			gateway.close();
		}
	});

	test("rejects malformed and oversized host requests with structured errors", async () => {
		const host = allowedHost();
		const malformed = await host.dispatch({
			session: makeSession(),
			principalId: "user-1",
			userRole: "user",
			request: { bad: true } as never,
		});
		expect(malformed).toMatchObject({ error: { code: "INVALID_PARAMS" } });

		const oversized = await host.dispatch({
			session: makeSession(),
			principalId: "user-1",
			userRole: "user",
			request: request("large", "context.get", { value: "x".repeat(300_000) }),
		});
		expect(oversized).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
	});
});
