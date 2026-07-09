/**
 * Helper for tools to resolve their execution backend from a ToolContext.
 *
 * When `ctx.resolveBackend` is present (normal agent-loop execution) it is used
 * so the session default / per-call `device` parameter is honoured. When it is
 * absent (unit tests that construct a bare ToolContext, or any legacy caller)
 * we fall back to the local backend, preserving the previous behaviour exactly.
 */
import type { ToolContext } from "../types";
import type { ExecutionBackend } from "./backend";
import { localBackend } from "./local-backend";

export function getToolBackend(ctx: ToolContext, device?: string): ExecutionBackend {
	if (ctx.resolveBackend) return ctx.resolveBackend(device);
	return localBackend;
}

/** True when the resolved backend is not the local server backend. */
export function isRemoteBackend(backend: ExecutionBackend): boolean {
	return backend.kind === "remote";
}
