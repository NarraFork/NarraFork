import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narrators,
	outlineBlocks,
	outlineSpaces,
	projects,
	terminals,
	userPreferences,
	users,
	workspacePanels,
	workspaces,
} from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
const realWs = { ...(await import("../../websocket/narrator-ws")) };
const realAgent = { ...(await import("../../lib/agent")) };
const broadcasts: unknown[] = [];
let generate: (...args: unknown[]) => Promise<string> = async () => "Shared purpose";
const model = mock((...args: unknown[]) => generate(...args));
mock.module("../../db", () => ({ db, sqlite }));
mock.module("../../websocket/narrator-ws", () => ({
	...realWs,
	broadcastToUser: (_: string, event: unknown) => broadcasts.push(event),
}));
mock.module("../../lib/agent", () => ({ ...realAgent, summaryGenerateWithHistory: model }));
const titleService = await import("../workspace-title");
const {
	queueOutlineTitleInvalidation,
	flushOutlineTitleInvalidations,
	settleOutlineTitleInvalidations,
	hasPendingOutlineTitleInvalidations,
} = await import("../workspace-title-outline");
const { addWorkspacePanel, removeWorkspacePanel, updateWorkspacePanelConfig } = await import(
	"../workspace-panel-service"
);
const { eventBus } = await import("../../lib/event-bus");
const { workspaceRoutes } = await import("../../routes/workspaces");
const { buildAppErrorResponse } = await import("../../lib/app-error-response");
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "owner", role: "user", iat: 0, exp: 0 });
	await next();
});
app.route("/workspaces", workspaceRoutes);
app.onError((err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: String(err) }, 500));
const NOW = "2026-08-01T00:00:00.000Z";
let idCounter = 0;
let workspaceId = "";

