import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type HelperReleasePlan,
	restoreHelperReleaseBundle,
} from "../../scripts/lib/helper-release-control";
import { HELPER_PLATFORMS } from "../../shared/helper-distribution";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const commit = "a".repeat(40);
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "helper-restore-cancel-"));
	roots.push(root);
	const bin = join(root, "bin");
	await mkdir(bin);
	const zip = join(root, "source.zip");
	execFileSync(
		"python3",
		[
			"-c",
			"import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z: z.writestr('helper-manifest-v1.json','{}')",
			zip,
		],
		{ timeout: 10000, maxBuffer: 65536 },
	);
	const bytes = await readFile(zip);
	await writeFile(
		join(bin, "gh"),
		"#!/usr/bin/env python3\nimport os,sys\nsys.stdout.buffer.write(open(os.environ['FIXTURE_ZIP'],'rb').read())\n",
	);
	await chmod(join(bin, "gh"), 0o700);
	await writeFile(
		join(bin, "unzip"),
		"#!/usr/bin/env python3\nimport os,signal,sys\nout=sys.argv[sys.argv.index('-d')+1]\nwith open(os.path.join(out,'partial'),'w') as f: f.write('owned partial extraction')\nmarker=os.environ['FIXTURE_MARKER']\nwith open(marker+'.tmp','w') as f: f.write(str(os.getpid()))\nos.replace(marker+'.tmp',marker)\nsignal.pause()\n",
	);
	await chmod(join(bin, "unzip"), 0o700);
	const plan: HelperReleasePlan = {
		schemaVersion: 1,
		repository: "Fixture/Fork",
		defaultBranch: "trunk",
		tag: "helpers-v1.0.0",
		commit,
		controlCommit: commit,
		kind: "helpers",
		version: "1.0.0",
		protocolVersion: 1,
		sourceRunId: "11",
		publish: true,
	};
	const names = [
		"Helper preflight",
		"Assemble exact helper bundle",
		...HELPER_PLATFORMS.flatMap((platform) => [
			`Build (${platform})`,
			`Native smoke (${platform})`,
		]),
	];
	const run = async (args: string[]) => {
		const path = args[1] ?? "";
		if (args[0] !== "api" || args.length !== 2) throw new Error("Read-only source provenance only");
		if (path.endsWith("/actions/runs/11"))
			return JSON.stringify({
				id: 11,
				status: "completed",
				event: "workflow_dispatch",
				head_repository: { full_name: plan.repository },
				path: ".github/workflows/helpers-release.yml",
				head_branch: "trunk",
				head_sha: commit,
				run_attempt: 1,
			});
		if (path.includes("/jobs?"))
			return JSON.stringify({
				total_count: names.length,
				jobs: names.map((name) => ({ name, conclusion: "success", run_id: 11, head_sha: commit })),
			});
		if (path.includes("/artifacts?"))
			return JSON.stringify({
				total_count: 1,
				artifacts: [
					{
						id: 44,
						name: `helper-bundle-helpers-${commit}`,
						expired: false,
						size_in_bytes: bytes.length,
						digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
						workflow_run: { id: 11 },
					},
				],
			});
		throw new Error(`Unexpected source API ${path}`);
	};
	const environment = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		GITHUB_RUN_ID: "22",
		GH_TOKEN: "fixture-gh-token",
		NF_UPDATE_TOKEN: "fixture-mirror-token",
		FIXTURE_ZIP: zip,
		FIXTURE_MARKER: join(root, "extract-ready"),
	};
	return {
		root,
		plan,
		environment,
		run,
		output: join(root, "restored"),
		git: (_root: string, args: string[]) => {
			expect(args).toEqual(["merge-base", "--is-ancestor", commit, "refs/remotes/origin/trunk"]);
			return "";
		},
	};
}

describe("helper restore extraction cancellation", () => {
	test("active unzip is asynchronous, abortable, awaited and owned files are cleaned", async () => {
		const f = await fixture();
		const parent = new AbortController();
		let watcher: ReturnType<typeof watch> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const ready = new Promise<void>((resolve, reject) => {
			watcher = watch(f.root, (_event, name) => {
				if (name === "extract-ready") resolve();
			});
			timer = setTimeout(() => reject(new Error("Fixture unzip did not start")), 2000);
		});
		const task = restoreHelperReleaseBundle(f.root, f.plan, f.output, {
			run: f.run,
			git: f.git,
			environment: f.environment,
			signal: parent.signal,
		});
		// Attach an error handler immediately while observing the child-start signal.
		const settled = task.then(
			() => undefined,
			(error: unknown) => error,
		);
		try {
			await ready;
			const pid = Number(await readFile(f.environment.FIXTURE_MARKER, "utf8"));
			expect(Number.isSafeInteger(pid)).toBe(true);
			parent.abort(new Error("fixture parent cancellation"));
			expect(await settled).toBeInstanceOf(Error);
			expect(() => process.kill(pid, 0)).toThrow();
			expect(await readdir(f.root)).not.toContain("restored");
			expect((await readdir(f.root)).some((name) => name.startsWith(".helper-restore-"))).toBe(
				false,
			);
		} finally {
			parent.abort();
			watcher?.close();
			if (timer) clearTimeout(timer);
			await settled;
		}
	});
	test("existing caller files and a colliding old archive path are never deleted", async () => {
		const f = await fixture();
		await mkdir(f.output);
		await writeFile(join(f.output, "user-file"), "preserve caller contents");
		await writeFile(join(f.root, "artifact-44.zip"), "preserve unrelated archive");
		await expect(
			restoreHelperReleaseBundle(f.root, f.plan, f.output, {
				run: f.run,
				git: f.git,
				environment: f.environment,
			}),
		).rejects.toThrow();
		expect(await readFile(join(f.output, "user-file"), "utf8")).toBe("preserve caller contents");
		expect(await readFile(join(f.root, "artifact-44.zip"), "utf8")).toBe(
			"preserve unrelated archive",
		);
		expect((await readdir(f.root)).some((name) => name.startsWith(".helper-restore-"))).toBe(false);
	});
	test("already-cancelled source restore never starts a download/extractor", async () => {
		const f = await fixture();
		const parent = new AbortController();
		parent.abort();
		await expect(
			restoreHelperReleaseBundle(f.root, f.plan, f.output, {
				run: f.run,
				git: f.git,
				environment: f.environment,
				signal: parent.signal,
			}),
		).rejects.toThrow();
		expect(await readdir(f.root)).not.toContain("extract-ready");
		expect(await readdir(f.root)).not.toContain("restored");
	});
});
