import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../../lib/app-error-response";

const realChildProcess = { ...(await import("node:child_process")) };
const realPlatform = { ...(await import("../../lib/platform")) };
let launchError: Error | undefined;
const unref = mock(() => {});
const spawn = mock((_cmd: string, _args: string[], _options: unknown) => {
	const child = Object.assign(new EventEmitter(), { unref });
	queueMicrotask(() => {
		if (launchError) child.emit("error", launchError);
		else child.emit("spawn");
	});
	return child;
});
mock.module("node:child_process", () => ({ ...realChildProcess, spawn }));
mock.module("../../lib/platform", () => ({
	...realPlatform,
	IS_LINUX: true,
	IS_MACOS: false,
	IS_WINDOWS: false,
}));
const { fsRoutes } = await import("../fs");
const app = new Hono().route("/fs", fsRoutes).onError((error, c) => {
	return buildAppErrorResponse(error, c) ?? c.json({ error: String(error) }, 500);
});

beforeEach(() => {
	launchError = undefined;
	spawn.mockClear();
	unref.mockClear();
});
afterAll(() => {
	mock.module("node:child_process", () => realChildProcess);
	mock.module("../../lib/platform", () => realPlatform);
	mock.restore();
});

function reveal(path: string) {
	return app.request("http://localhost/fs/reveal", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path }),
	});
}

test("Linux opens the directory with xdg-open without a shell or waiting for window exit", async () => {
	const path = resolve(import.meta.dir);
	const response = await reveal(path);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ ok: true });
	expect(spawn).toHaveBeenCalledWith("xdg-open", [path], { detached: true, stdio: "ignore" });
	expect(unref).toHaveBeenCalledTimes(1);
});

test("missing xdg-open returns an API error rather than an unhandled process error", async () => {
	launchError = new Error("spawn xdg-open ENOENT");
	const response = await reveal(import.meta.dir);
	expect(response.status).toBe(500);
	expect(await response.text()).toContain("Could not launch file manager (xdg-open)");
	expect(unref).not.toHaveBeenCalled();
});

test("invalid directories are rejected before launching a file manager", async () => {
	const response = await reveal(resolve(import.meta.dir, "does-not-exist-for-reveal"));
	expect(response.status).toBe(400);
	expect(spawn).not.toHaveBeenCalled();
});