function workspace(source: "manual" | "default" = "manual") {
	workspaceId = `workspace-${++idCounter}`;
	db.insert(workspaces)
		.values({
			id: workspaceId,
			userId: "owner",
			title: "Existing title",
			titleSource: source,
			tree: "{}",
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
	return workspaceId;
}
function narrator(id: string, title: string, ownerUserId = "owner") {
	db.insert(narrators)
		.values({ id, title, ownerUserId, visibility: "private", createdAt: NOW, updatedAt: NOW })
		.run();
}
function readWorkspace(id = workspaceId) {
	const row = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
	if (!row) throw new Error("Missing workspace fixture");
	return row;
}
function request(path: string, method: string, body: unknown) {
	return app.request(`/workspaces${path}`, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}
async function invalidateOutlineWorkspaceTitles(spaceId: string, pageIds: readonly string[]) {
	queueOutlineTitleInvalidation(spaceId, pageIds);
	await settleOutlineTitleInvalidations();
}
function deferred() {
	let resolve!: (value: string) => void;
	const promise = new Promise<string>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(() => {
	cleanDb(sqlite);
	model.mockClear();
	broadcasts.length = 0;
	generate = async () => "Shared purpose";
	for (const id of ["owner", "other"])
		db.insert(users)
			.values({ id, username: id, passwordHash: "hash", role: "user", createdAt: NOW })
			.run();
	db.insert(userPreferences)
		.values({ id: "pref", userId: "owner", language: "zh-CN", createdAt: NOW, updatedAt: NOW })
		.run();
});
afterEach(() => cleanDb(sqlite));
afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.module("../../websocket/narrator-ws", () => realWs);
	mock.module("../../lib/agent", () => realAgent);
	mock.restore();
});

describe("workspace title metadata and HTTP contract", () => {
	it("upgrades old workspace names conservatively and defaults missing import columns", async () => {
		const legacy = new Database(":memory:");
		try {
			legacy.exec(
				"CREATE TABLE workspaces (id TEXT PRIMARY KEY, title TEXT NOT NULL); INSERT INTO workspaces VALUES ('old', 'My previous workspace');",
			);
			legacy.exec(
				await Bun.file(
					new URL("../../../drizzle/0248_needy_maria_hill.sql", import.meta.url),
				).text(),
			);
			expect(
				legacy.query("SELECT title, title_source, title_revision FROM workspaces").get(),
			).toEqual({ title: "My previous workspace", title_source: "manual", title_revision: 0 });
			legacy.exec("INSERT INTO workspaces (id, title) VALUES ('import', 'Imported old name')");
			expect(legacy.query("SELECT title_source FROM workspaces WHERE id = 'import'").get()).toEqual(
				{ title_source: "manual" },
			);
		} finally {
			legacy.close();
		}
	});
	it("keeps legacy/import rows manual, while untitled creations are default", async () => {
		workspace();
		expect(readWorkspace().titleSource).toBe("manual");
		const implicit = await (await request("", "POST", { tree: "{}" })).json();
		const explicit = await (await request("", "POST", { tree: "{}", title: "Mine" })).json();
		expect(implicit.titleSource).toBe("default");
		expect(implicit.titleRevision).toBe(0);
		expect(explicit.titleSource).toBe("manual");
		const detail = await (await app.request(`/workspaces/${implicit.id}`)).json();
		expect(detail.titleSource).toBe("default");
		expect(detail.titleRevision).toBe(0);
	});
	it("same-name PATCH marks manual, advances revision, broadcasts and rejects stale writes", async () => {
		workspace("default");
		const result = await request(`/${workspaceId}`, "PATCH", {
			title: "Existing title",
			expectedTitleRevision: 0,
		});
		expect(result.status).toBe(200);
		expect(await result.json()).toEqual({
			ok: true,
			title: "Existing title",
			titleSource: "manual",
			titleRevision: 1,
		});
		expect(broadcasts).toContainEqual({ type: "workspace_changed", workspaceId, reason: "title" });
		const stale = await request(`/${workspaceId}`, "PATCH", {
			title: "Stale",
			expectedTitleRevision: 0,
		});
		expect(stale.status).toBe(409);
		expect(readWorkspace().title).toBe("Existing title");
	});
	it("returns a candidate without storing it, with a compare-and-set revision", async () => {
		workspace();
		narrator("n", "Fix login flow");
		await addWorkspacePanel("owner", workspaceId, { kind: "narrator", narratorId: "n" });
		const response = await request(`/${workspaceId}/generate-title`, "POST", {});
		expect(response.status).toBe(200);
		const candidate = await response.json();
		expect(candidate).toEqual({ title: "Fix login flow", expectedTitleRevision: 1 });
		expect(model).not.toHaveBeenCalled();
		expect(readWorkspace().title).toBe("Existing title");
		expect(
			(await request(`/${workspaceId}`, "PATCH", { ...candidate, title: candidate.title })).status,
		).toBe(200);
	});
	it("rejects absent metadata and invalid bodies; does not disclose foreign workspaces", async () => {
		workspace();
		narrator("n", "New conversation");
		await addWorkspacePanel("owner", workspaceId, { kind: "narrator", narratorId: "n" });
		expect((await request(`/${workspaceId}/generate-title`, "POST", {})).status).toBe(400);
		expect((await request(`/${workspaceId}/generate-title`, "POST", { title: "x" })).status).toBe(
			400,
		);
		db.update(workspaces).set({ userId: "other" }).where(eq(workspaces.id, workspaceId)).run();
		expect((await request(`/${workspaceId}/generate-title`, "POST", {})).status).toBe(404);
		expect(model).not.toHaveBeenCalled();
	});
});

describe("bounded, authorized title inputs", () => {
	it("does not disclose a private project's name through a public session", async () => {
		workspace();
		db.insert(projects)
			.values({
				id: "private-project",
				name: "Confidential acquisition",
				ownerUserId: "other",
				visibility: "private",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.insert(narrators)
			.values({
				id: "public-session",
				title: "Public work",
				contextProjectId: "private-project",
				ownerUserId: "other",
				visibility: "public",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		await addWorkspacePanel("owner", workspaceId, {
			kind: "narrator",
			narratorId: "public-session",
		});
		await addWorkspacePanel("owner", workspaceId, { kind: "webview", config: { title: "Docs" } });
		await titleService.generateWorkspaceTitle("owner", workspaceId);
		expect(model.mock.calls[0][1]).toContain("Public work");
		expect(model.mock.calls[0][1]).not.toContain("Confidential acquisition");
		db.update(projects)
			.set({ visibility: "public" })
			.where(eq(projects.id, "private-project"))
			.run();
		await titleService.generateWorkspaceTitle("owner", workspaceId);
		expect(model.mock.calls[1][1]).toContain("Confidential acquisition");
	});
	it("explicitly requests English for an English-language user", async () => {
		workspace();
		db.update(userPreferences)
			.set({ language: "en" })
			.where(eq(userPreferences.userId, "owner"))
			.run();
		await addWorkspacePanel("owner", workspaceId, { kind: "webview", config: { title: "Docs" } });
		await titleService.generateWorkspaceTitle("owner", workspaceId);
		expect(model.mock.calls[0][0]).toContain("Write the title in English.");
		expect(model.mock.calls[0][2]).toBe("en");
	});
	it("reads only authorized outline headings and terminal metadata", async () => {
		workspace();
		for (const owner of ["owner", "other"]) {
			const spaceId = `space-${owner}`;
			db.insert(outlineSpaces)
				.values({ id: spaceId, key: spaceId, kind: "personal", ownerUserId: owner, createdAt: NOW })
				.run();
			db.insert(outlineBlocks)
				.values({
					id: `block-${owner}`,
					spaceId,
					sid: "a",
					pageId: `block-${owner}`,
					orderKey: "a0",
					content: `# ${owner} heading\nDo not send body to model`,
					contentHash: "x",
					authorKind: "human",
					authorId: owner,
					versionSeq: 1,
				})
				.run();
			await addWorkspacePanel("owner", workspaceId, {
				kind: "outline",
				config: { spaceId, blockId: `block-${owner}` },
			});
			narrator(`terminal-${owner}`, "Terminal session", owner);
			db.insert(terminals)
				.values({
					id: `t-${owner}`,
					narratorId: `terminal-${owner}`,
					name: `${owner} shell`,
					cwd: "/private/repo",
					createdAt: NOW,
				})
				.run();
			await addWorkspacePanel("owner", workspaceId, {
				kind: "terminal",
				config: { terminalConfig: { narratorId: `terminal-${owner}` } },
			});
		}
		await titleService.generateWorkspaceTitle("owner", workspaceId);
		const input = model.mock.calls[0][1] as string;
		expect(input).toContain("owner heading");
		expect(input).toContain("owner shell");
		expect(input).not.toContain("other heading");
		expect(input).not.toContain("other shell");
		expect(input).not.toContain("Do not send body");
		expect(input).not.toContain("/private");
	});
	it("omits unreadable sessions and ignores layout titles", async () => {
		workspace();
		narrator("secret", "Secret deal", "other");
		await addWorkspacePanel("owner", workspaceId, { kind: "narrator", narratorId: "secret" });
		db.update(workspaces)
			.set({ tree: JSON.stringify({ title: "Secret layout text" }) })
			.where(eq(workspaces.id, workspaceId))
			.run();
		await expect(titleService.generateWorkspaceTitle("owner", workspaceId)).rejects.toThrow(
			"meaningful title",
		);
		expect(model).not.toHaveBeenCalled();
	});
	it("uses nested webview metadata and standalone terminal basename, without URL parameters or full paths", async () => {
		workspace();
		await addWorkspacePanel("owner", workspaceId, {
			kind: "webview",
			config: { webviewConfig: { url: "https://docs.example.com/private/page?token=SECRET#hash" } },
		});
		await addWorkspacePanel("owner", workspaceId, {
			kind: "terminal",
			config: { terminalConfig: { cwd: "/home/private/repo" } },
		});
		const result = await titleService.generateWorkspaceTitle("owner", workspaceId);
		expect(result.title).toBe("Shared purpose");
		const call = model.mock.calls[0];
		expect(call[1]).toContain("docs.example.com");
		expect(call[1]).toContain("repo");
		expect(call[1]).not.toContain("SECRET");
		expect(call[1]).not.toContain("/home/private");
		expect(call[0]).toContain("Simplified Chinese (简体中文)");
		expect(call[2]).toBe("zh-CN");
		expect(call[3]).toEqual({ userId: "owner", kind: "title" });
		expect((call[4] as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
	});
	it("bounds panel count, UTF-8 input and output", async () => {
		workspace();
		for (let n = 0; n < 40; n++)
			await addWorkspacePanel("owner", workspaceId, {
				kind: "webview",
				config: { title: "中文".repeat(150) },
			});
		generate = async () => "x".repeat(2000);
		await expect(titleService.generateWorkspaceTitle("owner", workspaceId)).rejects.toThrow(
			"budget",
		);
		const input = model.mock.calls[0][1] as string;
		expect(Buffer.byteLength(input)).toBeLessThanOrEqual(titleService.WORKSPACE_TITLE_INPUT_BYTES);
		expect(JSON.parse(input).length).toBeLessThanOrEqual(titleService.WORKSPACE_TITLE_PANEL_LIMIT);
	});
});

describe("title input invalidation broadcasts and outline commits", () => {
	function space() {
		db.insert(outlineSpaces)
			.values({
				id: "outline-space",
				key: "outline-space",
				kind: "personal",
				ownerUserId: "owner",
				createdAt: NOW,
			})
			.run();
	}
	function block(id: string, content: string, pageId = id, parentId: string | null = null) {
		db.insert(outlineBlocks)
			.values({
				id,
				spaceId: "outline-space",
				sid: id,
				pageId,
				parentId,
				orderKey: id,
				content,
				contentHash: "hash",
				authorKind: "human",
				authorId: "owner",
				versionSeq: 1,
			})
			.run();
	}
	it("broadcasts a narrator-driven revision change even when the title stays manual", async () => {
		workspace();
		narrator("n", "Original title");
		await addWorkspacePanel("owner", workspaceId, { kind: "narrator", narratorId: "n" });
		const revision = readWorkspace().titleRevision;
		broadcasts.length = 0;
		eventBus.emit({ type: "narrator:title_updated", narratorId: "n", title: "Changed title" });
		await Bun.sleep(0);
		expect(readWorkspace().titleRevision).toBe(revision + 1);
		expect(readWorkspace().title).toBe("Existing title");
		expect(broadcasts).toEqual([{ type: "workspace_changed", workspaceId, reason: "title" }]);
	});
	it("an empty page-list panel wakes when its first page acquires a title", async () => {
		workspace("default");
		space();
		await addWorkspacePanel("owner", workspaceId, {
			kind: "outline",
			config: { spaceId: "outline-space" },
		});
		await expect(titleService.generateWorkspaceTitle("owner", workspaceId)).rejects.toThrow(
			"meaningful title",
		);
		block("root-page", "# Authentication roadmap\nPrivate page body");
		eventBus.emit({
			type: "outline:committed",
			spaceId: "outline-space",
			commitId: "commit",
			seq: 1,
			pageIds: ["root-page"],
			actorKind: "human",
			actorId: "owner",
		});
		await Bun.sleep(titleService.WORKSPACE_TITLE_DEBOUNCE_MS + 250);
		expect(readWorkspace().titleSource).toBe("auto");
		expect(readWorkspace().title).toBe("Shared purpose");
		expect(model.mock.calls[0][1]).toContain("Authentication roadmap");
		expect(model.mock.calls[0][1]).not.toContain("Private page body");
	});
	it("root heading changes invalidate child-focused and page-list candidates, not unrelated pages", async () => {
		space();
		block("root-page", "# Original root");
		block("child", "Child body", "root-page", "root-page");
		block("unrelated-root", "# Unrelated root");
		const focusedId = workspace();
		await addWorkspacePanel("owner", focusedId, {
			kind: "outline",
			config: { spaceId: "outline-space", blockId: "child" },
		});
		const candidate = await titleService.generateWorkspaceTitle("owner", focusedId);
		expect(model.mock.calls[0][1]).toContain("Original root");
		expect(model.mock.calls[0][1]).not.toContain("Child body");
		const listId = workspace();
		await addWorkspacePanel("owner", listId, {
			kind: "outline",
			config: { spaceId: "outline-space" },
		});
		// A second affected member must not cause a second revision bump for this commit.
		await addWorkspacePanel("owner", listId, {
			kind: "outline",
			config: { spaceId: "outline-space", blockId: "root-page" },
		});
		const unrelatedId = workspace();
		await addWorkspacePanel("owner", unrelatedId, {
			kind: "outline",
			config: { spaceId: "outline-space", blockId: "unrelated-root" },
		});
		const focusedRevision = readWorkspace(focusedId).titleRevision;
		const listRevision = readWorkspace(listId).titleRevision;
		const unrelatedRevision = readWorkspace(unrelatedId).titleRevision;
		broadcasts.length = 0;
		db.update(outlineBlocks)
			.set({ content: "# Revised root" })
			.where(eq(outlineBlocks.id, "root-page"))
			.run();
		await invalidateOutlineWorkspaceTitles("outline-space", ["root-page"]);
		expect(readWorkspace(focusedId).titleRevision).toBe(focusedRevision + 1);
		expect(readWorkspace(listId).titleRevision).toBe(listRevision + 1);
		expect(readWorkspace(unrelatedId).titleRevision).toBe(unrelatedRevision);
		expect(broadcasts).toHaveLength(2);
		await expect(
			titleService.updateWorkspaceTitle(
				"owner",
				focusedId,
				candidate.title,
				candidate.expectedTitleRevision,
			),
		).rejects.toThrow("changed");
	});
	function commit(pageIds = ["root-page"]) {
		eventBus.emit({
			type: "outline:committed",
			spaceId: "outline-space",
			commitId: "commit",
			seq: 1,
			pageIds,
			actorKind: "human",
			actorId: "owner",
		});
	}
	async function focusedOutlineWorkspace() {
		space();
		block("root-page", "# Root");
		block("child", "Child body", "root-page", "root-page");
		workspace();
		await addWorkspacePanel("owner", workspaceId, {
			kind: "outline",
			config: { spaceId: "outline-space", blockId: "child" },
		});
		return titleService.generateWorkspaceTitle("owner", workspaceId);
	}
	it("rejects an immediate candidate PATCH after a real outline commit without an explicit flush", async () => {
		const candidate = await focusedOutlineWorkspace();
		commit();
		expect(hasPendingOutlineTitleInvalidations()).toBe(true);
		const response = await request(`/${workspaceId}`, "PATCH", candidate);
		expect(response.status).toBe(409);
		expect(readWorkspace().title).toBe("Existing title");
		expect(readWorkspace().titleRevision).toBe(candidate.expectedTitleRevision + 1);
		expect(hasPendingOutlineTitleInvalidations()).toBe(false);
	});
	it("rejects adoption when another commit queues during the active invalidation scan", async () => {
		const candidate = await focusedOutlineWorkspace();
		const gate = deferred();
		const scan = spyOn(db.query.outlineBlocks, "findFirst").mockImplementationOnce(
			() => gate.promise.then(() => ({ pageId: "root-page" })) as never,
		);
		let active: Promise<void> | undefined;
		try {
			// This scan is unrelated to our root, so its completion does not bump the revision.
			commit(["unrelated-root"]);
			active = flushOutlineTitleInvalidations();
			const response = request(`/${workspaceId}`, "PATCH", candidate);
			await Bun.sleep(0);
			expect(scan).toHaveBeenCalledTimes(1);
			commit();
			gate.resolve("");
			expect((await response).status).toBe(409);
			expect(readWorkspace().titleRevision).toBe(candidate.expectedTitleRevision);
			expect(readWorkspace().title).toBe("Existing title");
			expect(hasPendingOutlineTitleInvalidations()).toBe(true);
		} finally {
			gate.resolve("");
			await active;
			scan.mockRestore();
			await flushOutlineTitleInvalidations();
		}
		expect(readWorkspace().titleRevision).toBe(candidate.expectedTitleRevision + 1);
		expect(hasPendingOutlineTitleInvalidations()).toBe(false);
	});
	it("bounds an active scan wait and resumes invalidation after a timed-out PATCH", async () => {
		const candidate = await focusedOutlineWorkspace();
		const gate = deferred();
		const scan = spyOn(db.query.outlineBlocks, "findFirst").mockImplementationOnce(
			() => gate.promise.then(() => ({ pageId: "root-page" })) as never,
		);
		const originalSetTimeout = globalThis.setTimeout;
		const budgets: number[] = [];
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(
			Object.assign((...args: Parameters<typeof setTimeout>) => {
				if (args[1] === 250) {
					budgets.push(args[1]);
					args[1] = 5;
				}
				return originalSetTimeout(...args);
			}, originalSetTimeout),
		);
		let active: Promise<void> | undefined;
		try {
			commit(["unrelated-root"]);
			active = flushOutlineTitleInvalidations();
			const response = await request(`/${workspaceId}`, "PATCH", candidate);
			expect(response.status).toBe(409);
			expect(budgets).toEqual([250]);
			expect(scan).toHaveBeenCalledTimes(1);
			expect(hasPendingOutlineTitleInvalidations()).toBe(true);
			expect(readWorkspace().titleRevision).toBe(candidate.expectedTitleRevision);
			expect(readWorkspace().title).toBe("Existing title");
			// A later event must remain queued even after the request deadline expires.
			commit();
		} finally {
			gate.resolve("");
			await active;
			scan.mockRestore();
			timer.mockRestore();
			await flushOutlineTitleInvalidations();
		}
		expect(hasPendingOutlineTitleInvalidations()).toBe(false);
		expect(readWorkspace().titleRevision).toBe(candidate.expectedTitleRevision + 1);
		const fresh = await titleService.generateWorkspaceTitle("owner", workspaceId);
		expect((await request(`/${workspaceId}`, "PATCH", fresh)).status).toBe(200);
	});
	it("does not return a candidate when unchanged headings receive a commit during generation", async () => {
		await focusedOutlineWorkspace();
		const revision = readWorkspace().titleRevision;
		generate = async () => {
			commit();
			return "Stale candidate";
		};
		const response = await request(`/${workspaceId}/generate-title`, "POST", {});
		expect(response.status).toBe(409);
		expect(readWorkspace().titleRevision).toBe(revision + 1);
		expect(readWorkspace().title).toBe("Existing title");
		expect(hasPendingOutlineTitleInvalidations()).toBe(false);
	});
	it("merges frequent outline commits into one global flight and queues only one next batch", async () => {
		space();
		block("root-page", "# Root");
		workspace();
		await addWorkspacePanel("owner", workspaceId, {
			kind: "outline",
			config: { spaceId: "outline-space" },
		});
		const revision = readWorkspace().titleRevision;
		broadcasts.length = 0;
		for (let n = 0; n < 1000; n++) queueOutlineTitleInvalidation("outline-space", ["root-page"]);
		const first = flushOutlineTitleInvalidations();
		expect(flushOutlineTitleInvalidations()).toBe(first);
		for (let n = 0; n < 1000; n++) queueOutlineTitleInvalidation("outline-space", ["root-page"]);
		expect(flushOutlineTitleInvalidations()).toBe(first);
		await first;
		expect(readWorkspace().titleRevision).toBe(revision + 1);
		await flushOutlineTitleInvalidations();
		expect(readWorkspace().titleRevision).toBe(revision + 2);
		expect(broadcasts).toHaveLength(2);
	});
	it("collapses pending-space overflow to one conservative sweep without dropping changes", async () => {
		space();
		workspace();
		await addWorkspacePanel("owner", workspaceId, {
			kind: "outline",
			config: { spaceId: "outline-space" },
		});
		const revision = readWorkspace().titleRevision;
		for (let n = 0; n < 300; n++) queueOutlineTitleInvalidation(`other-space-${n}`, ["root"]);
		// Even an event arriving after the bounded map overflow must not be silently lost.
		queueOutlineTitleInvalidation("outline-space", ["root-page"]);
		await flushOutlineTitleInvalidations();
		expect(readWorkspace().titleRevision).toBe(revision + 1);
	});
	it("cursor-pages outline memberships through the kind index and ignores unrelated spaces", async () => {
		space();
		const now = new Date();
		const rows = Array.from({ length: 106 }, (_, index) => ({
			id: `paged-${String(index).padStart(3, "0")}`,
			userId: "owner",
			title: "Personal name",
			tree: "{}",
			createdAt: now,
			updatedAt: now,
		}));
		db.insert(workspaces).values(rows).run();
		db.insert(workspacePanels)
			.values(
				rows.map((row, index) => ({
					id: `panel-${index}`,
					workspaceId: row.id,
					kind: "outline" as const,
					configJson: JSON.stringify({
						spaceId: index === 0 ? "different-space" : "outline-space",
					}),
					sortOrder: 0,
					createdAt: now,
					updatedAt: now,
				})),
			)
			.run();
		await invalidateOutlineWorkspaceTitles("outline-space", ["root-page"]);
		expect(readWorkspace("paged-000").titleRevision).toBe(0);
		expect(readWorkspace("paged-105").titleRevision).toBe(1);
		expect(broadcasts).toHaveLength(105);
		const plan = sqlite
			.query(
				"EXPLAIN QUERY PLAN SELECT id, workspace_id FROM workspace_panels WHERE kind = 'outline' AND (workspace_id, id) > ('paged-050', '') ORDER BY workspace_id, id LIMIT 100",
			)
			.all();
		expect(JSON.stringify(plan)).toContain("idx_workspace_panels_kind_workspace");
		expect(JSON.stringify(plan)).toContain("(workspace_id,id)>(?,?)");
	});
});

describe("concurrency and automatic generation", () => {
	it("aborts the provider and releases the single flight on timeout", async () => {
		workspace();
		await addWorkspacePanel("owner", workspaceId, { kind: "webview", config: { title: "Docs" } });
		generate = () => new Promise<string>(() => {});
		const originalSetTimeout = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(
			Object.assign((...args: Parameters<typeof setTimeout>) => {
				if (args[1] === titleService.WORKSPACE_TITLE_TIMEOUT_MS) args[1] = 10;
				return originalSetTimeout(...args);
			}, originalSetTimeout),
		);
		try {
			await expect(titleService.generateWorkspaceTitle("owner", workspaceId)).rejects.toThrow(
				"timed out",
			);
			expect((model.mock.calls[0][4] as { signal: AbortSignal }).signal.aborted).toBe(true);
			expect(timer).toHaveBeenCalled();
			generate = async () => "Recovered";
			expect((await titleService.generateWorkspaceTitle("owner", workspaceId)).title).toBe(
				"Recovered",
			);
		} finally {
			timer.mockRestore();
		}
	});
	it("coalesces same-workspace requests, then rejects a member-config race", async () => {
		workspace();
		const { panel } = await addWorkspacePanel("owner", workspaceId, {
			kind: "webview",
			config: { title: "Docs" },
		});
		const pending = deferred();
		generate = () => pending.promise;
		const first = titleService.generateWorkspaceTitle("owner", workspaceId);
		expect(titleService.generateWorkspaceTitle("owner", workspaceId)).toBe(first);
		while (!model.mock.calls.length) await Promise.resolve();
		await updateWorkspacePanelConfig("owner", workspaceId, panel.id, { title: "Changed" });
		pending.resolve("Old candidate");
		await expect(first).rejects.toThrow("changed");
		expect(model).toHaveBeenCalledTimes(1);
		expect(readWorkspace().title).toBe("Existing title");
	});
	it("member removal invalidates an already-generated candidate", async () => {
		workspace();
		narrator("n", "Login improvements");
		const { panel } = await addWorkspacePanel("owner", workspaceId, {
			kind: "narrator",
			narratorId: "n",
		});
		const candidate = await titleService.generateWorkspaceTitle("owner", workspaceId);
		await removeWorkspacePanel("owner", workspaceId, panel.id);
		await expect(
			titleService.updateWorkspaceTitle(
				"owner",
				workspaceId,
				candidate.title,
				candidate.expectedTitleRevision,
			),
		).rejects.toThrow("changed");
	});
	it("debounces consecutive additions and generates only once for a default workspace", async () => {
		workspace("default");
		narrator("n", "Login improvements");
		await addWorkspacePanel("owner", workspaceId, { kind: "narrator", narratorId: "n" });
		await addWorkspacePanel("owner", workspaceId, {
			kind: "webview",
			config: { title: "Authentication docs" },
		});
		await Bun.sleep(titleService.WORKSPACE_TITLE_DEBOUNCE_MS + 100);
		expect(readWorkspace().title).toBe("Shared purpose");
		expect(readWorkspace().titleSource).toBe("auto");
		expect(model).toHaveBeenCalledTimes(1);
		await addWorkspacePanel("owner", workspaceId, {
			kind: "webview",
			config: { title: "More docs" },
		});
		await Bun.sleep(titleService.WORKSPACE_TITLE_DEBOUNCE_MS + 100);
		expect(model).toHaveBeenCalledTimes(1);
	});
	it("title_updated wakes a default workspace and protects manually accepted names", async () => {
		workspace("default");
		narrator("n", "New conversation");
		await addWorkspacePanel("owner", workspaceId, { kind: "narrator", narratorId: "n" });
		db.update(narrators).set({ title: "Actual work" }).where(eq(narrators.id, "n")).run();
		eventBus.emit({ type: "narrator:title_updated", narratorId: "n", title: "Actual work" });
		await Bun.sleep(titleService.WORKSPACE_TITLE_DEBOUNCE_MS + 100);
		expect(readWorkspace().titleSource).toBe("auto");
		expect(readWorkspace().title).toBe("Actual work");
		await titleService.updateWorkspaceTitle("owner", workspaceId, "Chosen by me");
		eventBus.emit({ type: "narrator:title_updated", narratorId: "n", title: "Later" });
		await Bun.sleep(titleService.WORKSPACE_TITLE_DEBOUNCE_MS + 100);
		expect(readWorkspace().title).toBe("Chosen by me");
		expect(readWorkspace().titleSource).toBe("manual");
	});
	it("a manual rename during model generation wins", async () => {
		workspace("default");
		await addWorkspacePanel("owner", workspaceId, { kind: "webview", config: { title: "Docs" } });
		const pending = deferred();
		generate = () => pending.promise;
		const first = titleService.generateWorkspaceTitle("owner", workspaceId);
		while (!model.mock.calls.length) await Promise.resolve();
		await titleService.updateWorkspaceTitle("owner", workspaceId, "My name");
		pending.resolve("Generated");
		await expect(first).rejects.toThrow("changed");
		expect(readWorkspace().title).toBe("My name");
	});
	it("model failure leaves the default name unchanged", async () => {
		workspace("default");
		await addWorkspacePanel("owner", workspaceId, { kind: "webview", config: { title: "Docs" } });
		generate = async () => {
			throw new Error("Provider unavailable");
		};
		await expect(titleService.generateWorkspaceTitle("owner", workspaceId)).rejects.toThrow(
			"Provider unavailable",
		);
		expect(readWorkspace().titleSource).toBe("default");
		expect(readWorkspace().title).toBe("Existing title");
	});
});
