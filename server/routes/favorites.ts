import { and, eq, max } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { userFavoriteDirectories } from "../db/schema";
import { readQuery } from "../db/worker-read";
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
	const favorites = await readQuery(
		db.query.userFavoriteDirectories.findMany({
			where: eq(userFavoriteDirectories.userId, userId),
			orderBy: (f, { asc }) => [asc(f.sortOrder), asc(f.createdAt)],
		}),
		{ executionPolicy: "worker-required", signal: c.req.raw.signal },
	);
	return c.json(favorites);
});

// Add a favorite directory
favoriteRoutes.post("/", async (c) => {
	const userId = c.get("user").sub;
	const parsed = createFavoriteDirectorySchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const id = generateId();
	const now = new Date().toISOString();
	// Duplicate check, next position and insert decide together: two concurrent adds of
	// the same path must not both pass the check.
	const fav = db.transaction((tx) => {
		const existing = tx
			.select({ id: userFavoriteDirectories.id })
			.from(userFavoriteDirectories)
			.where(
				and(
					eq(userFavoriteDirectories.userId, userId),
					eq(userFavoriteDirectories.path, parsed.data.path),
				),
			)
			.limit(1)
			.get();
		if (existing) throw new ValidationError("Directory already in favorites");
		const maxOrder =
			tx
				.select({ value: max(userFavoriteDirectories.sortOrder) })
				.from(userFavoriteDirectories)
				.where(eq(userFavoriteDirectories.userId, userId))
				.get()?.value ?? -1;
		return tx
			.insert(userFavoriteDirectories)
			.values({
				id,
				userId,
				path: parsed.data.path,
				label: parsed.data.label ?? null,
				sortOrder: maxOrder + 1,
				createdAt: now,
			})
			.returning()
			.get();
	});

	return c.json(fav, 201);
});

// Update a favorite directory
favoriteRoutes.patch("/:id", async (c) => {
	const userId = c.get("user").sub;
	const id = c.req.param("id");
	const parsed = updateFavoriteDirectorySchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	// Ownership is part of the write predicate, so no separate read is needed.
	const updated = await db
		.update(userFavoriteDirectories)
		.set(parsed.data)
		.where(and(eq(userFavoriteDirectories.id, id), eq(userFavoriteDirectories.userId, userId)))
		.returning({ id: userFavoriteDirectories.id });
	if (!updated.length) throw new NotFoundError("Favorite directory", id);

	return c.json({ ok: true });
});

// Delete a favorite directory
favoriteRoutes.delete("/:id", async (c) => {
	const userId = c.get("user").sub;
	const id = c.req.param("id");

	const deleted = await db
		.delete(userFavoriteDirectories)
		.where(and(eq(userFavoriteDirectories.id, id), eq(userFavoriteDirectories.userId, userId)))
		.returning({ id: userFavoriteDirectories.id });
	if (!deleted.length) throw new NotFoundError("Favorite directory", id);

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
