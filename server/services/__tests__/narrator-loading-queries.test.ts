import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));
await import("../narrator-service");
const { getAuthorizedNarrator, requireNarratorAccess } = await import("../../lib/narrator-access");
const { getNarratorNavigationSummary } = await import("../narrator-navigation-summary");
const { countNarratorMessageRefs } = await import("../narrator-message-count");
const { narratorMessageQueries } = await import("../narrator-messages");
const { narratorRoutes } = await import("../../routes/narrators");
const gitSummaryModule = await import("../narrator-git-summary");
const displayReaderModule = await import("../narrator-display-page-reader");
const time = "2026-10-12T00:00:00.000Z";
/** `project` places the narrator in a project through its cwd's index link. */
function narrator(
	id: string,
	owner = "viewer",
	project: string | null = null,
	parent: string | null = null,
	variant = "primary",
) {
	sqlite
		.prepare(
			"INSERT INTO narrators (id, owner_user_id, visibility, write_audience, cwd, parent_narrator_id, variant, created_at, updated_at) VALUES (?, ?, 'private', 'owner', ?, ?, ?, ?, ?)",
		)
		.run(id, owner, project ? "/never-probe" : null, parent, variant, time, time);
	if (project)
		sqlite
			.prepare(
				"INSERT INTO narrator_project_links (narrator_id, project_id, role, source, directory, updated_at) VALUES (?, ?, 'primary', 'cwd', '/never-probe', ?)",
			)
			.run(id, project, time);
}
function queryTrace() {
	const queries: string[] = [];
	const prepare = sqlite.prepare.bind(sqlite);
	spyOn(sqlite, "prepare").mockImplementation((...args: Parameters<typeof sqlite.prepare>) => {
		queries.push(args[0]);
		return prepare(...args);
	});
	return queries;
}
function message(
	id: string,
	seq: number,
	content: unknown,
	parent: string | null = null,
	author = "n1",
) {
	sqlite
		.prepare(
			"INSERT INTO narrator_messages (id, narrator_id, parent_tool_use_id, role, content_json, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)",
		)
		.run(id, author, parent, JSON.stringify(content), time);
	sqlite
		.prepare(
			"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, 'n1', ?, ?)",
		)
		.run(`ref-${id}`, id, seq);
}
beforeEach(() => {
	mock.restore();
	cleanDb(sqlite);
	for (const id of ["viewer", "other"])
		sqlite
			.prepare(
				"INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'secret', 'user', ?)",
			)
			.run(id, id, time);
});
afterAll(() => {
	mock.restore();
	mock.module("../../db", () => realDbModule);
	cleanDb(sqlite);
});

