import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Keep module mocks in a child process: no DB or production connection is opened.
test("RemoteBackend Git RPC pins generation, negotiates capabilities and forwards cancellation", async () => {
	const backendPath = fileURLToPath(new URL("./device-remote-backend.ts", import.meta.url));
	const connectionPath = fileURLToPath(new URL("./device-connection-service.ts", import.meta.url));
	const settingsPath = fileURLToPath(new URL("../lib/settings/index.ts", import.meta.url));
	const source = `
import { mock } from "bun:test";
import assert from "node:assert/strict";
let online = true, supported = true, previewSupported = true, generation = 3;
const calls = [];
mock.module(${JSON.stringify(settingsPath)}, () => ({ settings: { devices: { maxRpcBytes: 65536 } } }));
mock.module(${JSON.stringify(connectionPath)}, () => ({
 hasDeviceProtocolFeature: (_id, f) => supported && (f === "git.workspace.v1" || (previewSupported && f === "git.workspace.commit-preview.v1")),
 sendRpc: async (id, method, params, opts) => {
  calls.push({id, method, params, opts});
  if (!online) throw new Error("offline");
  if (!supported) throw new Error("unsupported");
  if (!previewSupported && opts.requiredFeatures?.includes("git.workspace.commit-preview.v1")) throw new Error("preview unsupported");
  if (generation !== opts.expectedConnectionGeneration) throw new Error("generation changed");
  if (opts.signal?.aborted) throw new Error("aborted");
  return {stdout:"patch",truncated:true};
 }
}));
const { RemoteBackend } = await import(${JSON.stringify(backendPath)});
const b = new RemoteBackend("remote-device", {connectionGeneration:3,platform:{os:"windows",arch:"x64"}});
assert.equal(b.supportsGitWorkspace,true);
const controller = new AbortController();
const result = await b.gitWorkspace({cwd:"C:\\\\Repo",expectedRoot:"C:\\\\Repo",operation:"diff",files:["file"],timeoutMs:1250,maxBytes:999999},controller.signal);
assert.equal(result.truncated,true);
const c = calls.at(-1);
assert.equal(c.id,"remote-device"); assert.equal(c.method,"git.workspace");
assert.equal(c.opts.signal,controller.signal); assert.equal(c.opts.timeoutMs,6250);
assert.equal(c.params.timeoutMs,1250); assert.equal(c.params.maxBytes,65536);
assert.equal(c.opts.expectedConnectionGeneration,3); assert.deepEqual(c.opts.requiredFeatures,["git.workspace.v1"]);
assert.equal(b.supportsGitCommitPreview,true);
for (const operation of ["commitDetail", "commitDiff"]) {
 const request = {cwd:"/repo",expectedRoot:"/repo",operation,commit:"a".repeat(40),timeoutMs:1250,maxBytes:999999};
 if (operation === "commitDiff") Object.assign(request,{path:"new name.txt",oldPath:"old name.txt"});
 await b.gitWorkspace(request,controller.signal);
 const preview = calls.at(-1);
 assert.equal(preview.method,"git.workspace");
 assert.equal(preview.params.operation,operation);
 assert.equal(preview.params.commit,"a".repeat(40));
 assert.equal(preview.params.expectedRoot,"/repo");
 assert.equal(preview.params.maxBytes,65536);
 assert.equal(preview.opts.timeoutMs,6250);
 assert.equal(preview.opts.signal,controller.signal);
 assert.equal(preview.opts.expectedConnectionGeneration,3);
 assert.deepEqual(preview.opts.requiredFeatures,["git.workspace.v1","git.workspace.commit-preview.v1"]);
 if (operation === "commitDiff") {
  assert.equal(preview.params.path,"new name.txt"); assert.equal(preview.params.oldPath,"old name.txt");
 }
}
previewSupported=false;
assert.equal(b.supportsGitCommitPreview,false); assert.equal(b.supportsGitWorkspace,true);
await assert.rejects(b.gitWorkspace({cwd:"/repo",operation:"commitDetail",commit:"a".repeat(40)}),/preview unsupported/);
await b.gitWorkspace({cwd:"/repo",operation:"probe"});
assert.deepEqual(calls.at(-1).opts.requiredFeatures,["git.workspace.v1"]);
previewSupported=true;
supported=false; assert.equal(b.supportsGitWorkspace,false);
await assert.rejects(b.gitWorkspace({cwd:"/repo",operation:"probe"}),/unsupported/);
supported=true; generation=4;
await assert.rejects(b.gitWorkspace({cwd:"/repo",operation:"probe"}),/generation changed/);
generation=3; online=false;
await assert.rejects(b.gitWorkspace({cwd:"/repo",operation:"probe"}),/offline/);
online=true; controller.abort();
await assert.rejects(b.gitWorkspace({cwd:"/repo",operation:"probe"},controller.signal),/aborted/);
assert.equal(calls.length,9);
console.log("remote Git backend assertions passed");
`;
	const proc = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
	const timeout = setTimeout(() => proc.kill(), 10000);
	async function collect(stream: ReadableStream<Uint8Array>) {
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of stream) {
			size += chunk.byteLength;
			if (size > 65536) {
				proc.kill();
				throw new Error("test output limit");
			}
			chunks.push(chunk);
		}
		return Buffer.concat(chunks).toString();
	}
	try {
		const [stdout, stderr, code] = await Promise.all([
			collect(proc.stdout),
			collect(proc.stderr),
			proc.exited,
		]);
		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain("remote Git backend assertions passed");
	} finally {
		clearTimeout(timeout);
	}
}, 15000);
