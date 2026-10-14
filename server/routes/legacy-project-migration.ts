import { Hono } from "hono";
import { z } from "zod";
import { ValidationError } from "../lib/errors";
import { projectPrincipalOf } from "../lib/project-access";
import { legacyProjectMigrationService } from "../services/legacy-project-migration";

const confirmSchema = z
	.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) })
	.strict();
export function createLegacyProjectMigrationRoutes(service = legacyProjectMigrationService) {
	const routes = new Hono();
	routes.get("/:id/legacy-migration/preview", async (c) =>
		c.json(await service.preview(c.req.param("id"), projectPrincipalOf(c))),
	);
	routes.post("/:id/legacy-migration", async (c) => {
		const parsed = confirmSchema.safeParse(
			await c.req.json().catch(() => {
				throw new ValidationError("Invalid migration confirmation JSON");
			}),
		);
		if (!parsed.success)
			throw new ValidationError("Migration requires confirm: true and a valid preview revision");
		const body = parsed.data;
		const result = await service.migrate(c.req.param("id"), projectPrincipalOf(c), body.revision);
		return c.json(
			result,
			result.phase === "cleanup_pending" ? 202 : result.phase === "blocked" ? 409 : 200,
		);
	});
	return routes;
}
export const legacyProjectMigrationRoutes = createLegacyProjectMigrationRoutes();
export const legacyChapterMigrationRoutes = new Hono();
legacyChapterMigrationRoutes.get("/:chapterId/target", async (c) =>
	c.json(
		await legacyProjectMigrationService.chapterTarget(
			c.req.param("chapterId"),
			projectPrincipalOf(c),
		),
	),
);
