import { describe, expect, test } from "bun:test";
import { resolvePermissionDecision } from "@server/services/narrator-permission";
import { genUiParameters, genUiTool } from "./tools/gen-ui";
import type { AgentConfig } from "./types";

const cwd = "/project";
const path = `${cwd}/.narrafork/gen_ui/demo-abc123/App.tsx`;

function resolveTarget(input: Record<string, unknown>, overrides: Partial<AgentConfig> = {}) {
	const routing = genUiTool.executionRouting;
	if (routing?.kind !== "single") throw new Error("GenUI must use ordinary file routing");
	return routing.resolve(input, { cwd, ...overrides } as AgentConfig);
}

describe("GenUI file execution routing", () => {
	test("create and show both use the normal file endpoint with write/read operations", () => {
		expect(resolveTarget({ action: "create", prefix: "demo" })).toMatchObject({
			key: "primary",
			operation: "write",
			path: `${cwd}/.narrafork/gen_ui`,
			deviceId: "local",
		});
		expect(resolveTarget({ action: "show", path })).toMatchObject({
			key: "primary",
			operation: "read",
			path,
			deviceId: "local",
		});
	});

	test("create uses the current worktree root and retains its remote device", () => {
		const workspaceContext = {
			revision: 1,
			deviceId: "remote-device",
			cwd: "/project/worktree/nested",
			contextKey: "workspace-test",
			pathFlavor: "posix" as const,
			git: {
				workspaceKey: "worktree",
				repositoryKey: "repository",
				rootPath: "/project/worktree",
			},
			capabilities: { switchDirectory: true },
		};
		expect(resolveTarget({ action: "create", prefix: "demo" }, { workspaceContext })).toMatchObject(
			{
				operation: "write",
				path: "/project/worktree/.narrafork/gen_ui",
				deviceId: "remote-device",
				workdir: workspaceContext.cwd,
			},
		);
		expect(resolveTarget({ action: "show", path }, { workspaceContext })).toMatchObject({
			operation: "read",
			deviceId: "remote-device",
		});
	});

	test("inspection is an execution/write operation, not an exempt UI read", () => {
		const input = { action: "inspect", toolUseId: "use", toolCallId: "call" };
		expect(resolveTarget(input)).toMatchObject({ operation: "write", deviceId: "local" });
		for (const ceiling of [
			{ permMode: "readOnly" },
			{ permMode: "bypassPermissions", planMode: true, relaxedPlan: true },
			{ permMode: "bypassPermissions", reviewReadOnlyBash: true },
		]) {
			expect(resolvePermissionDecision({ toolName: "GenUI", input, cwd, ...ceiling })).toBe("deny");
		}
		expect(resolvePermissionDecision({ toolName: "GenUI", input, cwd, permMode: "default" })).toBe(
			"ask",
		);
	});

	test("removed actions and project-kit parameters are rejected", () => {
		for (const action of ["prepare", "catalog", "read", "list", "edit", "archive"]) {
			expect(genUiParameters.safeParse({ action }).success).toBe(false);
		}
		expect(
			genUiParameters.safeParse({ action: "create", prefix: "demo", config: {} }).success,
		).toBe(false);
	});

	test("create cannot bypass read-only, relaxed planning, or review ceilings", () => {
		for (const ceiling of [
			{ permMode: "readOnly" },
			{ permMode: "bypassPermissions", planMode: true, relaxedPlan: true },
			{ permMode: "bypassPermissions", reviewReadOnlyBash: true },
		]) {
			expect(
				resolvePermissionDecision({
					toolName: "GenUI",
					input: { action: "create", prefix: "demo" },
					cwd,
					...ceiling,
				}),
			).toBe("deny");
		}
	});

	test("show follows ordinary read policy; create follows ordinary file-write policy", () => {
		for (const permMode of ["readOnly", "default", "acceptEdits"]) {
			expect(
				resolvePermissionDecision({
					toolName: "GenUI",
					input: { action: "show", path },
					cwd,
					permMode,
				}),
			).toBe("allow");
		}
		for (const [permMode, expected] of [
			["default", "ask"],
			["acceptEdits", "allow"],
		] as const) {
			expect(
				resolvePermissionDecision({
					toolName: "GenUI",
					input: { action: "create", prefix: "demo" },
					cwd,
					permMode,
				}),
			).toBe(expected);
		}
	});

	test("show never bypasses directory denials or read-only external paths", () => {
		expect(
			resolvePermissionDecision({
				toolName: "GenUI",
				input: { action: "show", path },
				cwd,
				permMode: "bypassPermissions",
				blacklistDirs: [{ path: `${cwd}/.narrafork/gen_ui`, denyLevel: "denyAll", enabled: true }],
			}),
		).toBe("deny");
		expect(
			resolvePermissionDecision({
				toolName: "GenUI",
				input: { action: "show", path: "/outside/App.tsx" },
				cwd,
				permMode: "readOnly",
			}),
		).toBe("deny");
	});
});
