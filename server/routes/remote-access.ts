import { Hono } from "hono";
import { isRemoteIpcId } from "../../shared/remote-access/ipc";
import { ValidationError } from "../lib/errors";
import { requireAdmin } from "../middleware/auth";
import { remoteAccessRuntime } from "../services/remote-access-runtime";

/** Mounted only on the ordinary app; the RTC method/path policy excludes this prefix. */
export const remoteAccessRoutes = new Hono();
remoteAccessRoutes.use("*", requireAdmin);
remoteAccessRoutes.get("/status", async (c) => c.json(await remoteAccessRuntime.status()));
remoteAccessRoutes.post("/component/install", async (c) =>
	c.json(await remoteAccessRuntime.install()),
);
remoteAccessRoutes.post("/invitations", async (c) => {
	c.header("Cache-Control", "no-store");
	return c.json(await remoteAccessRuntime.command("pair.create"));
});
remoteAccessRoutes.delete("/invitations/:inviteId", async (c) => {
	const inviteId = c.req.param("inviteId");
	if (!isRemoteIpcId(inviteId)) throw new ValidationError("Invalid invitation ID");
	await remoteAccessRuntime.command("pair.cancel", { inviteId });
	return c.json({ ok: true });
});
remoteAccessRoutes.get("/grants", async (c) =>
	c.json(await remoteAccessRuntime.command("grants.list")),
);
remoteAccessRoutes.delete("/grants/:grantId", async (c) => {
	const grantId = c.req.param("grantId");
	if (!isRemoteIpcId(grantId)) throw new ValidationError("Invalid grant ID");
	await remoteAccessRuntime.command("grants.revoke", { grantId });
	return c.json({ ok: true });
});
