import { afterEach, describe, expect, test } from "bun:test";
import type { ToolContext } from "../../types";
import type { ExecutionBackend } from "../backend";
import {
	ExecutionTargetError,
	localBackend,
	resolveBackend,
	setRemoteBackendResolver,
} from "../registry";
import { getToolBackend } from "../tool-backend";

const remoteBackend = {
	deviceId: "device-1",
	kind: "remote",
} as ExecutionBackend;

function bareContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		narratorId: "narrator-1",
		cwd: "/workspace",
		locale: "en",
		signal: new AbortController().signal,
		requestPermission: async () => ({ behavior: "allow" }),
		...overrides,
	};
}

afterEach(() => {
	setRemoteBackendResolver(null);
});

describe("execution backend routing", () => {
	test("uses local only when no target is configured or local is explicit", () => {
		expect(resolveBackend()).toBe(localBackend);
		expect(resolveBackend({ sessionDefault: null })).toBe(localBackend);
		expect(resolveBackend({ requested: "local", sessionDefault: "device-1" })).toBe(localBackend);
	});

	test("resolves an explicit remote target", () => {
		setRemoteBackendResolver((deviceId) => (deviceId === "device-1" ? remoteBackend : null));

		expect(resolveBackend({ requested: "device-1" })).toBe(remoteBackend);
	});

	test("resolves the session default when no explicit target is provided", () => {
		setRemoteBackendResolver((deviceId) => (deviceId === "device-1" ? remoteBackend : null));

		expect(resolveBackend({ sessionDefault: "device-1" })).toBe(remoteBackend);
	});

	test("rejects invalid resolver results instead of accepting the wrong backend", () => {
		setRemoteBackendResolver(() => localBackend);
		expect(() => resolveBackend({ requested: "device-1" })).toThrow(ExecutionTargetError);

		setRemoteBackendResolver(() => remoteBackend);
		expect(() => resolveBackend({ requested: "device-2" })).toThrow(ExecutionTargetError);
	});

	test("throws a typed error for an unknown or offline explicit remote target", () => {
		setRemoteBackendResolver(() => null);

		expect(() => resolveBackend({ requested: "missing-device" })).toThrow(ExecutionTargetError);
		try {
			resolveBackend({ requested: "missing-device" });
		} catch (error) {
			expect(error).toBeInstanceOf(ExecutionTargetError);
			expect((error as ExecutionTargetError).code).toBe("REMOTE_DEVICE_UNAVAILABLE");
			expect((error as ExecutionTargetError).deviceId).toBe("missing-device");
			expect((error as ExecutionTargetError).source).toBe("requested");
			expect((error as Error).message).toContain("was not run locally");
		}
	});

	test("throws instead of falling back for an unavailable session default", () => {
		setRemoteBackendResolver(() => null);

		try {
			resolveBackend({ sessionDefault: "stale-default" });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(ExecutionTargetError);
			expect((error as ExecutionTargetError).source).toBe("session_default");
			expect((error as ExecutionTargetError).deviceId).toBe("stale-default");
		}
	});

	test("bare tool contexts use the registry instead of silently selecting local", () => {
		setRemoteBackendResolver((deviceId) => (deviceId === "device-1" ? remoteBackend : null));

		expect(getToolBackend(bareContext())).toBe(localBackend);
		expect(getToolBackend(bareContext({ defaultDeviceId: "device-1" }))).toBe(remoteBackend);
		expect(() => getToolBackend(bareContext({ defaultDeviceId: "offline-device" }))).toThrow(
			ExecutionTargetError,
		);
		expect(() => getToolBackend(bareContext(), "missing-device")).toThrow(ExecutionTargetError);
	});

	test("bare tool contexts enforce a frozen target without local fallback", () => {
		setRemoteBackendResolver((deviceId) => (deviceId === "device-1" ? remoteBackend : null));
		const ctx = bareContext({
			executionTarget: {
				deviceId: "device-1",
				backendKind: "remote",
				cwd: "/remote/work",
				selectionSource: "session_default",
			},
		});

		expect(getToolBackend(ctx)).toBe(remoteBackend);
		expect(() => getToolBackend(ctx, "local")).toThrow("attempted to change");
		setRemoteBackendResolver(() => null);
		expect(() => getToolBackend(ctx)).toThrow(ExecutionTargetError);
	});
});
