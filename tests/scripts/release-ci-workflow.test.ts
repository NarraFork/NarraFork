import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import {
	assertReleaseGate,
	createCiReleaseGhRunner,
	normalizeMatrixArtifacts,
	parseCiReleaseArgs,
	releaseMatrix,
	runCiRelease,
	validateBuildRecoveryArgs,
} from "../../scripts/ci-release";
import { CI_RELEASE_TARGETS, type CiReleasePlan } from "../../scripts/lib/ci-release-types";

type Step = {
	name?: string;
	uses?: string;
	run?: string;
	if?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
};
type Job = {
	name?: string;
	needs?: string[];
	if?: string;
	uses?: string;
	permissions?: Record<string, string>;
	environment?: string;
	steps?: Step[];
	strategy?: { "fail-fast": boolean; matrix: string };
	"timeout-minutes"?: number;
	"runs-on"?: string;
	with?: Record<string, unknown>;
};
type Workflow = {
	on: Record<
		string,
		{
			inputs?: Record<
				string,
				{ description?: string; default?: unknown; required?: boolean; type?: string }
			>;
		}
	>;
	permissions: Record<string, string>;
	concurrency: { group: string; "cancel-in-progress": boolean | string };
	jobs: Record<string, Job>;
};
const root = resolve(import.meta.dir, "../..");
const release = Bun.YAML.parse(
	readFileSync(join(root, ".github/workflows/release.yml"), "utf8"),
) as Workflow;
const ci = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as Workflow;
const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const plan = { version: "0.9.0", runId: 45, runAttempt: 2 } as CiReleasePlan;
const expression = (value: string) => `\${{ ${value} }}`;

function gateEnv(restore: boolean, publish: boolean): NodeJS.ProcessEnv {
	return {
		PREFLIGHT_RESULT: "success",
		RESTORE_MODE: String(restore),
		BUILD_REUSE_MODE: "false",
		SMOKE_ONLY: "false",
		RESTORE_PLATFORMS_RESULT: "skipped",
		PUBLISH_REQUESTED: String(publish),
		VERIFY_RESULT: restore ? "skipped" : "success",
		BUILD_RESULT: restore ? "skipped" : "success",
		SMOKE_RESULT: restore ? "skipped" : "success",
		ASSEMBLE_RESULT: restore ? "skipped" : "success",
		RESTORE_RESULT: restore ? "success" : "skipped",
		PUBLISH_RESULT: publish ? "success" : "skipped",
		INDEX_ONLY: "false",
		INDEX_COMMIT: publish ? "a".repeat(40) : "",
		INDEX_GENERATION: publish ? "1" : "",
	};
}

