import type { ExecutionBackend } from "@server/lib/agent/execution/backend";
import { targetPathSemantics } from "@server/lib/agent/execution/path-semantics";
import type { ToolExecutionTarget } from "@server/lib/agent/types";
import type { ExecutionTargetContext, OAuthRuleTargetGroup } from "../types";

export function executionContext(
	input: {
		deviceId?: string;
		kind?: "local" | "remote";
		pathFlavor?: "posix" | "windows";
		cwd?: string;
		deviceClass?: OAuthRuleTargetGroup | null;
		runtimeGeneration?: number;
	} = {},
): ExecutionTargetContext {
	const deviceId = input.deviceId ?? "local";
	const kind = input.kind ?? (deviceId === "local" ? "local" : "remote");
	const pathFlavor = input.pathFlavor ?? "posix";
	const paths = targetPathSemantics(pathFlavor);
	const cwd = input.cwd ?? (pathFlavor === "windows" ? "C:\\workspace" : "/workspace");
	const runtimeGeneration = input.runtimeGeneration ?? 0;
	const backend = {
		deviceId,
		kind,
		paths,
		pathFlavor,
		runtimeGeneration,
	} as ExecutionBackend;
	const target = Object.freeze({
		deviceId,
		backendKind: kind,
		cwd,
		pathFlavor,
		runtimeGeneration,
		selectionSource: deviceId === "local" ? "local_default" : "session_default",
	} satisfies ToolExecutionTarget);
	return Object.freeze({
		backend,
		target,
		paths,
		deviceClass: input.deviceClass ?? null,
	});
}
