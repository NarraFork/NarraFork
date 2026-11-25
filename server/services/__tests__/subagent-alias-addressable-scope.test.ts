/**
 * Alias occupancy and Send/Await/Watch resolution share one set: members of this
 * parent that are still addressable (idle, working, waiting). Archived history,
 * however large, is neither selectable nor a reason to refuse a new name.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { backfillNarratorAliasSelectors } from "../../db/alias-selector-backfill";
import { backgroundTasks, narrators } from "../../db/schema";
import { delegationRegistration } from "../../lib/validators/runtime-registration";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));

const aliases = await import("../subagent-alias");
const { resolveSubagentTargets, awaitAgentResultDetailed } = await import("../agent-communication");
const { resolveAwaitAgentNarratorIds } = await import("../await-agent-resolution");

afterAll(async () => {
	mock.module("../../db", () => realDb);
	await fixture.close();
});

const PARENT = "alias-scope-parent";
const OTHER = "alias-scope-other";
const NOW = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
	cleanDb(sqlite);
	aliases.clearAliasRegistry(PARENT);
	aliases.clearAliasRegistry(OTHER);
	db.insert(narrators)
		.values([
			{ id: PARENT, type: "primary", variant: "primary", createdAt: NOW, updatedAt: NOW },
			{ id: OTHER, type: "primary", variant: "primary", createdAt: NOW, updatedAt: NOW },
		])
		.run();
});

function seedMember(row: {
	id: string;
	parent?: string;
	status?: "idle" | "working" | "waiting" | "archived";
	title?: string | null;
	titleSlug?: string | null;
	aliasSelector?: string | null;
	traits?: string[];
	controller?: string;
}) {
	const parent = row.parent ?? PARENT;
	db.insert(narrators)
		.values({
			id: row.id,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: parent,
			policySourceNarratorId: parent,
			status: row.status ?? "idle",
			title: row.title ?? null,
			titleSlug: row.titleSlug ?? null,
			aliasSelector: row.aliasSelector ?? null,
			traits: row.traits,
			runtimeRegistrationJson: delegationRegistration(row.controller ?? parent, "general"),
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

test("a session past 1000 archived children can still register a new alias", async () => {
	const registration = JSON.stringify(delegationRegistration(PARENT, "general"));
	const insert = sqlite.prepare(
		`INSERT INTO narrators (
			id, type, variant, parent_narrator_id, policy_source_narrator_id, status,
			title, title_slug, alias_selector, traits, runtime_registration_json,
			created_at, updated_at
		) VALUES (?, 'subagent', 'subagent:general', ?, ?, 'archived', ?, ?, ?, ?, ?, ?, ?)`,
	);
	sqlite.transaction(() => {
		for (let i = 0; i < 1001; i++) {
			const alias = i === 0 ? "old-work" : `archived-${i}`;
			insert.run(
				`archived-child-${i}`,
				PARENT,
				PARENT,
				alias,
				alias,
				alias,
				JSON.stringify([`subagent-alias:${alias}`]),
				registration,
				NOW,
				NOW,
			);
		}
	})();
	seedMember({ id: "fresh-child", title: "Old Work", titleSlug: "old-work" });

	const registered = await aliases.registerAndPersistSubagentAlias(
		PARENT,
		"fresh-child",
		"old work",
	);

	expect(registered.alias).toBe("old-work");
	const stored = db.select().from(narrators).where(eq(narrators.id, "fresh-child")).get();
	expect(stored?.aliasSelector).toBe("old-work");
});

test("a live or still-addressable alias is not reused", async () => {
	seedMember({
		id: "live",
		title: "Live Work",
		titleSlug: "live-work",
		aliasSelector: "live-work",
		traits: ["subagent-alias:live-work"],
	});
	seedMember({
		id: "busy",
		status: "working",
		title: "Busy Work",
		titleSlug: "busy-work",
		aliasSelector: "busy-work-9",
		traits: ["subagent-alias:busy-work-9"],
	});
	seedMember({ id: "next-live", title: "Live Work" });
	seedMember({ id: "next-busy", title: "Busy Work" });
	db.insert(backgroundTasks)
		.values({
			id: "bash-live",
			parentNarratorId: PARENT,
			type: "bash",
			status: "running",
			alias: "shell-job",
			command: "sleep 1",
			startedAt: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(backgroundTasks)
		.values({
			id: "bash-done",
			parentNarratorId: PARENT,
			type: "bash",
			status: "completed",
			alias: "old-shell",
			command: "true",
			startedAt: NOW,
			completedAt: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	seedMember({ id: "next-shell" });
	seedMember({ id: "next-old-shell" });

	expect(
		(await aliases.registerAndPersistSubagentAlias(PARENT, "next-live", "live work")).alias,
	).toBe("live-work-2");
	expect(
		(await aliases.registerAndPersistSubagentAlias(PARENT, "next-busy", "busy work")).alias,
	).toBe("busy-work-2");
	expect(
		(await aliases.registerAndPersistSubagentAlias(PARENT, "next-shell", "shell job")).alias,
	).toBe("shell-job-2");
	expect(
		(await aliases.registerAndPersistSubagentAlias(PARENT, "next-old-shell", "old shell")).alias,
	).toBe("old-shell");
});

test("an archived unused alias is not resolved and is not occupancy", async () => {
	seedMember({
		id: "gone-agent",
		status: "archived",
		title: "Gone Agent",
		titleSlug: "gone",
		aliasSelector: "gone",
		traits: ["subagent-alias:gone"],
	});
	seedMember({
		id: "here-agent",
		title: "Here Agent",
		titleSlug: "here",
		aliasSelector: "here",
		traits: ["subagent-alias:here"],
	});
	db.update(narrators)
		.set({ isBackground: true, backgroundStatus: "completed", backgroundResult: "done" })
		.where(eq(narrators.id, "here-agent"))
		.run();
	await expect(resolveSubagentTargets({ callerNarratorId: PARENT, id: "gone" })).rejects.toThrow(
		/No accessible subagent/,
	);
	await expect(
		awaitAgentResultDetailed({
			callerNarratorId: PARENT,
			id: "gone",
			signal: new AbortController().signal,
		}),
	).rejects.toThrow(/No accessible subagent/);
	const targets = await resolveSubagentTargets({ callerNarratorId: PARENT, id: "here" });
	expect(targets.map((target) => target.id)).toEqual(["here-agent"]);
	const watched = await awaitAgentResultDetailed({
		callerNarratorId: PARENT,
		id: "here",
		signal: new AbortController().signal,
	});
	expect(watched.id).toBe("here-agent");

	const resolved = await resolveAwaitAgentNarratorIds(PARENT, [
		{ toolUseId: "await-gone", selector: "gone" },
		{ toolUseId: "await-here", selector: "here" },
		{ toolUseId: "send-gone", selector: "gone", send: true, callerId: PARENT },
		{ toolUseId: "send-here", selector: "here", send: true, callerId: PARENT },
	]);
	expect(resolved.has("await-gone")).toBe(false);
	expect(resolved.has("send-gone")).toBe(false);
	expect(resolved.get("await-here")?.id).toBe("here-agent");
	expect(resolved.get("send-here")?.id).toBe("here-agent");

	const archived = await resolveSubagentTargets({
		callerNarratorId: PARENT,
		id: "gone",
		includeArchived: true,
	});
	expect(archived.map((target) => target.id)).toEqual(["gone-agent"]);

	seedMember({ id: "reuse-gone", title: "Gone" });
	expect((await aliases.registerAndPersistSubagentAlias(PARENT, "reuse-gone", "gone")).alias).toBe(
		"gone",
	);
});

test("parent isolation still holds for siblings and grandchildren", async () => {
	seedMember({
		id: "other-live",
		parent: OTHER,
		titleSlug: "shared",
		aliasSelector: "shared",
		traits: ["subagent-alias:shared"],
	});
	seedMember({ id: "child", title: "Child" });
	seedMember({
		id: "grandchild",
		parent: "child",
		controller: "child",
		titleSlug: "nested",
		aliasSelector: "nested",
		traits: ["subagent-alias:nested"],
	});
	seedMember({ id: "on-parent" });

	expect((await aliases.registerAndPersistSubagentAlias(PARENT, "on-parent", "shared")).alias).toBe(
		"shared",
	);
	const again = await aliases.registerAndPersistSubagentAlias(PARENT, "child", "nested");
	expect(again.alias).toBe("nested");
});

test("re-registering the same subagent keeps its alias", async () => {
	seedMember({ id: "same", title: "Keep Me", titleSlug: "keep-me" });
	const first = await aliases.registerAndPersistSubagentAlias(PARENT, "same", "keep me");
	const second = await aliases.registerAndPersistSubagentAlias(PARENT, "same", "keep me");
	expect(first.alias).toBe("keep-me");
	expect(second.alias).toBe("keep-me");
	expect(second.conflicted).toBe(false);
});

test("startup backfill stores the slug and the persisted alias", () => {
	sqlite
		.prepare(
			`INSERT INTO narrators (
				id, type, parent_narrator_id, title, traits, created_at, updated_at
			) VALUES ('legacy', 'subagent', ?, 'Map Providers', ?, ?, ?)`,
		)
		.run(PARENT, JSON.stringify(["subagent-alias:map-providers"]), NOW, NOW);
	backfillNarratorAliasSelectors(sqlite);
	const row = sqlite
		.query("SELECT title_slug, alias_selector FROM narrators WHERE id = 'legacy'")
		.get() as { title_slug: string; alias_selector: string };
	expect(row.title_slug).toBe("map-providers");
	expect(row.alias_selector).toBe("map-providers");
	backfillNarratorAliasSelectors(sqlite);
	const again = sqlite.query("SELECT title_slug FROM narrators WHERE id = 'legacy'").get() as {
		title_slug: string;
	};
	expect(again.title_slug).toBe("map-providers");
});

test("candidate lookup uses the title slug index", () => {
	const plan = sqlite
		.query(
			`EXPLAIN QUERY PLAN
			 SELECT id FROM narrators
			 WHERE parent_narrator_id = ? AND title_slug = ?`,
		)
		.all(PARENT, "live-work") as Array<{ detail: string }>;
	expect(plan.some((row) => row.detail.includes("idx_narrators_parent_title_slug"))).toBe(true);
});
