import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPILED_WORKER_ENTRIES, compiledWorkerBuildEntrypoints } from "./compiled-worker";

// Registration of each spawned worker is enforced by `compiledWorkerSpecifiers` taking a
// `CompiledWorkerEntry`. These checks cover what the type system cannot see.
const root = join(import.meta.dir, "../..");

function serverSources(): string[] {
	return [
		...new Bun.Glob("**/*.{ts,tsx,js,mjs,cjs}").scanSync({ cwd: join(root, "server") }),
	].filter((path) => !path.includes(".test.") && !path.includes("__tests__/"));
}

test("production compile spreads the worker registry instead of listing worker paths", () => {
	const source = readFileSync(join(root, "scripts/build-cross-platform.ts"), "utf8");
	expect(source).toContain("...compiledWorkerBuildEntrypoints()");
	expect([...source.matchAll(/"(\.\/server\/[^"\r\n]+\.ts)"/g)].map((match) => match[1])).toEqual([
		"./server/index.ts",
	]);
	for (const entry of COMPILED_WORKER_ENTRIES) {
		expect(existsSync(join(root, "server", entry))).toBe(true);
	}
});

test("local and release builds share all 18 unique, existing worker entries", () => {
	expect(COMPILED_WORKER_ENTRIES).toHaveLength(18);
	expect(new Set(COMPILED_WORKER_ENTRIES).size).toBe(COMPILED_WORKER_ENTRIES.length);
	expect(compiledWorkerBuildEntrypoints()).toEqual(
		COMPILED_WORKER_ENTRIES.map((entry) => `./server/${entry}`),
	);
	for (const script of ["scripts/lib/runtime-compiler.ts", "scripts/build-cross-platform.ts"]) {
		const source = readFileSync(join(root, script), "utf8");
		expect(source).toContain("...compiledWorkerBuildEntrypoints()");
		expect(source).toContain('"./server/index.ts"');
	}
	for (const entry of compiledWorkerBuildEntrypoints()) {
		expect(existsSync(join(root, entry))).toBe(true);
	}
});

test("both editor IO workers remain production compile entries", () => {
	for (const entry of [
		"./server/services/editor-document-worker.ts",
		"./server/services/editor-document-stream-worker.ts",
	]) {
		expect(COMPILED_WORKER_ENTRIES.map((path) => `./server/${path}`)).toContain(entry);
	}
	expect(existsSync(join(root, "shared/compiled-worker-entries.ts"))).toBe(false);
});

const ts = new Bun.Transpiler({ loader: "ts" });
const tsx = new Bun.Transpiler({ loader: "tsx" });
function executableText(source: string, path = "worker.ts"): string {
	// Remove comments/type-only syntax, not executable Blob/eval strings. No whole-file exemptions.
	return (path.endsWith(".tsx") ? tsx : ts).transformSync(source);
}

