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