describe("request-local narrator loading", () => {
	test("real detail route never probes Git and the authenticated deferred endpoint returns nullable summary", async () => {
		narrator("n1");
		const summary = spyOn(gitSummaryModule, "getNarratorGitSummary").mockResolvedValue(null);
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("user", { sub: "viewer", role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
			await next();
		});
		app.route("/api/narrators", narratorRoutes);
		const detail = await app.request("/api/narrators/n1");
		expect(detail.status).toBe(200);
		expect(await detail.json()).toMatchObject({
			id: "n1",
			gitSummary: null,
			navigationSummary: { projectId: null },
		});
		expect(summary).not.toHaveBeenCalled();
		const deferred = await app.request("/api/narrators/n1/git/summary");
		expect(deferred.status).toBe(200);
		expect(await deferred.json()).toBeNull();
		expect(summary).toHaveBeenCalledTimes(1);
	});

	test("ModelTrace detail returns an authorized source for mobile Return, not a hidden or deleted parent", async () => {
		const { returnFromModelTrace } = await import(
			"../../../frontend/components/narrator/interaction/model-trace-return"
		);
		narrator("source");
		narrator("trace", "viewer", null, "source");
		sqlite
			.prepare("UPDATE narrators SET traits = ? WHERE id = 'trace'")
			.run(JSON.stringify(["modeltrace"]));
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("user", { sub: "viewer", role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
			await next();
		});
		app.route("/api/narrators", narratorRoutes);
		async function detailAndReturn() {
			const response = await app.request("/api/narrators/trace");
			expect(response.status).toBe(200);
			const detail = await response.json();
			const navigateToNarrator = mock(() => {});
			const navigateToDefault = mock(() => {});
			returnFromModelTrace({ narrator: detail, navigateToNarrator, navigateToDefault });
			return { detail, navigateToNarrator, navigateToDefault };
		}
		const readable = await detailAndReturn();
		expect(readable.detail.navigationSummary.parentNarratorId).toBe("source");
		expect(readable.navigateToNarrator).toHaveBeenCalledWith("source");
		expect(readable.navigateToDefault).not.toHaveBeenCalled();
		sqlite.prepare("UPDATE narrators SET owner_user_id = 'other' WHERE id = 'source'").run();
		const hidden = await detailAndReturn();
		expect(hidden.detail.navigationSummary.parentNarratorId).toBeNull();
		expect(hidden.navigateToNarrator).not.toHaveBeenCalled();
		expect(hidden.navigateToDefault).toHaveBeenCalledTimes(1);
		sqlite.prepare("UPDATE narrators SET parent_narrator_id = NULL WHERE id = 'trace'").run();
		sqlite.prepare("DELETE FROM narrators WHERE id = 'source'").run();
		const deleted = await detailAndReturn();
		expect(deleted.detail.navigationSummary.parentNarratorId).toBeNull();
		expect(deleted.navigateToDefault).toHaveBeenCalledTimes(1);
	});

	test("actual display page retains creator/avatar and encrypted reasoning presence after repeated projection", async () => {
		narrator("n1");
		message("creator", 1, [
			{
				type: "thinking",
				thinking: "",
				providerMetadata: { openai: { reasoningEncryptedContent: "replay-secret" } },
			},
		]);
		sqlite.prepare("UPDATE narrator_messages SET created_by = 'viewer' WHERE id = 'creator'").run();
		const page = await narratorMessageQueries.getPretextDocumentPage("n1", { limit: 1 });
		expect(page.messages[0]?.creator).toMatchObject({ id: "viewer", username: "viewer" });
		expect(Object.keys(page.messages[0]?.creator ?? {}).sort()).toEqual([
			"avatarColor",
			"avatarImageId",
			"id",
			"username",
		]);
		expect(page.messages[0]?.contentJson).toEqual([
			{ type: "thinking", thinking: "", providerMetadata: { hasEncryptedReasoning: true } },
		]);
	});

	test("cancellation and withdrawal during worker wait are enforced by actual page entry", async () => {
		narrator("n1");
		message("top", 1, [{ type: "text", text: "hello" }]);
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(
			narratorMessageQueries.getPretextDocumentPage("n1", { signal: cancelled.signal }),
		).rejects.toMatchObject({ statusCode: 499, code: "DISPLAY_PAGE_CANCELLED" });
		const read = displayReaderModule.readDisplayFixtureMessages;
		spyOn(displayReaderModule, "readDisplayFixtureMessages").mockImplementation(async (...args) => {
			const result = await read(...args);
			sqlite.prepare("DELETE FROM narrator_message_refs WHERE id = 'ref-top'").run();
			return result;
		});
		await expect(
			narratorMessageQueries.getPretextDocumentPage("n1", { limit: 1 }),
		).rejects.toMatchObject({ statusCode: 409, code: "HISTORY_AGGREGATE_UNAVAILABLE" });
	});
	test("read middleware snapshot is reusable without a second query, never as write, and require remains fresh", async () => {
		narrator("n1");
		const app = new Hono();
		app.onError((error) => Response.json({ error: error.message }, { status: 404 }));
		app.use("*", async (c, next) => {
			c.set("user", { sub: "viewer", role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
			await requireNarratorAccess(c, "n1", "read");
			await next();
		});
		app.get("/read", (c) =>
			c.json({
				id: getAuthorizedNarrator(c, "n1", "read")?.id,
				write: !!getAuthorizedNarrator(c, "n1", "write"),
			}),
		);
		app.get("/fresh", async (c) => {
			sqlite.prepare("UPDATE narrators SET owner_user_id = 'other' WHERE id = 'n1'").run();
			await requireNarratorAccess(c, "n1", "read");
			return c.json({ leaked: true });
		});
		const queries = queryTrace();
		expect(await (await app.request("/read")).json()).toEqual({ id: "n1", write: false });
		expect(queries.filter((query) => query.includes('from "narrators"'))).toHaveLength(1);
		expect((await app.request("/fresh")).status).toBe(404);
	});

	test("exact refs cache keys by version, not insert-only counts, and eviction remains bounded", async () => {
		narrator("n1");
		message("one", 1, []);
		message("two", 2, []);
		sqlite
			.prepare("UPDATE narrators SET message_count = 99, message_version = 7 WHERE id = 'n1'")
			.run();
		const queries = queryTrace();
		expect(await countNarratorMessageRefs("n1", 7)).toBe(2);
		const afterFirst = queries.length;
		expect(await countNarratorMessageRefs("n1", 7)).toBe(2);
		expect(queries.length).toBe(afterFirst);
		sqlite.prepare("DELETE FROM narrator_message_refs WHERE id = 'ref-two'").run();
		sqlite.prepare("UPDATE narrators SET message_version = 8 WHERE id = 'n1'").run();
		expect(await countNarratorMessageRefs("n1", 8)).toBe(1);
		for (let i = 0; i < 260; i++) {
			narrator(`evict-${i}`);
			await countNarratorMessageRefs(`evict-${i}`, 0);
		}
		const beforeReload = queries.length;
		expect(await countNarratorMessageRefs("n1", 8)).toBe(1);
		expect(queries.length).toBe(beforeReload + 1);
	});

	test("navigation uses only readable parent and project summaries", async () => {
		sqlite
			.prepare(
				"INSERT INTO projects (id, name, git_path, owner_user_id, visibility, created_at, updated_at) VALUES ('project', 'Project', '/never-probe', 'viewer', 'private', ?, ?)",
			)
			.run(time, time);
		narrator("parent", "viewer", "project");
		narrator("hidden", "other", "project");
		const principal = { userId: "viewer", isAdmin: false };
		const result = await getNarratorNavigationSummary(
			{
				id: "child",
				parentNarratorId: "parent",
				variant: "subagent:general",
				contextProjectId: null,
			},
			principal,
		);
		expect(result).toEqual({
			parentNarratorId: "parent",
			parentNarratorTitle: null,
			projectId: "project",
		});
		expect(
			await getNarratorNavigationSummary(
				{
					id: "hidden-child",
					parentNarratorId: "hidden",
					variant: "subagent:general",
					contextProjectId: null,
				},
				principal,
			),
		).toEqual({
			parentNarratorId: null,
			parentNarratorTitle: null,
			projectId: null,
		});
		const primary = {
			id: "parent",
			parentNarratorId: null,
			variant: "primary",
			contextProjectId: null,
		};
		expect((await getNarratorNavigationSummary(primary, principal)).projectId).toBe("project");
		sqlite.prepare("UPDATE projects SET owner_user_id = 'other' WHERE id = 'project'").run();
		expect(await getNarratorNavigationSummary(primary, principal)).toEqual({
			parentNarratorId: null,
			parentNarratorTitle: null,
			projectId: null,
		});
	});

	test("standalone navigation honors explicit project grants but never knowledge-domain credentials", async () => {
		sqlite
			.prepare(
				"INSERT INTO projects (id, name, git_path, owner_user_id, visibility, created_at, updated_at) VALUES ('project', 'Project', '/never-probe', 'other', 'private', ?, ?)",
			)
			.run(time, time);
		sqlite
			.prepare(
				"INSERT INTO acl_grants (id, scope_type, scope_id, principal_type, principal_id, capability, created_at) VALUES ('grant', 'project', 'project', 'user', 'viewer', 'read', ?)",
			)
			.run(time);
		const row = {
			id: "standalone",
			parentNarratorId: null,
			variant: "primary",
			contextProjectId: "project",
		};
		expect(
			(await getNarratorNavigationSummary(row, { userId: "viewer", isAdmin: false })).projectId,
		).toBe("project");
		sqlite
			.prepare(
				"UPDATE acl_grants SET domain_kind = 'clearance', domain_value = 'low' WHERE id = 'grant'",
			)
			.run();
		expect(
			(await getNarratorNavigationSummary(row, { userId: "viewer", isAdmin: false })).projectId,
		).toBeNull();
	});

	test("mixed inline and child cards resolve initial aggregation once, narrow creators, and keep the final version assertion", async () => {
		narrator("n1");
		narrator("inline");
		message("top", 1, [
			{ type: "tool_use", id: "inline-use", name: "Bash", input: {} },
			{ type: "tool_use", id: "agent-use", name: "Agent", input: {} },
		]);
		message("inline-msg", 2, [{ type: "text", text: "inline" }], "inline-use", "inline");
		for (const [id, name] of [
			["inline-use", "Bash"],
			["agent-use", "Agent"],
		])
			sqlite
				.prepare(
					"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, input_json, status, created_at) VALUES (?, 'n1', 'top', ?, ?, '{}', 'completed', ?)",
				)
				.run(`tool-${id}`, id as string, name as string, time);
		const queries = queryTrace();
		const page = await narratorMessageQueries.getPretextDocumentPage("n1", { limit: 32 });
		expect(page.messages).toHaveLength(1);
		expect(page.messages[0]?.children).toHaveLength(1);
		const scopeQueries = queries.filter(
			(query) =>
				query.includes("aggregate_ref.seq") && query.includes('from "narrator_tool_calls"'),
		);
		// One initial union resolve plus one post-summary withdrawal guard, not two initial resolves.
		expect(scopeQueries).toHaveLength(2);
		console.info("Display-page SQLite driver query counts", {
			total: queries.length,
			aggregateParentReads: scopeQueries.length,
		});
		// One narrow metadata read: the run registration (own-turn placement) and version.
		expect(
			queries.some(
				(query) =>
					query.includes('"runtime_registration_json"') && query.includes('"message_version"'),
			),
		).toBe(true);
		expect(
			queries
				.filter((query) => query.includes('"creator"'))
				.every((query) => !query.includes("password_hash")),
		).toBe(true);
		await expect(
			narratorMessageQueries.getPretextDocumentPage("n1", {
				messageVersion: page.messageVersion + 1,
			}),
		).rejects.toMatchObject({ statusCode: 409, code: "PRETEXT_DOCUMENT_CHANGED" });
	});
});
