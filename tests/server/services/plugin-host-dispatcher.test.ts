import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
	PluginHostDispatcher,
	PluginHostDispatcherError,
} from "../../../server/services/plugin-host-dispatcher";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await sleep(1);
	if (!predicate()) throw new Error("condition did not become true before timeout");
}

const identity = {
	pluginId: "com.example.hosted",
	packageVersion: "1.2.3",
	installationId: "install-1",
	runtimeId: "runtime-1",
	runtimeGeneration: 7,
};

describe("PluginHostDispatcher", () => {
	it("constructs Host-owned identity and ignores forged identity, user, and scope params", async () => {
		const dispatcher = new PluginHostDispatcher({
			identity,
			scope: { projectId: "host-project" },
			methods: {
				inspect: {
					method: "inspect",
					handler: async (_params, context) => ({
						pluginId: context.plugin.pluginId,
						runtimeId: context.plugin.runtimeId,
						generation: context.plugin.runtimeGeneration,
						installationId: context.plugin.installationId,
						principalKind: context.invocation.kind,
						userId: context.invocation.userId ?? null,
						projectId: context.scope.projectId ?? null,
					}),
				},
			},
		});
		const response = await dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "identity",
			method: "inspect",
			params: {
				pluginId: "com.example.attacker",
				runtimeId: "runtime-attacker",
				generation: 999,
				userId: "admin",
				scope: { projectId: "attacker-project" },
			},
		});
		expect(response).toEqual({
			jsonrpc: "2.0",
			id: "identity",
			result: {
				pluginId: identity.pluginId,
				runtimeId: identity.runtimeId,
				generation: identity.runtimeGeneration,
				installationId: identity.installationId,
				principalKind: "plugin_background",
				userId: null,
				projectId: "host-project",
			},
		});
	});

	it("fails closed when a broker is injected but the method has no capability binding", async () => {
		const dispatcher = new PluginHostDispatcher({
			identity,
			capabilityBroker: { authorize: async () => ({ allowed: true }) },
			methods: {
				unbound: {
					method: "unbound",
					handler: async () => ({ shouldNotRun: true }),
				},
			},
		});
		const response = await dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "unbound",
			method: "unbound",
		});
		expect("error" in response).toBe(true);
		if ("error" in response) {
			expect(response.error.data).toMatchObject({
				code: "PERMISSION_DENIED",
				details: { reason: "CAPABILITY_BINDING_MISSING" },
			});
		}
	});

	it("returns standard method-not-found and invalid-params errors", async () => {
		const dispatcher = new PluginHostDispatcher({
			identity,
			methods: {
				validate: {
					method: "validate",
					paramsSchema: z.object({ value: z.string() }).strict(),
					handler: async (params) => params,
				},
			},
		});
		const unknown = await dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method: "missing" });
		const invalid = await dispatcher.dispatch({
			jsonrpc: "2.0",
			id: 2,
			method: "validate",
			params: { value: 123 },
		});
		expect("error" in unknown && unknown.error.code).toBe(-32601);
		expect("error" in invalid && invalid.error.code).toBe(-32602);
	});

	it("rejects a duplicate active id without invoking the handler twice", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const dispatcher = new PluginHostDispatcher({
			identity,
			methods: {
				wait: {
					method: "wait",
					handler: async () => {
						calls++;
						await gate;
						return { ok: true };
					},
				},
			},
		});
		const request = { jsonrpc: "2.0" as const, id: "duplicate", method: "wait" };
		const first = dispatcher.dispatch(request);
		await eventually(() => calls === 1);
		const duplicate = await dispatcher.dispatch(request);
		expect("error" in duplicate && duplicate.error.code).toBe(-32600);
		expect(calls).toBe(1);
		release();
		await expect(first).resolves.toMatchObject({ result: { ok: true } });
	});

	it("aborts a dispatched side effect and reports UNKNOWN_RESULT exactly once", async () => {
		let started = false;
		let sawAbort = false;
		const dispatcher = new PluginHostDispatcher({
			identity,
			methods: {
				mutate: {
					method: "mutate",
					sideEffect: "unknown",
					handler: async (_params, context) => {
						started = true;
						await new Promise<void>((resolve) => {
							context.signal.addEventListener(
								"abort",
								() => {
									sawAbort = true;
									resolve();
								},
								{ once: true },
							);
						});
						return { committed: true };
					},
				},
			},
		});
		const result = dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "cancel-side-effect",
			method: "mutate",
		});
		await eventually(() => started);
		expect(await dispatcher.cancel("cancel-side-effect", "user cancelled")).toBe(true);
		const response = await result;
		expect("error" in response && response.error.data).toMatchObject({ code: "UNKNOWN_RESULT" });
		expect(sawAbort).toBe(true);
		expect(dispatcher.inboundActive.size).toBe(0);
	});

	it("applies one deadline across context, resolvers, authorization, and handler", async () => {
		let resolverAborted = false;
		const dispatcher = new PluginHostDispatcher({
			identity,
			defaultTimeoutMs: 15,
			maxTimeoutMs: 50,
			methods: {
				slowResolver: {
					method: "slowResolver",
					timeoutMs: 15,
					resourceResolver: async ({ signal }) => {
						await new Promise<void>((resolve) => {
							signal.addEventListener(
								"abort",
								() => {
									resolverAborted = true;
									resolve();
								},
								{ once: true },
							);
						});
						return { type: "project", id: "never" };
					},
					handler: async () => ({ shouldNotRun: true }),
				},
			},
		});
		const response = await dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "deadline",
			method: "slowResolver",
		});
		expect("error" in response && response.error.data).toMatchObject({
			details: { code: "TIMEOUT" },
		});
		expect(resolverAborted).toBe(true);
	});

	it("normalizes injected business errors into JSON-RPC responses", async () => {
		const dispatcher = new PluginHostDispatcher({
			identity,
			methods: {
				fail: {
					method: "fail",
					handler: async () => {
						throw new PluginHostDispatcherError("PERMISSION_DENIED", "Denied", {
							rpcCode: -32008,
							retryable: false,
						});
					},
				},
			},
		});
		const response = await dispatcher.dispatch({ jsonrpc: "2.0", id: "failure", method: "fail" });
		expect(response).toMatchObject({
			id: "failure",
			error: {
				code: -32008,
				data: { code: "PERMISSION_DENIED", retryable: false },
			},
		});
	});
});
