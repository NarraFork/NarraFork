import type { ErrorMessageCode, ErrorMessageParams } from "@shared/error-catalog";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { workerFailureDetails } from "./failure";

/** Stable, content-free infrastructure errors shared by the pool and its worker. */
export class DbReadError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "DbReadError";
	}
}
export interface SerializedReadError {
	code?: string;
	message: string;
	statusCode?: number;
	errorType?: "AppError" | "NotFoundError" | "ValidationError" | "ForbiddenError";
	messageCode?: ErrorMessageCode;
	messageParams?: ErrorMessageParams;
}
export function readAborted(): DbReadError {
	return new DbReadError("DB_READ_ABORTED", "database read task aborted");
}
function businessEnvelope(error: SerializedReadError): boolean {
	return (
		Number.isInteger(error.statusCode) &&
		(error.statusCode ?? 0) >= 400 &&
		(error.statusCode ?? 0) < 500 &&
		typeof error.code === "string" &&
		/^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) &&
		typeof error.message === "string" &&
		Buffer.byteLength(error.message) <= 4096
	);
}
export function workerFailure(error: unknown): SerializedReadError {
	if (error instanceof DbReadError) return { code: error.code, message: error.message };
	if (error instanceof AppError && businessEnvelope(error)) {
		return {
			code: error.code,
			message: error.message,
			statusCode: error.statusCode,
			errorType:
				error instanceof NotFoundError
					? "NotFoundError"
					: error instanceof ValidationError
						? "ValidationError"
						: error instanceof ForbiddenError
							? "ForbiddenError"
							: "AppError",
			...(error.messageCode
				? { messageCode: error.messageCode, messageParams: error.messageParams }
				: {}),
		};
	}
	const { code } = workerFailureDetails(error, false);
	if (code?.startsWith("SQLITE_")) return { code, message: "database read worker query failed" };
	const message = error instanceof Error ? error.message : "";
	if (message === "Invalid or oversized read query") return { code: "DB_READ_INVALID", message };
	if (/^Read query exceeded its (row|byte) budget$/.test(message))
		return { code: "DB_READ_BUDGET", message };
	return { code: "DB_READ_FAILED", message: "database read worker query failed" };
}
/** Reconstruct only the allowlisted business envelope, never a remote stack or constructor. */
export function errorFromWorkerFailure(error: SerializedReadError): Error {
	if (businessEnvelope(error)) {
		const restored = new AppError(
			error.message,
			error.statusCode,
			error.code,
			error.messageCode
				? { messageCode: error.messageCode, messageParams: error.messageParams }
				: undefined,
		);
		if (
			error.errorType === "NotFoundError" &&
			error.statusCode === 404 &&
			error.code === "NOT_FOUND"
		)
			Object.setPrototypeOf(restored, NotFoundError.prototype);
		else if (error.errorType === "ValidationError" && error.statusCode === 400)
			Object.setPrototypeOf(restored, ValidationError.prototype);
		else if (
			error.errorType === "ForbiddenError" &&
			error.statusCode === 403 &&
			error.code === "FORBIDDEN"
		)
			Object.setPrototypeOf(restored, ForbiddenError.prototype);
		return restored;
	}
	if (typeof error.code === "string" && /^DB_READ_[A-Z0-9_]{1,112}$/.test(error.code))
		return new DbReadError(error.code, error.message);
	return Object.assign(new Error(error.message), { code: error.code });
}
