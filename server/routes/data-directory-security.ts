import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { db } from "../db";
import { users } from "../db/schema";
import { readQueryFirst } from "../db/worker-read";
import {
	inspectApplicationDataDirectory,
	publicDataDirectoryStatus,
	repairApplicationDataDirectory,
} from "../lib/data-directory-security";
import { ForbiddenError, ValidationError } from "../lib/errors";
import { getNarraforkHome } from "../lib/narrafork-home";
import { dataDirectoryRepairSchema } from "../lib/validators/settings";
import { requireAdmin, requireSessionAuth } from "../middleware/auth";

export const dataDirectorySecurityRoutes = new Hono();

// OS-level maintenance is a first-party session action, never an OAuth grant.
dataDirectorySecurityRoutes.use("*", requireSessionAuth);
dataDirectorySecurityRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	await next();
});

async function isCurrentAdmin(userId: string): Promise<boolean> {
	// Privileged filesystem changes must not trust a role retained in an older JWT.
	const user = await readQueryFirst(
		db.select({ role: users.role }).from(users).where(eq(users.id, userId)),
	);
	return user?.role === "admin";
}

dataDirectorySecurityRoutes.get("/", async (c) => {
	const status = await inspectApplicationDataDirectory(getNarraforkHome());
	return c.json(
		(await isCurrentAdmin(c.get("user").sub)) ? status : publicDataDirectoryStatus(status),
	);
});

dataDirectorySecurityRoutes.post(
	"/repair",
	requireAdmin,
	bodyLimit({
		maxSize: 1_024,
		onError: (c) =>
			c.json({ error: "Repair request is too large", code: "PAYLOAD_TOO_LARGE" }, 413),
	}),
	async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch (error) {
			if (error instanceof Error && error.name === "BodyLimitError")
				return c.json({ error: "Repair request is too large", code: "PAYLOAD_TOO_LARGE" }, 413);
			throw new ValidationError("Invalid repair confirmation");
		}
		if (!dataDirectoryRepairSchema.safeParse(body).success)
			throw new ValidationError(
				"Explicit repair confirmation is required; no path overrides are accepted",
			);
		const authorize = async () => {
			if (!(await isCurrentAdmin(c.get("user").sub))) throw new ForbiddenError();
		};
		await authorize();
		const status = await repairApplicationDataDirectory(getNarraforkHome(), authorize);
		await authorize(); // Do not leak filesystem diagnostics after a concurrent role downgrade.
		return c.json(status);
	},
);
