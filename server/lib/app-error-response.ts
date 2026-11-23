import type { ErrorResponsePayload } from "@shared/error-catalog";
import type { Context } from "hono";
import {
	DATABASE_READ_RETRY_AFTER_SECONDS,
	isDatabaseReadUnavailable,
} from "./db-reader-readiness";
import { AppError, catalogError, RateLimitError } from "./errors";

// Only transient reader/admission failures are service unavailability. Invalid queries,
// SQL failures, budget violations and cancellation retain the generic safe error boundary.
const unavailableReadCodes = new Set([
	"DB_READ_UNAVAILABLE",
	"DB_READ_OVERLOADED",
	"DB_READ_TASK_OVERLOADED",
	"DB_READ_BUSY",
	"DB_READ_DATABASE_CLOSED",
	"DB_READ_WORKER_EXITED",
	"DB_READ_READER_EXIT_UNCONFIRMED",
	"DB_READ_TASK_TIMEOUT",
]);

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

/** Share the infrastructure-only classification and safe payload across HTTP and WS upgrades. */
export function toDatabaseReadUnavailablePayload(error: unknown): ErrorResponsePayload | null {
	try {
		if (
			!(error instanceof AppError) &&
			error instanceof Error &&
			"code" in error &&
			typeof error.code === "string" &&
			unavailableReadCodes.has(error.code)
		) {
			// Readers can report plain Error instances reconstructed from worker messages.
			// Match only stable codes; never serialize their message, reason, SQL or binds.
			return { ...toErrorPayload(catalogError("DATABASE_READ_UNAVAILABLE")), code: error.code };
		}
	} catch {
		return null;
	}
	return null;
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
	const unavailablePayload = toDatabaseReadUnavailablePayload(error);
	if (unavailablePayload) {
		c.header("Retry-After", String(DATABASE_READ_RETRY_AFTER_SECONDS));
		return c.json(unavailablePayload, 503);
	}
	return null;
}
