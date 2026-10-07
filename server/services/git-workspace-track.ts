import type { WorkspaceContext } from "@shared/workspace-context";
import type { ToolExecutionTarget } from "../lib/agent/types";
import { gitDiscoveryCache } from "./git-discovery-cache";
import type { GitStatusSummary } from "./git-service";
import { getStatusSummaryCached, invalidateStatus } from "./git-status-cache";
import { authorizeGitTargetForPrincipal } from "./git-workspace-access";
import type { NarratorPrincipal } from "./narrator-acl";
import { createRemoteGitService } from "./remote-git-service";

/** A completed tool's admitted endpoint, not the active narrator's later cwd/default device. */
export async function getAdmittedGitTrackingSnapshot(input: {
	narratorId: string;
	principal: NarratorPrincipal;
	endpoint: ToolExecutionTarget;
	workspaceContext: WorkspaceContext;
	/** Only Git-init/explicit discovery-changing operations invalidate discovery. */
	refreshDiscovery?: boolean;
	signal?: AbortSignal;
}) {
	const { endpoint, workspaceContext: frozen } = input;
	// Explicit temporary overrides cannot publish facts under the resident workspace's badge.
	if (endpoint.deviceId !== frozen.deviceId) return null;
	if (input.refreshDiscovery) {
		gitDiscoveryCache.invalidate(frozen.deviceId, frozen.cwd);
	}
	const signal = AbortSignal.any([
		input.signal ?? new AbortController().signal,
		AbortSignal.timeout(10_000),
	]);
	const target = await authorizeGitTargetForPrincipal(
		input.principal,
		{ narratorId: input.narratorId },
		"read",
		signal,
		true,
	);
	const current = target.workspaceContext;
	if (
		!current ||
		current.contextKey !== frozen.contextKey ||
		current.revision !== frozen.revision ||
		target.workspace.deviceId !== endpoint.deviceId ||
		(endpoint.runtimeGeneration !== undefined &&
			endpoint.runtimeGeneration !== target.backend?.runtimeGeneration)
	)
		return null;
	const { backend, workspace } = target;
	if (!backend || backend.kind !== endpoint.backendKind) return null;
	if (workspace.state !== "ready" || !workspace.rootPath || !workspace.capabilities.read)
		return backend.paths.contains(frozen.cwd, endpoint.cwd) ? { workspace, status: null } : null;
	if (!backend.paths.contains(workspace.rootPath, endpoint.cwd)) return null;
	let status: GitStatusSummary;
	if (backend.kind === "remote") {
		status = await createRemoteGitService(backend, signal).getStatusSummary(workspace.rootPath);
	} else {
		invalidateStatus(workspace.rootPath);
		status = await getStatusSummaryCached(workspace.rootPath, { ttlMs: 0 });
	}
	// Keep this helper free of broadcasting: the caller suppresses late pushes after a switch.
	return { workspace, status };
}
