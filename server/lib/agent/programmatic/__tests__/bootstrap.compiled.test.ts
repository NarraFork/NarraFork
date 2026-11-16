import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerHandle } from "../../../worker-runtime/lifecycle";
import { PROGRAMMATIC_LIMITS, type SandboxResult, type StartFrame } from "../protocol";
import { BoundedStderr, NdjsonFrames, WireBudget } from "../wire";

let root: string;
let bootstrap: string;
let cwd: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "nf-programmatic-compiled-"));
	cwd = join(root, "empty");
	await mkdir(cwd);
	const entry = join(root, "generator.ts");
	const binary = join(root, "generator");
	bootstrap = join(root, "bootstrap.mjs");
	await writeFile(
		entry,
		`import {createSandboxBootstrap} from ${JSON.stringify(join(import.meta.dir, "../bootstrap.ts"))}; await Bun.write(process.argv[2],createSandboxBootstrap());`,
	);
	const built = await Bun.build({
		entrypoints: [entry],
		target: "bun",
		minify: true,
		compile: { outfile: binary },
	});
	expect(built.success).toBe(true);
	const generator = WorkerHandle.subprocess([binary, bootstrap], {
		cwd,
		stdout: "ignore",
		stderr: "ignore",
		timeout: 5000,
	});
	expect(await generator.exited).toBe(0);
	await generator.close();
}, 60000);
afterAll(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});

type Fault =
	| "none"
	| "create"
	| "startup"
	| "unresponsive"
	| "close-after-response"
	| "close-before-request"
	| "close-without-result";
