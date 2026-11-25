/**
 * Alias occupancy and Send/Await/Watch resolution share one set: members of this
 * parent that are still addressable (idle, working, waiting). Archived history,
 * however large, is neither selectable nor a reason to refuse a new name.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import {
	backfillNarratorAliasSelectors,
	recomputeNarratorAliasSelectors,
} from "../../db/alias-selector-backfill";
import { backgroundTasks, narrators } from "../../db/schema";
import { delegationRegistration } from "../../lib/validators/runtime-registration";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));

const aliases = await import("../subagent-alias");
const { resolveSubagentTargets, awaitAgentResultDetailed, resolveAgentLifecycleTarget } =
	await import("../agent-communication");
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
	createdAt?: string;
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
			createdAt: row.createdAt ?? NOW,
			updatedAt: row.createdAt ?? NOW,
		})
		.run();
}

async function messageFrom(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "";
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

test("restoring an archived agent suffixes an alias a live sibling still holds", async () => {
	seedMember({
		id: "restored-review",
		status: "archived",
		title: "Review",
		titleSlug: "review",
		aliasSelector: "review",
		traits: ["subagent-alias:review"],
	});
	seedMember({
		id: "live-review",
		title: "Review",
		titleSlug: "review",
		aliasSelector: "review",
		traits: ["subagent-alias:review"],
	});
	db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, "restored-review")).run();

	await aliases.reconcileRestoredSubagentAlias("restored-review");

	const restored = db.select().from(narrators).where(eq(narrators.id, "restored-review")).get();
	const live = db.select().from(narrators).where(eq(narrators.id, "live-review")).get();
	expect(restored?.aliasSelector).toBe("review-2");
	expect(live?.aliasSelector).toBe("review");
	const targets = await resolveSubagentTargets({ callerNarratorId: PARENT, id: "review" });
	expect(targets.map((target) => target.id)).toEqual(["live-review"]);
});

test("duplicate title slugs do not hide a later occupied suffix", async () => {
	const registration = JSON.stringify(delegationRegistration(PARENT, "general"));
	const insert = sqlite.prepare(
		`INSERT INTO narrators (
			id, type, variant, parent_narrator_id, policy_source_narrator_id, status,
			title, title_slug, alias_selector, traits, runtime_registration_json,
			created_at, updated_at
		) VALUES (?, 'subagent', 'subagent:general', ?, ?, 'idle', 'Build-2', 'build-2', ?, ?, ?, ?, ?)`,
	);
	sqlite.transaction(() => {
		for (let i = 0; i < 32; i++) {
			const alias = `worker-${i}`;
			insert.run(
				`worker-${i}`,
				PARENT,
				PARENT,
				alias,
				JSON.stringify([`subagent-alias:${alias}`]),
				registration,
				NOW,
				NOW,
			);
		}
	})();
	seedMember({
		id: "holds-build",
		title: "Build",
		titleSlug: "build",
		aliasSelector: "other-build",
		traits: ["subagent-alias:other-build"],
	});
	seedMember({
		id: "holds-build-3",
		title: "Build-3",
		titleSlug: "build-3",
		aliasSelector: "other-build-3",
		traits: ["subagent-alias:other-build-3"],
	});
	seedMember({ id: "newcomer" });

	expect((await aliases.registerAndPersistSubagentAlias(PARENT, "newcomer", "build")).alias).toBe(
		"build-4",
	);
});

test("a newer task of the agent being registered does not hide an older live owner", async () => {
	seedMember({
		id: "older-owner",
		title: "Keeper",
		titleSlug: "keeper",
		aliasSelector: "keeper",
		traits: ["subagent-alias:keeper"],
	});
	seedMember({ id: "registering" });
	db.insert(backgroundTasks)
		.values({
			id: "task-older",
			parentNarratorId: PARENT,
			type: "agent",
			status: "completed",
			alias: "mine",
			subagentNarratorId: "older-owner",
			startedAt: "2026-01-01T00:00:00.000Z",
			completedAt: "2026-01-01T00:00:01.000Z",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: NOW,
		})
		.run();
	db.insert(backgroundTasks)
		.values({
			id: "task-self",
			parentNarratorId: PARENT,
			type: "agent",
			status: "completed",
			alias: "mine",
			subagentNarratorId: "registering",
			startedAt: "2026-01-02T00:00:00.000Z",
			completedAt: "2026-01-02T00:00:01.000Z",
			createdAt: "2026-01-02T00:00:00.000Z",
			updatedAt: NOW,
		})
		.run();

	expect((await aliases.registerAndPersistSubagentAlias(PARENT, "registering", "mine")).alias).toBe(
		"mine-2",
	);
});

test("archive names the addressable owner and unarchive names the archived one", async () => {
	seedMember({
		id: "old-review",
		status: "archived",
		title: "Old Review",
		titleSlug: "old-review",
		aliasSelector: "review",
		traits: ["subagent-alias:review"],
	});
	seedMember({
		id: "live-review",
		title: "Live Review",
		titleSlug: "live-review",
		aliasSelector: "review",
		traits: ["subagent-alias:review"],
	});
	db.insert(backgroundTasks)
		.values({
			id: "old-review-task",
			parentNarratorId: PARENT,
			type: "agent",
			status: "completed",
			alias: "review",
			subagentNarratorId: "old-review",
			startedAt: "2026-01-03T00:00:00.000Z",
			completedAt: "2026-01-03T00:00:01.000Z",
			createdAt: "2026-01-03T00:00:00.000Z",
			updatedAt: NOW,
		})
		.run();

	expect(await resolveAgentLifecycleTarget(PARENT, "review", "archive")).toBe("live-review");
	expect(await resolveAgentLifecycleTarget(PARENT, "review", "unarchive")).toBe("old-review");
	expect(await resolveAgentLifecycleTarget(PARENT, "old-review", "archive")).toBe("old-review");

	seedMember({
		id: "archived-dup-a",
		status: "archived",
		title: "Dup A",
		titleSlug: "dup-a",
		aliasSelector: "dup",
		traits: ["subagent-alias:dup"],
	});
	seedMember({
		id: "archived-dup-b",
		status: "archived",
		title: "Dup B",
		titleSlug: "dup-b",
		aliasSelector: "dup",
		traits: ["subagent-alias:dup"],
	});
	expect(await messageFrom(resolveAgentLifecycleTarget(PARENT, "dup", "unarchive"))).toMatch(
		/Ambiguous subagent target/,
	);
});

test("historical lookup finds an archived id and refuses a reused name", async () => {
	seedMember({
		id: "gone-id",
		status: "archived",
		title: "Gone",
		titleSlug: "gone",
		aliasSelector: "gone",
		traits: ["subagent-alias:gone"],
	});
	const byId = await resolveSubagentTargets({
		callerNarratorId: PARENT,
		id: "gone-id",
		historical: true,
	});
	expect(byId.map((target) => target.id)).toEqual(["gone-id"]);
	expect(
		await messageFrom(resolveSubagentTargets({ callerNarratorId: PARENT, id: "gone-id" })),
	).toMatch(/No accessible subagent/);

	const onlyArchived = await resolveSubagentTargets({
		callerNarratorId: PARENT,
		id: "gone",
		historical: true,
	});
	expect(onlyArchived.map((target) => target.id)).toEqual(["gone-id"]);

	seedMember({
		id: "live-gone",
		title: "Other",
		titleSlug: "other",
		aliasSelector: "gone",
		traits: ["subagent-alias:gone"],
	});
	expect(
		await messageFrom(
			resolveSubagentTargets({ callerNarratorId: PARENT, id: "gone", historical: true }),
		),
	).toMatch(/Ambiguous subagent target/);
	const stillById = await resolveSubagentTargets({
		callerNarratorId: PARENT,
		id: "gone-id",
		historical: true,
	});
	expect(stillById.map((target) => target.id)).toEqual(["gone-id"]);
	const delivery = await resolveSubagentTargets({ callerNarratorId: PARENT, id: "gone" });
	expect(delivery.map((target) => target.id)).toEqual(["live-gone"]);
});

test("recompute replaces selectors an overwrite left behind", () => {
	seedMember({
		id: "imported",
		title: "New Name",
		titleSlug: "new-name",
		aliasSelector: "new-name",
		traits: ["subagent-alias:new-name"],
	});
	seedMember({
		id: "skipped",
		title: "Keep",
		titleSlug: "stale-keep",
		aliasSelector: "stale-keep",
		traits: ["subagent-alias:fresh-keep"],
	});
	db.update(narrators)
		.set({ title: "Old Name", traits: ["subagent-alias:old-name"] })
		.where(eq(narrators.id, "imported"))
		.run();
	backfillNarratorAliasSelectors(sqlite);
	const stale = sqlite
		.query("SELECT title_slug, alias_selector FROM narrators WHERE id = 'imported'")
		.get() as { title_slug: string; alias_selector: string };
	expect(stale.title_slug).toBe("new-name");
	expect(stale.alias_selector).toBe("new-name");

	recomputeNarratorAliasSelectors(sqlite, ["imported"]);
	const rewritten = sqlite
		.query("SELECT title_slug, alias_selector FROM narrators WHERE id = 'imported'")
		.get() as { title_slug: string; alias_selector: string };
	expect(rewritten.title_slug).toBe("old-name");
	expect(rewritten.alias_selector).toBe("old-name");
	const skipped = sqlite
		.query("SELECT title_slug, alias_selector FROM narrators WHERE id = 'skipped'")
		.get() as { title_slug: string; alias_selector: string };
	expect(skipped.title_slug).toBe("stale-keep");
	expect(skipped.alias_selector).toBe("stale-keep");
});

test("unarchive still finds an archived title outside the live match window", async () => {
	for (let i = 0; i < 6; i++) {
		seedMember({
			id: `live-window-${i}`,
			title: "Review",
			titleSlug: "review",
			aliasSelector: "review",
			traits: ["subagent-alias:review"],
			createdAt: `2026-06-0${i + 1}T00:00:00.000Z`,
		});
	}
	seedMember({
		id: "archived-window",
		status: "archived",
		title: "Review",
		titleSlug: "review",
		aliasSelector: "review",
		traits: ["subagent-alias:review"],
		createdAt: "2026-01-01T00:00:00.000Z",
	});

	expect(await resolveAgentLifecycleTarget(PARENT, "review", "unarchive")).toBe("archived-window");
});

test("lifecycle and file reports stay inside the operation's team", async () => {
	seedMember({ id: "worker" });
	seedMember({
		id: "sibling-review",
		title: "Review",
		titleSlug: "review",
		aliasSelector: "review",
		traits: ["subagent-alias:review"],
	});
	seedMember({
		id: "helper-review",
		parent: "worker",
		controller: "worker",
		status: "archived",
		title: "Review",
		titleSlug: "review",
		aliasSelector: "review",
		traits: ["subagent-alias:review"],
	});

	expect(await resolveAgentLifecycleTarget("worker", "review", "unarchive")).toBe("helper-review");
	const report = await resolveSubagentTargets({
		callerNarratorId: "worker",
		id: "review",
		historical: true,
		teamId: PARENT,
	});
	expect(report.map((target) => target.id)).toEqual(["sibling-review"]);
});

test("restore suffixes the narrator and the owned agent task", async () => {
	seedMember({
		id: "live-audit",
		title: "Audit",
		titleSlug: "audit",
		aliasSelector: "audit",
		traits: ["subagent-alias:audit"],
	});
	seedMember({
		id: "restored-audit",
		title: "Audit",
		titleSlug: "audit",
		aliasSelector: "audit",
		traits: ["subagent-alias:audit"],
	});
	db.insert(backgroundTasks)
		.values({
			id: "restored-audit-task",
			parentNarratorId: PARENT,
			type: "agent",
			status: "completed",
			alias: "audit",
			subagentNarratorId: "restored-audit",
			startedAt: NOW,
			createdAt: "2026-03-01T00:00:00.000Z",
			updatedAt: NOW,
		})
		.run();

	await aliases.reconcileRestoredSubagentAlias("restored-audit");

	const stored = db.select().from(narrators).where(eq(narrators.id, "restored-audit")).get();
	expect(stored?.aliasSelector).toBe("audit-2");
	const task = db
		.select()
		.from(backgroundTasks)
		.where(eq(backgroundTasks.id, "restored-audit-task"))
		.get();
	expect(task?.alias).toBe("audit-2");
	const { backgroundTaskService } = await import("../background-task-service");
	const snapshot = await backgroundTaskService.readTaskSnapshot(PARENT, "audit-2");
	expect(snapshot?.id).toBe("restored-audit-task");
});

test("restoring a primary fork does not persist a subagent alias", async () => {
	db.insert(narrators)
		.values({
			id: "primary-fork",
			type: "primary",
			variant: "primary",
			parentNarratorId: PARENT,
			status: "idle",
			title: "Forked Session",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	seedMember({
		id: "delegated-restored",
		title: "Audit",
		titleSlug: "audit",
		aliasSelector: "audit",
		traits: ["subagent-alias:audit"],
	});

	await aliases.reconcileRestoredSubagentAlias("primary-fork");
	await aliases.reconcileRestoredSubagentAlias("delegated-restored");

	const fork = db.select().from(narrators).where(eq(narrators.id, "primary-fork")).get();
	expect(fork?.aliasSelector ?? null).toBeNull();
	expect(JSON.stringify(fork?.traits ?? [])).not.toContain("subagent-alias:");
	const restored = db.select().from(narrators).where(eq(narrators.id, "delegated-restored")).get();
	expect(restored?.aliasSelector).toBe("audit");
});

test("historical lookup of a foreign archived id matches a missing session", async () => {
	seedMember({
		id: "foreign-archived",
		parent: OTHER,
		controller: OTHER,
		status: "archived",
		title: "Secret Title",
		titleSlug: "secret-title",
		aliasSelector: "secret-title",
		traits: ["subagent-alias:secret-title"],
	});
	const { contextAskTool } = await import("../../lib/agent/tools/context-ask");
	const ctx = { narratorId: PARENT } as Parameters<typeof contextAskTool.execute>[1];
	const missing = await contextAskTool.execute(
		{ id: "missing-session", questions: ["What changed?"] },
		ctx,
	);
	const foreign = await contextAskTool.execute(
		{ id: "foreign-archived", questions: ["What changed?"] },
		ctx,
	);
	expect(foreign.output).toBe(
		String(missing.output).replaceAll("missing-session", "foreign-archived"),
	);
	expect(String(foreign.output)).not.toContain("Secret Title");
});
