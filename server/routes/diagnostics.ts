import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { cpuProfiler, DEFAULT_CPU_PROFILE_DURATION_MS } from "../services/cpu-profiler";

export const diagnosticsRoutes = new Hono();

diagnosticsRoutes.post("/cpu-profile", async (c) => {
	c.header("Cache-Control", "no-store");
	const text = await c.req.text();
	let body: unknown = {};
	if (text.trim()) {
		try {
			body = JSON.parse(text);
		} catch {
			throw new ValidationError("Request body must be valid JSON");
		}
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new ValidationError("Request body must be a JSON object");
	}
	const durationMs =
		"durationMs" in body && body.durationMs !== undefined
			? body.durationMs
			: DEFAULT_CPU_PROFILE_DURATION_MS;
	if (typeof durationMs !== "number") {
		throw new ValidationError("durationMs must be a positive integer");
	}
	const profile = await cpuProfiler.capture(durationMs, c.req.raw.signal);
	c.header("Content-Disposition", `attachment; filename="cpu-${Date.now()}.cpuprofile"`);
	return c.json(profile);
});
