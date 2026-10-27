/**
 * Global search scope and grouping.
 *
 * The default scope is what people wrote and read in primary sessions: a search must not list
 * every subagent run, every session a knowledge entry was injected into, or every tool output
 * that happens to mention the term. Each `include` flag brings one of those back. Message hits
 * are then grouped per narrator so one long session cannot fill the page.
 */
import { describe, expect, mock, test } from "bun:test";
import { getTestDb } from "../../../../tests/setup";
import {
	CONVERSATION_MESSAGE_SCOPE,
	type EntitySearchQuery,
	FULL_MESSAGE_SCOPE,
	type MessageSearchRow,
} from "../types";

const { db, sqlite } = getTestDb();
mock.module("../../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const { ensureFts, replaceBlockIndexText } = await import("../../../db/fts");
ensureFts(sqlite, { skipUncleanShutdownRebuild: true });

const { createSqliteSearchStore } = await import("../sqlite-store");
const store = createSqliteSearchStore(async (sql, params) =>
	sqlite.prepare<Record<string, unknown>, typeof params>(sql).all(...params),
);
const { groupMessageHits, messageCandidateLimit } = await import("../../search-service");

const NOW = "2026-10-01T00:00:00.000Z";

function run(sql: string, params: unknown[] = []): void {
	sqlite.prepare(sql).run(...(params as never[]));
}

run(`INSERT INTO users (id, username, password_hash, created_at) VALUES ('u1', 'u1', 'x', ?)`, [
	NOW,
]);
run(
	`INSERT INTO projects (id, name, visibility, owner_user_id, created_at, updated_at)
	 VALUES ('p1', 'Project', 'public', 'u1', ?, ?)`,
	[NOW, NOW],
);
for (const [id, type, title] of [
	["primary", "primary", "zebrafish primary session"],
	["sub", "subagent", "zebrafish explore subagent"],
] as const) {
	run(
		`INSERT INTO narrators (id, context_project_id, title, type, visibility, owner_user_id, created_at, updated_at)
		 VALUES (?, 'p1', ?, ?, 'public', 'u1', ?, ?)`,
		[id, title, type, NOW, NOW],
	);
}

/** [id, narrator, role, origin, text] */
const MESSAGES: [string, string, string, string | null, string][] = [
	["m-user", "primary", "user", null, "how do zebrafish fins regrow"],
	["m-assistant", "primary", "assistant", null, "zebrafish regrow fins through blastema"],
	["m-hint", "primary", "sys", "system", "knowledge hint: zebrafish handbook entry"],
	["m-auto", "primary", "user", "system", "scheduled task: summarize zebrafish notes"],
	["m-sub", "sub", "assistant", null, "found zebrafish references in three files"],
	["m-tool", "primary", "assistant", null, "let me look"],
	["m-ctx", "primary", "user", null, ""],
];
MESSAGES.forEach(([id, narrator, role, origin, text], index) => {
	run(
		`INSERT INTO narrator_messages (id, narrator_id, role, origin, content_json, content_text, created_at)
		 VALUES (?, ?, ?, ?, '[]', ?, ?)`,
		[id, narrator, role, origin, text || null, `2026-10-01T00:00:0${index}.000Z`],
	);
});

/** Blocks whose text only the block index holds: a tool result and an injected context. */
for (const [id, message, kind, subtype, text] of [
	["b-tool", "m-tool", "tool", "Grep", 'Grep {"pattern":"zebrafish"} src/zebrafish.ts'],
	["b-ctx", "m-ctx", "context", "todo_reminder", "zebrafish reminder injected by the runtime"],
] as const) {
	run(
		`INSERT INTO narrator_blocks (id, message_id, ordinal, kind, subtype, wire_id, created_at, payload)
		 VALUES (?, ?, 0, ?, ?, ?, ?, '{}')`,
		[id, message, kind, subtype, kind === "tool" ? `call-${id}` : null, NOW],
	);
	replaceBlockIndexText(sqlite, id, text);
}

function query(scope: EntitySearchQuery["scope"], text = "zebrafish"): EntitySearchQuery {
	return {
		text,
		strategy: "index",
		limit: 50,
		sort: "time",
		viewer: { userId: "u1", isAdmin: true },
		scope,
	};
}

async function messageIds(scope: EntitySearchQuery["scope"]): Promise<string[]> {
	return (await store.searchMessages(query(scope))).map((row) => row.id).sort();
}

describe("message search scope", () => {
	test("the conversation scope keeps only what people wrote and read in primary sessions", async () => {
		expect(await messageIds(CONVERSATION_MESSAGE_SCOPE)).toEqual(["m-assistant", "m-user"]);
	});

	test("an omitted scope searches everything, as before scopes existed", async () => {
		const all = ["m-assistant", "m-auto", "m-ctx", "m-hint", "m-sub", "m-tool", "m-user"];
		expect(await messageIds(undefined)).toEqual(all);
		expect(await messageIds(FULL_MESSAGE_SCOPE)).toEqual(all);
	});

	test("each include flag brings back exactly its own content", async () => {
		const base = CONVERSATION_MESSAGE_SCOPE;
		expect(await messageIds({ ...base, subagents: true })).toEqual([
			"m-assistant",
			"m-sub",
			"m-user",
		]);
		expect(await messageIds({ ...base, system: true })).toEqual([
			"m-assistant",
			"m-auto",
			"m-ctx",
			"m-hint",
			"m-user",
		]);
		expect(await messageIds({ ...base, tools: true })).toEqual(["m-assistant", "m-tool", "m-user"]);
	});

	test("the substring path applies the same scope", async () => {
		const rows = await store.searchMessages({
			...query(CONVERSATION_MESSAGE_SCOPE, "zebrafish"),
			strategy: "substring",
		});
		expect(rows.map((row) => row.id).sort()).toEqual(["m-assistant", "m-user"]);
	});
});

describe("narrator search scope", () => {
	test("subagent titles are found only when subagents are included", async () => {
		const ids = async (scope: EntitySearchQuery["scope"]) =>
			(await store.searchNarrators(query(scope))).map((row) => row.id).sort();
		expect(await ids(CONVERSATION_MESSAGE_SCOPE)).toEqual(["primary"]);
		expect(await ids({ ...CONVERSATION_MESSAGE_SCOPE, subagents: true })).toEqual([
			"primary",
			"sub",
		]);
	});
});

describe("modeltrace sessions are never searchable", () => {
	for (const [id, type, traits] of [
		["trace-source", "primary", "[]"],
		["trace-fork", "primary", '["other"]'],
		["trace-sub", "subagent", "[]"],
		["trace-hidden", "primary", '["other","modeltrace"]'],
	] as const) {
		run(
			`INSERT INTO narrators (id, title, type, traits, parent_narrator_id, created_at, updated_at)
			 VALUES (?, 'tracefish session', ?, ?, ?, ?, ?)`,
			[id, type, traits, id === "trace-source" ? null : "trace-source", NOW, NOW],
		);
		run(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, content_text, created_at)
			 VALUES (?, ?, 'assistant', '[]', 'tracefish history', ?)`,
			[`${id}-message`, id, NOW],
		);
		run(
			`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq)
			 VALUES (?, ?, ?, 1)`,
			[`${id}-ref`, id, `${id}-message`],
		);
		run(
			`INSERT INTO narrator_blocks (id, message_id, ordinal, kind, created_at, payload)
			 VALUES (?, ?, 0, 'output', ?, '{}')`,
			[`${id}-block`, `${id}-message`, NOW],
		);
		replaceBlockIndexText(sqlite, `${id}-block`, "tracefish history");
	}
	for (const id of ["trace-hidden", "trace-fork"]) {
		run(
			`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq)
			 VALUES (?, ?, 'trace-source-message', 0)`,
			[`${id}-shared`, id],
		);
	}
	const visible = ["trace-fork", "trace-source", "trace-sub"];
	for (const blockOnly of [false, true]) {
		const traceStore = createSqliteSearchStore(
			async (sql, params) =>
				sqlite.prepare<Record<string, unknown>, typeof params>(sql).all(...params),
			{ blockOnly: () => blockOnly },
		);
		for (const strategy of ["index", "substring"] as const) {
			test(`${strategy}, blockOnly=${blockOnly}: filters before LIMIT and retains source/forks/subagents`, async () => {
				const q = { ...query(FULL_MESSAGE_SCOPE, "tracefish"), strategy, limit: 3 };
				expect((await traceStore.searchNarrators(q)).map((r) => r.id).sort()).toEqual(visible);
				expect((await traceStore.searchMessages(q)).map((r) => r.narratorId).sort()).toEqual(
					visible,
				);
				expect(
					(await traceStore.searchSessionAggregates(q)).map((r) => r.narratorId).sort(),
				).toEqual(visible);
				const recall = { text: q.text, strategy, limit: 3, previewChars: 200 };
				expect(
					(await traceStore.searchRecallMessages({ ...recall, narratorId: null }))
						.map((r) => r.narratorId)
						.sort(),
				).toEqual(visible);
				expect(
					await traceStore.searchRecallMessages({ ...recall, narratorId: "trace-hidden" }),
				).toEqual([]);
				expect(
					(await traceStore.searchRecallMessages({ ...recall, narratorId: "trace-fork" }))
						.map((r) => r.messageId)
						.sort(),
				).toEqual(["trace-fork-message", "trace-source-message"]);
				const timeline = { text: q.text, strategy, limit: 3, inheritedScopes: [] };
				for (const inheritedScopes of [[], [{ narratorId: "trace-source", upperBoundSeq: 2 }]]) {
					expect(
						await traceStore.searchTimeline({
							...timeline,
							inheritedScopes,
							narratorId: "trace-hidden",
						}),
					).toEqual([]);
				}
				expect(
					(await traceStore.searchTimeline({ ...timeline, narratorId: "trace-source" })).map(
						(r) => r.messageId,
					),
				).toEqual(["trace-source-message"]);
				expect(
					(await traceStore.searchTimeline({ ...timeline, narratorId: "trace-fork" })).map(
						(r) => r.messageId,
					),
				).toEqual(["trace-fork-message", "trace-source-message"]);
			});
		}
	}
});

function row(id: string, narratorId: string | null): MessageSearchRow {
	return {
		id,
		narratorId,
		narratorTitle: null,
		projectName: null,
		model: null,
		messageRole: "assistant",
		createdAt: null,
		snippet: id,
		preview: "",
		rank: null,
	};
}

describe("groupMessageHits", () => {
	test("groups by narrator in arrival order, keeping the best hit first", () => {
		const groups = groupMessageHits(
			[row("a1", "A"), row("b1", "B"), row("a2", "A"), row("a3", "A"), row("a4", "A")],
			10,
		);
		expect(groups.map((group) => group.best.id)).toEqual(["a1", "b1"]);
		expect(groups[0].hits.map((hit) => hit.id)).toEqual(["a1", "a2", "a3"]);
		expect(groups[0].hitCount).toBe(4);
		expect(groups[1].hitCount).toBe(1);
	});

	test("one long session cannot crowd out the others", () => {
		const rows = [
			...Array.from({ length: 40 }, (_, i) => row(`a${i}`, "A")),
			row("b1", "B"),
			row("c1", "C"),
		];
		expect(groupMessageHits(rows, 3).map((group) => group.best.id)).toEqual(["a0", "b1", "c1"]);
	});

	test("stops opening groups at the limit but still counts hits of open ones", () => {
		const groups = groupMessageHits([row("a1", "A"), row("b1", "B"), row("a2", "A")], 1);
		expect(groups).toHaveLength(1);
		expect(groups[0].hitCount).toBe(2);
	});

	test("a row without a narrator is its own group", () => {
		const groups = groupMessageHits([row("x1", null), row("x2", null)], 10);
		expect(groups.map((group) => group.best.id)).toEqual(["x1", "x2"]);
	});

	test("reads several candidates per group, within a hard ceiling", () => {
		expect(messageCandidateLimit(10)).toBe(50);
		expect(messageCandidateLimit(100)).toBe(500);
		expect(messageCandidateLimit(1000)).toBe(500);
	});
});
