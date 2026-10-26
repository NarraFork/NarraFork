import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../app";
import { db } from "../../db";
import { users } from "../../db/schema";
import { createToken } from "../../lib/auth";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";

// A handler that surfaces its request's abort, as Git routes do when a client switches narrators.
app.get("/api/__client-abort-probe", (c) => {
	c.req.raw.signal.throwIfAborted();
	throw new Error("probe failure");
});

const userId = generateId();
let authorization = "";
beforeAll(async () => {
	db.insert(users)
		.values({
			id: userId,
			username: userId,
			passwordHash: "unused",
			createdAt: new Date().toISOString(),
		})
		.run();
	authorization = `Bearer ${await createToken(userId)}`;
});
afterAll(() => {
	db.delete(users).where(eq(users.id, userId)).run();
});

const errors = spyOn(logger, "error");
afterEach(() => errors.mockClear());

function probe(signal?: AbortSignal) {
	return app.request("http://localhost/api/__client-abort-probe", {
		headers: { authorization },
		signal,
	});
}

test("an abort from a client that went away is not logged as a server error", async () => {
	const controller = new AbortController();
	controller.abort();
	const response = await probe(controller.signal);
	expect(response.status).toBe(499);
	expect(errors).not.toHaveBeenCalled();
});

test("other failures still are", async () => {
	const response = await probe();
	expect(response.status).toBe(500);
	expect(errors).toHaveBeenCalledWith("Unhandled error", expect.anything());
});
