import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertBridgeMode,
	BRIDGE_PREPARE_STEP,
	BRIDGE_UPLOAD_STEP,
	type BridgeIdentity,
	bridgeArtifactName,
	ciBridgeDeadlineSignal,
	createBridgeGhRunner,
	restoreUpdateServerBridgeArtifact,
	validateBridgeEnvelope,
	writeBridgeEnvelope,
} from "../../scripts/lib/ci-update-server-bridge-restore";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const control = "b".repeat(40);
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function fixture(
	kind: "main" | "helpers" | "executor" = "main",
	extras: [string, string][] = [],
) {
	const root = await mkdtemp(join(tmpdir(), "ci-bridge-"));
	roots.push(root);
	const input = join(root, "input");
	await mkdir(input);
	const sealName = kind === "main" ? "prepared-main-mirror.json" : "tools-mirror-seal.json";
	const seal = '{"frozen":true}\n';
	const identity: BridgeIdentity = {
		kind,
		repository: "Example/Fork",
		defaultBranch: "trunk",
		tag: kind === "main" ? "v1.2.1" : `${kind}-v1.2.1`,
		version: "1.2.1",
		commit: "a".repeat(40),
		sourceRunId: 11,
		sourceRunAttempt: 2,
		serverUrl: "https://mirror.example",
		manifestSha256: "c".repeat(64),
	};
	await writeFile(join(input, sealName), seal);
	const envelope = await writeBridgeEnvelope(input, identity, sha(seal), {
		GITHUB_RUN_ID: "22",
		GITHUB_RUN_ATTEMPT: "3",
		GITHUB_SHA: control,
	});
	await mkdir(join(input, "assets"));
	await writeFile(join(input, "assets", "frozen-patch"), "original sealed bytes");
	const archive = join(root, "archive.zip");
	const extrasPath = join(root, "extras.json");
	await writeFile(extrasPath, JSON.stringify(extras));
	execFileSync(
		"python3",
		[
			"-c",
			"import json,os,sys,zipfile\nroot,out,extras=sys.argv[1:]\nwith zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:\n for base,dirs,files in os.walk(root):\n  for name in files:\n   p=os.path.join(base,name);z.write(p,os.path.relpath(p,root))\n for name,text in json.load(open(extras)): z.writestr(name,text)",
			input,
			archive,
			extrasPath,
		],
		{ timeout: 10000, maxBuffer: 65536 },
	);
	const bytes = await readFile(archive);
	const source = {
		id: 22,
		run_attempt: 3,
		workflow_id: 77,
		path:
			kind === "main" ? ".github/workflows/release.yml" : ".github/workflows/helpers-release.yml",
		event: "workflow_dispatch",
		head_branch: "trunk",
		head_sha: control,
		status: "completed",
		conclusion: "failure",
		repository: { id: 88, full_name: identity.repository },
		head_repository: { id: 88, full_name: identity.repository },
	};
	const artifact = {
		id: 44,
		name: bridgeArtifactName(kind, 22, 3),
		expired: false,
		size_in_bytes: bytes.length,
		digest: `sha256:${sha(bytes)}`,
		workflow_run: {
			id: 22,
			repository_id: 88,
			head_repository_id: 88,
			head_sha: control,
			head_branch: "trunk",
		},
	};
	const job = {
		id: 55,
		run_id: 22,
		run_attempt: 3,
		head_sha: control,
		name: kind === "main" ? "Publish verified release" : "Publish approved helper draft",
		conclusion: "failure",
		steps: [BRIDGE_PREPARE_STEP, BRIDGE_UPLOAD_STEP].map((name) => ({
			name,
			status: "completed",
			conclusion: "success",
		})),
	};
	const calls: string[][] = [];
	const run = async (args: string[]) => {
		calls.push(args);
		if (args[0] !== "api" || args.some((arg) => ["POST", "PATCH", "PUT", "DELETE"].includes(arg)))
			throw new Error("Fixture forbids GitHub writes");
		const path = args[1] ?? "";
		if (path.endsWith("/actions/runs/22")) return JSON.stringify(source);
		if (path.endsWith("/actions/workflows/77"))
			return JSON.stringify({ id: 77, path: source.path, state: "active" });
		if (path.includes("/git/ref/heads/"))
			return JSON.stringify({ object: { type: "commit", sha: "d".repeat(40) } });
		if (path.includes("/compare/"))
			return JSON.stringify({ status: "ahead", merge_base_commit: { sha: control } });
		if (path.includes("/jobs?")) return JSON.stringify({ total_count: 1, jobs: [job] });
		if (path.includes("/artifacts?"))
			return JSON.stringify({ total_count: 1, artifacts: [artifact] });
		if (path.endsWith("/actions/artifacts/44")) return JSON.stringify(artifact);
		throw new Error(`Unexpected fixture API ${path}`);
	};
	const fetchCalls: { url: string; headers: Headers }[] = [];
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		fetchCalls.push({ url: String(url), headers: new Headers(init?.headers) });
		return new Response(bytes);
	}) as unknown as typeof fetch;
	const options = {
		identity,
		bridgeRunId: 22,
		destination: join(root, "restored"),
		run,
		fetch: fetcher,
		env: {
			GITHUB_RUN_ID: "33",
			GITHUB_RUN_ATTEMPT: "1",
			GITHUB_REPOSITORY: identity.repository,
			GITHUB_EVENT_NAME: "workflow_dispatch",
			GITHUB_REF: "refs/heads/trunk",
			GH_TOKEN: "fixture-github-token",
		},
	};
	return { root, input, options, bytes, seal, envelope, source, artifact, job, calls, fetchCalls };
}

