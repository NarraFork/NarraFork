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

type Fault = "none" | "create" | "startup" | "unresponsive";
async function run(source: string, fault: Fault = "none", wallMs = 2000) {
	// Deliberately NOT a Podman isolation test: fixture cgroup files allow the
	// production broker to run outside a container. Only bootstrap/VM/thread mechanics
	// are asserted; effective container policy is covered by the opt-in Podman suite.
	const prefix = `const nativeFile=Bun.file; Bun.file=(path,...args)=>({"/sys/fs/cgroup/memory.max":"268435456","/sys/fs/cgroup/pids.max":"32","/sys/fs/cgroup/cpu.max":"100000 100000"}[path]===undefined ? nativeFile(path,...args) : {text:async()=>({"/sys/fs/cgroup/memory.max":"268435456","/sys/fs/cgroup/pids.max":"32","/sys/fs/cgroup/cpu.max":"100000 100000"}[path])});
const NativeWorker=globalThis.Worker; globalThis.Worker=class extends NativeWorker { constructor(url,options){ if(${JSON.stringify(fault)}==="create") throw Error("fixture creation failed"); if(${JSON.stringify(fault)}==="startup") url=URL.createObjectURL(new Blob(['throw Error("fixture startup failed")'])); if(${JSON.stringify(fault)}==="unresponsive") url=URL.createObjectURL(new Blob(['self.onmessage=()=>{}'])); super(url,options); this.addEventListener("close",()=>process.stderr.write("fixture-native-exit\\n"),{once:true}); }};\n`;
	const script = join(root, `run-${crypto.randomUUID()}.mjs`);
	await writeFile(script, prefix + (await Bun.file(bootstrap).text()));
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
