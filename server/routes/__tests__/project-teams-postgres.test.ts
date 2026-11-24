/**
 * On PostgreSQL every team route answers 503 POSTGRES_UNSUPPORTED before any access check: the
 * team rides on the narrator surface, which is SQLite-only today, like the project mutations.
 * The project and team ids below do not exist, so a route that got as far as an access check
 * would answer 404 instead.
 */
import { afterAll, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, activeDatabaseBackend: "postgres" }));
const { AppError } = await import("../../lib/errors");
const { projectTeamRoutes } = await import("../project-teams");

afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.restore();
});

const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "pg-user", role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
	await next();
});
app.onError((error) =>
	error instanceof AppError
		? Response.json({ code: error.code }, { status: error.statusCode })
		: Response.json({ error: String(error) }, { status: 500 }),
);
app.route("/projects", projectTeamRoutes);

test("every team route is refused with 503 on PostgreSQL", async () => {
	const cases: Array<[string, string, unknown?]> = [
		["GET", "/projects/p1/teams"],
		["POST", "/projects/p1/teams", { name: "Team" }],
		["GET", "/projects/p1/teams/t1"],
		["PATCH", "/projects/p1/teams/t1", { brief: "x" }],
		["POST", "/projects/p1/teams/t1/archive"],
		["POST", "/projects/p1/teams/t1/unarchive"],
		["GET", "/projects/p1/teams/t1/summary"],
		["GET", "/projects/p1/teams/t1/board?column=queued"],
		["GET", "/projects/p1/teams/t1/events"],
		["GET", "/projects/p1/teams/t1/approvals"],
		["GET", "/projects/p1/teams/t1/running"],
		["GET", "/projects/p1/teams/t1/members"],
	];
	for (const [method, path, body] of cases) {
		const response = await app.request(`http://localhost${path}`, {
			method,
			...(body === undefined
				? {}
				: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		});
		expect({ method, path, status: response.status }).toEqual({ method, path, status: 503 });
		expect(((await response.json()) as { code: string }).code).toBe("POSTGRES_UNSUPPORTED");
	}
});
