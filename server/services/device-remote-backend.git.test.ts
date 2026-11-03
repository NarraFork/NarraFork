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
let online = true, supported = true, previewSupported = true, statusSupported = true, lineStatsSupported = true, branchesSupported = true, switchSupported = true, syncSupported = true, generation = 3;
const calls = [];
mock.module(${JSON.stringify(settingsPath)}, () => ({ settings: { devices: { maxRpcBytes: 65536 } } }));
mock.module(${JSON.stringify(connectionPath)}, () => ({
 getDeviceConnectionGeneration: () => online ? generation : null,
 hasDeviceProtocolFeature: (_id, f) => supported && (f === "git.workspace.v1" || (previewSupported && f === "git.workspace.commit-preview.v1") || (statusSupported && f === "git.workspace.status.v1") || (lineStatsSupported && f === "git.workspace.line-stats.v1") || (branchesSupported && f === "git.workspace.branches.v1") || (switchSupported && f === "git.workspace.branch-switch.v1") || (syncSupported && f === "git.workspace.remote-sync.v1")),
 sendRpc: async (id, method, params, opts) => {
  calls.push({id, method, params, opts});
  if (!online) throw new Error("offline");
  if (!supported) throw new Error("unsupported");
  if (!previewSupported && opts.requiredFeatures?.includes("git.workspace.commit-preview.v1")) throw new Error("preview unsupported");
  if (!lineStatsSupported && opts.requiredFeatures?.includes("git.workspace.line-stats.v1")) throw new Error("line stats unsupported");
  if (!branchesSupported && opts.requiredFeatures?.includes("git.workspace.branches.v1")) throw new Error("branches unsupported");
  if (!switchSupported && opts.requiredFeatures?.includes("git.workspace.branch-switch.v1")) throw new Error("checkout unsupported");
  if (!syncSupported && opts.requiredFeatures?.includes("git.workspace.remote-sync.v1")) throw new Error("sync unsupported");
  if (generation !== opts.expectedConnectionGeneration) throw new Error("generation changed");
  if (opts.signal?.aborted) throw new Error("aborted");
  return {stdout:"patch",truncated:true};
 }
}));
const { RemoteBackend } = await import(${JSON.stringify(backendPath)});
const b = new RemoteBackend("remote-device", {connectionGeneration:3,platform:{os:"windows",arch:"x64"}});
assert.equal(b.supportsGitWorkspace,true);
assert.equal(b.supportsGitWorkspaceStatus,true);
statusSupported=false;
assert.equal(b.supportsGitWorkspaceStatus,false);
assert.equal(b.supportsGitWorkspace,true);
statusSupported=true;
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
assert.equal(b.supportsGitLineStats,true);
await b.gitWorkspace({cwd:"/repo",expectedRoot:"/repo",operation:"lineStats",timeoutMs:1250,maxBytes:999999},controller.signal);
const stats = calls.at(-1);
assert.equal(stats.params.operation,"lineStats");
assert.equal(stats.params.expectedRoot,"/repo");
assert.equal(stats.params.maxBytes,65536);
assert.equal(stats.opts.signal,controller.signal);
assert.equal(stats.opts.timeoutMs,6250);
assert.equal(stats.opts.expectedConnectionGeneration,3);
assert.deepEqual(stats.opts.requiredFeatures,["git.workspace.v1","git.workspace.line-stats.v1"]);
lineStatsSupported=false;
assert.equal(b.supportsGitLineStats,false);
await assert.rejects(b.gitWorkspace({cwd:"/repo",operation:"lineStats"}),/line stats unsupported/);
lineStatsSupported=true;
// Branch listing, switching and remote sync each negotiate their own feature and
// must not borrow another operation's capability.
assert.equal(b.supportsGitBranches,true);
assert.equal(b.supportsGitBranchSwitch,true);
assert.equal(b.supportsGitRemoteSync,true);
for (const [operation, feature] of [
 ["branches","git.workspace.branches.v1"],
 ["checkout","git.workspace.branch-switch.v1"],
 ["push","git.workspace.remote-sync.v1"],
 ["fetch","git.workspace.remote-sync.v1"],
]) {
 const request = {cwd:"/repo",expectedRoot:"/repo",operation,timeoutMs:1250,maxBytes:999999};
 if (operation === "checkout") Object.assign(request,{branch:"feature/x",create:true,startPoint:"origin/feature/x"});
 if (operation === "push") Object.assign(request,{remote:"origin",setUpstream:true});
 if (operation === "fetch") Object.assign(request,{prune:true});
 await b.gitWorkspace(request,controller.signal);
 const call = calls.at(-1);
 assert.equal(call.method,"git.workspace");
 assert.equal(call.params.operation,operation);
 assert.equal(call.params.maxBytes,65536);
 assert.equal(call.opts.signal,controller.signal);
 assert.equal(call.opts.timeoutMs,6250);
 assert.equal(call.opts.expectedConnectionGeneration,3);
 assert.deepEqual(call.opts.requiredFeatures,["git.workspace.v1",feature]);
 if (operation === "checkout") {
  assert.equal(call.params.branch,"feature/x"); assert.equal(call.params.create,true); assert.equal(call.params.startPoint,"origin/feature/x");
 }
 if (operation === "push") { assert.equal(call.params.remote,"origin"); assert.equal(call.params.setUpstream,true); }
 if (operation === "fetch") assert.equal(call.params.prune,true);
}
branchesSupported=false;
assert.equal(b.supportsGitBranches,false);
assert.equal(b.supportsGitWorkspace,true);
await assert.rejects(b.gitWorkspace({cwd:"/repo",operation:"branches"}),/branches unsupported/);
switchSupported=false;
assert.equal(b.supportsGitBranchSwitch,false);
await assert.rejects(b.gitWorkspace({cwd:"/repo",operation:"checkout",branch:"x"}),/checkout unsupported/);
syncSupported=false;
assert.equal(b.supportsGitRemoteSync,false);
await assert.rejects(b.gitWorkspace({cwd:"/repo",operation:"push"}),/sync unsupported/);
await assert.rejects(b.gitWorkspace({cwd:"/repo",operation:"fetch"}),/sync unsupported/);
supported=false; assert.equal(b.supportsGitWorkspace,false);
assert.equal(b.supportsGitLineStats,false);
assert.equal(b.supportsGitBranches,false);
assert.equal(b.supportsGitBranchSwitch,false);
assert.equal(b.supportsGitRemoteSync,false);
await assert.rejects(b.gitWorkspace({cwd:"/repo",operation:"probe"}),/unsupported/);
supported=true; generation=4;
await assert.rejects(b.gitWorkspace({cwd:"/repo",operation:"probe"}),/generation changed/);
generation=3; online=false;
await assert.rejects(b.gitWorkspace({cwd:"/repo",operation:"probe"}),/offline/);
online=true; controller.abort();
await assert.rejects(b.gitWorkspace({cwd:"/repo",operation:"probe"},controller.signal),/aborted/);
assert.equal(calls.length,19);
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