describe("remote frontend release wiring", () => {
	test("only declared target checkouts build remote assets with frozen identity and run production browser checks", () => {
		const build = ci.jobs.build.steps?.find(
			(step) => step.name === "Build declared remote frontend",
		);
		expect(build?.if).toContain("frontend-capability.json");
		for (const flag of ["--repository=", "--version=", "--commit=", "--output="])
			expect(build?.run).toContain(flag);
		expect(build?.env?.SOURCE_COMMIT).toContain("inputs.checkout-ref");
		expect(release.jobs.verify.with?.["release-version"]).toContain("preflight.outputs.version");
		expect(
			ci.jobs.tests.steps?.find((step) => step.name === "Run repository tests")?.env
				?.NF_REMOTE_PRODUCTION_TEST,
		).toBe("1");
	});
	test("remote artifact producer and upload share a non-hidden directory", () => {
		const steps = ci.jobs.build.steps ?? [];
		const build = steps.find((step) => step.name === "Build declared remote frontend");
		const upload = steps.find((step) => step.name === "Upload remote frontend");
		const path = upload?.with?.path;
		expect(typeof path).toBe("string");
		if (typeof path !== "string") throw new Error("Missing remote artifact upload directory");
		const directory = path.replace(/\/$/, "");
		expect(directory.split("/").every((segment) => !!segment && !segment.startsWith("."))).toBe(
			true,
		);
		expect(build?.run).toContain(`--output=${directory}`);
		const typecheckIndex = steps.findIndex((step) => step.run === "bunx tsgo --noEmit");
		expect(typecheckIndex).toBeGreaterThanOrEqual(0);
		for (const [index, step] of steps.entries()) {
			if (step.uses?.startsWith("actions/upload-artifact@"))
				expect(index).toBeGreaterThan(typecheckIndex);
		}
		// Do not broadly enable uploading hidden content just to include these two public assets.
		expect(upload?.with?.["include-hidden-files"]).not.toBe(true);
	});
	test("raw-build recovery restores exact artifacts without source builds; ordinary binary input stays ordinary", () => {
		const job = release.jobs["restore-remote-frontend"];
		expect(job.if).toContain("build-reuse-mode == 'true'");
		expect(job.if).toContain("remote-frontend == 'true'");
		const code = job.steps?.map((step) => step.run ?? "").join("\n") ?? "";
		expect(code).toContain("restore-remote-frontend");
		expect(code).not.toContain("build-remote-frontend");
		expect(code).not.toContain("bun install");
		expect(release.jobs.assemble.needs).toContain("restore-remote-frontend");
		expect(
			release.jobs.assemble.steps?.find(
				(step) => step.name === "Download exact remote frontend artifact",
			)?.with?.name,
		).toBe(`remote-frontend-${expression("github.run_id")}-${expression("github.run_attempt")}`);
		expect(
			release.jobs.build.steps
				?.filter((step) => step.with?.path === "dist/frontend/")
				.map((step) => step.with?.name),
		).toEqual(["ci-frontend"]);
	});
	test("a declared raw-build recovery cannot publish with failed or skipped remote restore", () => {
		const env = {
			...gateEnv(false, false),
			BUILD_REUSE_MODE: "true",
			VERIFY_RESULT: "skipped",
			BUILD_RESULT: "skipped",
			RESTORE_PLATFORMS_RESULT: "success",
			REMOTE_FRONTEND_DECLARED: "true",
			REMOTE_FRONTEND_RESTORE_RESULT: "success",
		};
		expect(() => assertReleaseGate(env)).not.toThrow();
		for (const result of ["failed", "skipped", "cancelled", ""])
			expect(() => assertReleaseGate({ ...env, REMOTE_FRONTEND_RESTORE_RESULT: result })).toThrow(
				"remote frontend",
			);
		expect(() =>
			assertReleaseGate({
				...env,
				REMOTE_FRONTEND_DECLARED: "false",
				REMOTE_FRONTEND_RESTORE_RESULT: "skipped",
			}),
		).not.toThrow();
	});
	test("trusted publisher control bundles the verifier without worker files or dependency installation", async () => {
		const built = await Bun.build({
			entrypoints: [join(root, "scripts/ci-release.ts")],
			target: "bun",
			format: "esm",
		});
		expect(built.success).toBe(true);
		expect(built.outputs).toHaveLength(1);
		expect(built.outputs[0].size).toBeLessThan(3 * 1024 ** 2);
		const source = await built.outputs[0].text();
		expect(source).toContain("REMOTE_FRONTEND");
		expect(source).not.toContain('new URL("./remote-frontend-archive-worker.ts"');
	}, 30_000);
});

describe("CI component read transport", () => {
	test("read budgets reach the cancellable transport while uploads retain the ordinary runner", async () => {
		const parent = new AbortController();
		const request = new AbortController();
		const commands: string[][] = [];
		let forwarded:
			| { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number }
			| undefined;
		const run = createCiReleaseGhRunner(
			parent.signal,
			async (args) => {
				commands.push(args);
				return "upload";
			},
			async (_args, controls) => {
				forwarded = controls;
				return "read";
			},
		);
		expect(await run(["release", "upload", "v0.9.2"])).toBe("upload");
		expect(
			await run(["api", "repos/Example/Fork/git/trees/sha"], {
				signal: request.signal,
				timeoutMs: 30_000,
				maxOutputBytes: 1024 * 1024,
			}),
		).toBe("read");
		expect(commands).toHaveLength(1);
		expect(forwarded?.timeoutMs).toBe(30_000);
		expect(forwarded?.maxOutputBytes).toBe(1024 * 1024);
		expect(forwarded?.signal?.aborted).toBe(false);
		request.abort(new Error("request budget expired"));
		expect(forwarded?.signal?.aborted).toBe(true);
	});
	test("parent cancellation reaches active reads and pre-aborted requests never start a child", async () => {
		const parent = new AbortController();
		let entered = false;
		const run = createCiReleaseGhRunner(
			parent.signal,
			async () => "ordinary",
			async (_args, controls) => {
				entered = true;
				return new Promise<string>((_resolve, reject) => {
					controls?.signal?.addEventListener("abort", () => reject(controls.signal?.reason), {
						once: true,
					});
					parent.abort(new Error("publisher deadline"));
				});
			},
		);
		await expect(
			run(["api", "source"], { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 }),
		).rejects.toThrow("publisher deadline");
		expect(entered).toBe(true);
		entered = false;
		await expect(run(["api", "source"], { timeoutMs: 30_000 })).rejects.toThrow();
		expect(entered).toBe(false);
	});
});

