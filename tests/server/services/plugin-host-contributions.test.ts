import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "@server/lib/agent/tool-registry";
import type { ToolContext } from "@server/lib/agent/types";
import { type ManifestInput, parseManifest, safeParseManifest } from "@server/lib/plugins/manifest";
import type { InvocationScope } from "@server/lib/plugins/permissions";
import { PluginAgentToolBridge } from "@server/services/plugin-agent-tool-bridge";
import {
	CapabilityBroker,
	type HostCallContext,
	type InvocationPrincipal,
	type PluginPrincipal,
} from "@server/services/plugin-capability-broker";
import {
	type PluginCommandInvokeContext,
	PluginCommandRegistry,
	type PluginCommandRegistryOptions,
} from "@server/services/plugin-command-registry";
import {
	type PluginHostHandlerRegistration,
	type PluginToolCapabilityBroker,
	PluginToolRegistry,
} from "@server/services/plugin-tool-registry";

const principal: PluginPrincipal = {
	pluginId: "com.example.host",
	packageVersion: "1.0.0",
	runtimeId: "host:contributions",
	runtimeGeneration: 1,
	installationId: "installed-host-1",
};
const fullToolId = `${principal.pluginId}/send`;
const inputSchema = {
	type: "object",
	properties: { text: { type: "string", minLength: 1 } },
	required: ["text"],
	additionalProperties: false,
};

function manifest() {
	const input: ManifestInput = {
		schemaVersion: 1,
		pluginId: principal.pluginId,
		version: "1.0.0",
		displayName: "Host contribution fixture",
		engine: {
			runtime: "bun",
			hostApi: ">=1.0 <2",
			rpc: "narrafork.rpc/1",
			runner: "local-process",
		},
		activationEvents: ["onTool:send", "onCommand:bind"],
		contributes: {
			tools: [
				{ id: "send", title: "Send", execution: "host", inputSchema, allowBackground: false },
			],
			commands: [{ id: "bind", title: "Bind", handler: "host", inputSchema }],
		},
		permissions: {
			host: ["provider.use"],
			network: { mode: "none", allow: [] },
			filesystem: { package: "readOnly", pluginData: "readWrite", workspace: "none" },
			process: { spawn: "none" },
		},
	};
	return parseManifest(input);
}

function registration(
	overrides: Partial<PluginHostHandlerRegistration> = {},
): PluginHostHandlerRegistration {
	return {
		principal,
		isTrusted: () => true,
		resolvePrincipal: () => principal,
		...overrides,
	};
}

function invocation(userId = "user-1"): InvocationPrincipal {
	return { kind: "user", source: "ui", userId, userRole: "user" };
}

function scope(userId = "user-1"): InvocationScope {
	return { userId, narratorId: `narrator-${userId}` };
}

function commandContext(userId = "user-1"): PluginCommandInvokeContext {
	return {
		requestId: `request-${userId}`,
		correlationId: `correlation-${userId}`,
		invocation: invocation(userId),
		scope: scope(userId),
	};
}

function broker(
	authorize: PluginToolCapabilityBroker["authorize"] = async () => ({ allowed: true }),
): PluginToolCapabilityBroker {
	return { authorize };
}

function toolRegistry(capabilityBroker = broker()): PluginToolRegistry {
	const registry = new PluginToolRegistry({ capabilityBroker });
	registry.registerManifest(manifest());
	return registry;
}

