import type { Context } from "hono";
import { AppError, RateLimitError } from "./errors";

/** Serialize known application errors consistently for the global Hono handler. */
export function buildAppErrorResponse(error: unknown, c: Context): Response | null {
	if (error instanceof RateLimitError) {
		c.header("Retry-After", String(error.retryAfterSeconds));
		return c.json(
			{
				error: error.message,
				code: error.code,
				retryAfterSeconds: error.retryAfterSeconds,
			},
			429,
		);
	}
	if (error instanceof AppError) {
		// biome-ignore lint/suspicious/noExplicitAny: Hono requires a literal status union
		return c.json({ error: error.message, code: error.code }, error.statusCode as any);
	}
	return null;
}