describe("published recovery component mode forwarding", () => {
	test.each([
		"index",
		"publish",
	] as const)("%s CLI forwards the correct readiness mode at every publication recheck", async (command) => {
		const original = { tag: "v0.9.0", version: "0.9.0", runId: 45, runAttempt: 2 };
		const seen: { requireAlreadyPublished?: boolean; publish: boolean }[] = [];
		const stop = new Error("verified mode forwarding");
		// Execute the actual dispatcher in a fresh VM; only external boundaries are mocked.
		// This avoids persistent module mocks and any real GitHub, git or filesystem writes.
		const context = {
			argv:
				command === "index"
					? ["index", "--plan=plan.json", "--publish=true"]
					: [command, "--tag=v0.9.0", "--source-run-id=45", "--bundle-dir=bundle"],
			parseCiReleaseArgs,
			timeReleasePhase: (_phase: string, _details: unknown, operation: () => unknown) =>
				operation(),
			AbortController,
			process: {
				cwd: () => root,
				env: { PUBLISH_REQUESTED: "true" },
				once: () => {},
				removeListener: () => {},
			},
			ciPublicationDeadlineSignal: (_env: unknown, signal: AbortSignal) => signal,
			createPublicationGhRunner: () => async () => "",
			createCiReleaseGhRunner: () => async () => "",
			runGh: async () => "",
			required: (values: Record<string, string>, name: string) => values[name],
			positiveId: Number,
			resolve,
			join,
			readPlan: async () => original,
			assertPrimaryReleaseCheckout: () => {},
			resolveUpdateServerBridgeConfig: () => ({ serverUrl: "https://fixture.invalid" }),
			restoreCiReleaseBundle: async () => ({ plan: original }),
			verifyReleaseBundle: async () => ({ plan: original }),
			hashReleaseFile: async () => ({ sha256: "a".repeat(64) }),
			preparePublishedUpdateIndexRelease: async () => ({}),
			revalidateCiReleasePlan: async (
				value: unknown,
				options: { requireAlreadyPublished?: boolean; publish: boolean },
			) => {
				seen.push(options);
				if (command !== "index" || seen.length === 2) throw stop;
				return value;
			},
		};
		await expect(runInNewContext(`(${runCiRelease.toString()})(argv)`, context)).rejects.toBe(stop);
		expect(seen).toHaveLength(command === "index" ? 2 : 1);
		for (const options of seen) {
			expect(options.publish).toBe(true);
			expect(options.requireAlreadyPublished).toBe(command !== "publish");
		}
	});
	test.each([
		"index",
	] as const)("%s-only preflight forwards recovery mode without changing publication authorization", async (mode) => {
		let seen: { indexOnly?: boolean; mirrorOnly?: boolean; publish: boolean } | undefined;
		const stop = new Error("verified preflight mode");
		await expect(
			runInNewContext(`(${runCiRelease.toString()})(argv)`, {
				argv: ["preflight", "--tag=v0.9.0", "--publish=true", `--${mode}-only=true`],
				parseCiReleaseArgs,
				timeReleasePhase: (_phase: string, _details: unknown, operation: () => unknown) =>
					operation(),
				AbortController,
				process: { cwd: () => root, env: {}, once: () => {}, removeListener: () => {} },
				runGh: async () => "",
				createCiReleaseGhRunner: () => async () => "",
				required: (values: Record<string, string>, name: string) => values[name],
				assertBridgeMode: () => {},
				validateBuildRecoveryArgs,
				createCiReleasePlan: async (options: typeof seen) => {
					seen = options;
					throw stop;
				},
			}),
		).rejects.toBe(stop);
		expect(seen?.publish).toBe(true);
		expect(seen?.indexOnly).toBe(mode === "index");
		expect(seen?.mirrorOnly).toBeUndefined();
	});
});

