import { Hono } from "hono";
import { AppError, ValidationError } from "../lib/errors";
import { cpuProfileSchema } from "../lib/validators/diagnostics";
import { requireAdmin, requireSessionAuth } from "../middleware/auth";
import { cpuProfiler } from "../services/cpu-profiler";

const MAX_BODY_BYTES = 1024;

function bodyTooLarge() {
	return new AppError("Request body too large", 413, "PAYLOAD_TOO_LARGE");
}

async function readBody(request: Request): Promise<unknown> {
	if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) throw bodyTooLarge();
	if (!request.body) return {};

	const reader = request.body.getReader();
	const bytes = new Uint8Array(MAX_BODY_BYTES);
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (size + value.byteLength > MAX_BODY_BYTES) {
				void reader.cancel().catch(() => {});
				throw bodyTooLarge();
			}
			bytes.set(value, size);
			size += value.byteLength;
		}
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
		return text.trim() ? JSON.parse(text) : {};
	} catch (error) {
		if (request.signal.aborted) throw new DOMException("Request aborted", "AbortError");
		if (error instanceof AppError) throw error;
		throw new ValidationError("Request body must be valid JSON");
	} finally {
		reader.releaseLock();
	}
}

export const diagnosticsRoutes = new Hono();

diagnosticsRoutes.post(
	"/cpu-profile",
	async (c, next) => {
		c.header("Cache-Control", "private, no-store");
		await next();
	},
	requireSessionAuth,
	requireAdmin,
	async (c) => {
		const input = cpuProfileSchema.safeParse(await readBody(c.req.raw));
		if (!input.success) throw new ValidationError("Invalid CPU profile options");

		const profile = await cpuProfiler.capture(input.data.durationMs, c.req.raw.signal);
		c.header("Content-Disposition", `attachment; filename="cpu-${Date.now()}.cpuprofile"`);
		return c.json(profile);
	},
);
