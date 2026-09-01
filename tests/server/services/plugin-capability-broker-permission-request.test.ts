import { describe, expect, mock, test } from "bun:test";
import type { PermissionGrant } from "@server/lib/plugins/permissions";
import {
	CapabilityBroker,
	type HostCallContext,
	type PluginPermissionRequestInput,
} from "@server/services/plugin-capability-broker";

const capability = "query.read.projects" as const;
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

describe("CapabilityBroker permission request on denial", () => {
	test("un-granted capability fires onPermissionRequest and attaches pendingRequestId", async () => {
		const callback = mock<
			(
				input: PluginPermissionRequestInput,
			) => Promise<{ requestId: string } | undefined> | { requestId: string } | undefined
		>(async () => ({ requestId: "pending-req-1" }));

		const capabilityBroker = new CapabilityBroker({
			bindings: new Map([[principal.pluginId, makeBinding({ installationGrants: [] })]]),
			now: () => now,
			onPermissionRequest: callback,
		} as never);

		const result = await capabilityBroker.authorize(context(), capability);

		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.error.reason).toBe("CAPABILITY_NOT_GRANTED");
			expect(result.pendingRequestId).toBe("pending-req-1");
			expect(result.error.pendingRequestId).toBe("pending-req-1");
		}

		expect(callback).toHaveBeenCalledTimes(1);
		const callArg = callback.mock.calls[0]?.[0];
		expect(callArg).toBeDefined();
		expect(callArg?.pluginId).toBe(principal.pluginId);
		expect(callArg?.installationId).toBe(principal.installationId);
		expect(callArg?.runtimeId).toBe(principal.runtimeId);
		expect(callArg?.runtimeGeneration).toBe(principal.runtimeGeneration);
		expect(callArg?.capability).toBe(capability);
		expect(callArg?.scope).toBeDefined();
	});

	test("callback returning undefined does not add pendingRequestId", async () => {
		const callback = mock<
			(
				input: PluginPermissionRequestInput,
			) => Promise<{ requestId: string } | undefined> | { requestId: string } | undefined
		>(() => undefined);

		const capabilityBroker = new CapabilityBroker({
			bindings: new Map([[principal.pluginId, makeBinding({ installationGrants: [] })]]),
			now: () => now,
			onPermissionRequest: callback,
		} as never);

		const result = await capabilityBroker.authorize(context(), capability);

		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.error.reason).toBe("CAPABILITY_NOT_GRANTED");
			expect(result.pendingRequestId).toBeUndefined();
			expect(result.error.pendingRequestId).toBeUndefined();
		}
		expect(callback).toHaveBeenCalledTimes(1);
	});

	test("granted capability succeeds and does NOT fire onPermissionRequest", async () => {
		const callback = mock<
			(
				input: PluginPermissionRequestInput,
			) => Promise<{ requestId: string } | undefined> | { requestId: string } | undefined
		>(() => ({ requestId: "should-not-appear" }));

		const capabilityBroker = new CapabilityBroker({
			bindings: new Map([[principal.pluginId, makeBinding()]]),
			now: () => now,
			onPermissionRequest: callback,
		} as never);

		const result = await capabilityBroker.authorize(context(), capability);

		expect(result.allowed).toBe(true);
		expect(callback).toHaveBeenCalledTimes(0);
	});

	test("plugin disabled denial does NOT fire onPermissionRequest", async () => {
		const callback = mock<
			(
				input: PluginPermissionRequestInput,
			) => Promise<{ requestId: string } | undefined> | { requestId: string } | undefined
		>(() => ({ requestId: "should-not-appear" }));

		const capabilityBroker = new CapabilityBroker({
			bindings: new Map([
				[
					principal.pluginId,
					makeBinding({
						desiredState: "disabled",
						installationGrants: [],
					}),
				],
			]),
			now: () => now,
			onPermissionRequest: callback,
		} as never);

		const result = await capabilityBroker.authorize(context(), capability);

		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.error.reason).toBe("PLUGIN_NOT_ENABLED");
		}
		expect(callback).toHaveBeenCalledTimes(0);
	});

	test("plugin quarantine denial does NOT fire onPermissionRequest", async () => {
		const callback = mock<
			(
				input: PluginPermissionRequestInput,
			) => Promise<{ requestId: string } | undefined> | { requestId: string } | undefined
		>(() => ({ requestId: "should-not-appear" }));

		const capabilityBroker = new CapabilityBroker({
			bindings: new Map([
				[
					principal.pluginId,
					makeBinding({
						runtimeState: "quarantine",
						installationGrants: [],
					}),
				],
			]),
			now: () => now,
			onPermissionRequest: callback,
		} as never);

		const result = await capabilityBroker.authorize(context(), capability);

		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.error.reason).toBe("PLUGIN_QUARANTINED");
		}
		expect(callback).toHaveBeenCalledTimes(0);
	});

	test("callback throwing is silently ignored and denial still returned", async () => {
		const callback = mock(() => {
			throw new Error("callback explosion");
		});

		const capabilityBroker = new CapabilityBroker({
			bindings: new Map([[principal.pluginId, makeBinding({ installationGrants: [] })]]),
			now: () => now,
			onPermissionRequest: callback,
		} as never);

		// Should not throw — callback errors are swallowed
		const result = await capabilityBroker.authorize(context(), capability);

		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			expect(result.error.reason).toBe("CAPABILITY_NOT_GRANTED");
			expect(result.pendingRequestId).toBeUndefined();
		}
		expect(callback).toHaveBeenCalledTimes(1);
	});

	test("scope is derived from invocation context", async () => {
		let capturedScope: { type: string; id?: string } | undefined;
		const callback = mock((input: { scope: { type: string; id?: string } }) => {
			capturedScope = input.scope;
			return { requestId: "req-scope-1" };
		});

		const capabilityBroker = new CapabilityBroker({
			bindings: new Map([[principal.pluginId, makeBinding({ installationGrants: [] })]]),
			now: () => now,
			onPermissionRequest: callback,
		} as never);

		await capabilityBroker.authorize(context({ scope: { projectId: "project-1" } }), capability);

		expect(capturedScope).toBeDefined();
		// With only projectId in scope, should derive { type: "project", id: "project-1" }
		expect(capturedScope!.type).toBe("project");
		expect(capturedScope!.id).toBe("project-1");
	});

	test("empty scope defaults to global", async () => {
		let capturedScope: { type: string; id?: string } | undefined;
		const callback = mock((input: { scope: { type: string; id?: string } }) => {
			capturedScope = input.scope;
			return { requestId: "req-global-1" };
		});

		const capabilityBroker = new CapabilityBroker({
			bindings: new Map([[principal.pluginId, makeBinding({ installationGrants: [] })]]),
			now: () => now,
			onPermissionRequest: callback,
		} as never);

		await capabilityBroker.authorize(context({ scope: {} }), capability);

		expect(capturedScope).toBeDefined();
		expect(capturedScope!.type).toBe("global");
	});
});
