import { Hono } from "hono";
import { getChangelogs } from "../lib/changelog";

const app = new Hono();

app.get("/", async (c) => {
	const changelogs = await getChangelogs();
	return c.json(changelogs);
});

export default app;
