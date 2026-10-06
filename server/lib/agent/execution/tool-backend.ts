/**
 * Helper for tools to resolve their execution backend from a ToolContext.
 *
 * Normal agent-loop execution injects a resolver that also enforces the frozen
 * target. Bare/legacy callers still go through the canonical registry: local is
 * selected only when no target is configured or it is explicitly requested.
 * Unknown/offline remote targets must never degrade into local execution.
 */
import type { ToolContext } from "../types";
import type { ExecutionBackend } from "./backend";
import { resolveBackend } from "./registry";

export function getToolBackend(ctx: ToolContext, device?: string): ExecutionBackend {
	if (ctx.resolveBackend) return ctx.resolveBackend(device);

	const frozenDevice = ctx.executionTarget?.deviceId;
	if (frozenDevice !== undefined) {
		if (device !== undefined && device !== frozenDevice) {
			throw new Error(
				`Tool attempted to change its frozen execution device from ` +
					`"${frozenDevice}" to "${device}".`,
			);
		}
		return resolveBackend({ requested: frozenDevice });
	}

	return resolveBackend({ requested: device, sessionDefault: ctx.defaultDeviceId });
}

/** True when the resolved backend is not the local server backend. */
export function isRemoteBackend(backend: ExecutionBackend): boolean {
	return backend.kind === "remote";
}
