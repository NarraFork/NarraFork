export class AppError extends Error {
	constructor(
		message: string,
		public statusCode: number = 500,
		public code: string = "INTERNAL_ERROR",
	) {
		super(message);
	}
}

export class NotFoundError extends AppError {
	constructor(entity: string, id: string) {
		super(`${entity} not found: ${id}`, 404, "NOT_FOUND");
	}
}

export class ValidationError extends AppError {
	constructor(message: string) {
		super(message, 400, "VALIDATION_ERROR");
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
