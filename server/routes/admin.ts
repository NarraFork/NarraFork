import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { users } from "../db/schema";
import { AppError } from "../lib/errors";
import { loadSettings, saveSettings } from "../lib/settings";
import { adminUpdateSettingsSchema, adminUpdateUserSchema } from "../lib/validators";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { terminalService } from "../services/terminal-service";

export const adminRoutes = new Hono();

adminRoutes.use("*", requireAuth, requireAdmin);

adminRoutes.get("/users", async (c) => {
	const allUsers = await db.query.users.findMany({
		columns: { id: true, username: true, role: true, avatarColor: true, createdAt: true },
	});
	return c.json(allUsers);
});

adminRoutes.patch("/users/:id", async (c) => {
	const id = c.req.param("id");
	const parsed = adminUpdateUserSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new AppError(parsed.error.message, 400, "VALIDATION_ERROR");

	const { username, password } = parsed.data;
	if (!username && !password) {
		throw new AppError("At least one of username or password is required", 400, "VALIDATION_ERROR");
	}

	const updates: Record<string, string> = {};

	if (username) {
		const existing = await db.query.users.findFirst({
			where: eq(users.username, username),
		});
		if (existing && existing.id !== id) {
			throw new AppError("Username already taken", 409, "USERNAME_TAKEN");
		}
		updates.username = username;
	}

	if (password) {
		updates.passwordHash = await Bun.password.hash(password, {
			algorithm: "bcrypt",
			cost: 10,
		});
	}

	const [updated] = await db
		.update(users)
		.set(updates)
		.where(eq(users.id, id))
		.returning({ id: users.id, username: users.username, role: users.role });
	if (!updated) throw new AppError("User not found", 404, "NOT_FOUND");
	return c.json(updated);
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

// === Terminal Management ===

adminRoutes.get("/terminals", async (c) => {
	const terminals = await terminalService.listAll();
	const orphanSockets = terminalService.listOrphanSockets();
	const attachedSet = terminalService.getAttachedSet();
	// Annotate each terminal with whether it's currently attached + process info
	const annotated = terminals.map((t) => ({
		...t,
		attached: attachedSet.has(t.id),
		processes: t.status === "running" ? terminalService.getProcesses(t.id) : [],
	}));
	return c.json({ terminals: annotated, orphanSockets });
});

adminRoutes.delete("/terminals/:id", async (c) => {
	const id = c.req.param("id");
	await terminalService.kill(id);
	return c.json({ ok: true });
});

adminRoutes.post("/terminals/kill-orphan", async (c) => {
	const { terminalId } = await c.req.json();
	if (!terminalId || typeof terminalId !== "string") {
		throw new AppError("terminalId is required", 400, "VALIDATION_ERROR");
	}
	terminalService.killOrphanSocket(terminalId);
	return c.json({ ok: true });
});

adminRoutes.post("/terminals/:id/reattach", async (c) => {
	const id = c.req.param("id");
	const success = await terminalService.reattach(id);
	if (!success) {
		throw new AppError("Failed to reattach terminal", 400, "REATTACH_FAILED");
	}
	return c.json({ ok: true });
});

adminRoutes.post("/terminals/reattach-orphan", async (c) => {
	const { terminalId } = await c.req.json();
	if (!terminalId || typeof terminalId !== "string") {
		throw new AppError("terminalId is required", 400, "VALIDATION_ERROR");
	}
	const terminal = await terminalService.reattachOrphan(terminalId);
	return c.json(terminal);
});
