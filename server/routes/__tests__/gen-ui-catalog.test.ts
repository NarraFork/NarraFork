import { describe, expect, test } from "bun:test";
import type { GenUiFileReference } from "@shared/gen-ui-files";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";
import { createGenUiRoutes, type GenUiRouteDependencies } from "../gen-ui";

const reference: GenUiFileReference = {
	version: 1,
	toolUseId: "use",
	toolCallId: "call",
	deviceId: "local",
	workspaceKey: "workspace",
	cwd: "/work",
	directory: "/work/.narrafork/gen_ui/demo-id",
	entry: "App.tsx",
	title: "demo-id",
};
function fixture(overrides: Partial<GenUiRouteDependencies> = {}) {
	const seen: unknown[][] = [];
	const deps: GenUiRouteDependencies = {
		authorize: async () => "actor",
		tool: async (...args) => {
			seen.push(args);
			return {
				id: "call",
				toolName: "GenUI",
				outputJson: { _metadata: { genUi: reference } },
			};
		},
		preview: async (...args) => {
			seen.push(args.slice(0, 3));
			return {
				js: "(()=>{})()",
				css: "",
				directory: reference.directory,
				entry: "App.tsx",
				files: ["App.tsx"],
			};
		},
		kit: {
			overview: async () => ({ status: { state: "builtin", components: [] }, request: null }),
			bundle: async () => ({ js: "", css: "", hash: "h", components: [], hasSetup: false }),
			approve: async () => ({ status: { state: "builtin", components: [] }, request: null }),
			dismiss: async () => ({ dismissed: true }),
		},
		answerForm: (...args) => {
			seen.push(args);
			return args[1] === "waiting";
		},
		liveReference: async (options) => {
			seen.push([options]);
			return { ...reference, toolCallId: options.toolCallId, directory: options.appPath };
		},
		...overrides,
	};
	return { app: createGenUiRoutes(deps), seen };
}
const url = "/n/gen-ui/preview/use?toolCallId=call";

