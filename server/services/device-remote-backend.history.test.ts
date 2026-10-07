import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Mock the RPC transport in a bounded child process, never the production DB/connection.
test("remote data plane pins generation/features and never falls back to plain filesystem IO", async () => {
	const backendPath = fileURLToPath(new URL("./device-remote-backend.ts", import.meta.url));
	const connectionPath = fileURLToPath(new URL("./device-connection-service.ts", import.meta.url));
	const settingsPath = fileURLToPath(new URL("../lib/settings/index.ts", import.meta.url));
	const source = `
import { mock } from "bun:test";
import assert from "node:assert/strict";
let generation=3, supported=true;
const calls=[];
mock.module(${JSON.stringify(settingsPath)},()=>({settings:{devices:{maxRpcBytes:65536}}}));
mock.module(${JSON.stringify(connectionPath)},()=>({
 hasDeviceProtocolFeature:()=>supported,
 sendRpc:async(id,method,params,opts)=>{
  calls.push({id,method,params,opts});
  if(opts.expectedConnectionGeneration!==generation)throw new Error("generation changed");
  if(opts.signal?.aborted)throw new Error("aborted");
  if(!supported)throw new Error("unsupported");
  return {ok:true};
 }
}));
const {RemoteBackend}=await import(${JSON.stringify(backendPath)});
const b=new RemoteBackend("remote-device",{connectionGeneration:3,defaultCwd:"/wrong/default",platform:{os:"linux",arch:"x64"}});
const controller=new AbortController();
const binding={sourceInstanceId:"source",workspaceInstanceId:"workspace",scopeId:"scope",root:"/selected/repo",rootIdentity:"disk:inode",fence:7};
await b.remoteHistory("open",{root:binding.root,scopeId:"scope",fence:7},controller.signal);
assert.equal(calls.at(-1).params.root,"/selected/repo");
assert.equal(calls.at(-1).opts.timeoutMs,10000);
assert.deepEqual(calls.at(-1).opts.requiredFeatures,["history.v1"]);
for(const operation of ["capture","mutate","restore","status","finalize","compensate","inspect","objectRead"]){
 await b.remoteHistory(operation,{binding,operationId:"op",requestDigest:"a".repeat(64)},controller.signal);
 const call=calls.at(-1);
 assert.equal(call.method,"history."+operation);
 assert.equal(call.params.binding.root,"/selected/repo");
 assert.equal(call.opts.expectedConnectionGeneration,3);
 assert.equal(call.opts.signal,controller.signal);
 assert.deepEqual(call.opts.requiredFeatures,["history.v1"]);
 assert.equal(call.opts.timeoutMs,["capture","mutate","restore","compensate"].includes(operation)?120000:10000);
}
const before=calls.length;
await assert.rejects(b.remoteHistory("mutate",{binding,operationId:"huge",requestDigest:"a".repeat(64),changes:[{path:"file",expected:{kind:"absent"},desired:{kind:"absent"},contentBase64:"a".repeat(70000)}]}),/byte budget/);
assert.equal(calls.length,before);
await b.listBounded("/selected/repo",{expectedResolvedPath:"/selected/repo",maxScanned:100000,maxEntries:1000,maxBytes:1000000,timeoutMs:9000,showHidden:true,directoriesOnly:true,signal:controller.signal});
const list=calls.at(-1);
assert.equal(list.method,"fs.listBounded");
assert.equal(list.params.maxScanned,10000);assert.equal(list.params.maxEntries,500);
assert.equal(list.params.maxBytes,65536);assert.equal(list.params.timeoutMs,2000);
assert.equal(list.params.showHidden,true);assert.equal(list.params.directoriesOnly,true);
assert.deepEqual(list.opts.requiredFeatures,["fs.list.bounded.v1"]);
await b.gitWorktree({operation:"list",cwd:"/selected/repo",expectedRoot:"/selected/repo",expectedRepository:"/selected/repo/.git"},controller.signal);
assert.equal(calls.at(-1).method,"git.worktree");assert.deepEqual(calls.at(-1).opts.requiredFeatures,["git.worktree.v1"]);
for(const operation of ["inspect","prepare","readChunk","release"]){
 await b.shareArchive({operation,operationId:"share-op",paths:["/selected/repo/file"],maxChunkBytes:9999999},controller.signal);
 assert.equal(calls.at(-1).method,"share."+operation);
 assert.deepEqual(calls.at(-1).opts.requiredFeatures,["share.archive.v1"]);
 assert.ok(calls.at(-1).params.maxChunkBytes<=1024*1024);
 assert.ok(calls.at(-1).params.maxChunkBytes<=Math.floor((65536-8192)*3/4));
}
generation=4;
await assert.rejects(b.remoteHistory("status",{binding,operationId:"op"}),/generation changed/);
supported=false;
const unsupportedCount=calls.length;
await assert.rejects(b.remoteHistory("open",{root:"/selected/repo",scopeId:"scope",fence:7}),/upgrade required/);
await assert.rejects(b.listBounded("/selected/repo"),/upgrade required/);
await assert.rejects(b.shareArchive({operation:"inspect",operationId:"share-op"}),/upgrade required/);
assert.equal(calls.length,unsupportedCount);
assert.ok(calls.every(c=>!c.method.startsWith("fs.write")));
console.log("remote data plane backend assertions passed");
`;
	const proc = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(), 10_000);
	async function collect(stream: ReadableStream<Uint8Array>) {
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of stream) {
			size += chunk.byteLength;
			if (size > 65536) {
				proc.kill();
				throw new Error("test output budget");
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
		expect(stdout).toContain("remote data plane backend assertions passed");
	} finally {
		clearTimeout(timer);
		if (proc.exitCode === null) proc.kill();
	}
});
