import { beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { AppError, NotFoundError } from "../lib/errors";

let writable = true;
let updating = false;
const release = mock(() => {});
const createTask = mock(async (input: { authorizeDispatch: () => Promise<void> }) => {
	await input.authorizeDispatch();
	return { id: "bash-1", alias: "preview" };
});
const createSession = mock(async (..._args: unknown[]) => ({ id: "browser-1" }));
mock.module("../lib/narrator-access", () => ({
	requireNarratorAccess: async (_ctx: unknown, id: string, need: string) => {
		if (!writable || id !== "owner" || need !== "write") throw new NotFoundError("Narrator", id);
	},
}));
mock.module("../services/manual-background-task", () => ({
	createManualBackgroundTask: createTask,
}));
mock.module("../services/update-coordinator", () => ({
	tryAcquireFinalUpdateExecution: () => (updating ? null : { release }),
}));
mock.module("../lib/browser/session", () => ({ createSession }));

const { narratorManualResourceRoutes } = await import("./narrator-manual-resources");
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "operator", role: "user", iat: 1, exp: 2 });
	await next();
});
app.route("/api/narrators", narratorManualResourceRoutes);
app.onError((error) => {
	if (error instanceof AppError)
		return Response.json({ error: error.message }, { status: error.statusCode });
	throw error;
});

const task = { kind: "service", command: "npm run dev", title: "Preview" };
const browser = { url: "https://example.test/", ttlMs: 2_000 };
const post = (path: string, body: unknown, id = "owner") =>
	app.request(`/api/narrators/${id}/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "content-length": "1" },
		body: JSON.stringify(body),
	});

beforeEach(() => {
	writable = true;
	updating = false;
	createTask.mockClear();
	createSession.mockClear();
	release.mockClear();
});

test("blocks read-only and foreign narrators without dispatch", async () => {
	writable = false;
	expect((await post("background-tasks", task)).status).toBe(404);
	writable = true;
	expect((await post("browser-sessions", browser, "foreign")).status).toBe(404);
	expect(createTask).not.toHaveBeenCalled();
	expect(createSession).not.toHaveBeenCalled();
});

test("rejects invalid and oversized requests before calling a launcher", async () => {
	expect((await post("background-tasks", { ...task, command: " \n " })).status).toBe(400);
	expect((await post("background-tasks", { ...task, deviceId: "other" })).status).toBe(400);
	expect((await post("background-tasks", { ...task, command: "a".repeat(70_000) })).status).toBe(
		413,
	);
	expect((await post("browser-sessions", { url: "file:///secret" })).status).toBe(400);
	expect((await post("browser-sessions", { ...browser, ttlMs: 10 })).status).toBe(400);
	expect((await post("browser-sessions", { url: "https://name:pass@example.test" })).status).toBe(
		400,
	);
	expect(createTask).not.toHaveBeenCalled();
	expect(createSession).not.toHaveBeenCalled();
});

test("returns task identity and requests a managed browser owned by the same narrator", async () => {
	const createdTask = await post("background-tasks", task);
	expect(createdTask.status).toBe(201);
	expect(await createdTask.json()).toEqual({ id: "bash-1", alias: "preview" });
	expect(createTask).toHaveBeenCalledWith(
		expect.objectContaining({ ...task, narratorId: "owner", userId: "operator" }),
	);
	const createdBrowser = await post("browser-sessions", browser);
	expect(createdBrowser.status).toBe(201);
	expect(await createdBrowser.json()).toEqual({ id: "browser-1" });
	expect(createSession).toHaveBeenCalledWith("owner", browser.url, true, 2_000, false, undefined, {
		managedManual: true,
	});
	expect(release).toHaveBeenCalledTimes(1);
});

test("browser startup errors release admission and a maintenance gate prevents launch", async () => {
	createSession.mockRejectedValueOnce(new AppError("Browser unavailable", 502));
	expect((await post("browser-sessions", browser)).status).toBe(502);
	expect(release).toHaveBeenCalledTimes(1);
	updating = true;
	expect((await post("browser-sessions", browser)).status).toBe(503);
	expect(createSession).toHaveBeenCalledTimes(1);
});
