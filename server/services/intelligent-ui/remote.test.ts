import { describe, expect, mock, test } from "bun:test";
import { FEATURE_FS_CREATE_BOUND_PARENT_V1 } from "@server/lib/agent/execution/rpc-types";

const features = new Set<string>();
const calls: Array<{
	method: string;
	params: Record<string, unknown>;
	options: Record<string, unknown>;
}> = [];
let created = true;
mock.module("../device-connection-service", () => ({
	hasDeviceProtocolFeature: (_device: string, feature: string) => features.has(feature),
	sendRpc: async (
		_device: string,
		method: string,
		params: Record<string, unknown>,
		options: Record<string, unknown>,
	) => {
		calls.push({ method, params, options });
		return method === "fs.mkdirExclusive" ? { created } : {};
	},
}));
const { RemoteBackend } = await import("../device-remote-backend");
const backend = new RemoteBackend("remote-only", {
	connectionGeneration: 42,
	defaultCwd: "/work",
	platform: { os: "linux", arch: "amd64" },
	supportsFsStatResolvedPath: true,
	supportsFsReadAtomicResolvedPath: true,
	supportsFsWriteAtomicResolvedPath: true,
});

describe("remote exclusive creation capability", () => {
	test("old executors fail before an RPC, never delegate to local IO", async () => {
		features.clear();
		calls.length = 0;
		await expect(
			backend.mkdirExclusive("/work/new", { expectedResolvedPath: "/work/new" }),
		).rejects.toThrow("upgrade");
		await expect(
			backend.writeFileBytes("/work/new", new Uint8Array(), { exclusive: true }),
		).rejects.toThrow("upgrade");
		expect(calls).toEqual([]);
	});
	test("negotiates exclusive mkdir and retains cancellation/generation/canonical path", async () => {
		features.add("fs.mkdir.exclusive.v1");
		features.add(FEATURE_FS_CREATE_BOUND_PARENT_V1);
		calls.length = 0;
		const signal = new AbortController().signal;
		created = true;
		expect(
			await backend.mkdirExclusive("/work/new", {
				expectedResolvedPath: "/work/new",
				signal,
				timeoutMs: 1000,
			}),
		).toBe(true);
		expect(calls[0]).toMatchObject({
			method: "fs.mkdirExclusive",
			params: { path: "/work/new", expectedResolvedPath: "/work/new" },
			options: {
				signal,
				timeoutMs: 1000,
				expectedConnectionGeneration: 42,
				requiredFeatures: ["fs.mkdir.exclusive.v1", FEATURE_FS_CREATE_BOUND_PARENT_V1],
			},
		});
		created = false;
		expect(await backend.mkdirExclusive("/work/new", { expectedResolvedPath: "/work/new" })).toBe(
			false,
		);
	});
	test("exclusive initial writes negotiate both canonical and no-overwrite features", async () => {
		features.add("fs.mkdir.exclusive.v1");
		features.add(FEATURE_FS_CREATE_BOUND_PARENT_V1);
		calls.length = 0;
		await backend.writeFileBytes("/work/new/App.tsx", new TextEncoder().encode("source"), {
			expectedResolvedPath: "/work/new/App.tsx",
			exclusive: true,
		});
		expect(calls[0]).toMatchObject({
			method: "fs.write",
			params: { exclusive: true, expectedResolvedPath: "/work/new/App.tsx" },
			options: {
				requiredFeatures: [
					"fs.write.atomic-resolved-path.v1",
					"fs.mkdir.exclusive.v1",
					FEATURE_FS_CREATE_BOUND_PARENT_V1,
				],
				expectedConnectionGeneration: 42,
			},
		});
	});
});
