import { type Context, Hono } from "hono";
import type { JwtPayload } from "../lib/auth";
import { ValidationError } from "../lib/errors";
import { legacyMigrationArtifactIo } from "../services/legacy-migration-artifact-io";

// The parent app must mount this group behind requireAuth. Never accept actor DTOs.
function principalOf(c: Context) {
	const user = c.get("user") as JwtPayload | undefined;
	return { userId: user?.sub ?? "", isAdmin: user?.role === "admin" };
}
function pageLimit(value: string | undefined) {
	if (value === undefined) return 50;
	if (!/^[0-9]{1,3}$/.test(value)) throw new ValidationError("Invalid artifact page limit");
	return Number(value);
}
export function createLegacyMigrationArtifactRoutes(service = legacyMigrationArtifactIo) {
	const routes = new Hono();
	routes.get("/:id", async (c) =>
		c.json(await service.descriptor(c.req.param("id"), principalOf(c))),
	);
	routes.get("/:id/tree", async (c) =>
		c.json(
			await service.tree(
				c.req.param("id"),
				principalOf(c),
				c.req.query("sha") ?? "",
				c.req.query("path") ?? "",
				c.req.raw.signal,
			),
		),
	);
	routes.get("/:id/entries", async (c) =>
		c.json(
			await service.entries(
				c.req.param("id"),
				principalOf(c),
				c.req.query("cursor") ?? "0",
				pageLimit(c.req.query("limit")),
				c.req.raw.signal,
			),
		),
	);
	routes.get("/:id/file", async (c) =>
		c.json(
			await service.file(
				c.req.param("id"),
				principalOf(c),
				c.req.query("path") ?? "",
				c.req.raw.signal,
			),
		),
	);
	// No request-body target path is parsed, and this endpoint performs no writes.
	routes.post("/:id/restore-preview", async (c) =>
		c.json(await service.restorePreview(c.req.param("id"), principalOf(c), c.req.raw.signal)),
	);
	return routes;
}
export const legacyMigrationArtifactRoutes = createLegacyMigrationArtifactRoutes();