describe("release workflow safety", () => {
	test("release entry points and imported helpers survive an ordinary fresh clone", () => {
		const paths = [
			"scripts/ci-release.ts",
			"scripts/smoke-release-binary.ts",
			"scripts/lib/github-release-baseline.ts",
			"scripts/lib/github-release-summary.ts",
			"scripts/lib/build-repository.ts",
			"scripts/lib/update-index.ts",
			"scripts/lib/update-index-github.ts",
			"scripts/lib/ci-publication-runtime.ts",
			"scripts/lib/publication-receipt.ts",
			...new Bun.Glob("scripts/lib/ci-{release,build}-*.ts").scanSync({ cwd: root }),
		];
		const result = spawnSync("git", ["check-ignore", "--no-index", "--", ...paths], {
			cwd: root,
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 16384,
		});
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
	});
	test("manual default is build-only, without automatic release mutation triggers", () => {
		expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
		expect(release.on.workflow_dispatch?.inputs?.publish).toEqual({
			description: "Publish after verification and release Environment approval",
			required: true,
			type: "boolean",
			default: false,
		});
		expect(Object.keys(release.on.workflow_dispatch?.inputs ?? {}).sort()).toEqual([
			"build_run_attempt",
			"build_run_id",
			"index_only",
			"publish",
			"smoke_target",
			"source_run_id",
			"tag",
		]);
		expect(release.permissions).toEqual({ contents: "read" });
		expect(release.concurrency).toEqual({
			group: "main-program-release",
			"cancel-in-progress": false,
		});
	});
	test("only the protected publisher holds write permission, and it never installs dependencies", () => {
		for (const [name, job] of Object.entries(release.jobs)) {
			expect(JSON.stringify(job)).not.toContain("continue-on-error");
			if (name === "publish") {
				expect(job.environment).toBe("release");
				expect(job.permissions).toEqual({ contents: "write", actions: "read" });
				expect(
					job.steps?.some((step) =>
						/bun install|bun run build|build-cross-platform/.test(step.run ?? ""),
					),
				).toBe(false);
			} else expect(Object.values(job.permissions ?? {})).not.toContain("write");
			if (!job.uses) expect(job["timeout-minutes"]).toBeGreaterThan(0);
			for (const step of job.steps ?? []) {
				if (step.uses) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
				if (step.uses?.startsWith("actions/checkout@"))
					expect(step.with?.["persist-credentials"]).toBe(false);
				expect(step.run ?? "").not.toMatch(/\$\{\{\s*inputs\./);
			}
		}
		expect(JSON.stringify(release)).not.toContain("secrets: inherit");
		expect(JSON.stringify(release)).not.toContain("--clobber");
		expect(JSON.stringify(release)).not.toContain("git push");
	});
	test("reuses complete CI on the frozen target, not merely a main check status", () => {
		expect(release.jobs.verify?.uses).toBe("./.github/workflows/ci.yml");
		expect(release.jobs.verify?.with?.["checkout-ref"]).toBe(
			expression("needs.preflight.outputs.commit"),
		);
		expect(ci.on.workflow_call?.inputs?.["checkout-ref"]).toMatchObject({
			required: true,
			type: "string",
		});
		for (const job of ["static-checks", "build", "tests"]) {
			const steps = ci.jobs[job]?.steps ?? [];
			const validate = steps.find((step) => step.name === "Validate checkout reference");
			const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
			expect(checkout?.with?.ref).toBe(expression("inputs.checkout-ref || github.sha"));
			expect(validate?.env?.SOURCE_REF).toBe(expression("inputs.checkout-ref"));
			for (const ref of [
				"",
				"a".repeat(40),
				"main",
				"a".repeat(39),
				"refs/tags/v0.9.0",
				"$(touch unsafe)",
				"a\n",
			]) {
				const result = spawnSync("bash", ["-e", "-c", validate?.run ?? "exit 99"], {
					env: { ...process.env, SOURCE_REF: ref },
					timeout: 5000,
					maxBuffer: 16384,
				});
				expect(result.status).toBe(ref === "" || ref === "a".repeat(40) ? 0 : 1);
			}
		}
		expect(ci.concurrency.group).toContain("release-call");
		expect(ci.concurrency.group).toContain("standalone");
	});
	test("build and native smoke both cover the same complete eight-target matrix", () => {
		const matrix = releaseMatrix(plan);
		expect(matrix.include).toHaveLength(8);
		expect(new Set(matrix.include.map((entry) => entry.target)).size).toBe(8);
		expect(
			matrix.include.every((entry) => entry.binary === `narrafork-${plan.version}-${entry.suffix}`),
		).toBe(true);
		for (const name of ["build", "smoke"]) {
			expect(release.jobs[name]?.strategy).toEqual({
				"fail-fast": false,
				matrix: expression("fromJSON(needs.preflight.outputs.matrix)"),
			});
		}
		expect(
			release.jobs.build?.steps?.find((step) => step.name === "Strict target build")?.run,
		).toContain("--release-ci");
		const smoke = release.jobs.smoke?.steps?.find(
			(step) => step.name === "Run the downloaded binary on its native platform",
		);
		expect(smoke?.run).toContain("smoke-release-binary.ts");
		expect(smoke?.run).not.toContain("build-cross-platform");
	});
	test("Node 24 artifact consumption requires both complete platform files before smoke", async () => {
		for (const job of Object.values(release.jobs))
			for (const step of job.steps ?? [])
				if (step.uses?.startsWith("actions/download-artifact@"))
					expect(step.uses).toBe(
						"actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
					);
		const steps = release.jobs.smoke?.steps ?? [];
		const downloadIndex = steps.findIndex((step) =>
			step.uses?.startsWith("actions/download-artifact@"),
		);
		const checkIndex = steps.findIndex(
			(step) => step.name === "Verify complete downloaded platform inputs",
		);
		const smokeIndex = steps.findIndex(
			(step) => step.name === "Run the downloaded binary on its native platform",
		);
		expect(downloadIndex).toBeGreaterThanOrEqual(0);
		expect(checkIndex).toBeGreaterThan(downloadIndex);
		expect(smokeIndex).toBeGreaterThan(checkIndex);
		expect(steps[downloadIndex]?.with?.["digest-mismatch"]).toBe("error");
		const directory = await mkdtemp(join(tmpdir(), "nf-platform-inputs-"));
		temporary.push(directory);
		const platform = join(directory, ".ci-release", "platform");
		await mkdir(platform, { recursive: true });
		const name = "narrafork-0.9.0-macos-x64";
		const check = () =>
			spawnSync("bash", ["-e", "-c", steps[checkIndex]?.run ?? "exit 99"], {
				cwd: directory,
				env: { ...process.env, BINARY: name },
				timeout: 5_000,
				maxBuffer: 16_384,
			}).status;
		expect(check()).toBe(1);
		await writeFile(join(platform, name), "binary");
		expect(check()).toBe(1);
		await writeFile(join(platform, `${name}.metadata.json`), "");
		expect(check()).toBe(1);
		await writeFile(join(platform, `${name}.metadata.json`), "metadata");
		expect(check()).toBe(0);
	});
	test("artifact identity is attempt-scoped, and assembly does not overwrite flattened files", () => {
		for (const job of Object.values(release.jobs))
			for (const step of job.steps ?? []) {
				if (step.uses?.startsWith("actions/upload-artifact@")) {
					expect(step.with?.name).toContain(
						`${expression("github.run_id")}-${expression("github.run_attempt")}`,
					);
					expect(step.with?.overwrite).toBeUndefined();
					expect(step.with?.["if-no-files-found"]).toBe(
						step.name === "Preserve partial publication receipts" ? "ignore" : "error",
					);
				}
				if (step.uses?.startsWith("actions/download-artifact@"))
					expect(step.with?.["merge-multiple"]).toBeUndefined();
			}
		expect(
			release.jobs.restore?.steps?.find(
				(step) => step.name === "Verify original bundle or prepare read-only index repair",
			)?.run,
		).toContain("control.js restore");
		expect(
			release.jobs.publish?.steps?.find(
				(step) => step.name === "Publish verified release and index, or repair only the index",
			)?.run,
		).toContain("control.js publish");
		expect(release.jobs.publish?.if).toContain("!cancelled()");
		expect(release.jobs.gate?.if).toBe(expression("always()"));
	});
});

describe("release mode gate behavior", () => {
	test("a public release is not green until its verified index receipt exists", () => {
		const env = gateEnv(false, true);
		for (const key of ["INDEX_COMMIT", "INDEX_GENERATION"])
			for (const value of [undefined, "", "invalid", "0"]) {
				expect(() => assertReleaseGate({ ...env, [key]: value })).toThrow();
			}
	});
	test("index-only recovery has no build and still requires protected publication evidence", () => {
		expect(() => assertReleaseGate({ ...gateEnv(true, false), INDEX_ONLY: "true" })).not.toThrow();
		expect(() => assertReleaseGate({ ...gateEnv(true, true), INDEX_ONLY: "true" })).not.toThrow();
		expect(() => assertReleaseGate({ ...gateEnv(false, false), INDEX_ONLY: "true" })).toThrow();
	});
	for (const restore of [false, true])
		for (const publish of [false, true]) {
			test(`only accepts required successes and deliberately skipped jobs (${restore}, ${publish})`, () => {
				const env = gateEnv(restore, publish);
				expect(() => assertReleaseGate(env)).not.toThrow();
				for (const key of Object.keys(env).filter((name) => name.endsWith("_RESULT"))) {
					for (const result of [undefined, "failure", "cancelled", "skipped", "success", ""]) {
						if (result === env[key]) continue;
						expect(() => assertReleaseGate({ ...env, [key]: result })).toThrow();
					}
				}
				for (const flag of ["RESTORE_MODE", "PUBLISH_REQUESTED"])
					for (const value of [undefined, "", "yes"])
						expect(() => assertReleaseGate({ ...env, [flag]: value })).toThrow();
			});
		}
});

test("CLI rejects unknown commands, flags and duplicates rather than changing mode", () => {
	expect(parseCiReleaseArgs(["preflight", "--tag=v0.9.0", "--publish=false"])).toEqual({
		command: "preflight",
		values: { tag: "v0.9.0", publish: "false" },
	});
	for (const argv of [
		[],
		["release"],
		["publish", "--clobber=true"],
		["preflight", "--tag=a", "--tag=b"],
		["gate", "--publish=true"],
		["preflight", "v0.9.0"],
	])
		expect(() => parseCiReleaseArgs(argv)).toThrow();
});

test("matrix normalization accepts only the exact attempt's eight platform directories", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ci-release-matrix-"));
	temporary.push(dir);
	for (const { target } of CI_RELEASE_TARGETS)
		await mkdir(join(dir, `release-platform-${target}-45-2`));
	await normalizeMatrixArtifacts(dir, "platform", plan);
	expect((await readdir(dir)).sort()).toEqual(
		CI_RELEASE_TARGETS.map((entry) => entry.target).sort(),
	);
	await expect(normalizeMatrixArtifacts(dir, "platform", plan)).rejects.toThrow();
});

test("matrix normalization refuses missing, foreign-attempt and symlink directories", async () => {
	for (const scenario of ["missing", "attempt", "symlink"]) {
		const dir = await mkdtemp(join(tmpdir(), "ci-release-matrix-"));
		temporary.push(dir);
		for (const [index, { target }] of CI_RELEASE_TARGETS.entries()) {
			const path = join(dir, `release-platform-${target}-45-${scenario === "attempt" ? 1 : 2}`);
			if (index === 0 && scenario === "missing") continue;
			if (index === 0 && scenario === "symlink") await symlink(tmpdir(), path);
			else await mkdir(path);
		}
		await expect(normalizeMatrixArtifacts(dir, "platform", plan)).rejects.toThrow();
	}
});

function originalBuildPlan(single = false): CiReleasePlan {
	return {
		...plan,
		buildSource: {
			runId: 12,
			runAttempt: 3,
			workflowCommit: "a".repeat(40),
			controlArtifact: { id: 200, digest: `sha256:${"b".repeat(64)}`, size: 1000 },
			platforms: CI_RELEASE_TARGETS.slice(0, single ? 1 : undefined).map(({ target }, index) => ({
				target,
				artifact: { id: 201 + index, digest: `sha256:${"c".repeat(64)}`, size: 1000 },
			})),
		},
	};
}

describe("original build native re-verification", () => {
	test("selects one platform only for diagnostics and preserves the full default matrix", () => {
		expect(releaseMatrix(originalBuildPlan(true)).include.map(({ target }) => target)).toEqual([
			"linux-x64",
		]);
		expect(releaseMatrix(originalBuildPlan()).include).toEqual(releaseMatrix(plan).include);
		const values = {
			"build-run-id": "12",
			"build-run-attempt": "3",
			"smoke-target": "windows-x64",
			publish: "false",
		};
		expect(validateBuildRecoveryArgs(values)).toEqual({
			buildRunId: 12,
			buildRunAttempt: 3,
			smokeTarget: "windows-x64",
		});
		const invalidChanges: Record<string, string>[] = [
			{ "build-run-attempt": "" },
			{ "build-run-id": "" },
			{ "build-run-attempt": "0" },
			{ "build-run-id": "9007199254740992" },
			{ "source-run-id": "34" },
			{ "index-only": "true" },
			{ publish: "true" },
			{ "smoke-target": "windows-x86" },
		];
		for (const change of invalidChanges)
			expect(() => validateBuildRecoveryArgs({ ...values, ...change })).toThrow();
		expect(() => validateBuildRecoveryArgs({ "smoke-target": "windows-x64" })).toThrow();
		expect(validateBuildRecoveryArgs({})).toEqual({
			buildRunId: undefined,
			buildRunAttempt: undefined,
			smokeTarget: undefined,
		});
	});

	test("restores original bytes without installing or compiling a product in the restore job", () => {
		const job = release.jobs["restore-platform"];
		expect(job?.if).toContain("build-reuse-mode == 'true'");
		expect(job?.permissions).toEqual({ contents: "read", actions: "read" });
		expect(job?.["runs-on"]).toBe("ubuntu-24.04");
		expect(job?.strategy).toEqual({
			"fail-fast": false,
			matrix: expression("fromJSON(needs.preflight.outputs.matrix)"),
		});
		expect(JSON.stringify(job)).not.toMatch(/bun install|build-cross-platform|bun run build/);
		expect(
			job?.steps?.find(({ name }) => name === "Restore exact original platform bytes")?.run,
		).toContain("control.js restore-platform");
		for (const name of ["verify", "build"])
			expect(release.jobs[name]?.if).toContain("build-reuse-mode == 'false'");
		for (const name of ["smoke", "assemble", "publish"])
			expect(release.jobs[name]?.if).toContain("needs.restore-platform.result == 'success'");
		for (const name of ["assemble", "publish"])
			expect(release.jobs[name]?.if).toContain("smoke-only == 'false'");
		expect(release.jobs.gate?.needs).toContain("restore-platform");
	});

	for (const diagnostic of [false, true])
		for (const publish of diagnostic ? [false] : [false, true])
			test(`requires restore and native evidence without source CI or rebuilding (${diagnostic}, ${publish})`, () => {
				const env = {
					...gateEnv(false, publish),
					BUILD_REUSE_MODE: "true",
					SMOKE_ONLY: String(diagnostic),
					RESTORE_PLATFORMS_RESULT: "success",
					VERIFY_RESULT: "skipped",
					BUILD_RESULT: "skipped",
					ASSEMBLE_RESULT: diagnostic ? "skipped" : "success",
				};
				expect(() => assertReleaseGate(env)).not.toThrow();
				for (const key of Object.keys(env).filter((key) => key.endsWith("_RESULT")))
					for (const value of [undefined, "", "success", "skipped", "cancelled", "failure"])
						if (value !== env[key as keyof typeof env])
							expect(() => assertReleaseGate({ ...env, [key]: value })).toThrow();
				for (const key of ["BUILD_REUSE_MODE", "SMOKE_ONLY"])
					for (const value of [undefined, "", "yes"])
						expect(() => assertReleaseGate({ ...env, [key]: value })).toThrow();
				if (diagnostic)
					expect(() => assertReleaseGate({ ...env, PUBLISH_REQUESTED: "true" })).toThrow(
						"gate mode",
					);
				expect(() => assertReleaseGate({ ...env, RESTORE_MODE: "true" })).toThrow("gate mode");
			});
});

type ReleaseJobContext = { result: string; outputs: Record<string, string> };
function eligibleJob(
	name: string,
	needs: Record<string, ReleaseJobContext>,
	publish: boolean,
	cancelled = false,
): boolean {
	const job = release.jobs[name];
	if (!job?.if) throw new Error(`Missing explicit release condition: ${name}`);
	// GitHub implicitly requires successful dependencies unless a status function is present.
	if (
		!job.if.includes("always()") &&
		(cancelled || (job.needs ?? []).some((dependency) => needs[dependency]?.result !== "success"))
	)
		return false;
	const expression = job.if
		.trim()
		.slice(3, -2)
		.replace(/needs\.([a-z-]+)\.outputs\.([a-z-]+)/g, 'needs["$1"].outputs["$2"]')
		.replace(/needs\.([a-z-]+)\.result/g, 'needs["$1"].result');
	// Only checked-in boolean job expressions are evaluated, in a bounded sandbox with no I/O.
	return Boolean(
		runInNewContext(
			expression,
			{ needs, inputs: { publish }, always: () => true, cancelled: () => cancelled },
			{ timeout: 100 },
		),
	);
}

describe("release dependency graph conditions execute against each recovery mode", () => {
	function context(mode: "fresh" | "single" | "all" | "bundle") {
		const reuse = mode === "single" || mode === "all";
		const needs: Record<string, ReleaseJobContext> = {
			preflight: {
				result: "success",
				outputs: {
					"restore-mode": String(mode === "bundle"),
					"build-reuse-mode": String(reuse),
					"smoke-only": String(mode === "single"),
				},
			},
		};
		for (const [name, result] of Object.entries({
			verify: mode === "fresh" ? "success" : "skipped",
			build: mode === "fresh" ? "success" : "skipped",
			"restore-platform": reuse ? "success" : "skipped",
			smoke: mode === "bundle" ? "skipped" : "success",
			assemble: mode === "fresh" || mode === "all" ? "success" : "skipped",
			restore: mode === "bundle" ? "success" : "skipped",
			publish: "skipped",
		}))
			needs[name] = { result, outputs: {} };
		return needs;
	}
	test("declared remote restore participates only in raw-build recovery, not original full-bundle recovery", () => {
		for (const mode of ["fresh", "single", "all", "bundle"] as const) {
			const needs = context(mode);
			needs.preflight.outputs["remote-frontend"] = "true";
			needs["restore-remote-frontend"] = {
				result: mode === "all" ? "success" : "skipped",
				outputs: {},
			};
			expect(eligibleJob("restore-remote-frontend", needs, true)).toBe(mode === "all");
			expect(eligibleJob("publish", needs, true)).toBe(mode !== "single");
			if (mode === "all") {
				needs["restore-remote-frontend"].result = "failure";
				expect(eligibleJob("assemble", needs, true)).toBe(false);
				expect(eligibleJob("publish", needs, true)).toBe(false);
			}
		}
	});
	for (const mode of ["fresh", "single", "all", "bundle"] as const)
		test(`skipped job propagation and publisher eligibility are correct for ${mode}`, () => {
			const needs = context(mode);
			expect(eligibleJob("verify", needs, false)).toBe(mode === "fresh");
			expect(eligibleJob("build", needs, false)).toBe(mode === "fresh");
			expect(eligibleJob("restore-platform", needs, false)).toBe(
				mode === "single" || mode === "all",
			);
			expect(eligibleJob("smoke", needs, false)).toBe(mode !== "bundle");
			expect(eligibleJob("assemble", needs, false)).toBe(mode === "fresh" || mode === "all");
			expect(eligibleJob("restore", needs, false)).toBe(mode === "bundle");
			expect(eligibleJob("publish", needs, false)).toBe(false);
			expect(eligibleJob("publish", needs, true)).toBe(mode !== "single");
			expect(eligibleJob("publish", needs, true, true)).toBe(false);
			for (const result of ["failure", "cancelled", "skipped"])
				for (const dependency of mode === "fresh"
					? ["preflight", "verify", "build", "smoke", "assemble"]
					: mode === "all"
						? ["preflight", "restore-platform", "smoke", "assemble"]
						: mode === "bundle"
							? ["preflight", "restore"]
							: ["preflight", "restore-platform", "smoke"]) {
					const failed = { ...needs, [dependency]: { ...needs[dependency], result } };
					expect(eligibleJob("publish", failed, true)).toBe(false);
				}
		});
});