function commandRegistry(options: PluginCommandRegistryOptions = {}): PluginCommandRegistry {
	const registry = new PluginCommandRegistry({ capabilityBroker: broker(), ...options });
	registry.registerManifest(manifest());
	return registry;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

describe("host contribution manifest", () => {
	test("accepts host-only declarations without a server and keeps background opt-in false", () => {
		const parsed = parseManifest(manifest());
		expect(parsed.server).toBeUndefined();
		expect(parsed.contributes.tools[0].execution).toBe("host");
		expect(parsed.contributes.commands[0].handler).toBe("host");
		expect(parsed.contributes.tools[0].allowBackground).toBe(false);
	});

	test("keeps existing server/ui contribution backend requirements", () => {
		for (const execution of ["server", "ui"] as const) {
			const value = manifest();
			value.contributes.tools[0].execution = execution;
			expect(safeParseManifest(value).success).toBe(false);
		}
		for (const handler of ["server", "ui"] as const) {
			const value = manifest();
			value.contributes.commands[0].handler = handler;
			expect(safeParseManifest(value).success).toBe(false);
		}
	});
});

describe("host tool contributions", () => {
	test("cannot fall through to generic handlers or runtime for a third-party host declaration", async () => {
		let fallbackCalls = 0;
		const registry = new PluginToolRegistry({
			capabilityBroker: broker(),
			handler: () => {
				fallbackCalls++;
				return "wrong";
			},
			resolveRuntime: () => {
				fallbackCalls++;
				return undefined;
			},
		});
		registry.registerManifest(manifest(), {
			principal,
			handler: () => {
				fallbackCalls++;
				return "wrong";
			},
		});
		await expect(
			registry.invoke(fullToolId, { text: "test" }, commandContext()),
		).rejects.toMatchObject({ code: "HOST_UNAVAILABLE" });
		expect(fallbackCalls).toBe(0);
		await expect(
			registry.invoke(`${principal.pluginId}/unknown`, {}, commandContext()),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("derives plugin identity from the live trusted installation and freezes every host context field", async () => {
		let authorized: HostCallContext | undefined;
		const registry = toolRegistry(
			broker(async (request) => {
				authorized = request.context;
				expect(request.capability).toBe("provider.use");
				expect(request.methodId).toBe(`tools.invoke:${fullToolId}`);
				return { allowed: true };
			}),
		);
		registry.registerHostHandler(
			principal.pluginId,
			"send",
			(_input, call) => {
				if (!authorized)
					throw new Error("Capability authorization must run before handler dispatch");
				expect(call.host).toBe(authorized);
				expect(call.host.plugin).toEqual({ ...principal, contributionId: "send" });
				for (const field of [call.host, call.host.plugin, call.host.invocation, call.host.scope])
					expect(Object.isFrozen(field)).toBe(true);
				return {
					output: call.host.invocation.userId ?? "missing-user",
					metadata: { narrator: call.host.scope.narratorId ?? "missing-narrator" },
				};
			},
			registration(),
		);
		await expect(
			registry.invoke(
				fullToolId,
				{ text: "sensitive-content" },
				{
					context: {
						requestId: "host-request",
						correlationId: "host-correlation",
						deadlineAt: new Date(Date.now() + 10_000).toISOString(),
						plugin: { ...principal, pluginId: "com.example.forged", installationId: "forged" },
						invocation: invocation(),
						scope: scope(),
					},
				},
			),
		).resolves.toMatchObject({ output: "user-1" });
		expect(registry.getAuditEntries()[0]).toMatchObject({
			pluginId: principal.pluginId,
			principalKind: "user",
			userId: "user-1",
			contributionId: "send",
			outcome: "succeeded",
		});
		expect(JSON.stringify(registry.getAuditEntries())).not.toContain("sensitive-content");
	});

	test("fails closed for trust, absent installations and every pinned identity dimension", async () => {
		for (const options of [
			registration({ isTrusted: () => false }),
			registration({ resolvePrincipal: () => undefined }),
			...Object.entries({
				pluginId: "com.example.other",
				packageVersion: "2.0.0",
				installationId: "other-install",
				runtimeId: "foreign-runtime",
				runtimeGeneration: 2,
				contributionId: "other",
			}).map(([key, value]) =>
				registration({ resolvePrincipal: () => ({ ...principal, [key]: value }) }),
			),
		]) {
			let calls = 0;
			const registry = toolRegistry();
			registry.registerHostHandler(
				principal.pluginId,
				"send",
				() => {
					calls++;
					return "wrong";
				},
				options,
			);
			await expect(
				registry.invoke(fullToolId, { text: "hello" }, commandContext()),
			).rejects.toBeDefined();
			expect(calls).toBe(0);
		}
	});

	test("never uses a stale manifest principal for host registration with no live resolver", async () => {
		const registry = new PluginToolRegistry({ capabilityBroker: broker() });
		registry.registerManifest(manifest(), { principal });
		registry.registerHostHandler(
			principal.pluginId,
			"send",
			() => "wrong",
			registration({ resolvePrincipal: undefined }),
		);
		await expect(
			registry.invoke(fullToolId, { text: "hello" }, commandContext()),
		).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
	});

	test("preserves input validation, background refusal and capability denial before execution", async () => {
		let calls = 0;
		let authorizations = 0;
		const registry = toolRegistry(
			broker(async () => {
				authorizations++;
				return { allowed: false, error: { code: "PERMISSION_DENIED" } };
			}),
		);
		registry.registerHostHandler(
			principal.pluginId,
			"send",
			() => {
				calls++;
				return "wrong";
			},
			registration(),
		);
		await expect(
			registry.invoke(fullToolId, { text: "hello", userId: "forged" }, commandContext()),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		await expect(
			registry.invoke(
				fullToolId,
				{ text: "hello" },
				{ invocation: { kind: "plugin_background", source: "schedule" } },
			),
		).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		expect(authorizations).toBe(0);
		await expect(
			registry.invoke(fullToolId, { text: "hello" }, commandContext()),
		).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		expect(authorizations).toBe(1);
		expect(calls).toBe(0);
		expect(registry.getAuditEntries()[1].principalKind).toBe("plugin_background");
	});

	test("isolates concurrent calls and propagates handler timeouts and cancellation", async () => {
		const registry = toolRegistry();
		const entered = deferred<void>();
		const release = deferred<void>();
		registry.registerHostHandler(
			principal.pluginId,
			"send",
			async (_input, call) => {
				entered.resolve();
				await release.promise;
				return call.host.invocation.userId;
			},
			registration(),
		);
		const one = registry.invoke(fullToolId, { text: "one" }, commandContext("one"));
		const two = registry.invoke(fullToolId, { text: "two" }, commandContext("two"));
		await entered.promise;
		release.resolve();
		expect((await Promise.all([one, two])).map((result) => result.output)).toEqual(["one", "two"]);
		for (const mode of ["timeout", "cancel"] as const) {
			const hung = toolRegistry();
			const started = deferred<void>();
			let signal: AbortSignal | undefined;
			hung.registerHostHandler(
				principal.pluginId,
				"send",
				(_input, call) => {
					signal = call.signal;
					started.resolve();
					return new Promise(() => {});
				},
				registration(),
			);
			const controller = new AbortController();
			const pending = hung.invoke(
				fullToolId,
				{ text: "wait" },
				{
					...commandContext(),
					timeoutMs: mode === "timeout" ? 15 : 1_000,
					signal: controller.signal,
				},
			);
			await started.promise;
			if (mode === "cancel") controller.abort();
			await expect(pending).rejects.toMatchObject(
				mode === "timeout" ? { code: "TIMEOUT" } : { name: "AbortError" },
			);
			expect(signal?.aborted).toBe(true);
			expect(hung.getAuditEntries()[0].outcome).toBe(mode === "timeout" ? "timeout" : "cancelled");
		}
	});

	test("does not execute a host handler with a pre-cancelled caller", async () => {
		let calls = 0;
		const registry = toolRegistry();
		registry.registerHostHandler(
			principal.pluginId,
			"send",
			() => {
				calls++;
				return "wrong";
			},
			registration(),
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			registry.invoke(
				fullToolId,
				{ text: "hello" },
				{ ...commandContext(), signal: controller.signal },
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toBe(0);
	});

	test("uses explicit trusted template followInstallation without bypassing live installation resolution", async () => {
		let live: PluginPrincipal | undefined = {
			...principal,
			installationId: "reinstalled",
			runtimeGeneration: 20,
		};
		let trusted = true;
		const registry = toolRegistry();
		registry.registerHostHandler(
			principal.pluginId,
			"send",
			() => "ok",
			registration({
				followInstallation: true,
				resolvePrincipal: () => live,
				isTrusted: () => trusted,
			}),
		);
		await expect(
			registry.invoke(fullToolId, { text: "hello" }, commandContext()),
		).resolves.toMatchObject({ output: "ok" });
		trusted = false;
		await expect(
			registry.invoke(fullToolId, { text: "hello" }, commandContext()),
		).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		trusted = true;
		live = undefined;
		await expect(
			registry.invoke(fullToolId, { text: "hello" }, commandContext()),
		).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
	});

	test("unregister during authorization cannot dispatch an already captured host handler", async () => {
		const entered = deferred<void>();
		const authorized = deferred<void>();
		const registry = toolRegistry(
			broker(async () => {
				entered.resolve();
				await authorized.promise;
				return { allowed: true };
			}),
		);
		let calls = 0;
		const unregister = registry.registerHostHandler(
			principal.pluginId,
			"send",
			() => {
				calls++;
				return "wrong";
			},
			registration(),
		);
		const pending = registry.invoke(fullToolId, { text: "hello" }, commandContext());
		await entered.promise;
		unregister();
		authorized.resolve();
		await expect(pending).rejects.toMatchObject({ code: "HOST_UNAVAILABLE" });
		expect(calls).toBe(0);
	});
});

describe("host command contributions", () => {
	test("cannot dispatch unknown or third-party host declarations or another plugin full id", async () => {
		let runtimeCalls = 0;
		const registry = commandRegistry({
			resolveRuntime: () => {
				runtimeCalls++;
				return undefined;
			},
		});
		await expect(
			registry.invoke("bind", principal.pluginId, { text: "hello" }, commandContext()),
		).rejects.toMatchObject({ code: "HOST_UNAVAILABLE" });
		await expect(
			registry.invoke("unknown", principal.pluginId, undefined, commandContext()),
		).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
		await expect(
			registry.invoke(
				`${principal.pluginId}/bind`,
				"com.example.other",
				undefined,
				commandContext(),
			),
		).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		expect(runtimeCalls).toBe(0);
	});

	test("uses trusted UI context but ignores its forged plugin identity and payload identity", async () => {
		let authorized: HostCallContext | undefined;
		const registry = commandRegistry({
			capabilityBroker: broker(async (request) => {
				authorized = request.context;
				expect(request.methodId).toBe(`commands.invoke:${principal.pluginId}/bind`);
				return { allowed: true };
			}),
		});
		registry.registerHostHandler(
			principal.pluginId,
			"bind",
			(_input, call) => {
				expect(call.host.plugin).toEqual({ ...principal, contributionId: "bind" });
				expect(call.host.requestId).toBe("trusted-request");
				expect(call.host.correlationId).toBe("trusted-correlation");
				if (!authorized)
					throw new Error("Capability authorization must run before handler dispatch");
				expect(call.host).toBe(authorized);
				for (const value of [
					call.host,
					call.host.plugin,
					call.invocation,
					call.scope,
					call.descriptor,
				])
					expect(Object.isFrozen(value)).toBe(true);
				return {
					output: {
						userId: call.invocation.userId ?? "missing-user",
						narratorId: call.scope.narratorId ?? "missing-narrator",
					},
				};
			},
			registration(),
		);
		const context = commandContext();
		context.hostContext = {
			requestId: "trusted-request",
			correlationId: "trusted-correlation",
			deadlineAt: new Date(Date.now() + 10_000).toISOString(),
			plugin: { ...principal, pluginId: "com.example.forged", installationId: "foreign" },
			invocation: invocation(),
			scope: scope(),
		};
		await expect(
			registry.invoke("bind", principal.pluginId, { text: "hello", userId: "forged" }, context),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		await expect(
			registry.invoke("bind", principal.pluginId, { text: "sensitive-content" }, context),
		).resolves.toMatchObject({
			output: { userId: "user-1", narratorId: "narrator-user-1" },
			secretWrites: [],
			configWrites: [],
		});
		expect(registry.getAuditEntries()[1]).toMatchObject({
			outcome: "succeeded",
			userId: "user-1",
			contributionId: "bind",
			requestId: "trusted-request",
			correlationId: "trusted-correlation",
		});
		expect(JSON.stringify(registry.getAuditEntries())).not.toContain("sensitive-content");
	});

	test("rejects background, system, forged user authority and inconsistent user scope", async () => {
		let calls = 0;
		const registry = commandRegistry();
		registry.registerHostHandler(
			principal.pluginId,
			"bind",
			() => {
				calls++;
				return {};
			},
			registration(),
		);
		for (const context of [
			{ requestId: "background-default" },
			{ requestId: "background", invocation: { kind: "plugin_background", source: "command" } },
			{ requestId: "system", invocation: { kind: "system", source: "internal" } },
			{
				requestId: "forged",
				invocation: { kind: "plugin_background", source: "schedule", userId: "user-1" },
			},
			{ ...commandContext(), scope: scope("foreign-user") },
		] as PluginCommandInvokeContext[]) {
			await expect(
				registry.invoke("bind", principal.pluginId, { text: "hello" }, context),
			).rejects.toBeDefined();
		}
		expect(calls).toBe(0);
		expect(registry.getAuditEntries()[0]).toMatchObject({
			principalKind: "plugin_background",
			outcome: "denied",
		});
	});

	test("requires a live matching installed principal and rechecks package trust", async () => {
		for (const options of [
			registration({ isTrusted: () => false }),
			registration({ resolvePrincipal: () => undefined }),
			...Object.entries({
				pluginId: "com.example.other",
				packageVersion: "2.0.0",
				installationId: "other-install",
				runtimeId: "foreign-runtime",
				runtimeGeneration: 2,
				contributionId: "other",
			}).map(([key, value]) =>
				registration({ resolvePrincipal: () => ({ ...principal, [key]: value }) }),
			),
		]) {
			let calls = 0;
			const registry = commandRegistry();
			registry.registerHostHandler(
				principal.pluginId,
				"bind",
				() => {
					calls++;
					return {};
				},
				options,
			);
			await expect(
				registry.invoke("bind", principal.pluginId, { text: "hello" }, commandContext()),
			).rejects.toBeDefined();
			expect(calls).toBe(0);
		}
	});

	test("fails closed without capability broker or when grants deny and accepts scalar command schemas", async () => {
		for (const capabilityBroker of [
			undefined,
			broker(async () => ({ allowed: false, error: { code: "PERMISSION_DENIED" } })),
		]) {
			let calls = 0;
			const registry = commandRegistry({ capabilityBroker });
			registry.registerHostHandler(
				principal.pluginId,
				"bind",
				() => {
					calls++;
					return {};
				},
				registration(),
			);
			await expect(
				registry.invoke("bind", principal.pluginId, { text: "hello" }, commandContext()),
			).rejects.toBeDefined();
			expect(calls).toBe(0);
		}
		const value = manifest();
		value.contributes.commands[0].inputSchema = { type: "string", minLength: 2 };
		const registry = commandRegistry();
		registry.registerManifest(value);
		registry.registerHostHandler(
			principal.pluginId,
			"bind",
			(input) => ({ output: input }),
			registration(),
		);
		await expect(
			registry.invoke("bind", principal.pluginId, "ok", commandContext()),
		).resolves.toMatchObject({ output: "ok" });
		await expect(
			registry.invoke("bind", principal.pluginId, "x", commandContext()),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
	});

	test("keeps concurrent command identity isolated", async () => {
		const registry = commandRegistry();
		const release = deferred<void>();
		const entered = deferred<void>();
		registry.registerHostHandler(
			principal.pluginId,
			"bind",
			async (_input, call) => {
				entered.resolve();
				await release.promise;
				return {
					output: { user: call.invocation.userId ?? "missing-user", request: call.host.requestId },
				};
			},
			registration(),
		);
		const calls = [
			registry.invoke("bind", principal.pluginId, { text: "one" }, commandContext("one")),
			registry.invoke("bind", principal.pluginId, { text: "two" }, commandContext("two")),
		];
		await entered.promise;
		release.resolve();
		expect((await Promise.all(calls)).map((result) => result.output)).toEqual([
			{ user: "one", request: "request-one" },
			{ user: "two", request: "request-two" },
		]);
	});

	test("times out and cancels hung commands while aborting handler signals", async () => {
		for (const mode of ["timeout", "cancel"] as const) {
			const registry = commandRegistry();
			const entered = deferred<void>();
			let signal: AbortSignal | undefined;
			registry.registerHostHandler(
				principal.pluginId,
				"bind",
				(_input, call) => {
					signal = call.signal;
					entered.resolve();
					return new Promise(() => {});
				},
				registration(),
			);
			const controller = new AbortController();
			const pending = registry.invoke(
				"bind",
				principal.pluginId,
				{ text: "hello" },
				{
					...commandContext(),
					timeoutMs: mode === "timeout" ? 15 : 1_000,
					signal: controller.signal,
				},
			);
			await entered.promise;
			if (mode === "cancel") controller.abort();
			await expect(pending).rejects.toMatchObject(
				mode === "timeout" ? { code: "TIMEOUT" } : { name: "AbortError" },
			);
			expect(signal?.aborted).toBe(true);
			expect(registry.getAuditEntries()[0].outcome).toBe(
				mode === "timeout" ? "timeout" : "cancelled",
			);
		}
	});

	test("pre-cancelled and expired calls never execute handlers", async () => {
		let calls = 0;
		const registry = commandRegistry();
		registry.registerHostHandler(
			principal.pluginId,
			"bind",
			() => {
				calls++;
				return {};
			},
			registration(),
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			registry.invoke(
				"bind",
				principal.pluginId,
				{ text: "hello" },
				{ ...commandContext(), signal: controller.signal },
			),
		).rejects.toMatchObject({ name: "AbortError" });
		await expect(
			registry.invoke(
				"bind",
				principal.pluginId,
				{ text: "hello" },
				{ ...commandContext(), deadlineAt: new Date(0).toISOString() },
			),
		).rejects.toMatchObject({ code: "TIMEOUT" });
		expect(calls).toBe(0);
	});

	test("timeout covers pending authorization and late resolution cannot invoke handlers", async () => {
		const authorization = deferred<void>();
		let calls = 0;
		const registry = commandRegistry({
			capabilityBroker: broker(async () => {
				await authorization.promise;
				return { allowed: true };
			}),
		});
		registry.registerHostHandler(
			principal.pluginId,
			"bind",
			() => {
				calls++;
				return {};
			},
			registration(),
		);
		await expect(
			registry.invoke(
				"bind",
				principal.pluginId,
				{ text: "hello" },
				{ ...commandContext(), timeoutMs: 15 },
			),
		).rejects.toMatchObject({ code: "TIMEOUT" });
		authorization.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toBe(0);
	});

	test("handler unregister and manifest replacement during authorization prevent dispatch", async () => {
		for (const mode of ["unregister", "replace"] as const) {
			const entered = deferred<void>();
			const release = deferred<void>();
			let calls = 0;
			const registry = commandRegistry({
				capabilityBroker: broker(async () => {
					entered.resolve();
					await release.promise;
					return { allowed: true };
				}),
			});
			const unregister = registry.registerHostHandler(
				principal.pluginId,
				"bind",
				() => {
					calls++;
					return {};
				},
				registration(),
			);
			const pending = registry.invoke(
				"bind",
				principal.pluginId,
				{ text: "hello" },
				commandContext(),
			);
			await entered.promise;
			if (mode === "unregister") unregister();
			else registry.registerManifest(manifest());
			release.resolve();
			await expect(pending).rejects.toMatchObject({ code: "HOST_UNAVAILABLE" });
			expect(calls).toBe(0);
		}
	});

	test("supports trusted reinstall templates but never follows foreign runtime or package versions", async () => {
		let live: PluginPrincipal | undefined = {
			...principal,
			installationId: "new-install",
			runtimeGeneration: 20,
		};
		const registry = commandRegistry();
		registry.registerHostHandler(
			principal.pluginId,
			"bind",
			() => ({ output: "ok" }),
			registration({ followInstallation: true, resolvePrincipal: () => live }),
		);
		await expect(
			registry.invoke("bind", principal.pluginId, { text: "hello" }, commandContext()),
		).resolves.toMatchObject({ output: "ok" });
		live = { ...principal, runtimeId: "other-runtime" };
		await expect(
			registry.invoke("bind", principal.pluginId, { text: "hello" }, commandContext()),
		).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		live = { ...principal, packageVersion: "2.0.0" };
		await expect(
			registry.invoke("bind", principal.pluginId, { text: "hello" }, commandContext()),
		).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		live = undefined;
		await expect(
			registry.invoke("bind", principal.pluginId, { text: "hello" }, commandContext()),
		).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
	});
});

describe("host tools in the agent bridge", () => {
	test("discovers host-only tools and executes without activating a server process", async () => {
		let activations = 0;
		const registry = toolRegistry();
		registry.registerHostHandler(
			principal.pluginId,
			"send",
			(_input, call) => `${call.invocation.userId}:${call.scope.narratorId}`,
			registration(),
		);
		const bridge = new PluginAgentToolBridge({
			pluginToolRegistry: registry,
			agentToolRegistry: new ToolRegistry(),
			activatePlugin: async () => {
				activations++;
				throw new Error("must not start");
			},
			isRuntimeActive: () => false,
		});
		expect(bridge.sync()[0].descriptor.execution).toBe("host");
		const context: ToolContext = {
			narratorId: "narrator-1",
			cwd: "/workspace",
			signal: new AbortController().signal,
			locale: "en",
			userId: "user-1",
			requestPermission: async () => ({ behavior: "allow" }),
		};
		await expect(
			bridge.invokeFullId(fullToolId, { text: "hello" }, context),
		).resolves.toMatchObject({ output: "user-1:narrator-1" });
		expect(activations).toBe(0);
		const unbound = toolRegistry();
		const unboundBridge = new PluginAgentToolBridge({
			pluginToolRegistry: unbound,
			agentToolRegistry: new ToolRegistry(),
		});
		unboundBridge.sync();
		await expect(
			unboundBridge.invokeFullId(fullToolId, { text: "hello" }, context),
		).rejects.toMatchObject({ code: "HOST_UNAVAILABLE" });
	});

	test("real installation grants authorize host-only commands/tools and revocation stops both", async () => {
		const capabilityBroker = new CapabilityBroker();
		const binding = {
			plugin: principal,
			desiredState: "enabled" as const,
			compatibilityState: "compatible" as const,
			runtimeState: "active" as const,
			manifestRequested: ["provider.use"],
			installationGrants: [
				{ capability: "provider.use" as const, scope: { type: "global" as const } },
			],
			hostPolicy: ["provider.use"],
			currentUserAuthority: ["provider.use"],
			contributionPolicy: ["provider.use"],
			runnerEnforcement: ["provider.use"],
			grantRevision: 1,
		};
		capabilityBroker.setBinding(principal.pluginId, binding);
		let toolCalls = 0;
		let commandCalls = 0;
		const tools = toolRegistry(capabilityBroker);
		const commands = commandRegistry({ capabilityBroker });
		tools.registerHostHandler(
			principal.pluginId,
			"send",
			() => {
				toolCalls++;
				return "ok";
			},
			registration(),
		);
		commands.registerHostHandler(
			principal.pluginId,
			"bind",
			() => {
				commandCalls++;
				return { output: "ok" };
			},
			registration(),
		);
		await expect(
			tools.invoke(fullToolId, { text: "hello" }, commandContext()),
		).resolves.toMatchObject({ output: "ok" });
		await expect(
			commands.invoke("bind", principal.pluginId, { text: "hello" }, commandContext()),
		).resolves.toMatchObject({ output: "ok" });
		capabilityBroker.setBinding(principal.pluginId, {
			...binding,
			installationGrants: [],
			grantRevision: 2,
		});
		await expect(
			tools.invoke(fullToolId, { text: "hello" }, commandContext()),
		).rejects.toBeDefined();
		await expect(
			commands.invoke("bind", principal.pluginId, { text: "hello" }, commandContext()),
		).rejects.toBeDefined();
		expect(toolCalls).toBe(1);
		expect(commandCalls).toBe(1);
		capabilityBroker.setBinding(principal.pluginId, {
			...binding,
			desiredState: "disabled",
			grantRevision: 3,
		});
		await expect(
			commands.invoke("bind", principal.pluginId, { text: "hello" }, commandContext()),
		).rejects.toMatchObject({ code: "PLUGIN_DISABLED" });
		expect(commandCalls).toBe(1);
	});

	test("host tools time out and cancel authorization before dispatch", async () => {
		for (const mode of ["timeout", "cancel"] as const) {
			const entered = deferred<void>();
			const release = deferred<void>();
			let calls = 0;
			const registry = toolRegistry(
				broker(async () => {
					entered.resolve();
					await release.promise;
					return { allowed: true };
				}),
			);
			registry.registerHostHandler(
				principal.pluginId,
				"send",
				() => {
					calls++;
					return "wrong";
				},
				registration(),
			);
			const controller = new AbortController();
			const pending = registry.invoke(
				fullToolId,
				{ text: "hello" },
				{
					...commandContext(),
					timeoutMs: mode === "timeout" ? 15 : 1_000,
					signal: controller.signal,
				},
			);
			await entered.promise;
			if (mode === "cancel") controller.abort();
			await expect(pending).rejects.toMatchObject(
				mode === "timeout" ? { code: "TIMEOUT" } : { name: "AbortError" },
			);
			release.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(calls).toBe(0);
		}
	});

	test("package trust and installation identity changes during authorization prevent host dispatch", async () => {
		for (const kind of ["tool", "command"] as const) {
			for (const mode of ["trust", "identity"] as const) {
				const entered = deferred<void>();
				const release = deferred<void>();
				let calls = 0;
				let trusted = true;
				let live = { ...principal };
				const capabilityBroker = broker(async () => {
					entered.resolve();
					await release.promise;
					return { allowed: true };
				});
				const options = registration({
					followInstallation: true,
					isTrusted: () => trusted,
					resolvePrincipal: () => live,
				});
				const tools = toolRegistry(capabilityBroker);
				const commands = commandRegistry({ capabilityBroker });
				tools.registerHostHandler(
					principal.pluginId,
					"send",
					() => {
						calls++;
						return "wrong";
					},
					options,
				);
				commands.registerHostHandler(
					principal.pluginId,
					"bind",
					() => {
						calls++;
						return {};
					},
					options,
				);
				const pending =
					kind === "tool"
						? tools.invoke(fullToolId, { text: "hello" }, commandContext())
						: commands.invoke("bind", principal.pluginId, { text: "hello" }, commandContext());
				await entered.promise;
				if (mode === "trust") trusted = false;
				else live = { ...principal, installationId: "reinstalled" };
				release.resolve();
				await expect(pending).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
				expect(calls).toBe(0);
			}
		}
	});

	test("narrator scope mismatch rejects tools and commands before handlers", async () => {
		let calls = 0;
		const tools = toolRegistry();
		const commands = commandRegistry();
		tools.registerHostHandler(
			principal.pluginId,
			"send",
			() => {
				calls++;
				return "wrong";
			},
			registration(),
		);
		commands.registerHostHandler(
			principal.pluginId,
			"bind",
			() => {
				calls++;
				return {};
			},
			registration(),
		);
		const context = {
			...commandContext(),
			invocation: { ...invocation(), narratorId: "forged-narrator" },
		};
		await expect(tools.invoke(fullToolId, { text: "hello" }, context)).rejects.toMatchObject({
			code: "PERMISSION_DENIED",
		});
		await expect(
			commands.invoke("bind", principal.pluginId, { text: "hello" }, context),
		).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		expect(calls).toBe(0);
	});

	test("a real broker still refuses a synthetic host principal with no installed binding", async () => {
		let calls = 0;
		const registry = toolRegistry(new CapabilityBroker());
		registry.registerHostHandler(
			principal.pluginId,
			"send",
			() => {
				calls++;
				return "wrong";
			},
			registration(),
		);
		await expect(
			registry.invoke(fullToolId, { text: "hello" }, commandContext()),
		).rejects.toBeDefined();
		expect(calls).toBe(0);
	});
});
