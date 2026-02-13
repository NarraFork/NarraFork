import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { users } from "../db/schema";
import { AppError } from "../lib/errors";
import { loadSettings, saveSettings } from "../lib/settings";
import { adminUpdateSettingsSchema } from "../lib/validators";
import { requireAdmin, requireAuth } from "../middleware/auth";

export const adminRoutes = new Hono();

adminRoutes.use("*", requireAuth, requireAdmin);

adminRoutes.get("/users", async (c) => {
	const allUsers = await db.query.users.findMany({
		columns: { id: true, username: true, role: true, createdAt: true },
	});
	return c.json(allUsers);
});

adminRoutes.delete("/users/:id", async (c) => {
	const id = c.req.param("id");
	const caller = c.get("user");

	if (id === caller.sub) {
		throw new AppError("Cannot delete your own account", 400, "SELF_DELETE");
	}

	const [deleted] = await db.delete(users).where(eq(users.id, id)).returning();
	if (!deleted) throw new AppError("User not found", 404, "NOT_FOUND");
	return c.json({ ok: true });
});

adminRoutes.patch("/settings", async (c) => {
	const parsed = adminUpdateSettingsSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new AppError(parsed.error.message, 400, "VALIDATION_ERROR");

	const current = loadSettings();
	current.auth.registrationOpen = parsed.data.registrationOpen;
	saveSettings(current);
	return c.json({ registrationOpen: current.auth.registrationOpen });
});
