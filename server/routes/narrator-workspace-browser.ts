import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../lib/logger";
import { requireNarratorAccess } from "../lib/narrator-access";
import { browseWorkspaceDirectory } from "../services/workspace-browser-service";
import { workspaceContextService } from "../services/workspace-context-service";

const browseSchema = z
	.object({
		expectedRevision: z.coerce.number().int().nonnegative(),
		contextKey: z.string().min(1).max(8192),
		path: z.string().max(8192).optional(),
		showHidden: z
			.enum(["0", "1"])
			.default("0")
			.transform((v) => v === "1"),
		directoriesOnly: z
			.enum(["0", "1"])
			.default("0")
			.transform((v) => v === "1"),
	})
	.strict();

/** Mount after narrator read ACL; never exposed as the permission-rule browser. */
export const narratorWorkspaceBrowserRoutes = new Hono();
narratorWorkspaceBrowserRoutes.get("/:id/workspace-browser", async (c) => {
	await requireNarratorAccess(c, c.req.param("id"), "read");
	const input = browseSchema.parse(c.req.query());
	const started = performance.now();
	const result = await workspaceContextService.withRevision(
		c.req.param("id"),
		input.expectedRevision,
		undefined,
		(context) =>
			browseWorkspaceDirectory(c.req.param("id"), context, input, {
				userId: c.get("user").sub,
				signal: c.req.raw.signal,
			}),
	);
	// A grant revoked while a remote directory was in flight must hide the result.
	await requireNarratorAccess(c, c.req.param("id"), "read");
	const elapsedMs = Math.round(performance.now() - started);
	if (elapsedMs > 250 || result.truncated)
		logger.warn("Workspace browser slow or bounded listing", {
			narratorId: c.req.param("id"),
			deviceId: result.deviceId,
			revision: result.revision,
			elapsedMs,
			truncated: result.truncated,
			scanned: result.scanned,
			reason: result.reason,
		});
	return c.json(result);
});
