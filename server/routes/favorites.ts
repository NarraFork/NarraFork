import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { userFavoriteDirectories } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import {
	createFavoriteDirectorySchema,
	reorderFavoriteDirectoriesSchema,
	updateFavoriteDirectorySchema,
} from "../lib/validators";

export const favoriteRoutes = new Hono();

// List current user's favorite directories
favoriteRoutes.get("/", async (c) => {
	const userId = c.get("user").sub;
	const favorites = await db.query.userFavoriteDirectories.findMany({
		where: eq(userFavoriteDirectories.userId, userId),
		orderBy: (f, { asc }) => [asc(f.sortOrder), asc(f.createdAt)],
	});
	return c.json(favorites);
});

// Add a favorite directory
favoriteRoutes.post("/", async (c) => {
	const userId = c.get("user").sub;
	const parsed = createFavoriteDirectorySchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const existing = await db.query.userFavoriteDirectories.findFirst({
		where: and(
			eq(userFavoriteDirectories.userId, userId),
			eq(userFavoriteDirectories.path, parsed.data.path),
		),
	});
	if (existing) throw new ValidationError("Directory already in favorites");

	const all = await db.query.userFavoriteDirectories.findMany({
		where: eq(userFavoriteDirectories.userId, userId),
	});
	const maxOrder = all.reduce((max, f) => Math.max(max, f.sortOrder), -1);

	const id = generateId();
	const now = new Date().toISOString();
	const [fav] = await db
		.insert(userFavoriteDirectories)
		.values({
			id,
			userId,
			path: parsed.data.path,
			label: parsed.data.label ?? null,
			sortOrder: maxOrder + 1,
			createdAt: now,
		})
		.returning();

	return c.json(fav, 201);
});

// Update a favorite directory
favoriteRoutes.patch("/:id", async (c) => {
	const userId = c.get("user").sub;
	const id = c.req.param("id");
	const parsed = updateFavoriteDirectorySchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const fav = await db.query.userFavoriteDirectories.findFirst({
		where: and(eq(userFavoriteDirectories.id, id), eq(userFavoriteDirectories.userId, userId)),
	});
	if (!fav) throw new NotFoundError("Favorite directory", id);

	await db
		.update(userFavoriteDirectories)
		.set(parsed.data)
		.where(eq(userFavoriteDirectories.id, id));

	return c.json({ ok: true });
});

// Delete a favorite directory
favoriteRoutes.delete("/:id", async (c) => {
	const userId = c.get("user").sub;
	const id = c.req.param("id");

	const fav = await db.query.userFavoriteDirectories.findFirst({
		where: and(eq(userFavoriteDirectories.id, id), eq(userFavoriteDirectories.userId, userId)),
	});
	if (!fav) throw new NotFoundError("Favorite directory", id);

	await db.delete(userFavoriteDirectories).where(eq(userFavoriteDirectories.id, id));

	return c.json({ ok: true });
});

// Reorder favorites (bulk update sortOrder)
favoriteRoutes.put("/reorder", async (c) => {
	const userId = c.get("user").sub;
	const parsed = reorderFavoriteDirectoriesSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	for (let i = 0; i < parsed.data.ids.length; i++) {
		await db
			.update(userFavoriteDirectories)
			.set({ sortOrder: i })
			.where(
				and(
					eq(userFavoriteDirectories.id, parsed.data.ids[i]),
					eq(userFavoriteDirectories.userId, userId),
				),
			);
	}

	return c.json({ ok: true });
});
