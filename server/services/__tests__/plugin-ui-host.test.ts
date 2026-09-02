import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type JsonValue,
	PLUGIN_UI_REQUEST_MAX_BYTES,
	type UiRpcRequest,
} from "../../../frontend/components/plugins/protocol";
import { CapabilityBroker } from "../plugin-capability-broker";
import { PluginEventGateway, type SubscribeEventsResult } from "../plugin-event-gateway";
import { PluginHostServices } from "../plugin-host-services";
import type { StoredPermissionGrant } from "../plugin-permission-store";
import { PluginStorage, PluginStorageFactory } from "../plugin-storage";
import { PLUGIN_UI_HOST_REQUEST_MAX_BYTES, PluginUiHost } from "../plugin-ui-host";
import type { PluginUiSession } from "../plugin-ui-session";

const roots: string[] = [];

function makeSession(): PluginUiSession {
	return {
		pluginId: "com.example.host",
		version: "1.0.0",
		hash: "c".repeat(64),
		authorityInstallationId: "installation-ui-host",
		installationId: "installation-1",
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

function subscriptionResult(subscriptionId: string): SubscribeEventsResult {
	return {
		subscriptionId,
		mode: "live",
		delivery: {
			maxFrameBytes: 1024,
			queueEvents: 10,
			queueBytes: 4096,
			maxRatePerSecond: 10,
		},
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

	test("shares storage root, revisions, and quota state with the backend runtime", async () => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-shared-storage-"));
		roots.push(root);
		const storageFactory = new PluginStorageFactory({ root });
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker, storageFactory });
		const session = makeSession();
		const runtimeId = "runtime-shared-storage";
		const installationId = session.authorityInstallationId;
		const capabilities: StoredPermissionGrant["capability"][] = [
			"storage.read_self",
			"storage.write_self",
		];
		const runtime = hostServices.bindRuntime({
			pluginId: session.pluginId,
			packageVersion: session.version,
			installationId,
			runtimeId,
			runtimeGeneration: 1,
			grantRevision: 1,
			desiredState: "enabled",
			compatibilityState: "compatible",
			runtimeState: "active",
			manifestRequested: capabilities,
			grants: capabilities.map((capability, index) => ({
				pluginId: session.pluginId,
				installationId,
				grantId: `grant-${index}`,
				capability,
				scope: { type: "global" },
				grantedBy: "admin-user-1",
				revision: 1,
			})),
			scope: { workspaceId: "workspace-1" },
		});
		const uiHost = new PluginUiHost({
			capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
			storageFactory,
		});
		const scope = { type: "workspace", id: "workspace-1" } as const;

		const uiSet = await uiHost.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("ui-set-shared", "storage.set", {
				scope,
				key: "shared-key",
				value: { source: "ui" },
			}),
		});
		expect(uiSet).toMatchObject({ result: { revision: 1, value: { source: "ui" } } });

		const backendGet = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "backend-get-shared",
			method: "storage.get",
			params: { scope, key: "shared-key" },
		});
		expect(backendGet).toMatchObject({
			result: { revision: 1, value: { source: "ui" } },
		});

		const backendSet = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "backend-set-shared",
			method: "storage.set",
			params: {
				scope,
				key: "shared-key",
				value: { source: "backend" },
				expectedRevision: 1,
			},
		});
		expect(backendSet).toMatchObject({
			result: { revision: 2, value: { source: "backend" } },
		});

		const uiGet = await uiHost.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("ui-get-shared", "storage.get", { scope, key: "shared-key" }),
		});
		expect(uiGet).toMatchObject({
			result: { revision: 2, value: { source: "backend" } },
		});
		expect(storageFactory.get(session.pluginId).root).toBe(root);
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
					// The gateway requires a verifiable authority revision; this
					// unit test focuses on the UI→gateway schema mapping, so it
					// supplies the revision explicitly instead of provisioning a
					// real authority record.
					grantRevision: 1,
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

	test("strips the UI-protocol transport from delivery before gateway subscription", async () => {
		// The UI panel passes `delivery.transport: "poll"` (UI protocol field), but
		// the backend subscribe schema is strict and would reject the unknown
		// field with INVALID_SUBSCRIPTION — which previously made every UI-panel
		// event subscription fail silently, so the panel never refreshed.
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
					mode: "live",
					grantRevision: 1,
					delivery: {
						transport: "poll",
						maxRatePerSecond: 10,
						queueEvents: 100,
						queueBytes: 256 * 1024,
					},
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

	test("revokes gateway subscriptions and forgets session ownership idempotently", async () => {
		const active = new Set<string>();
		const revokedSessions: string[] = [];
		const gateway = {
			subscribe: async () => {
				active.add("subscription-1");
				return {
					subscriptionId: "subscription-1",
					mode: "live" as const,
					delivery: {
						maxFrameBytes: 1024,
						queueEvents: 10,
						queueBytes: 4096,
						maxRatePerSecond: 10,
					},
				};
			},
			unsubscribe: (subscriptionId: string) => active.delete(subscriptionId),
			poll: () => [],
			revokeSession: (sessionId: string) => {
				revokedSessions.push(sessionId);
				const count = active.size;
				active.clear();
				return count;
			},
		};
		const host = new PluginUiHost({
			capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
			eventGateway: gateway,
		});
		const session = makeSession();
		const subscribed = await host.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("subscribe-owned", "events.subscribe", {
				topics: ["narrafork.chapter.created"],
			}),
		});
		expect(subscribed).toMatchObject({ result: { subscriptionId: "subscription-1" } });
		expect(host.revokeSession(session.sessionId, "route-delete")).toBe(1);
		expect(host.revokeSession(session.sessionId, "route-delete")).toBe(0);
		expect(revokedSessions).toEqual([session.sessionId, session.sessionId]);

		const polled = await host.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("poll-revoked", "events.poll", {
				subscriptionId: "subscription-1",
			}),
		});
		expect(polled).toMatchObject({ error: { code: "NOT_FOUND" } });
	});

	test("fences a subscribe that resolves after its session is revoked", async () => {
		let resolveSubscription: ((value: SubscribeEventsResult) => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const pending = new Promise<SubscribeEventsResult>((resolve) => {
			resolveSubscription = resolve;
		});
		const unsubscribed: Array<{ subscriptionId: string; reason?: string }> = [];
		const gateway = {
			subscribe: async () => {
				markStarted?.();
				return pending;
			},
			unsubscribe: (subscriptionId: string, reason?: string) => {
				unsubscribed.push({ subscriptionId, reason });
				return true;
			},
			poll: () => [],
			revokeSession: () => 0,
		};
		const host = new PluginUiHost({
			capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
			eventGateway: gateway,
		});
		const session = makeSession();
		const dispatch = host.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("subscribe-race", "events.subscribe", {
				topics: ["narrafork.chapter.created"],
			}),
		});
		await started;
		expect(host.revokeSession(session.sessionId, "expired")).toBe(0);
		resolveSubscription?.({
			subscriptionId: "subscription-race",
			mode: "live",
			delivery: {
				maxFrameBytes: 1024,
				queueEvents: 10,
				queueBytes: 4096,
				maxRatePerSecond: 10,
			},
		});
		const response = await dispatch;
		expect(response).toMatchObject({ error: { code: "CANCELLED" } });
		expect(unsubscribed).toEqual([{ subscriptionId: "subscription-race", reason: "expired" }]);
	});

	test("unsubscribes a subscription that finishes registering after the request times out", async () => {
		let resolveSubscription: ((value: SubscribeEventsResult) => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const pending = new Promise<SubscribeEventsResult>((resolve) => {
			resolveSubscription = resolve;
		});
		let markCleaned: (() => void) | undefined;
		const cleaned = new Promise<void>((resolve) => {
			markCleaned = resolve;
		});
		let observedSignal: AbortSignal | undefined;
		let pollCalls = 0;
		const unsubscribed: Array<{ subscriptionId: string; reason?: string }> = [];
		const host = new PluginUiHost({
			capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
			eventGateway: {
				subscribe: async (_input: unknown, options?: { signal: AbortSignal }) => {
					observedSignal = options?.signal;
					markStarted?.();
					return pending;
				},
				unsubscribe: (subscriptionId: string, reason?: string) => {
					unsubscribed.push({ subscriptionId, reason });
					markCleaned?.();
					return true;
				},
				poll: () => {
					pollCalls += 1;
					return [];
				},
			} as never,
			timeoutMs: 5,
		});
		const session = makeSession();
		const dispatch = host.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("subscribe-timeout-race", "events.subscribe", {
				topics: ["narrafork.chapter.created"],
			}),
		});
		await started;
		const response = await dispatch;
		expect(response).toMatchObject({ error: { code: "TIMEOUT" } });
		expect(observedSignal?.aborted).toBe(true);

		resolveSubscription?.(subscriptionResult("subscription-timeout-race"));
		await cleaned;
		expect(unsubscribed).toEqual([
			{ subscriptionId: "subscription-timeout-race", reason: "request-timeout" },
		]);
		const polled = await host.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("poll-timeout-race", "events.poll", {
				subscriptionId: "subscription-timeout-race",
			}),
		});
		expect(polled).toMatchObject({ error: { code: "NOT_FOUND" } });
		expect(pollCalls).toBe(0);
	});

	test("unsubscribes a subscription that finishes registering after external cancellation", async () => {
		let resolveSubscription: ((value: SubscribeEventsResult) => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const pending = new Promise<SubscribeEventsResult>((resolve) => {
			resolveSubscription = resolve;
		});
		let markCleaned: (() => void) | undefined;
		const cleaned = new Promise<void>((resolve) => {
			markCleaned = resolve;
		});
		const unsubscribed: Array<{ subscriptionId: string; reason?: string }> = [];
		const host = new PluginUiHost({
			capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
			eventGateway: {
				subscribe: async () => {
					markStarted?.();
					return pending;
				},
				unsubscribe: (subscriptionId: string, reason?: string) => {
					unsubscribed.push({ subscriptionId, reason });
					markCleaned?.();
					return true;
				},
				poll: () => [],
			} as never,
		});
		const session = makeSession();
		const controller = new AbortController();
		const dispatch = host.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("subscribe-cancel-race", "events.subscribe", {
				topics: ["narrafork.chapter.created"],
			}),
			signal: controller.signal,
		});
		await started;
		controller.abort("user-cancelled");
		const response = await dispatch;
		expect(response).toMatchObject({ error: { code: "CANCELLED" } });

		resolveSubscription?.(subscriptionResult("subscription-cancel-race"));
		await cleaned;
		expect(unsubscribed).toEqual([
			{ subscriptionId: "subscription-cancel-race", reason: "request-cancelled" },
		]);
	});

	test("cleans up a timed-out subscription even when the session is revoked before registration finishes", async () => {
		let resolveSubscription: ((value: SubscribeEventsResult) => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const pending = new Promise<SubscribeEventsResult>((resolve) => {
			resolveSubscription = resolve;
		});
		let markCleaned: (() => void) | undefined;
		const cleaned = new Promise<void>((resolve) => {
			markCleaned = resolve;
		});
		const revokedSessions: string[] = [];
		const unsubscribed: Array<{ subscriptionId: string; reason?: string }> = [];
		const host = new PluginUiHost({
			capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
			eventGateway: {
				subscribe: async () => {
					markStarted?.();
					return pending;
				},
				unsubscribe: (subscriptionId: string, reason?: string) => {
					unsubscribed.push({ subscriptionId, reason });
					markCleaned?.();
					return true;
				},
				poll: () => [],
				revokeSession: (sessionId: string) => {
					revokedSessions.push(sessionId);
					return 0;
				},
			} as never,
			timeoutMs: 5,
		});
		const session = makeSession();
		const dispatch = host.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("subscribe-timeout-revoke-race", "events.subscribe", {
				topics: ["narrafork.chapter.created"],
			}),
		});
		await started;
		const response = await dispatch;
		expect(response).toMatchObject({ error: { code: "TIMEOUT" } });
		expect(host.revokeSession(session.sessionId, "deleted-after-timeout")).toBe(0);

		resolveSubscription?.(subscriptionResult("subscription-timeout-revoke-race"));
		await cleaned;
		expect(revokedSessions).toEqual([session.sessionId]);
		expect(unsubscribed).toEqual([
			{ subscriptionId: "subscription-timeout-revoke-race", reason: "request-timeout" },
		]);
		const polled = await host.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("poll-timeout-revoke-race", "events.poll", {
				subscriptionId: "subscription-timeout-revoke-race",
			}),
		});
		expect(polled).toMatchObject({ error: { code: "NOT_FOUND" } });
	});

	test("aborts the in-flight controller when a session is revoked", async () => {
		let started: (() => void) | undefined;
		const didStart = new Promise<void>((resolve) => {
			started = resolve;
		});
		let observedSignal: AbortSignal | undefined;
		const host = new PluginUiHost({
			capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
			publicApi: {
				query: async (_context: unknown, _request: unknown, options: { signal: AbortSignal }) => {
					observedSignal = options.signal;
					started?.();
					return await new Promise((_, reject) => {
						options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
							once: true,
						});
					});
				},
			} as never,
		});
		const session = makeSession();
		const dispatch = host.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("query-abort", "queries.execute", { queryId: "test.query" }),
		});
		await didStart;
		host.revokeSession(session.sessionId, "expired");
		const response = await dispatch;
		expect(observedSignal?.aborted).toBe(true);
		expect(response).toMatchObject({ error: { code: "CANCELLED" } });
	});

	test("aborts the in-flight controller when a cancellable request times out", async () => {
		let observedSignal: AbortSignal | undefined;
		const host = new PluginUiHost({
			capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
			publicApi: {
				query: async (_context: unknown, _request: unknown, options: { signal: AbortSignal }) => {
					observedSignal = options.signal;
					return await new Promise((_, reject) => {
						options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
							once: true,
						});
					});
				},
			} as never,
			timeoutMs: 5,
		});
		const response = await host.dispatch({
			session: makeSession(),
			principalId: "user-1",
			userRole: "user",
			request: request("query-timeout", "queries.execute", { queryId: "test.query" }),
		});
		expect(observedSignal?.aborted).toBe(true);
		expect(response).toMatchObject({ error: { code: "TIMEOUT" } });
	});

	test("does not report cancellation after an uncancellable command commit begins", async () => {
		let started: (() => void) | undefined;
		const didStart = new Promise<void>((resolve) => {
			started = resolve;
		});
		let finish: ((value: unknown) => void) | undefined;
		const result = new Promise((resolve) => {
			finish = resolve;
		});
		let observedSignal: AbortSignal | undefined;
		const host = new PluginUiHost({
			capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
			publicApi: {
				command: async (_context: unknown, _request: unknown, options: { signal: AbortSignal }) => {
					observedSignal = options.signal;
					started?.();
					return await result;
				},
			} as never,
		});
		const session = makeSession();
		const dispatch = host.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("command-commit", "commands.execute", { commandId: "test.command" }),
		});
		await didStart;
		host.revokeSession(session.sessionId, "expired");
		expect(observedSignal?.aborted).toBe(true);
		finish?.({ status: "succeeded", data: { committed: true } });
		const response = await dispatch;
		expect(response).toMatchObject({ result: { status: "succeeded", data: { committed: true } } });
	});

	test("does not enter a storage write after revocation wins before the commit fence", async () => {
		let authorizeStorage: ((value: unknown) => void) | undefined;
		let storageAuthorizationStarted: (() => void) | undefined;
		const didStartStorageAuthorization = new Promise<void>((resolve) => {
			storageAuthorizationStarted = resolve;
		});
		const storageAuthorization = new Promise((resolve) => {
			authorizeStorage = resolve;
		});
		let authorizationCalls = 0;
		let writes = 0;
		const host = new PluginUiHost({
			capabilityBroker: {
				authorize: async () => {
					authorizationCalls += 1;
					if (authorizationCalls === 1) return { allowed: true } as never;
					storageAuthorizationStarted?.();
					return (await storageAuthorization) as never;
				},
			},
			storageFactory: (() => ({
				set: async () => {
					writes += 1;
					return { key: "theme", value: "dark", revision: 1 };
				},
			})) as never,
		});
		const session = makeSession();
		const dispatch = host.dispatch({
			session,
			principalId: "user-1",
			userRole: "user",
			request: request("storage-fenced", "storage.set", {
				scope: { type: "workspace", id: "workspace-1" },
				key: "theme",
				value: "dark",
			}),
		});
		await didStartStorageAuthorization;
		host.revokeSession(session.sessionId, "expired");
		authorizeStorage?.({ allowed: true });
		const response = await dispatch;
		expect(writes).toBe(0);
		expect(response).toMatchObject({ error: { code: "CANCELLED" } });
	});

	test("waits for an uncancellable storage write instead of timing out before it lands", async () => {
		let started: (() => void) | undefined;
		const didStart = new Promise<void>((resolve) => {
			started = resolve;
		});
		let finish: (() => void) | undefined;
		const canFinish = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let committed = false;
		const storage = {
			set: async () => {
				started?.();
				await canFinish;
				committed = true;
				return { key: "theme", value: "dark", revision: 1 };
			},
		};
		const host = new PluginUiHost({
			capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
			storageFactory: (() => storage) as never,
			timeoutMs: 5,
		});
		const dispatch = host.dispatch({
			session: makeSession(),
			principalId: "user-1",
			userRole: "user",
			request: request("storage-commit", "storage.set", {
				scope: { type: "workspace", id: "workspace-1" },
				key: "theme",
				value: "dark",
			}),
		});
		await didStart;
		await Bun.sleep(10);
		finish?.();
		const response = await dispatch;
		expect(committed).toBe(true);
		expect(response).toMatchObject({ result: { key: "theme", value: "dark" } });
	});

	test("rejects malformed and oversized host requests with structured errors", async () => {
		expect(PLUGIN_UI_HOST_REQUEST_MAX_BYTES).toBe(PLUGIN_UI_REQUEST_MAX_BYTES);
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
			request: request("large", "context.get", {
				value: "x".repeat(PLUGIN_UI_HOST_REQUEST_MAX_BYTES),
			}),
		});
		expect(oversized).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
	});

	/*
	 * Size is judged BEFORE shape, matching `validateUiEnvelope` on the client.
	 *
	 * These two cases are what the ordering is for, and the first one is why the check
	 * above was passing for the wrong reason: the envelope schema caps any single string at
	 * 1 MB, well under the 5 MB envelope ceiling, so an oversized payload used to fail
	 * `safeParse` first and be reported as INVALID_PARAMS — a "your message is malformed"
	 * answer to "your message is too big".
	 */
	test("an oversized payload is reported as too large, not as malformed", async () => {
		const host = allowedHost();
		// One string past the envelope ceiling: too big AND (by the per-string cap) not
		// schema-valid. The size verdict has to win, or the limit is unreportable.
		const response = await host.dispatch({
			session: makeSession(),
			principalId: "user-1",
			userRole: "user",
			request: request("single-huge-string", "context.get", {
				value: "x".repeat(PLUGIN_UI_HOST_REQUEST_MAX_BYTES + 1),
			}),
		});
		expect(response).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
		// The request's own id is preserved, so the caller can settle the right pending call
		// rather than seeing an "invalid-request" it never sent.
		expect(response).toMatchObject({ id: "single-huge-string" });
	});

	test("an oversized payload built from individually-legal strings is also refused", async () => {
		// The case that DID reach the size check before: every string is under the per-string
		// cap, so only the envelope total is out of bounds. It must still be refused, and
		// with the same code as the single-string case.
		const host = allowedHost();
		const chunk = "y".repeat(500_000);
		const values: Record<string, JsonValue> = {};
		for (let i = 0; i < 12; i++) values[`chunk-${i}`] = chunk;

		const response = await host.dispatch({
			session: makeSession(),
			principalId: "user-1",
			userRole: "user",
			request: request("many-legal-strings", "context.get", values),
		});
		expect(response).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
	});

	test("a request just under the ceiling is not refused for size", async () => {
		// The other side of the bound: the limit must not reject a legitimate payload. This
		// one is schema-valid and inside the ceiling, so whatever comes back is a verdict on
		// the METHOD, never PAYLOAD_TOO_LARGE.
		const host = allowedHost();
		const response = await host.dispatch({
			session: makeSession(),
			principalId: "user-1",
			userRole: "user",
			request: request("comfortable", "context.get", { value: "z".repeat(900_000) }),
		});
		expect(response).not.toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
	});
});
