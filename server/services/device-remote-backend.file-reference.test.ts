import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

/** Module mocks live in a subprocess so neither a DB nor other tests' transports are touched. */
test("remote bounded file RPCs negotiate features and preserve deadlines, cancellation and generation", async () => {
	const backendPath = fileURLToPath(new URL("./device-remote-backend.ts", import.meta.url));
	const connectionPath = fileURLToPath(new URL("./device-connection-service.ts", import.meta.url));
	const settingsPath = fileURLToPath(new URL("../lib/settings/index.ts", import.meta.url));
	const source = `
import { mock } from "bun:test";
import assert from "node:assert/strict";
const features = new Set();
const calls = [];
let currentGeneration = 7;
let hang = false;
mock.module(${JSON.stringify(settingsPath)}, () => ({ settings: { devices: { maxRpcBytes: 1048576, rpcTimeoutMs: 10000 } } }));
mock.module(${JSON.stringify(connectionPath)}, () => ({
  hasDeviceProtocolFeature: (_id, feature) => features.has(feature),
  sendRpc: async (id, method, params, opts) => {
    calls.push({id, method, params, opts});
    assert.equal(opts.expectedConnectionGeneration, 7);
    if (opts.expectedConnectionGeneration !== currentGeneration) throw new Error("generation changed");
    for (const feature of opts.requiredFeatures ?? []) if (!features.has(feature)) throw Object.assign(new Error("unsupported " + feature), { name: "DeviceCapabilityError" });
    if (hang) return new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true }));
    if (method === "glob") return { matches: ["file.ts"], truncated: true };
    if (method === "fs.stat") return { exists: true, isFile: true, isDirectory: false, size: 2, resolvedPath: "/work/file.ts" };
    if (method === "fs.read") return { dataB64: "b2s=", totalSize: 2, truncated: false, resolvedPath: "/work/file.ts" };
    throw new Error("Unexpected RPC " + method);
  }
}));
const { RemoteBackend } = await import(${JSON.stringify(backendPath)});
const backend = new RemoteBackend("DeviceCase", { connectionGeneration: 7, defaultCwd: "/work", platform: {os: "linux", arch: "x64"}, supportsFsStatResolvedPath: true, supportsFsReadAtomicResolvedPath: true });
const abort = new AbortController();
await assert.rejects(backend.glob("**/*", {cwd: "/work", timeoutMs: 1500}), /unsupported glob.bounded.v1/);
features.add("glob.bounded.v1");
const matches = await backend.glob("**/*", {cwd: "/work", timeoutMs: 1500, maxBytes: 128 * 1024, maxResults: 51, signal: abort.signal, query: "file", includeDirectories: true});
assert.equal(matches.truncated, true);
let sent = calls.at(-1);
assert.equal(sent.id, "DeviceCase"); assert.equal(sent.opts.signal, abort.signal);
assert.equal(sent.opts.timeoutMs, 1500); assert.equal(sent.params.timeoutMs, 1500);
assert.equal(sent.params.query, "file"); assert.equal(sent.params.maxBytes, 128 * 1024);
assert.equal(sent.params.includeDirectories, true);
assert.deepEqual(sent.opts.requiredFeatures, ["glob.bounded.v1"]);
features.add("fs.stat.resolved-path.v1");
await backend.statFile("/work/file.ts", {signal: abort.signal, timeoutMs: 500});
assert.equal(calls.at(-1).opts.signal, abort.signal); assert.equal(calls.at(-1).opts.timeoutMs, 500);
features.add("fs.read.atomic-resolved-path.v1");
assert.equal(backend.supportsFsReadBounded, false);
await assert.rejects(backend.readFileBytes("/work/file.ts", {expectedResolvedPath: "/work/file.ts", timeoutMs: 1000}), /unsupported fs.read.bounded.v1/);
features.add("fs.read.bounded.v1"); assert.equal(backend.supportsFsReadBounded, true);
await backend.readFileBytes("/work/file.ts", {expectedResolvedPath: "/work/file.ts", timeoutMs: 1000, signal: abort.signal, maxBytes: 1048576});
sent = calls.at(-1); assert.equal(sent.opts.timeoutMs, 1000); assert.equal(sent.params.timeoutMs, 1000);
assert.deepEqual(sent.opts.requiredFeatures, ["fs.read.atomic-resolved-path.v1", "fs.read.bounded.v1"]);
hang = true;
const pending = backend.glob("**/*", {cwd: "/work", timeoutMs: 1500, signal: abort.signal});
abort.abort(new Error("cancel scan")); await assert.rejects(pending, /cancel scan/);
hang = false; currentGeneration++;
await assert.rejects(backend.glob("**/*", {cwd: "/work", timeoutMs: 1500}), /generation changed/);
console.log("bounded RPC assertions passed");
`;
	const proc = Bun.spawn([process.execPath, "--eval", source], {
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const timer = setTimeout(() => proc.kill(), 10_000);
	const collect = async (stream: ReadableStream<Uint8Array>) => {
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > 64 * 1024) {
					proc.kill();
					throw new Error("RPC test output cap exceeded");
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		return Buffer.concat(chunks).toString("utf8");
	};
	try {
		const [stdout, stderr, code] = await Promise.all([
			collect(proc.stdout),
			collect(proc.stderr),
			proc.exited,
		]);
		expect(stderr).toBe("");
		expect(code).toBe(0);
		expect(stdout).toContain("bounded RPC assertions passed");
	} finally {
		clearTimeout(timer);
	}
}, 15_000);
