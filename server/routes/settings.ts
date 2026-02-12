import { Hono } from "hono";
import { loadSettings, type NarraForkSettings, saveSettings } from "../lib/settings";

export const settingsRoutes = new Hono();

settingsRoutes.get("/", (c) => {
	return c.json(loadSettings());
});

settingsRoutes.patch("/", async (c) => {
	const body = await c.req.json();
	const current = loadSettings();
	// Deep merge: iterate top-level keys
	const merged = { ...current } as NarraForkSettings;
	for (const key of Object.keys(body) as Array<keyof NarraForkSettings>) {
		if (body[key] && typeof body[key] === "object" && !Array.isArray(body[key])) {
			(merged as any)[key] = { ...(current as any)[key], ...body[key] };
		} else {
			(merged as any)[key] = body[key];
		}
	}
	saveSettings(merged);
	return c.json(merged);
});
