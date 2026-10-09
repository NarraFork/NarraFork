import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	assertReleaseGate,
	normalizeMatrixArtifacts,
	parseCiReleaseArgs,
	releaseMatrix,
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
			"index_only",
			"publish",
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
	test("artifact identity is attempt-scoped, and assembly does not overwrite flattened files", () => {
		for (const job of Object.values(release.jobs))
			for (const step of job.steps ?? []) {
				if (step.uses?.startsWith("actions/upload-artifact@")) {
					expect(step.with?.name).toContain(
						`${expression("github.run_id")}-${expression("github.run_attempt")}`,
					);
					expect(step.with?.overwrite).toBeUndefined();
					expect(step.with?.["if-no-files-found"]).toBe("error");
				}
				if (step.uses?.startsWith("actions/download-artifact@"))
					expect(step.with?.["merge-multiple"]).toBeUndefined();
			}
		expect(
			release.jobs.restore?.steps?.find(
				(step) => step.name === "Verify original bundle or prepare read-only index repair",
			)?.run,
		).toContain("control.js restore");
		expect(release.jobs.publish?.steps?.at(-1)?.run).toContain("control.js publish");
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