describe("GenUI file preview route", () => {
	test("loads the visible exact tool record; never accepts a source path", async () => {
		const { app, seen } = fixture();
		const response = await app.request(url);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(seen).toEqual([
			["n", "use", "call"],
			["n", "actor", reference],
		]);
		expect((await app.request(`${url}&path=/etc/passwd`)).status).toBe(400);
		expect((await app.request("/n/gen-ui/preview/use")).status).toBe(400);
	});
	test("checks access before tool lookup or reading source", async () => {
		const { app, seen } = fixture({
			authorize: async () => {
				throw new AppError("denied", 403);
			},
		});
		expect((await app.request(url)).status).toBe(403);
		expect(seen).toEqual([]);
	});
	test.each([
		{ id: "call", toolName: "Read", outputJson: { _metadata: { genUi: reference } } },
		{
			id: "other",
			toolName: "GenUI",
			outputJson: { _metadata: { genUi: reference } },
		},
		{
			id: "call",
			toolName: "GenUI",
			outputJson: { _metadata: { genUi: { ...reference, toolUseId: "other" } } },
		},
		{ id: "call", toolName: "GenUI", outputJson: "forged text" },
	])("rejects mismatched or non-UI persisted records", async (tool) => {
		const { app, seen } = fixture({ tool: async () => tool });
		expect((await app.request(url)).status).toBe(404);
		expect(seen).toEqual([]);
	});
	test("accepts only server-owned COW provenance for the visible exact copy", async () => {
		for (const origin of ["call", "unrelated", null]) {
			const { app, seen } = fixture({
				tool: async () => ({
					id: "copy",
					toolName: "GenUI",
					executionOriginToolCallId: origin,
					outputJson: { _metadata: { genUi: reference } },
				}),
			});
			expect((await app.request("/n/gen-ui/preview/use?toolCallId=copy")).status).toBe(
				origin === "call" ? 200 : 404,
			);
			if (origin === "call")
				expect(seen).toEqual([["n", "actor", { ...reference, toolCallId: "copy" }]]);
			else expect(seen).toEqual([]);
		}
	});
	test("form answers reach only a waiting call, as plain checked data", async () => {
		const { app, seen } = fixture();
		const post = (toolUseId: string, body: unknown) =>
			app.request(`/n/gen-ui/form/${toolUseId}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const fields = { size: "L", count: 3, agree: true, tags: ["a", "b"], none: null };
		expect((await post("waiting", { status: "submitted", message: "Go", fields })).status).toBe(
			200,
		);
		expect((await post("waiting", { status: "closed" })).status).toBe(200);
		expect((await post("done", { status: "closed" })).status).toBe(409);
		for (const bad of [
			{ status: "submitted", message: "Go", fields: { "a b": 1 } },
			{ status: "submitted", message: "Go", fields: { a: { nested: 1 } } },
			{ status: "submitted", fields: {} },
			{ status: "maybe" },
		])
			expect((await post("waiting", bad)).status).toBe(400);
		expect(seen).toEqual([
			["n", "waiting", { status: "submitted", message: "Go", fields }],
			["n", "waiting", { status: "closed" }],
			["n", "done", { status: "closed" }],
		]);
	});
	test("form answers check access first", async () => {
		const { app, seen } = fixture({
			authorize: async () => {
				throw new AppError("denied", 403);
			},
		});
		const response = await app.request("/n/gen-ui/form/waiting", {
			method: "POST",
			body: JSON.stringify({ status: "closed" }),
		});
		expect(response.status).toBe(403);
		expect(seen).toEqual([]);
	});
	test("does not expose any legacy catalog/session/action routes", async () => {
		const { app } = fixture();
		for (const suffix of ["catalog", "session", "actions", "list", "ui"])
			expect((await app.request(`/n/gen-ui/${suffix}`)).status).toBe(404);
	});
	test("real full fork and COW keep the preview attached to its visible historical copy", async () => {
		const { eq } = await import("drizzle-orm");
		const { db } = await import("../../db");
		const { narrators, users, narratorMessages, narratorMessageRefs, narratorToolCalls } =
			await import("../../db/schema");
		const { narratorService } = await import("../../services/narrator-service");
		const { narratorPersistence } = await import("../../services/narrator-persistence");
		const now = new Date().toISOString();
		const parent = "ui-cow-parent";
		const messageId = "ui-cow-message";
		const original = { ...reference, toolCallId: "ui-cow-call", toolUseId: "ui-cow-use" };
		await db.insert(users).values({
			id: "ui-cow-owner",
			username: "ui-cow-owner",
			passwordHash: "x",
			role: "user",
			createdAt: now,
		});
		await db.insert(narrators).values({
			id: parent,
			title: "UI parent",
			cwd: "/workspace",
			ownerUserId: "ui-cow-owner",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId: parent,
			role: "assistant",
			createdAt: now,
			contentJson: [
				{
					type: "tool_use",
					id: original.toolUseId,
					name: "GenUI",
					input: { action: "show", path: original.directory },
				},
			],
		});
		await db
			.insert(narratorMessageRefs)
			.values({ id: "ui-cow-ref", narratorId: parent, messageId, seq: 0 });
		await db.insert(narratorToolCalls).values({
			id: original.toolCallId,
			narratorId: parent,
			messageId,
			toolUseId: original.toolUseId,
			toolName: "GenUI",
			status: "success",
			createdAt: now,
			outputJson: { _metadata: { genUi: original } },
		});
		const fork = await narratorService.forkNarrator(parent, null, { inheritMode: "full" });
		const copiedMessage = await narratorPersistence.copyOnWriteMessage(fork.id, messageId, {
			contentText: "Fork-only note",
		});
		expect(copiedMessage).not.toBe(messageId);
		const copy = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.messageId, copiedMessage),
		});
		if (!copy) throw new Error("COW did not preserve the UI tool row");
		expect(copy.executionOriginToolCallId).toBe(original.toolCallId);
		// No UI-specific COW rewriting: the original output remains unchanged.
		expect(copy.outputJson).toEqual({ _metadata: { genUi: original } });
		const seen: GenUiFileReference[] = [];
		const app = createGenUiRoutes({
			authorize: async () => "ui-cow-owner",
			preview: async (_narratorId, _userId, ref) => {
				seen.push(ref);
				return { js: "", css: "", directory: ref.directory, entry: ref.entry, files: [ref.entry] };
			},
		});
		const request = (narratorId: string, id: string) =>
			app.request(`/${narratorId}/gen-ui/preview/${original.toolUseId}?toolCallId=${id}`);
		expect((await request(fork.id, original.toolCallId)).status).toBe(404);
		expect((await request(fork.id, copy.id)).status).toBe(200);
		expect(seen.at(-1)).toEqual({ ...original, toolCallId: copy.id });
		expect((await request(parent, copy.id)).status).toBe(404);
		expect((await request(parent, original.toolCallId)).status).toBe(200);
		// Losing the original row must not destroy a copy's trusted provenance.
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.id, original.toolCallId));
		expect((await request(fork.id, copy.id)).status).toBe(200);
		// A different origin is not a substitute for the selected historical identity.
		await db
			.update(narratorToolCalls)
			.set({ executionOriginToolCallId: "other" })
			.where(eq(narratorToolCalls.id, copy.id));
		expect((await request(fork.id, copy.id)).status).toBe(404);
	});
	test("production ACL rejects public-only readers and accepts the actual owner", async () => {
		// tests/preload.ts isolates this real database from all user data.
		const { db } = await import("../../db");
		const { narrators, users } = await import("../../db/schema");
		const now = new Date().toISOString();
		for (const id of ["ui-owner", "ui-reader"])
			await db
				.insert(users)
				.values({ id, username: id, passwordHash: "x", role: "user", createdAt: now });
		await db.insert(narrators).values({
			id: "ui-public",
			title: "test",
			ownerUserId: "ui-owner",
			visibility: "public",
			writeAudience: "owner",
			createdAt: now,
			updatedAt: now,
		});
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("user", {
				sub: c.req.header("test-user") ?? "",
				role: "user",
				iat: 0,
				exp: Number.MAX_SAFE_INTEGER,
			});
			await next();
		});
		app.route(
			"/",
			createGenUiRoutes({
				tool: async () => ({
					id: "call",
					toolName: "GenUI",
					outputJson: { _metadata: { genUi: reference } },
				}),
				preview: async () => ({
					js: "",
					css: "",
					directory: reference.directory,
					entry: "App.tsx",
					files: ["App.tsx"],
				}),
			}),
		);
		const path = "/ui-public/gen-ui/preview/use?toolCallId=call";
		expect((await app.request(path, { headers: { "test-user": "ui-reader" } })).status).toBe(403);
		expect((await app.request(path, { headers: { "test-user": "ui-owner" } })).status).toBe(200);
	});
});
