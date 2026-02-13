import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { users } from "../db/schema";
import { loginUser, registerUser } from "../lib/auth";
import { ValidationError } from "../lib/errors";
import { loginSchema, registerSchema } from "../lib/validators";
import { requireAuth } from "../middleware/auth";

export const authRoutes = new Hono();

authRoutes.post("/register", async (c) => {
	const parsed = registerSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { user, token } = await registerUser(parsed.data.username, parsed.data.password);
	return c.json({ user, token }, 201);
});

authRoutes.post("/login", async (c) => {
	const parsed = loginSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { user, token } = await loginUser(parsed.data.username, parsed.data.password);
	return c.json({ user, token });
});

authRoutes.get("/me", requireAuth, async (c) => {
	const payload = c.get("user");
	const user = await db.query.users.findFirst({
		where: eq(users.id, payload.sub),
		columns: { id: true, username: true, role: true, createdAt: true },
	});
	if (!user) return c.json({ error: "User not found" }, 404);
	return c.json(user);
});
