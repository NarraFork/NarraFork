import { describe, expect, test } from "bun:test";
import { type WorktreeListResult, worktreeListPreview } from "../narrator-worktrees";
import { classifyToolDetail, type ToolMetaRow } from "./tool-detail";
import { projectToolIO } from "./tool-io-projection";

function detail(toolName: string, inputJson: unknown, outputJson?: unknown) {
	return classifyToolDetail({
		previewId: "workspace-test",
		toolName,
		category: "workspace",
		status: "success",
		inputJson,
		outputJson,
	});
}
function rows(value: ReturnType<typeof detail>): ToolMetaRow[] {
	return (
		value?.sections.flatMap((part) => (part.body.kind === "meta-rows" ? part.body.rows : [])) ?? []
	);
}

describe("workspace details", () => {
	test("creation shows resolved branch and path, not internal protocol or badges", () => {
		const value = detail(
			"Worktree",
			{
				action: "create",
				destinationPath: "/repo/new",
				branch: { kind: "new" },
				requestId: "secret",
			},
			JSON.stringify({
				outcome: "created",
				worktree: { path: "/repo/new", branch: "refs/heads/fix/new", head: "hash" },
				residuals: { branchExists: true },
			}),
		);
		expect(rows(value).map((row) => row.text)).toEqual(["Created", "fix/new · /repo/new"]);
		expect(value?.sections).toHaveLength(1);
		for (const row of rows(value)) {
			expect(row.badges).toBeUndefined();
			expect(row.actions).toBeUndefined();
		}
	});
	test("listing handles detached entries and truncation", () => {
		expect(
			rows(
				detail(
					"Worktree",
					{ action: "list" },
					{
						entries: [
							{ path: "/repo", branch: "refs/heads/main" },
							{ path: "/detached", detached: true },
						],
						truncated: true,
					},
				),
			).map((row) => row.text),
		).toEqual(["List worktrees", "main · /repo", "Detached HEAD · /detached", "List truncated"]);
		expect(rows(detail("Worktree", { action: "list" }, { entries: [] })).at(-1)?.text).toBe(
			"No worktrees",
		);
	});
	test("directory switch displays transition, hiding revision and workspace keys", () => {
		const value = detail(
			"SwitchWorkingDirectory",
			{ target: { cwd: "/new", deviceId: "local" } },
			{
				changed: true,
				previous: { cwd: "/old", revision: 0 },
				current: { cwd: "/new", revision: 1, contextKey: "private", deviceId: "local" },
			},
		);
		expect(rows(value).map((row) => row.text)).toEqual(["Switched", "/old → /new"]);
		expect(value?.sections).toHaveLength(1);
	});
	test("no-op switch and remote target", () => {
		expect(
			rows(
				detail(
					"SwitchWorkingDirectory",
					{},
					{ changed: false, current: { cwd: "/same", deviceId: "remote" } },
				),
			).map((row) => row.text),
		).toEqual(["Unchanged", "/same", "remote"]);
	});
	test("failed and uncertain creates never look successful and retain reason", () => {
		for (const outcome of ["failed", "unknown"]) {
			const value = detail(
				"Worktree",
				{ action: "create" },
				{ outcome, error: { code: "DENIED", message: "Not allowed" } },
			);
			expect(rows(value).at(-1)?.text).toBe("Not allowed");
			expect(rows(value)[0]?.text).toBe(outcome === "failed" ? "Failed" : "Outcome unknown");
		}
	});
	test("unrecognized outputs retain fallback and incomplete inputs do not crash", () => {
		for (const name of ["Worktree", "SwitchWorkingDirectory", "SwitchDevice"]) {
			const value = detail(name, null, "offline");
			expect(value?.sections.some((part) => part.key === "output.main")).toBe(true);
			expect(rows(value).length).toBeGreaterThan(0);
		}
	});
	test("localized text is part of measured detail data", () => {
		const value = classifyToolDetail({
			previewId: "workspace-localized",
			toolName: "Worktree",
			category: "workspace",
			inputJson: { action: "create" },
			outputJson: { outcome: "created", worktree: { path: "/new" } },
			labels: { workspaceCreated: "已创建" },
		});
		expect(rows(value)[0]?.text).toBe("已创建");
	});
});

function listResult(count: number): WorktreeListResult {
	return {
		repositoryKey: "repository",
		entries: Array.from({ length: count }, (_, index) => ({
			path: `/home/fulcrum/projects/narrafork/.worktrees/feature-worktree-${index}`,
			branch: `refs/heads/feature/branch-${index}`,
			head: "a".repeat(40),
			detached: false,
			locked: false,
			prunable: false,
		})),
		truncated: false,
		capabilities: {
			list: true,
			create: true,
			switch: false,
			delete: false,
			prune: false,
			remote: false,
		},
	};
}

for (const leafBudget of [2000, 8192]) {
	test(`structured list survives ${leafBudget}-char output projection`, () => {
		const result = listResult(60);
		const projected = projectToolIO(
			{
				_text: JSON.stringify(result),
				_metadata: { workspaceWorktrees: worktreeListPreview(result) },
			},
			{ leafBudget },
		) as Record<string, unknown>;
		const value = classifyToolDetail({
			previewId: "projected-list",
			toolName: "Worktree",
			category: "workspace",
			inputJson: { action: "list" },
			outputJson: projected,
			metadata: projected._metadata,
		});
		expect(value?.sections).toHaveLength(1);
		expect(rows(value)).toHaveLength(61);
		expect(rows(value).at(-1)?.text).toBe(`feature/branch-59 · ${result.entries[59]?.path}`);
	});
}

test("preview bounds row count and string sizes with an explicit truncation notice", () => {
	const result = listResult(201);
	const first = result.entries[0];
	if (!first) throw new Error("Missing list fixture");
	first.path = `/${"p".repeat(4000)}`;
	first.branch = `refs/heads/${"b".repeat(4000)}`;
	const preview = worktreeListPreview(result);
	expect(preview.entries).toHaveLength(100);
	expect(preview.entries[0]?.path).toHaveLength(1024);
	expect(preview.entries[0]?.branch).toHaveLength(256);
	expect(preview.truncated).toBe(true);
	const projected = projectToolIO({ workspaceWorktrees: preview }, { leafBudget: 2000 });
	expect(projected).toEqual({ workspaceWorktrees: preview });
	const value = classifyToolDetail({
		previewId: "bounded-list",
		toolName: "Worktree",
		category: "workspace",
		inputJson: { action: "list" },
		metadata: projected,
	});
	expect(rows(value).at(-1)?.text).toBe("List truncated");
});