async function run(source: string, fault: Fault = "none", wallMs = 2000) {
	// Deliberately NOT a Podman isolation test: fixture cgroup files allow the
	// production broker to run outside a container. Only bootstrap/VM/thread mechanics
	// are asserted; effective container policy is covered by the opt-in Podman suite.
	const prefix = `const nativeFile=Bun.file; Bun.file=(path,...args)=>({"/sys/fs/cgroup/memory.max":"268435456","/sys/fs/cgroup/pids.max":"32","/sys/fs/cgroup/cpu.max":"100000 100000"}[path]===undefined ? nativeFile(path,...args) : {text:async()=>({"/sys/fs/cgroup/memory.max":"268435456","/sys/fs/cgroup/pids.max":"32","/sys/fs/cgroup/cpu.max":"100000 100000"}[path])});
let fixtureDeadline;
if(${JSON.stringify(fault)}==="close-without-result"){
 const nativeSetTimeout=globalThis.setTimeout;
 globalThis.setTimeout=(callback,ms,...args)=>{
  if(ms===${wallMs}) fixtureDeadline=callback;
  return nativeSetTimeout(callback,ms,...args);
 };
}
const NativeWorker=globalThis.Worker; globalThis.Worker=class extends NativeWorker { constructor(url,options){ if(${JSON.stringify(fault)}==="create") throw Error("fixture creation failed"); if(${JSON.stringify(fault)}==="startup") url=URL.createObjectURL(new Blob(['throw Error("fixture startup failed")'])); if(${JSON.stringify(fault)}==="unresponsive") url=URL.createObjectURL(new Blob(['self.onmessage=()=>{}'])); super(url,options); if(${JSON.stringify(fault)}==="close-without-result") this.addEventListener("message",event=>{if(event.data?.type==="result"){event.stopImmediatePropagation();process.stderr.write("fixture-result-withheld\\n");if(!fixtureDeadline) throw Error("fixture outer deadline was not registered");fixtureDeadline();}}); this.addEventListener("close",()=>process.stderr.write("fixture-native-exit\\n"),{once:true}); }};\n`;
	// In this test-owned subprocess only, hold the broker at the publication signal
	// until the real Worker has consumed the final response and closed the mailbox.
	// This is an event handshake, not a scheduling delay or execution fallback.
	// The request-read variant returns one pre-close snapshot from isClosed(),
	// modeling a close between that observation and takeRequest()'s next atomic read.
	// Documented mailbox ABI: close=2, request signal=6, response state/signal/seq=9/10/11.
	const coordinatedClose =
		fault === "close-after-response" || fault === "close-before-request"
			? `const nativeNotify=Atomics.notify, nativeWait=Atomics.wait, nativeLoad=Atomics.load;
let finalClosed=false, consumed=false, staleRead=false;
Atomics.load=(header,slot)=>{
 const value=nativeLoad(header,slot);
 if(finalClosed && slot===9 && value===0) consumed=true;
 if(${JSON.stringify(fault)}==="close-before-request" && consumed && slot===2 && value>0 && !staleRead){
  staleRead=true;
  process.stderr.write("fixture-close-before-request\\n");
  return 0;
 }
 return value;
};
Atomics.notify=(header,slot,count)=>{
 const finalResponse=slot===10 && nativeLoad(header,11)===3 && !finalClosed;
 const notified=nativeNotify(header,slot,count);
 if(finalResponse){
  const end=Date.now()+${wallMs};
  while(nativeLoad(header,2)===0){
   const signal=nativeLoad(header,6);
   if(nativeLoad(header,2)!==0) break;
   const remaining=end-Date.now();
   if(remaining<=0) throw Error("fixture Worker did not close its mailbox");
   nativeWait(header,6,signal,remaining);
  }
  if(nativeLoad(header,9)!==0) throw Error("fixture final response was not consumed");
  finalClosed=true;
  process.stderr.write("fixture-close-after-response\\n");
 }
 return notified;
};\n`
			: "";
	const script = join(root, `run-${crypto.randomUUID()}.mjs`);
	await writeFile(script, prefix + coordinatedClose + (await Bun.file(bootstrap).text()));
	const handle = WorkerHandle.subprocess([process.execPath, script], {
		cwd,
		env: { PATH: process.env.PATH, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 5000,
	});
	const child = handle.resource;
	const frames = new NdjsonFrames(new WireBudget(), () => {
		void handle.close();
	});
	const stderr = new BoundedStderr(() => {
		void handle.close();
	}, 64 * 1024);
	const read = (async () => {
		try {
			for await (const chunk of child.stdout) frames.push(chunk);
			frames.finish();
		} catch (error) {
			frames.fail(error as Error);
		}
	})();
	const errors = (async () => {
		for await (const chunk of child.stderr) stderr.push(chunk);
	})();
	const start: StartFrame = {
		type: "start",
		version: 1,
		source,
		receivers: [
			{
				id: "catalog-id",
				name: "catalog",
				methods: [{ name: "read", description: "fixture read" }],
			},
		],
		budgets: { ...PROGRAMMATIC_LIMITS, wallMs },
	};
	let result: SandboxResult | undefined;
	let ready = 0;
	let calls = 0;
	try {
		for await (const text of frames) {
			const frame = JSON.parse(text);
			if (frame.type === "ready") {
				ready++;
				child.stdin.write(`${JSON.stringify(start)}\n`);
				await child.stdin.flush();
			} else if (frame.type === "call") {
				calls++;
				child.stdin.write(
					`${JSON.stringify({ type: "response", version: 1, sequence: frame.sequence, ok: true, value: frame.args })}\n`,
				);
				await child.stdin.flush();
			} else if (frame.type === "result") result = frame;
			else throw new Error("Unexpected broker frame");
		}
		const exit = await handle.exited;
		await Promise.all([read, errors]);
		return { result, ready, calls, exit, stderr: stderr.text() };
	} finally {
		await handle.close();
		await Promise.allSettled([read, errors]);
	}
}

describe("minified compiled bootstrap outside the repository", () => {
	test("serialized public Handle owns a real Worker through synchronous mailbox RPC and exit", async () => {
		const result = await run("return [1,2,3].map(n=>catalog.read(n));");
		expect(result.ready).toBe(1);
		expect(result.calls).toBe(3);
		expect(result.result).toMatchObject({ ok: true, value: [[1], [2], [3]] });
		expect(result.exit).toBe(0);
		expect(result.stderr).toBe("fixture-native-exit\n");
	});
	test("a final response consumed and closed before publication returns still delivers the Worker result", async () => {
		const result = await run("return [1,2,3].map(n=>catalog.read(n));", "close-after-response");
		expect(result.ready).toBe(1);
		expect(result.calls).toBe(3);
		expect(result.stderr).toBe("fixture-close-after-response\nfixture-native-exit\n");
		expect(result.result).toMatchObject({ ok: true, value: [[1], [2], [3]] });
		expect(result.exit).toBe(0);
	});
	test("closure between the pump's open check and request read still awaits the real result", async () => {
		const result = await run("return [1,2,3].map(n=>catalog.read(n));", "close-before-request");
		expect(result.ready).toBe(1);
		expect(result.calls).toBe(3);
		expect(result.stderr).toBe(
			"fixture-close-after-response\nfixture-close-before-request\nfixture-native-exit\n",
		);
		expect(result.result).toMatchObject({ ok: true, value: [[1], [2], [3]] });
		expect(result.exit).toBe(0);
	});
	test("closure during a request read preserves the Worker's structured failure", async () => {
		const result = await run(
			'[1,2,3].map(n=>catalog.read(n)); throw new Error("fixture script failed");',
			"close-before-request",
		);
		expect(result.calls).toBe(3);
		expect(result.stderr).toBe(
			"fixture-close-after-response\nfixture-close-before-request\nfixture-native-exit\n",
		);
		expect(result.result).toMatchObject({
			ok: false,
			error: { code: "SCRIPT_ERROR", message: "fixture script failed", fatal: true },
		});
		expect(result.exit).toBe(0);
	});
	test("a closed mailbox without a Worker result fails at the outer deadline", async () => {
		// Advance the actual registered outer deadline only after withholding the
		// real result, so slow startup cannot accidentally satisfy this assertion.
		const result = await run('return "MUST_NOT_FABRICATE_SUCCESS";', "close-without-result");
		expect(result.stderr).toBe("fixture-result-withheld\nfixture-native-exit\n");
		expect(result.result).toMatchObject({ ok: false, error: { code: "DEADLINE", fatal: true } });
		expect(result.result?.value).toBeUndefined();
		expect(result.exit).toBe(0);
	});
	test("Handle, Worker, host environment, network and code-generation capabilities never enter the VM", async () => {
		const result = await run(
			'let escape;try{({}).constructor.constructor("return process")();escape="escaped"}catch{escape="blocked"}return [typeof process,typeof Bun,typeof fetch,typeof require,typeof lifecycle,typeof WorkerHandle,typeof Worker,escape];',
		);
		expect(result.result).toMatchObject({
			ok: true,
			value: [
				"undefined",
				"undefined",
				"undefined",
				"undefined",
				"undefined",
				"undefined",
				"undefined",
				"blocked",
			],
		});
		expect(result.exit).toBe(0);
		expect(result.stderr).toBe("fixture-native-exit\n");
	});
	for (const fault of ["create", "startup", "unresponsive"] as const)
		test(`${fault} fails without executing user code on the broker thread`, async () => {
			const result = await run('return "MUST_NOT_EXECUTE";', fault, 100);
			expect(result.result?.ok).toBe(false);
			expect(result.result?.value).toBeUndefined();
			expect(result.calls).toBe(0);
			expect(result.exit).toBe(0);
			if (fault === "create") expect(result.stderr).not.toContain("fixture-native-exit");
			else expect(result.stderr).toContain("fixture-native-exit\n");
		});
	test("hostile user loop is stopped outside the VM, with a confirmed Worker exit", async () => {
		const result = await run("while(true){}", "none", 200);
		expect(result.result).toMatchObject({ ok: false, error: { code: "DEADLINE" } });
		expect(result.exit).toBe(0);
		expect(result.stderr).toBe("fixture-native-exit\n");
	});
});
