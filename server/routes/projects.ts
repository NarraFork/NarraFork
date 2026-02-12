import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { chapters, projects, repositories } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { createProjectSchema, updateProjectSchema } from "../lib/validators";

export const projectRoutes = new Hono();

const validStatuses = ["active", "archived"] as const;

projectRoutes.get("/", async (c) => {
	const status = c.req.query("status");
	const where =
		status && validStatuses.includes(status as any)
			? eq(projects.status, status as (typeof validStatuses)[number])
			: undefined;
	const result = await db.query.projects.findMany({
		where,
		with: { repositories: true },
		orderBy: (projects, { desc }) => [desc(projects.updatedAt)],
	});
	return c.json(result);
});

projectRoutes.post("/", async (c) => {
	const parsed = createProjectSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const body = parsed.data;

	const now = new Date().toISOString();
	const projectId = generateId();

	const [project] = await db
		.insert(projects)
		.values({
			id: projectId,
			name: body.name,
			description: body.description,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	if (body.repositoryPath) {
		await db.insert(repositories).values({
			id: generateId(),
			projectId,
			path: body.repositoryPath,
			displayName: body.repositoryName ?? body.name,
			isPrimary: true,
			defaultBranch: body.defaultBranch ?? "main",
			createdAt: now,
			updatedAt: now,
		});
	}

	return c.json(project, 201);
});

projectRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, id),
		with: { repositories: true },
	});
	if (!project) throw new NotFoundError("Project", id);
	return c.json(project);
});

projectRoutes.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const parsed = updateProjectSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const body = parsed.data;

	const now = new Date().toISOString();
	const [updated] = await db
		.update(projects)
		.set({ ...body, updatedAt: now })
		.where(eq(projects.id, id))
		.returning();
	if (!updated) throw new NotFoundError("Project", id);
	return c.json(updated);
});

projectRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	await db.delete(chapters).where(eq(chapters.projectId, id));
	await db.delete(repositories).where(eq(repositories.projectId, id));
	await db.delete(projects).where(eq(projects.id, id));
	return c.json({ ok: true });
});