/** Lexical regression guard for known constructor forms; not an arbitrary-code/dataflow proof. */
function workerConstructors(source: string, path = "worker.ts"): string[] {
	const code = executableText(source, path).replace(
		/\[(["'])(Worker|NodeWorker|construct)\1\]/g,
		".$2",
	);
	const aliases = new Set(["Worker", "NodeWorker"]);
	const last = (name: string) => name.slice(name.lastIndexOf(".") + 1);
	for (const match of code.matchAll(
		/\bimport\s*\{([^}]+)\}\s*from\s*["']node:worker_threads["']/g,
	)) {
		const fields = match[1];
		if (fields === undefined) throw new Error("Missing worker import scan capture");
		for (const part of fields.split(",")) {
			const worker = /^\s*Worker\s+as\s+([$\w]+)\s*$/.exec(part);
			if (worker?.[1]) aliases.add(worker[1]);
		}
	}
	for (const match of code.matchAll(
		/\{([^}]+)\}\s*=\s*(?:require\(["']node:worker_threads["']\)|(?:await\s+)?import\(["']node:worker_threads["']\)|globalThis|self)\s*[;,\n]/g,
	)) {
		const fields = match[1];
		if (fields === undefined) throw new Error("Missing worker destructuring scan capture");
		const worker = /\bWorker["']?\s*:\s*([$\w]+)/.exec(fields);
		if (worker?.[1]) aliases.add(worker[1]);
	}
	const assignments = [
		...code.matchAll(/\b(?:const|let|var)\s+([$\w]+)\s*=\s*([$\w]+(?:\.[$\w]+)*)\s*;/g),
	];
	let changed = true;
	while (changed) {
		changed = false;
		for (const [, alias, target] of assignments) {
			if (alias && target && aliases.has(last(target)) && !aliases.has(alias)) {
				aliases.add(alias);
				changed = true;
			}
		}
	}
	return [
		...code.matchAll(
			/\bnew\s+([$\w]+(?:\.[$\w]+)*)\s*\(|\bReflect\.construct\(\s*([$\w]+(?:\.[$\w]+)*)\s*,/g,
		),
	].flatMap((match) => {
		const name = match[1] ?? match[2];
		return name && aliases.has(last(name)) ? [name] : [];
	});
}

test("worker spawns go through the shared resolver and only Handle owns native constructors", () => {
	const offenders: string[] = [];
	for (const path of serverSources()) {
		if (path === "lib/worker-runtime/lifecycle.ts") continue;
		const source = readFileSync(join(root, "server", path), "utf8");
		for (const name of workerConstructors(source, path)) offenders.push(`${path}: ${name}`);
	}
	expect(offenders).toEqual([]);
	const core = readFileSync(join(root, "server/lib/worker-runtime/lifecycle.ts"), "utf8");
	expect(workerConstructors(core)).toEqual(["NodeWorker", "globalThis.Worker"]);
});

test("eval/Blob text, namespace aliases and Reflect cannot grant a file-wide constructor exemption", () => {
	for (const source of [
		'new Worker("x")',
		'new Worker("x", {eval:true}); const url=URL.createObjectURL(new Blob([]));',
		'const source = "new Worker(\\"x\\")"; export {source};',
		'import {Worker as Native} from "node:worker_threads"; new Native("x");',
		'import * as threads from "node:worker_threads"; new threads.Worker("x");',
		'const Factory=globalThis.Worker; const Alias=Factory; new (Alias)("x");',
		'const {Worker: Native}=require("node:worker_threads"); new Native("x");',
		'const {Worker: Native}=globalThis; new Native("x");',
		'const {"Worker": Native}=await import("node:worker_threads"); new Native("x");',
		'Reflect.construct(globalThis["Worker"], ["x"]);',
	])
		expect(workerConstructors(source)).toHaveLength(1);
	expect(
		workerConstructors('/* new Worker("ignored") */ new WorkerHandle(worker, exit, stop)'),
	).toEqual([]);
	expect(
		workerConstructors("WorkerHandle.bunThread(url); WorkerHandle.thread(source, {eval:true});"),
	).toEqual([]);
});

// Static coverage evidence, never a runtime registry or business protocol dispatch table.
const entryOwners: Record<(typeof COMPILED_WORKER_ENTRIES)[number], readonly string[]> = {
	"lib/db-worker/worker-entry.ts": ["lib/db-worker/pool.ts"],
	"lib/fs-scan-worker/fs-scan-worker-entry.ts": ["lib/fs-scan-worker/client.ts"],
	"lib/browser/memory-snapshot-worker.ts": [
		"lib/browser/memory-snapshot.ts",
		"lib/browser/memory-job.ts",
	],
	"lib/browser/memory-profile-worker.ts": [
		"lib/browser/memory-profiler.ts",
		"lib/browser/memory-job.ts",
	],
	"lib/share-preview-worker.ts": ["lib/share-preview-html.ts"],
	"lib/request-recorder-worker.ts": ["lib/request-recorder.ts"],
	"lib/startup-status/worker.ts": ["lib/startup-status/index.ts"],
	"lib/agent/request-json-worker.ts": ["lib/agent/request-json.ts"],
	"lib/agent/image-generation-response-worker.ts": ["lib/agent/image-generation-response.ts"],
	"services/editor-document-worker.ts": ["services/editor-document-jobs.ts"],
	"services/editor-document-stream-worker.ts": ["services/editor-document-streams.ts"],
	"services/outline/edit-text-worker.ts": ["services/outline/edit-text-runner.ts"],
	"services/git-untracked-line-worker.ts": ["services/git-line-stats.ts"],
	"services/git-current-baseline-worker.ts": ["services/git-current-baseline.ts"],
	"services/agent-runtime/model-history-worker.ts": [
		"services/agent-runtime/model-history-source.ts",
	],
	"services/narrator-prefix-snapshots-worker.ts": ["services/narrator-prefix-snapshots.ts"],
	"services/revert-transaction-manifest-worker.ts": ["services/revert-transaction-worker.ts"],
	"services/token-recalculation-worker.ts": ["services/token-recalculation-worker-client.ts"],
};
const evalOwners = [
	{
		kind: "Body",
		owners: ["services/revert-selection-service.ts"],
		marker: "connectCompiledWorker([BODY_WORKER]",
	},
	{
		kind: "Rewrite",
		owners: ["services/revert-history-commit.ts"],
		marker: "connectCompiledWorker([REWRITE_WORKER]",
	},
	{ kind: "GenUI", owners: ["services/gen-ui/compiler.ts"], marker: "WorkerHandle.bunThread" },
	{
		kind: "glob",
		owners: ["lib/agent/execution/local-backend.ts"],
		marker: "WorkerHandle.bunThread",
	},
	{
		kind: "historical-input",
		owners: ["services/tool-input-stream-source.ts", "services/tool-input-stream-source-worker.ts"],
		marker: "connectCompiledWorker([PROGRAM]",
	},
	{
		kind: "programmatic",
		owners: [
			"lib/agent/programmatic/bootstrap.ts",
			"lib/agent/programmatic/service.ts",
			"lib/agent/programmatic/podman-driver.ts",
		],
		marker: "lifecycle.bunThread",
	},
] as const;
const processOwners = [
	{ kind: "integrity", owner: "db/integrity-check.ts", marker: "WorkerHandle.subprocess" },
	{ kind: "snapshot-build", owner: "db/snapshot-build.ts", marker: "WorkerHandle.subprocess" },
	{
		kind: "physical-audit",
		owner: "services/file-change-physical-audit.ts",
		marker: "WorkerHandle.subprocess",
	},
	{
		kind: "parcel-watcher",
		owner: "lib/watcher/parcel-worker-client.ts",
		marker: "WorkerHandle.subprocess",
	},
	{ kind: "plugin-runtime", owner: "services/plugin-runtime.ts", marker: "new WorkerHandle" },
] as const;
function ownerText(paths: readonly string[]): string {
	return paths
		.map((path) => executableText(readFileSync(join(root, "server", path), "utf8"), path))
		.join("\n");
}
const admission = /\bnew\s+(?:WorkerPool|TaskQueue)\s*\(/;

test("all 29 families have explicit common-runtime coverage: 18 entries, 6 trusted evals, 5 processes", () => {
	expect(Object.keys(entryOwners)).toHaveLength(18);
	expect(evalOwners).toHaveLength(6);
	expect(processOwners).toHaveLength(5);
	expect(COMPILED_WORKER_ENTRIES.length + evalOwners.length + processOwners.length).toBe(29);
	for (const entry of COMPILED_WORKER_ENTRIES) {
		const text = ownerText(entryOwners[entry]);
		expect(text.includes(entry), entry).toBe(true);
		expect(/\bconnectCompiled(?:Bun)?Worker(?:\s*\(|\s*\)\s*\()/.test(text), entry).toBe(true);
		// Startup is a resource/lifecycle channel, not a fabricated CPU job queue.
		if (entry !== "lib/startup-status/worker.ts") expect(admission.test(text), entry).toBe(true);
		expect(text.includes("inlineFallback"), entry).toBe(false);
	}
	for (const { kind, owners, marker } of evalOwners) {
		const text = ownerText(owners);
		expect(text.includes(marker), `${kind}: ${marker}`).toBe(true);
		expect(admission.test(text), `${kind}: admission`).toBe(true);
		expect(text.includes("inlineFallback"), kind).toBe(false);
		if (kind === "Body" || kind === "Rewrite" || kind === "historical-input")
			expect(/\beval:\s*true/.test(text), `${kind}: trusted eval`).toBe(true);
		else expect(text.includes("URL.createObjectURL"), `${kind}: trusted Blob`).toBe(true);
	}
	const bootstrap = ownerText(["lib/agent/programmatic/bootstrap.ts"]);
	expect(bootstrap).toContain("WorkerHandle.toString()");
	for (const { kind, owner, marker } of processOwners) {
		const text = ownerText([owner]);
		expect(text.includes(marker), `${kind}: ${marker}`).toBe(true);
		expect(admission.test(text), `${kind}: admission`).toBe(true);
		expect(text.includes("inlineFallback"), kind).toBe(false);
	}
});

test("special worker process launchers keep native spawn centralized or wrapped, not a broad process exemption", () => {
	for (const { owner } of processOwners) {
		const text = ownerText([owner]);
		const native = [...text.matchAll(/\bBun\.spawn\s*\(/g)];
		// Plugin's injected spawner returns a process wrapped with its domain tree-exit ACK.
		expect(native.length, owner).toBe(owner === "services/plugin-runtime.ts" ? 1 : 0);
	}
	const driver = ownerText(["lib/agent/programmatic/podman-driver.ts"]);
	expect([...driver.matchAll(/\bnew\s+WorkerHandle\s*\(/g)]).toHaveLength(2);
	// Launcher process exit does not replace container absence proof.
	expect(driver).toContain('"container", "exists"');
});

test("the common runtime owns mechanics only, never business persistence or result caches", () => {
	for (const file of ["queue.ts", "pool.ts", "lifecycle.ts"]) {
		const source = ownerText([`lib/worker-runtime/${file}`]);
		expect(source).not.toContain("bun:sqlite");
		expect(source).not.toMatch(/from\s*["'][^"']*(?:\/services\/|\/db(?:\/|["']))/);
		expect(source).not.toContain("node:fs");
		expect(source).not.toMatch(/resultCache|cachedResults|inlineFallback/);
	}
});
