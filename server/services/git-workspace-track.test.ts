import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { WorkspaceContext } from "@shared/workspace-context";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { posixPathSemantics } from "../lib/agent/execution/path-semantics";
import type { ToolExecutionTarget } from "../lib/agent/types";
import type { GitWorkspaceTarget } from "./git-workspace";

const frozen: WorkspaceContext = {
	revision: 2,
	deviceId: "remote",
	cwd: "/selected/repo/sub",
	pathFlavor: "posix",
	contextKey: "selected",
	capabilities: { switchDirectory: true },
};
let target: GitWorkspaceTarget;
const authorize = mock(async () => target);
const remoteStatus = mock(async (_root: string) => ({
	branch: "feature",
	files: [],
	totalFiles: 0,
}));
const hostStatus = mock(async () => {
	throw new Error("host Git must not run");
});
const invalidateDiscovery = mock((_device: string, _cwd: string) => {});
mock.module("./git-workspace-access", () => ({ authorizeGitTargetForPrincipal: authorize }));
mock.module("./remote-git-service", () => ({
	createRemoteGitService: () => ({ getStatusSummary: remoteStatus }),
}));
mock.module("./git-status-cache", () => ({
	getStatusSummaryCached: hostStatus,
	invalidateStatus: () => {},
}));
mock.module("./git-discovery-cache", () => ({
	gitDiscoveryCache: { invalidate: invalidateDiscovery },
}));
const { getAdmittedGitTrackingSnapshot } = await import("./git-workspace-track");
const endpoint: ToolExecutionTarget = {
	deviceId: "remote",
	backendKind: "remote",
	cwd: "/selected/repo/sub",
	runtimeGeneration: 4,
	pathFlavor: "posix",
	selectionSource: "session_default",
};
const input = () => ({
	narratorId: "n",
	principal: { userId: "actor", isAdmin: false },
	endpoint,
	workspaceContext: frozen,
});
beforeEach(() => {
	target = {
		workspaceContext: structuredClone(frozen),
		repositoryPath: "/selected/repo/.git",
		backend: {
			kind: "remote",
			deviceId: "remote",
			defaultCwd: "/default/decoy",
			paths: posixPathSemantics,
			runtimeGeneration: 4,
		} as ExecutionBackend,
		workspace: {
			deviceId: "remote",
			cwd: frozen.cwd,
			rootPath: "/selected/repo",
			workspaceKey: "selected-wk",
			repositoryKey: "common",
			state: "ready",
			capabilities: { read: true, write: true },
		},
	};
	authorize.mockClear();
	remoteStatus.mockClear();
	hostStatus.mockClear();
	invalidateDiscovery.mockClear();
});
describe("admitted Git live facts", () => {
	test("remote status uses selected repository; pushes reuse cached discovery", async () => {
		const snapshot = await getAdmittedGitTrackingSnapshot(input());
		expect(snapshot?.status?.branch).toBe("feature");
		expect(remoteStatus).toHaveBeenCalledWith("/selected/repo");
		expect(hostStatus).not.toHaveBeenCalled();
		expect(invalidateDiscovery).not.toHaveBeenCalled();
	});
	test("explicit device/directory, stale revision and reconnect cannot pollute the current badge", async () => {
		for (const override of [
			{ deviceId: "other" },
			{ cwd: "/other/repo" },
			{ runtimeGeneration: 3 },
		])
			expect(
				await getAdmittedGitTrackingSnapshot({
					...input(),
					endpoint: { ...endpoint, ...override },
				}),
			).toBeNull();
		target.workspaceContext = { ...frozen, contextKey: "switched", revision: 3 };
		expect(await getAdmittedGitTrackingSnapshot(input())).toBeNull();
		expect(remoteStatus).not.toHaveBeenCalled();
		expect(hostStatus).not.toHaveBeenCalled();
	});
	test("git init explicitly refreshes discovery once under the original endpoint", async () => {
		expect(
			(await getAdmittedGitTrackingSnapshot({ ...input(), refreshDiscovery: true }))?.workspace
				.state,
		).toBe("ready");
		expect(invalidateDiscovery).toHaveBeenCalledTimes(1);
		expect(invalidateDiscovery).toHaveBeenCalledWith("remote", frozen.cwd);
	});
	test("non-Git/offline facts never start local or remote status commands", async () => {
		for (const state of ["not_git", "device_offline"] as const) {
			target.workspace.state = state;
			expect((await getAdmittedGitTrackingSnapshot(input()))?.status).toBeNull();
		}
		expect(remoteStatus).not.toHaveBeenCalled();
		expect(hostStatus).not.toHaveBeenCalled();
	});
});
