import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { users } from "../db/schema";
import { loginUser, registerUser } from "../lib/auth";
import { ValidationError } from "../lib/errors";
import { deleteAvatarImage, saveAvatarImage } from "../lib/uploads";
import { loginSchema, registerSchema } from "../lib/validators";
import { requireAuth } from "../middleware/auth";

export const authRoutes = new Hono();

authRoutes.post("/register", async (c) => {
	const parsed = registerSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { user, token, language } = await registerUser(
		parsed.data.username,
		parsed.data.password,
		parsed.data.language,
	);
	return c.json({ user, token, language }, 201);
});

authRoutes.post("/login", async (c) => {
	const parsed = loginSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { user, token, language } = await loginUser(parsed.data.username, parsed.data.password);
	return c.json({ user, token, language });
});

authRoutes.get("/me", requireAuth, async (c) => {
	const payload = c.get("user");
	const user = await db.query.users.findFirst({
		where: eq(users.id, payload.sub),
		columns: {
			id: true,
			username: true,
			role: true,
			avatarColor: true,
			avatarImageId: true,
			createdAt: true,
		},
	});
	if (!user) return c.json({ error: "User not found" }, 404);
	return c.json(user);
});

authRoutes.patch("/me/avatar", requireAuth, async (c) => {
	const payload = c.get("user");
	const formData = await c.req.formData();
	const file = formData.get("file");
	if (!file || !(file instanceof File)) {
		throw new ValidationError("No file provided");
	}

	const { imageId } = await saveAvatarImage(payload.sub, file);
	await db.update(users).set({ avatarImageId: imageId }).where(eq(users.id, payload.sub));

	return c.json({ ok: true, avatarImageId: imageId });
});

authRoutes.delete("/me/avatar", requireAuth, async (c) => {
	const payload = c.get("user");
	deleteAvatarImage(payload.sub);
	await db.update(users).set({ avatarImageId: null }).where(eq(users.id, payload.sub));
	return c.json({ ok: true });
});
