import type { ErrorResponsePayload } from "@shared/error-catalog";
import type { Context } from "hono";
import {
	DATABASE_READ_RETRY_AFTER_SECONDS,
	isDatabaseReadUnavailable,
} from "./db-reader-readiness";
import { AppError, catalogError, RateLimitError } from "./errors";

/**
 * Build the localizable wire body for an `AppError`.
 *
 * `error` (rendered English) is always emitted, including for catalog-backed errors: it is the
 * fallback for a client that does not know the `messageCode` yet, the text behind the UI's
 * "show original" affordance, and the only field non-browser consumers read.
 */
export function toErrorPayload(error: AppError): ErrorResponsePayload {
	const payload: ErrorResponsePayload = { error: error.message, code: error.code };
	if (error.details) payload.details = error.details;
	if (error.messageCode) {
		payload.messageCode = error.messageCode;
		// Omitted when empty so a parameterless error does not ship `{}` on every response.
		if (error.messageParams && Object.keys(error.messageParams).length > 0) {
			payload.messageParams = error.messageParams;
		}
	}
	return payload;
}

/** Serialize known application errors consistently for the global Hono handler. */
export function buildAppErrorResponse(error: unknown, c: Context): Response | null {
	if (error instanceof RateLimitError) {
		c.header("Retry-After", String(error.retryAfterSeconds));
		return c.json({ ...toErrorPayload(error), retryAfterSeconds: error.retryAfterSeconds }, 429);
	}
	if (isDatabaseReadUnavailable(error)) {
		c.header("Retry-After", String(DATABASE_READ_RETRY_AFTER_SECONDS));
		return c.json(toErrorPayload(catalogError("DATABASE_READ_UNAVAILABLE")), 503);
	}
	if (error instanceof AppError) {
		// biome-ignore lint/suspicious/noExplicitAny: Hono requires a literal status union
		return c.json(toErrorPayload(error), error.statusCode as any);
	}
	return null;
}
