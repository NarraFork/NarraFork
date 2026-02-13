import { describe, expect, it } from "bun:test";
import { AppError, NotFoundError, ValidationError } from "../../../server/lib/errors";

describe("AppError", () => {
	it("has default status 500 and code INTERNAL_ERROR", () => {
		const err = new AppError("boom");
		expect(err.message).toBe("boom");
		expect(err.statusCode).toBe(500);
		expect(err.code).toBe("INTERNAL_ERROR");
		expect(err).toBeInstanceOf(Error);
	});

	it("accepts custom status and code", () => {
		const err = new AppError("nope", 403, "FORBIDDEN");
		expect(err.statusCode).toBe(403);
		expect(err.code).toBe("FORBIDDEN");
	});
});

describe("NotFoundError", () => {
	it("formats entity and id in message", () => {
		const err = new NotFoundError("Chapter", "abc123");
		expect(err.message).toBe("Chapter not found: abc123");
		expect(err.statusCode).toBe(404);
		expect(err.code).toBe("NOT_FOUND");
		expect(err).toBeInstanceOf(AppError);
	});
});

describe("ValidationError", () => {
	it("has status 400", () => {
		const err = new ValidationError("bad input");
		expect(err.message).toBe("bad input");
		expect(err.statusCode).toBe(400);
		expect(err.code).toBe("VALIDATION_ERROR");
	});
});
