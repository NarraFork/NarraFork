export class AppError extends Error {
	constructor(
		message: string,
		public statusCode: number = 500,
		public code: string = "INTERNAL_ERROR",
	) {
		super(message);
	}
}

export class RateLimitError extends AppError {
	public readonly retryAfterSeconds: number;

	constructor(
		code: string,
		retryAfterMs: number,
		message: string = "Too many attempts. Please try again later.",
	) {
		super(message, 429, code);
		this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
	}
}

export class NotFoundError extends AppError {
	constructor(entity: string, id: string) {
		super(`${entity} not found: ${id}`, 404, "NOT_FOUND");
	}
}

export class ValidationError extends AppError {
	/**
	 * `code` may be narrowed past the generic `VALIDATION_ERROR` when a client has
	 * to REACT differently to one rejection than to the rest. Without a distinct
	 * code the only discriminator is the prose message, which is neither stable
	 * nor localizable.
	 */
	constructor(message: string, code: string = "VALIDATION_ERROR") {
		super(message, 400, code);
	}
}

/**
 * The caller is authenticated and the target exists, but this action is not
 * theirs to take. Distinct from `ValidationError` (400, "your input is wrong")
 * and `NotFoundError` (404, "pretend it isn't there"): a client can only offer
 * a sensible retry — or hide the affordance — if it can tell the three apart.
 */
export class ForbiddenError extends AppError {
	constructor(message: string = "You are not allowed to perform this action") {
		super(message, 403, "FORBIDDEN");
	}
}

export class PodmanNotFoundError extends AppError {
	constructor() {
		super("podman is not installed", 422, "PODMAN_NOT_FOUND");
	}
}

export class ContainerError extends AppError {
	constructor(message: string) {
		super(message, 502, "CONTAINER_ERROR");
	}
}

export class GitError extends AppError {
	constructor(message: string) {
		super(message, 422, "GIT_ERROR");
	}
}

export class GitAuthError extends AppError {
	constructor(message: string = "Git authentication required") {
		super(message, 401, "GIT_AUTH_REQUIRED");
	}
}

/** Convert a Zod error into a human-readable single-line message. */
export function formatZodError(error: {
	issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
	return error.issues
		.map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
		.join("; ");
}
