import { beforeEach, expect, mock, test } from "bun:test";
import type { WorkspaceContext } from "@shared/workspace-context";
import { Hono } from "hono";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";

const context: WorkspaceContext = {
	revision: 7,
	contextKey: "remote:selected",
	deviceId: "remote",
	cwd: "/selected",
	pathFlavor: "posix",
	capabilities: { switchDirectory: true },
};
let denied = false;
const access = mock(async (_c: unknown, _id: string, _need: string) => {
	if (denied) throw new AppError("Narrator not found", 404);
});
const browse = mock(
	async (_id: string, _context: WorkspaceContext, _input: unknown, _options: unknown) => ({
		path: "/selected",
		parent: null,
		entries: [],
		truncated: false,
		scanned: 0,
		revision: 7,
		contextKey: context.contextKey,
		deviceId: "remote",
	}),
);
const withRevision = mock(
	async (
		_id: string,
		revision: number,
		_key: unknown,
		action: (context: WorkspaceContext) => Promise<unknown>,
	) => {
		if (revision !== 7) throw new AppError("Workspace identity changed", 409);
		return action(context);
	},
);
mock.module("../lib/narrator-access", () => ({ requireNarratorAccess: access }));
mock.module("../services/workspace-browser-service", () => ({ browseWorkspaceDirectory: browse }));
mock.module("../services/workspace-context-service", () => ({
	workspaceContextService: { withRevision },
}));
const { narratorWorkspaceBrowserRoutes } = await import("./narrator-workspace-browser");
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "reader", role: "user", iat: 0, exp: 2_147_483_647 });
	await next();
});
app.onError((error, c) =>
	c.json(
		{ error: error.message },
		error instanceof AppError ? (error.statusCode as 400) : error instanceof ZodError ? 400 : 500,
	),
);
app.route("/narrators", narratorWorkspaceBrowserRoutes);
beforeEach(() => {
	denied = false;
	access.mockClear();
	browse.mockClear();
	withRevision.mockClear();
	browse.mockImplementation(async () => ({
		path: "/selected",
		parent: null,
		entries: [],
		truncated: false,
		scanned: 0,
		revision: 7,
		contextKey: context.contextKey,
		deviceId: "remote",
	}));
});
const url =
	"/narrators/n/workspace-browser?expectedRevision=7&contextKey=remote%3Aselected&path=child&showHidden=1";
test("safe browse takes actor from authentication, enters revision admission and rechecks narrator read ACL", async () => {
	const response = await app.request(url);
	expect(response.status).toBe(200);
	expect(access).toHaveBeenCalledTimes(2);
	expect(withRevision.mock.calls[0]?.slice(0, 3)).toEqual(["n", 7, undefined]);
	expect(browse.mock.calls[0]?.[1]).toBe(context);
	expect(browse.mock.calls[0]?.[3]).toMatchObject({ userId: "reader" });
});
test("stale revision and arbitrary device overrides never start directory IO", async () => {
	const stale = await app.request(url.replace("Revision=7", "Revision=6"));
	expect(stale.status).toBe(409);
	expect(browse).not.toHaveBeenCalled();
	const unsafe = await app.request(`${url}&deviceId=local`);
	expect(unsafe.status).toBe(400);
	expect(browse).not.toHaveBeenCalled();
});
test("revocation during an in-flight read hides even a completed remote result", async () => {
	browse.mockImplementation(async () => {
		denied = true;
		return {
			path: "/selected",
			parent: null,
			entries: [],
			truncated: false,
			scanned: 0,
			revision: 7,
			contextKey: context.contextKey,
			deviceId: "remote",
		};
	});
	const response = await app.request(url);
	expect(response.status).toBe(404);
	expect(access).toHaveBeenCalledTimes(2);
});
