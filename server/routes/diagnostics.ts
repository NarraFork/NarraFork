import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ValidationError } from "../lib/errors";
import { requireAdmin } from "../middleware/auth";
import { cpuProfiler, DEFAULT_CPU_PROFILE_DURATION_MS } from "../services/cpu-profiler";

export const diagnosticsRoutes = new Hono();

function bodyTooLarge(c: Context) {
	return c.json({ error: "Request body exceeds the 1 KiB limit" }, 413, {
		"Cache-Control": "no-store",
	});
}

diagnosticsRoutes.post(
	"/cpu-profile",
	requireAdmin,
	bodyLimit({ maxSize: 1024, onError: bodyTooLarge }),
	async (c) => {
		c.header("Cache-Control", "no-store");
		let text: string;
		try {
			text = await c.req.text();
		} catch (error) {
			// Hono signals overflow without Content-Length through the body stream.
			if (error instanceof Error && error.name === "BodyLimitError") return bodyTooLarge(c);
			throw error;
		}
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
	},
);
