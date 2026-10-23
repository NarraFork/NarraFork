import { afterEach, expect, mock, test } from "bun:test";

const fs = await import("node:fs");
mock.module("node:fs", () => ({ ...fs, mkdirSync: () => {} }));

let entries: Array<{ relPath: string; size: number; mtimeMs: number }> = [];
let truncated = false;
let localCount = 1;
const transportCalls: string[] = [];
mock.module("../device-connection-service", () => ({
	isDeviceOnline: () => true,
	deviceBufferedAmount: () => 0,
	getConnectedDeviceHello: () => undefined,
	hasDeviceProtocolFeature: () => false,
	sendChunkFrame: () => {
		throw new Error("UNAUTHORIZED_BYTES_REQUEST");
	},
	setChunkFrameHandler: () => {},
	getSessionDevices: async () => [],
	getDeviceRuntimeSnapshot: () => undefined,
	sendRpc: async (_id: string, method: string) => {
		transportCalls.push(method);
		if (method === "transfer.stat") return { exists: true, isDirectory: true, entries, truncated };
		throw new Error("UNAUTHORIZED_BYTES_REQUEST");
	},
}));
const fsPromises = await import("node:fs/promises");
mock.module("node:fs/promises", () => ({
	...fsPromises,
	readdir: async () =>
		Array.from({ length: localCount }, (_, i) => ({
			name: `file-${i}.txt`,
			isDirectory: () => false,
			isFile: () => true,
		})),
	stat: async () => ({ size: 0, mtimeMs: 0, isDirectory: () => false, isFile: () => true }),
	open: async () => {
		throw new Error("UNAUTHORIZED_LOCAL_OPEN");
	},
}));
const { downloadDirectory, uploadDirectory } = await import("../device-transfer-service");
const { transferFileTool } = await import("../../lib/agent/tools/transfer-file");

test("model recursive background requests fail closed with an explicit foreground alternative", async () => {
	const result = await transferFileTool.execute(
		{
			direction: "upload",
			device: "fixture",
			remotePath: "/remote",
			localPath: "/local",
			recursive: true,
			run_in_background: true,
		},
		{
			narratorId: "fixture",
			cwd: "/local",
			locale: "en",
			requestPermission: async () => {
				throw new Error("Unexpected permission request");
			},
			signal: new AbortController().signal,
			availableDevices: [
				{
					id: "fixture",
					name: "fixture",
					slug: "fixture",
					scope: "global",
					online: true,
					platform: { os: "linux", arch: "amd64" },
				},
			],
		},
	);
	expect(result.isError).toBe(true);
	expect(result.output).toContain("cannot run in the background");
	expect(result.output).toContain("archive");
	expect(result.output).toContain("foreground");
	expect(transportCalls).toEqual([]);
});
afterEach(() => {
	entries = [];
	truncated = false;
	localCount = 1;
	transportCalls.length = 0;
});

test("recursive download authorizes both descendant paths before any local open or byte request", async () => {
	entries = [{ relPath: "private.txt", size: 0, mtimeMs: 0 }];
	const checked: string[][] = [];
	await expect(
		downloadDirectory({
			deviceId: "fixture",
			remoteDir: "/remote",
			localDir: "/local",
			remotePlatformOs: "linux",
			authorizeFile: async (local: string, remote: string) => {
				checked.push([local, remote]);
				throw new Error("DESCENDANT_DENIED");
			},
		}),
	).rejects.toThrow(/DESCENDANT_DENIED; denied files: 1; transferred: 0; untransferred: 1/);
	expect(checked).toEqual([["/local/private.txt", "/remote/private.txt"]]);
	expect(transportCalls).toEqual(["transfer.stat"]);
});

test("recursive upload authorizes both descendant paths before reading file bytes", async () => {
	const checked: string[][] = [];
	await expect(
		uploadDirectory({
			deviceId: "fixture",
			remoteDir: "C:\\target",
			localDir: "/local",
			remotePlatformOs: "windows",
			authorizeFile: async (local: string, remote: string) => {
				checked.push([local, remote]);
				throw new Error("DESCENDANT_DENIED");
			},
		}),
	).rejects.toThrow(/DESCENDANT_DENIED; denied files: 1; transferred: 0; untransferred: 1/);
	expect(checked).toEqual([["/local/file-0.txt", "C:\\target\\file-0.txt"]]);
	expect(transportCalls).toEqual([]);
});

test("truncated remote manifests cannot be reported as successful complete transfers", async () => {
	truncated = true;
	await expect(
		downloadDirectory({
			deviceId: "fixture",
			remoteDir: "/remote",
			localDir: "/local",
			remotePlatformOs: "linux",
		}),
	).rejects.toThrow(/truncated|limit/i);
	expect(transportCalls).toEqual(["transfer.stat"]);
});

test("more than 50000 local files is refused before transferring a silently truncated prefix", async () => {
	localCount = 50_001;
	await expect(
		uploadDirectory({
			deviceId: "fixture",
			remoteDir: "/remote",
			localDir: "/local",
			remotePlatformOs: "linux",
		}),
	).rejects.toThrow(/50000|limit/i);
	expect(transportCalls).toEqual([]);
});