describe("immutable CI bridge restoration", () => {
	for (const kind of ["main", "helpers", "executor"] as const)
		test(`${kind}: failed publisher Y restores source X without rebuilding or GitHub writes`, async () => {
			const f = await fixture(kind);
			const result = await restoreUpdateServerBridgeArtifact(f.options);
			expect(result.envelope.sourceRunId).toBe(11);
			expect(result.envelope.bridgeRunId).toBe(22);
			expect(result.envelope.sealSha256).toBe(sha(f.seal));
			expect(await readFile(join(f.options.destination, "assets", "frozen-patch"), "utf8")).toBe(
				"original sealed bytes",
			);
			expect(f.calls.every((args) => args[0] === "api" && args.length === 2)).toBe(true);
			expect(JSON.stringify(result)).not.toContain("fixture-github-token");
		});
	for (const [field, value] of [
		["sourceRunId", 12],
		["sourceRunAttempt", 1],
		["repository", "Foreign/Fork"],
		["tag", "v9.9.9"],
		["commit", "e".repeat(40)],
		["serverUrl", "https://other.example"],
		["manifestSha256", "e".repeat(64)],
	] as const)
		test(`rejects changed ${field} identity`, async () => {
			const f = await fixture();
			await expect(
				restoreUpdateServerBridgeArtifact({
					...f.options,
					identity: { ...f.options.identity, [field]: value },
				}),
			).rejects.toThrow();
		});
	for (const field of ["event", "path", "head_branch", "head_sha"] as const)
		test(`rejects untrusted bridge run ${field}`, async () => {
			const f = await fixture();
			f.source[field] = field === "head_sha" ? "e".repeat(40) : "untrusted";
			await expect(restoreUpdateServerBridgeArtifact(f.options)).rejects.toThrow();
			expect(f.fetchCalls).toHaveLength(0);
		});
	test("rejects fork repository IDs despite matching display names", async () => {
		const f = await fixture();
		f.source.head_repository.id = 99;
		await expect(restoreUpdateServerBridgeArtifact(f.options)).rejects.toThrow();
	});
	test("unknown workflow path cannot approve an artifact", async () => {
		const f = await fixture();
		f.source.path = ".github/workflows/evil.yml";
		await expect(restoreUpdateServerBridgeArtifact(f.options)).rejects.toThrow();
	});
	for (const conclusion of ["failure", "skipped", "cancelled"])
		test(`upload ${conclusion} forbids GitHub publication recovery`, async () => {
			const f = await fixture();
			const upload = f.job.steps[1];
			if (!upload) throw new Error("Fixture upload missing");
			upload.conclusion = conclusion;
			await expect(restoreUpdateServerBridgeArtifact(f.options)).rejects.toThrow("did not succeed");
			expect(f.fetchCalls).toHaveLength(0);
		});
	test("duplicate preparation step is not accepted", async () => {
		const f = await fixture();
		const prepare = f.job.steps[0];
		if (!prepare) throw new Error("Fixture prepare missing");
		f.job.steps.push({ ...prepare });
		await expect(restoreUpdateServerBridgeArtifact(f.options)).rejects.toThrow();
	});
	test("expired artifact fails before downloading", async () => {
		const f = await fixture();
		f.artifact.expired = true;
		await expect(restoreUpdateServerBridgeArtifact(f.options)).rejects.toThrow();
		expect(f.fetchCalls).toHaveLength(0);
	});
	test("missing artifact digest is not an immutable upload", async () => {
		const f = await fixture();
		f.artifact.digest = "";
		await expect(restoreUpdateServerBridgeArtifact(f.options)).rejects.toThrow();
	});
	test("wrong archive digest rejects without leaving extracted bytes", async () => {
		const f = await fixture();
		f.artifact.digest = `sha256:${"e".repeat(64)}`;
		await expect(restoreUpdateServerBridgeArtifact(f.options)).rejects.toThrow("digest");
		expect((await readdir(f.root)).some((name) => name.startsWith(".restored-"))).toBe(false);
	});
	test("unbounded response is cancelled at declared artifact size", async () => {
		const f = await fixture();
		let cancelled = false;
		const fetcher = (async () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						controller.enqueue(new Uint8Array(f.bytes.length + 1));
					},
					cancel() {
						cancelled = true;
					},
				}),
			)) as unknown as typeof fetch;
		await expect(
			restoreUpdateServerBridgeArtifact({ ...f.options, fetch: fetcher }),
		).rejects.toThrow("size limit");
		expect(cancelled).toBe(true);
	});
	test("current publication binds successful upload receipt SHA and ID", async () => {
		const f = await fixture();
		f.options.env.GITHUB_RUN_ID = "22";
		f.options.env.GITHUB_RUN_ATTEMPT = "3";
		const result = await restoreUpdateServerBridgeArtifact({
			...f.options,
			uploadedArtifactId: "44",
			uploadedArtifactDigest: f.artifact.digest.slice(7),
		});
		expect(result.artifactId).toBe(44);
	});
	for (const bad of [
		{ uploadedArtifactId: "45", uploadedArtifactDigest: "e".repeat(64) },
		{ uploadedArtifactId: "44", uploadedArtifactDigest: "e".repeat(64) },
	])
		test(`rejects forged upload receipt ${JSON.stringify(bad)}`, async () => {
			const f = await fixture();
			await expect(restoreUpdateServerBridgeArtifact({ ...f.options, ...bad })).rejects.toThrow();
			expect(f.fetchCalls).toHaveLength(0);
		});
	for (const path of ["../escape", "/absolute", "assets/../../escape", "too/deep/file"])
		test(`unsafe ZIP ${path} fails before extraction`, async () => {
			const f = await fixture("main", [[path, "unsafe"]]);
			await expect(restoreUpdateServerBridgeArtifact(f.options)).rejects.toThrow();
		});
	test("duplicate ZIP envelope cannot replace trusted manifest", async () => {
		const f = await fixture("main", [["bridge-envelope.json", "{}"]]);
		await expect(restoreUpdateServerBridgeArtifact(f.options)).rejects.toThrow();
	});
	test("oversized JSON is rejected before reading or extraction", async () => {
		const f = await fixture("main", [["large.json", "x".repeat(1024 * 1024 + 1)]]);
		await expect(restoreUpdateServerBridgeArtifact(f.options)).rejects.toThrow();
	});
	test("archive redirect strips GitHub token and only trusts HTTPS artifact hosts", async () => {
		const f = await fixture();
		const headers: Headers[] = [];
		const fetcher = (async (_url: unknown, init?: RequestInit) => {
			headers.push(new Headers(init?.headers));
			return headers.length === 1
				? new Response(null, {
						status: 302,
						headers: { location: "https://fixture.blob.core.windows.net/archive" },
					})
				: new Response(f.bytes);
		}) as unknown as typeof fetch;
		await restoreUpdateServerBridgeArtifact({ ...f.options, fetch: fetcher });
		expect(headers[0]?.get("authorization")).toContain("fixture-github-token");
		expect(headers[1]?.get("authorization")).toBeNull();
	});
	test("untrusted redirect host receives no credentials or request", async () => {
		const f = await fixture();
		let count = 0;
		const fetcher = (async () => {
			count++;
			return new Response(null, {
				status: 302,
				headers: { location: "https://evil.example/archive" },
			});
		}) as unknown as typeof fetch;
		await expect(
			restoreUpdateServerBridgeArtifact({ ...f.options, fetch: fetcher }),
		).rejects.toThrow("Untrusted");
		expect(count).toBe(1);
	});
	test("arbitrary local seal cannot substitute for original Actions artifact", async () => {
		const f = await fixture();
		f.artifact.name = "operator-seal";
		await expect(
			restoreUpdateServerBridgeArtifact({ ...f.options, destination: f.input }),
		).rejects.toThrow();
		expect(f.fetchCalls).toHaveLength(0);
	});
	test("envelope rejects secrets and unknown fields", async () => {
		const f = await fixture();
		expect(() =>
			validateBridgeEnvelope({ ...f.envelope, token: "must-not-persist" }, f.options.identity),
		).toThrow();
	});
});
describe("one publication deadline and cancellable GitHub writes", () => {
	test("an exhausted workflow deadline is never renewed by a new stage", () => {
		const parent = new AbortController();
		const env = { NF_RELEASE_DEADLINE_MS: String(Date.now() - 1) };
		expect(ciBridgeDeadlineSignal(env, parent.signal).aborted).toBe(true);
		expect(ciBridgeDeadlineSignal(env, parent.signal).aborted).toBe(true);
	});
	test("parent cancellation aborts every stage", () => {
		const parent = new AbortController();
		const signal = ciBridgeDeadlineSignal({}, parent.signal);
		parent.abort();
		expect(signal.aborted).toBe(true);
	});
	for (const value of ["abc", "0", String(Date.now() + 31 * 60_000)])
		test(`rejects invalid deadline ${value}`, () => {
			expect(() =>
				ciBridgeDeadlineSignal({ NF_RELEASE_DEADLINE_MS: value }, new AbortController().signal),
			).toThrow();
		});
	async function fakeGh(body: string) {
		const root = await mkdtemp(join(tmpdir(), "ci-fake-gh-"));
		roots.push(root);
		await writeFile(join(root, "gh"), `#!/bin/sh\n${body}\n`);
		await chmod(join(root, "gh"), 0o700);
		return {
			...process.env,
			PATH: `${root}:${process.env.PATH}`,
			NF_UPDATE_TOKEN: "fixture-legacy-secret",
			NF_UPDATE_SERVER: "https://fixture.invalid",
			GH_TOKEN: "fixture-github-token",
		};
	}
	test("GitHub subprocess does not inherit legacy credentials", async () => {
		const env = await fakeGh(
			'printf \'%s:%s:%s\' "$NF_UPDATE_TOKEN" "$NF_UPDATE_SERVER" "$GH_TOKEN"',
		);
		expect(await createBridgeGhRunner(new AbortController().signal, env)([])).toBe(
			"::fixture-github-token",
		);
	});
	test("parent cancellation terminates only its active GitHub child", async () => {
		const env = await fakeGh("while true; do :; done");
		const parent = new AbortController();
		const task = createBridgeGhRunner(parent.signal, env)([]);
		parent.abort();
		await expect(task).rejects.toThrow();
	});
	for (const stream of ["stdout", "stderr"])
		test(`GitHub ${stream} is bounded before collection`, async () => {
			const env = await fakeGh(
				`exec python3 -c 'import sys; sys.${stream}.write("x" * (1024*1024+1))'`,
			);
			await expect(createBridgeGhRunner(new AbortController().signal, env)([])).rejects.toThrow();
		});
});
describe("explicit bridge modes", () => {
	test("GitHub-only and index repair never require a bridge run", () => {
		expect(() => assertBridgeMode({ publish: "false", mirrorOnly: "false" })).not.toThrow();
		expect(() =>
			assertBridgeMode({ publish: "true", mirrorOnly: "false", indexOnly: "true" }),
		).not.toThrow();
	});
	test("mirror-only accepts distinct source and publisher runs", () => {
		expect(() =>
			assertBridgeMode({
				publish: "true",
				mirrorOnly: "true",
				sourceRunId: "11",
				bridgeRunId: "22",
			}),
		).not.toThrow();
	});
	for (const values of [
		{ publish: "false", mirrorOnly: "true", sourceRunId: "11", bridgeRunId: "22" },
		{
			publish: "true",
			mirrorOnly: "true",
			indexOnly: "true",
			sourceRunId: "11",
			bridgeRunId: "22",
		},
		{ publish: "true", mirrorOnly: "true", sourceRunId: "11" },
		{ publish: "true", mirrorOnly: "true", sourceRunId: "-1", bridgeRunId: "22" },
		{ publish: "true", mirrorOnly: "false", bridgeRunId: "22" },
	])
		test(`rejects unsupported mode ${JSON.stringify(values)}`, () => {
			expect(() => assertBridgeMode(values)).toThrow();
		});
});
