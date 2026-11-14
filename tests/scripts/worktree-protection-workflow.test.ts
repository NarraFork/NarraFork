import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Step = {
	uses?: string;
	run?: string;
	if?: string;
	"continue-on-error"?: boolean;
	with?: Record<string, string>;
};
type Workflow = {
	on: { push: { paths: string[] }; pull_request: { paths: string[] } };
	permissions: { contents: string };
	jobs: Record<
		string,
		{
			"runs-on": string;
			"timeout-minutes": number;
			"continue-on-error"?: boolean;
			strategy: { "fail-fast": boolean; matrix: { os: string[] } };
			steps: Step[];
		}
	>;
};
const root = resolve(import.meta.dir, "../..");
const workflowPath = ".github/workflows/worktree-protection-lifecycle.yml";
const workflow = Bun.YAML.parse(readFileSync(join(root, workflowPath), "utf8")) as Workflow;
const lane = workflow.jobs.lifecycle;
const relatedTests = [
	"server/lib/platform-path.test.ts",
	"server/lib/agent/execution/__tests__/path-semantics.test.ts",
	"server/services/tree-snapshot-paths.test.ts",
	"server/services/resource-protection-index.test.ts",
	"server/services/resource-protection-production.test.ts",
	"server/services/narrator-worktree-resources.test.ts",
	"server/services/worktree-lifecycle-guard.test.ts",
	"server/services/worktree-lifecycle-guard.integration.test.ts",
	"server/services/worktree-tree-snapshot.test.ts",
	"server/services/snapshot-revert-tree.test.ts",
	"server/services/snapshot-capture-receipts.test.ts",
	"server/services/narrator-tree-snapshot-hooks.test.ts",
	"server/services/__tests__/subagent-tree-snapshot-hooks.test.ts",
	"server/services/__tests__/tool-edit-preview.test.ts",
	"server/lib/spawn-stream.test.ts",
	"server/lib/spawn-kill.test.ts",
	"tests/scripts/worktree-protection-workflow.test.ts",
];

describe("worktree protection lifecycle CI", () => {
	test("runs the same strict native regression on Linux, macOS, and Windows", () => {
		expect(lane.strategy.matrix.os).toEqual(["ubuntu-latest", "macos-latest", "windows-latest"]);
		expect(lane.strategy["fail-fast"]).toBe(false);
		expect(lane["runs-on"]).toBe("${{ matrix.os }}");
		expect(lane["timeout-minutes"]).toBe(20);
		expect(lane["continue-on-error"]).toBeUndefined();
		expect(workflow.permissions.contents).toBe("read");
	});

	test("keeps every related isolated test without retries or error suppression", () => {
		const step = lane.steps.find((entry) => entry.run?.startsWith("bun test"));
		expect(step).toBeDefined();
		expect(step?.if).toBeUndefined();
		expect(step?.["continue-on-error"]).toBeUndefined();
		const command = step?.run?.trim().split(/\s+/) ?? [];
		expect(command.slice(0, 3)).toEqual(["bun", "test", "--isolate"]);
		expect(command.slice(3)).toEqual(relatedTests);
		expect(step?.run).not.toMatch(/\|\|\s*(?:true|:)|exit\s+0|--retry|--test-name/);
		for (const path of relatedTests) expect(existsSync(join(root, path)), path).toBe(true);
	});

	test("every changed implementation and consuming test triggers its native lane", () => {
		for (const event of ["push", "pull_request"] as const) {
			for (const path of [
				workflowPath,
				"server/db/resource-protection-index.ts",
				"server/lib/agent/execution/path-semantics.ts",
				"server/lib/agent/execution/local-backend.ts",
				"server/lib/platform-path.ts",
				"server/lib/spawn.ts",
				"server/services/resource-protection-index.ts",
				"server/services/tree-snapshot-paths.ts",
				"server/services/worktree-lifecycle-guard.ts",
				"server/services/worktree-tree-snapshot.ts",
				"server/services/tool-edit-preview.ts",
				...relatedTests,
			]) {
				expect(
					workflow.on[event].paths.some((pattern) => new Bun.Glob(pattern).match(path)),
					`${event}: ${path}`,
				).toBe(true);
			}
		}
	});

	test("uses the repository Bun version and frozen dependency installation", () => {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const setup = lane.steps.find((step) => step.uses === "oven-sh/setup-bun@v2");
		expect(setup?.with?.["bun-version"]).toBe(pkg.packageManager.replace(/^bun@/, ""));
		expect(lane.steps.some((step) => step.run === "bun install --frozen-lockfile")).toBe(true);
		for (const step of lane.steps) expect(step["continue-on-error"]).toBeUndefined();
	});
});
