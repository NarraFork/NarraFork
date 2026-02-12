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
