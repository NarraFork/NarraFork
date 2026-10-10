import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertReleaseGate } from "../../scripts/ci-release";
import { assertHelperReleaseGate } from "../../scripts/lib/helper-release-control";
import { parseHelperReleaseArguments } from "../../scripts/release-helpers";

type Step = {
	name?: string;
	id?: string;
	if?: string;
	uses?: string;
	run?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
};
type Job = {
	if?: string;
	environment?: string;
	env?: Record<string, string>;
	concurrency?: { group: string; "cancel-in-progress": boolean };
	"timeout-minutes"?: number;
	steps: Step[];
	outputs?: Record<string, string>;
};
type Workflow = {
	concurrency: { group: string };
	on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> } };
	jobs: Record<string, Job>;
};
const load = (name: string) =>
	Bun.YAML.parse(
		readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
	) as Workflow;
const workflows = [
	{ workflow: load("release"), publisher: "publish" },
	{ workflow: load("helpers-release"), publisher: "publisher" },
];
const expression = (body: string) => `\${{ ${body} }}`;

describe("protected CI bridge wiring", () => {
	test("all three artifact kinds share the same static noncancelling publisher lock", () => {
		for (const { workflow, publisher } of workflows) {
			expect(workflow.jobs[publisher]?.concurrency).toEqual({
				group: "update-server-publish",
				"cancel-in-progress": false,
			});
			expect(workflow.concurrency.group).not.toBe("update-server-publish");
			expect(workflow.jobs[publisher]?.environment).toBe("release");
		}
	});
	for (const { workflow, publisher } of workflows)
		describe(publisher, () => {
			test("actual publisher condition rejects cancellation even with already-successful source jobs", () => {
				const condition = workflow.jobs[publisher]?.if?.trim();
				if (!condition?.startsWith("${{") || !condition.endsWith("}}"))
					throw new Error("Missing Actions expression");
				// Execute this repository-owned boolean expression against Actions contexts,
				// rather than merely asserting it contains a cancellation substring.
				const evaluate = new Function(
					"always",
					"cancelled",
					"inputs",
					"needs",
					`return (${condition.slice(3, -2).replaceAll("outputs.restore-mode", "outputs['restore-mode']")});`,
				) as (
					always: () => boolean,
					cancelled: () => boolean,
					inputs: { publish: boolean },
					needs: Record<string, { result: string; outputs?: Record<string, string> }>,
				) => boolean;
				for (const restoring of [false, true]) {
					const needs = {
						preflight: { result: "success", outputs: { "restore-mode": String(restoring) } },
						verify: { result: restoring ? "skipped" : "success" },
						build: { result: restoring ? "skipped" : "success" },
						smoke: { result: restoring ? "skipped" : "success" },
						assemble: { result: restoring ? "skipped" : "success" },
						restore: { result: restoring ? "success" : "skipped" },
					};
					expect(
						evaluate(
							() => true,
							() => false,
							{ publish: true },
							needs,
						),
					).toBe(true);
					expect(
						evaluate(
							() => true,
							() => true,
							{ publish: true },
							needs,
						),
					).toBe(false);
					expect(
						evaluate(
							() => true,
							() => false,
							{ publish: false },
							needs,
						),
					).toBe(false);
					const failed = { ...needs, [restoring ? "restore" : "assemble"]: { result: "failure" } };
					expect(
						evaluate(
							() => true,
							() => false,
							{ publish: true },
							failed,
						),
					).toBe(false);
				}
			});
			test("default dry runs cannot obtain legacy credentials", () => {
				expect(workflow.on.workflow_dispatch.inputs.publish?.default).toBe(false);
				expect(workflow.on.workflow_dispatch.inputs.mirror_only?.default).toBe(false);
				for (const [name, job] of Object.entries(workflow.jobs)) {
					if (name === publisher)
						expect(job.env).toEqual({
							NF_UPDATE_SERVER: expression("vars.NF_UPDATE_SERVER"),
							NF_UPDATE_TOKEN: expression("secrets.NF_UPDATE_TOKEN"),
						});
					else expect(JSON.stringify(job)).not.toMatch(/NF_UPDATE_TOKEN|NF_UPDATE_SERVER/);
					for (const step of job.steps ?? [])
						expect(step.run ?? "").not.toContain("NF_UPDATE_TOKEN");
				}
			});
			test("successful immutable upload is sequenced before the first GitHub publisher", () => {
				const steps = workflow.jobs[publisher]?.steps ?? [];
				const prepare = steps.findIndex(
					(step) => step.name === "Prepare immutable update server bridge",
				);
				const upload = steps.findIndex(
					(step) => step.name === "Seal immutable update server bridge artifact",
				);
				const publish = steps.findIndex((step) => /control.js publish/.test(step.run ?? ""));
				const mirror = steps.findIndex((step) => step.id === "mirror");
				expect(prepare).toBeGreaterThanOrEqual(0);
				expect(upload).toBeGreaterThan(prepare);
				expect(publish).toBeGreaterThan(upload);
				expect(mirror).toBeGreaterThan(publish);
				expect(steps[upload]?.with?.["if-no-files-found"]).toBe("error");
				expect(steps[upload]?.with?.overwrite).toBeUndefined();
				expect(steps[publish]?.env?.BRIDGE_ARTIFACT_ID).toBe(
					expression("steps.bridge-artifact.outputs.artifact-id"),
				);
				expect(steps[publish]?.env?.BRIDGE_ARTIFACT_DIGEST).toBe(
					expression("steps.bridge-artifact.outputs.artifact-digest"),
				);
			});
			test("mirror-only cannot execute prepare or GitHub publication; it restores both run identities", () => {
				const steps = workflow.jobs[publisher]?.steps ?? [];
				expect(steps.find((step) => step.id === "prepare-bridge")?.if).toContain(
					"!inputs.mirror_only",
				);
				expect(steps.find((step) => /control.js publish/.test(step.run ?? ""))?.if).toContain(
					"!inputs.mirror_only",
				);
				expect(steps.find((step) => step.id === "mirror")?.if).toContain("inputs.mirror_only");
				const preflight = JSON.stringify(workflow.jobs.preflight);
				expect(preflight).toContain("inputs.source_run_id");
				expect(preflight).toContain("inputs.bridge_run_id");
				expect(preflight).toContain("inputs.bridge_run_attempt");
			});
			test("partial receipts are retained without modifying the sealed artifact", () => {
				const steps = workflow.jobs[publisher]?.steps ?? [];
				const receipt = steps.find((step) => step.name === "Preserve partial publication receipts");
				expect(receipt?.if).toBe(expression("always()"));
				expect(receipt?.with?.["if-no-files-found"]).toBe("ignore");
				expect(String(receipt?.with?.path)).toContain("mirror-bridge/");
			});
			test("one shared absolute deadline is frozen before any publisher stage", () => {
				const job = workflow.jobs[publisher];
				expect(job?.["timeout-minutes"]).toBe(30);
				expect(job?.steps[0]?.run).toContain("NF_RELEASE_DEADLINE_MS");
				expect(job?.steps[0]?.run).toContain("25 * 60 * 1000");
				expect(job?.steps[0]?.run).toContain("$GITHUB_ENV");
				expect(
					job?.steps.filter((step) => /NF_RELEASE_DEADLINE_MS/.test(step.run ?? "")).length,
				).toBe(1);
			});
		});
});
function env(kind: "main" | "helpers", restore = false): NodeJS.ProcessEnv {
	return {
		PREFLIGHT_RESULT: "success",
		RESTORE_MODE: String(restore),
		SOURCE_RUN_ID: restore ? "11" : "",
		PUBLISH_REQUESTED: "true",
		VERIFY_RESULT: restore ? "skipped" : "success",
		BUILD_RESULT: restore ? "skipped" : "success",
		SMOKE_RESULT: restore ? "skipped" : "success",
		ASSEMBLE_RESULT: restore ? "skipped" : "success",
		RESTORE_RESULT: restore ? "success" : "skipped",
		PUBLISH_RESULT: "success",
		INDEX_ONLY: "false",
		MIRROR_ONLY: "false",
		MIRROR_REQUIRED: "false",
		MIRROR_STATUS: "",
		INDEX_COMMIT: kind === "main" ? "a".repeat(40) : "",
		INDEX_GENERATION: kind === "main" ? "1" : "",
	};
}
for (const kind of ["main", "helpers"] as const)
	describe(`${kind} real gate decisions`, () => {
		const gate = kind === "main" ? assertReleaseGate : assertHelperReleaseGate;
		test("GitHub-only succeeds without fabricated mirror receipt", () => {
			expect(() => gate(env(kind))).not.toThrow();
		});
		for (const status of [
			"",
			"PREPARED",
			"PUBLISHED",
			"INDEXED",
			"PUBLISHED_NOT_MIRRORED",
			"partial",
		])
			test(`configured mirror ${status || "missing"} fails`, () => {
				expect(() =>
					gate({ ...env(kind), MIRROR_REQUIRED: "true", MIRROR_STATUS: status }),
				).toThrow();
			});
		test("configured mirror succeeds only with verified MIRRORED status", () => {
			expect(() =>
				gate({ ...env(kind), MIRROR_REQUIRED: "true", MIRROR_STATUS: "MIRRORED" }),
			).not.toThrow();
		});
		test("mirror-only does not invent a fresh index commit and still requires mirror success", () => {
			const value = {
				...env(kind, true),
				MIRROR_ONLY: "true",
				MIRROR_REQUIRED: "true",
				MIRROR_STATUS: "MIRRORED",
				INDEX_COMMIT: "",
				INDEX_GENERATION: "",
			};
			expect(() => gate(value)).not.toThrow();
			expect(() => gate({ ...value, MIRROR_STATUS: "PUBLISHED_NOT_MIRRORED" })).toThrow();
		});
		for (const result of ["failure", "cancelled", "skipped"])
			test(`publisher ${result} never becomes success despite mirror output`, () => {
				expect(() =>
					gate({
						...env(kind),
						PUBLISH_RESULT: result,
						MIRROR_REQUIRED: "true",
						MIRROR_STATUS: "MIRRORED",
					}),
				).toThrow();
			});
		test("invalid mirror modes are rejected", () => {
			expect(() => gate({ ...env(kind), MIRROR_ONLY: "maybe" })).toThrow();
			expect(() => gate({ ...env(kind), MIRROR_REQUIRED: "maybe" })).toThrow();
		});
	});
describe("helper CLI mirror-only restrictions before any IO", () => {
	for (const args of [
		["--publish=false", "--mirror-only=true", "--source-run-id=11", "--bridge-run-id=22"],
		["--publish=true", "--mirror-only=true", "--source-run-id=11"],
		["--publish=true", "--mirror-only=true", "--source-run-id=-1", "--bridge-run-id=22"],
	])
		test(`rejects ${JSON.stringify(args)}`, () => {
			expect(() =>
				parseHelperReleaseArguments([
					"preflight",
					"--kind=helpers",
					"--tag=helpers-v1.0.0",
					...args,
				]),
			).toThrow();
		});
	test("accepts original source X with sealed publisher Y", () => {
		expect(
			parseHelperReleaseArguments([
				"preflight",
				"--kind=helpers",
				"--tag=helpers-v1.0.0",
				"--publish=true",
				"--mirror-only=true",
				"--source-run-id=11",
				"--bridge-run-id=22",
			]).options.get("bridge-run-id"),
		).toBe("22");
	});
});
