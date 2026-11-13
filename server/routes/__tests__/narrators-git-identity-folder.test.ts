/**
 * `GET /narrators/:id/git-identity` reports the pick of the sidebar folder the session sits
 * in. A session with no pick of its own commits under that folder's identity, so the menus
 * need it to say which identity "follow" means.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-git-identity-folder-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

// Imported after NARRAFORK_HOME is redirected so the DB never touches a real instance.
const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { folderGitIdentityBindings, narrators, userGitIdentities, userRecentTabs, users } =
	await import("../../db/schema");
const { generateId } = await import("../../lib/id");

const USER = "git-identity-folder-user";
const FOLDER = "git-identity-folder";
const IDENTITY = "git-identity-folder-identity";
const NOW = "2026-11-12T00:00:00.000Z";

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

function tab(input: { type: "folder" | "narrator"; id: string; folderId?: string; order: number }) {
	return {
		id: generateId(),
		userId: USER,
		tabKey: `${input.type}:${input.id}`,
		section: "work" as const,
		type: input.type,
		entityId: input.id,
		title: input.id,
		lastVisitedAt: 1,
		createdAt: NOW,
		updatedAt: NOW,
		sortOrder: input.order,
		...(input.type === "narrator" ? { representedNarratorId: input.id } : {}),
		...(input.folderId ? { folderId: input.folderId } : {}),
	};
}

beforeAll(async () => {
	await db.insert(users).values({
		id: USER,
		username: `${USER}-${Date.now()}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	const base = {
		ownerUserId: USER,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	} as const;
	await db.insert(narrators).values([
		{ id: "in-folder", ...base },
		{ id: "loose", ...base },
	]);
	await db.insert(userGitIdentities).values({
		id: IDENTITY,
		userId: USER,
		name: "Folder",
		email: "folder@example.com",
		isDefault: false,
		createdAt: NOW,
	});
	await db
		.insert(userRecentTabs)
		.values([
			tab({ type: "folder", id: FOLDER, order: 0 }),
			tab({ type: "narrator", id: "in-folder", folderId: FOLDER, order: 1 }),
			tab({ type: "narrator", id: "loose", order: 2 }),
		]);
	await db.insert(folderGitIdentityBindings).values({
		id: generateId(),
		folderId: FOLDER,
		userId: USER,
		identityId: IDENTITY,
		updatedAt: NOW,
	});
});

function app() {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: USER, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.route("/narrators", narratorRoutes);
	return instance;
}

async function read(narratorId: string) {
	const response = await app().request(`http://localhost/narrators/${narratorId}/git-identity`);
	expect(response.status).toBe(200);
	return (await response.json()) as { selectedId: string | null; folderSelectedId: string | null };
}

test("a session in a folder with a pick reports that folder's pick", async () => {
	expect(await read("in-folder")).toMatchObject({ selectedId: null, folderSelectedId: IDENTITY });
});

test("a session outside every folder has no folder pick", async () => {
	expect(await read("loose")).toMatchObject({ selectedId: null, folderSelectedId: null });
});
