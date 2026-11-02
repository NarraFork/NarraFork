import { afterAll, expect, mock, test } from "bun:test";
import { mediaRefToContentBlock } from "@shared/media-attachments";
import { drizzle } from "drizzle-orm/pg-proxy";

const realDb = { ...(await import("../../db")) };
const queries: { sql: string; params: unknown[] }[] = [];
const block = mediaRefToContentBlock({
	mediaId: "media",
	mediaType: "audio/wav",
	filename: "a.wav",
	size: 60,
	uploadNarratorId: "source",
});
let mode: "message" | "tool" = "message";
let revoked = false;
const pgDb = drizzle(async (sql, params) => {
	queries.push({ sql, params });
	if (sql.includes('from "narrator_message_refs"') && !sql.includes('join "narrator_messages"')) {
		return { rows: revoked ? [] : [[params[0]]] };
	}
	if (sql.includes('from "narrator_message_refs"')) {
		const secondPage = params.includes("ref-15");
		const rows = secondPage
			? [["message-16", "other", 0, "ref-16", JSON.stringify(mode === "message" ? [block] : [])]]
			: Array.from({ length: 16 }, (_, i) => [
					`message-${i}`,
					"other",
					0,
					`ref-${String(i).padStart(2, "0")}`,
					"[]",
				]);
		return { rows };
	}
	if (sql.includes('from "narrator_tool_calls"')) {
		if (mode === "tool" && params.includes("tool-63"))
			return { rows: [["tool-64", "message-0", "source", JSON.stringify({ _media: [block] })]] };
		if (mode === "tool")
			return {
				rows: Array.from({ length: 64 }, (_, i) => [
					`tool-${String(i).padStart(2, "0")}`,
					"message-0",
					"source",
					"{}",
				]),
			};
		return { rows: [] };
	}
	throw new Error(`Unexpected PostgreSQL query: ${sql}`);
});
const unavailable = new Proxy(
	{},
	{
		get() {
			throw new Error("SQLite must not be used");
		},
	},
);
mock.module("../../db", () => ({
	...realDb,
	db: unavailable,
	sqlite: unavailable,
	postgresRuntime: { client: { db: pgDb } },
}));
const { narratorReferencesMedia } = await import("../narrator-media-access");
afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.restore();
});

test("PostgreSQL pages exact message references without accessing SQLite", async () => {
	mode = "message";
	queries.length = 0;
	expect(await narratorReferencesMedia("context", "source", "media")).toBe(true);
	expect(queries.filter((q) => q.sql.includes('join "narrator_messages"'))).toHaveLength(2);
	expect(queries[0].params).toContain("context");
	expect(queries[2].params).toContain("ref-15");
	expect(await narratorReferencesMedia("context", "wrong", "media")).toBe(false);
});

test("PostgreSQL pages tool calls joined by referenced message", async () => {
	mode = "tool";
	queries.length = 0;
	expect(await narratorReferencesMedia("context", "source", "media")).toBe(true);
	const tools = queries.filter((q) => q.sql.includes('from "narrator_tool_calls"'));
	expect(tools).toHaveLength(2);
	expect(tools[0].params).toContain("message-0");
	expect(tools[1].params).toContain("tool-63");
	const recheck = queries.find(
		(q) =>
			q.sql.includes('from "narrator_message_refs"') && !q.sql.includes('join "narrator_messages"'),
	);
	expect(recheck?.params).toContain("ref-00");
	expect(recheck?.params).toContain("message-0");
	expect(recheck?.params).toContain("context");
	revoked = true;
	try {
		expect(await narratorReferencesMedia("context", "source", "media")).toBe(false);
	} finally {
		revoked = false;
	}
});
