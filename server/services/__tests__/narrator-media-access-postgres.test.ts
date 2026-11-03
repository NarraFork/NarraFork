import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mediaRefToContentBlock } from "@shared/media-attachments";
import { drizzle } from "drizzle-orm/pg-proxy";

const realDb = { ...(await import("../../db")) };
const queries: { sql: string; params: unknown[] }[] = [];
const MEDIA_ID = "media-01";
const IMAGE_ID = "image-01";
const mediaBlock = mediaRefToContentBlock({
	mediaId: MEDIA_ID,
	mediaType: "audio/wav",
	filename: "a.wav",
	size: 60,
	uploadNarratorId: "source",
});
const imageBlock = {
	type: "image",
	imageId: IMAGE_ID,
	filename: "a.png",
	mediaType: "image/png",
	uploadNarratorId: "source",
};
const imagesOutput = {
	_text: "inspected",
	_images: [{ imageId: IMAGE_ID, mediaType: "image/png", uploadNarratorId: "source" }],
};

/** What the second window's candidate holds, and what its tool call stores. */
let fixture: { content: unknown[]; output: unknown | undefined };
let revoked = false;

// The jsonText codec JSON.parses every stored value on read, so a row's driver value is
// the JSON text of what the application stored. A plain-string tool output arrives as
// JSON text of a string, and must stay a string after decoding.
const stored = (value: unknown) => JSON.stringify(value);

const pgDb = drizzle(async (sql, params) => {
	queries.push({ sql, params });
	if (sql.includes('from "narrator_message_refs"') && !sql.includes('join "narrator_messages"')) {
		return { rows: revoked ? [] : [[params[0]]] };
	}
	if (sql.includes('from "narrator_message_refs"')) {
		// Keys: a full first read of 256 small refs, then one more ref in the second read.
		if (params.includes("ref-255")) return { rows: [["ref-256", 0, "message-256", "100"]] };
		return {
			rows: Array.from({ length: 256 }, (_, i) => [
				`ref-${String(i).padStart(3, "0")}`,
				0,
				`message-${i}`,
				"100",
			]),
		};
	}
	if (sql.includes('from "narrator_messages"') && sql.includes("strpos(")) {
		// The candidate test: only message-256 holds the id.
		return { rows: params.includes("message-256") ? [["message-256"]] : [] };
	}
	if (sql.includes('from "narrator_messages"')) {
		return { rows: [["message-256", "other", stored(fixture.content)]] };
	}
	if (sql.includes('from "narrator_tool_calls"')) {
		return {
			rows:
				fixture.output === undefined
					? []
					: [["tool-1", "message-256", "other", stored(fixture.output)]],
		};
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
const { narratorReferencesMedia, narratorReferencesImage } = await import(
	"../narrator-media-access"
);
afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.restore();
});
beforeEach(() => {
	queries.length = 0;
	revoked = false;
});

const keyReads = () => queries.filter((q) => q.sql.includes('join "narrator_messages"'));
const candidateTests = () =>
	queries.filter((q) => q.sql.includes('from "narrator_messages"') && q.sql.includes("strpos("));

test("PostgreSQL sizes windows, prefilters them in SQL and decodes only candidates", async () => {
	fixture = { content: [mediaBlock], output: undefined };
	expect(await narratorReferencesMedia("context", "source", MEDIA_ID)).toBe(true);
	expect(keyReads()).toHaveLength(2);
	expect(keyReads()[0].sql).toContain("octet_length(");
	expect(keyReads()[0].params).toContain("context");
	expect(keyReads()[1].params).toContain("ref-255");
	expect(candidateTests()).toHaveLength(2);
	expect(candidateTests()[0].params).toContain(MEDIA_ID);
	const bodies = queries.filter(
		(q) =>
			q.sql.includes('from "narrator_messages"') &&
			!q.sql.includes("join") &&
			!q.sql.includes("strpos("),
	);
	expect(bodies).toHaveLength(1);
	expect(bodies[0].params).toEqual(["message-256"]);
	expect(await narratorReferencesMedia("context", "wrong", MEDIA_ID)).toBe(false);
});

test("PostgreSQL proves image references in content and tool output, re-checking the ref", async () => {
	fixture = { content: [imageBlock], output: undefined };
	expect(await narratorReferencesImage("context", "source", IMAGE_ID)).toBe(true);
	expect(await narratorReferencesImage("context", "wrong", IMAGE_ID)).toBe(false);

	fixture = { content: [], output: imagesOutput };
	expect(await narratorReferencesImage("context", "source", IMAGE_ID)).toBe(true);
	const tools = queries.filter((q) => q.sql.includes('from "narrator_tool_calls"'));
	expect(tools.at(-1)?.sql).toContain("strpos(");
	expect(tools.at(-1)?.params).toContain("message-256");
	revoked = true;
	expect(await narratorReferencesImage("context", "source", IMAGE_ID)).toBe(false);
});

test("PostgreSQL never re-parses a plain-string tool output into a reference", async () => {
	fixture = { content: [], output: JSON.stringify(imagesOutput) };
	expect(await narratorReferencesImage("context", "source", IMAGE_ID)).toBe(false);
	fixture = { content: [], output: JSON.stringify({ _media: [mediaBlock] }) };
	expect(await narratorReferencesMedia("context", "source", MEDIA_ID)).toBe(false);
	// The structured form of the same media output still counts.
	fixture = { content: [], output: { _media: [mediaBlock] } };
	expect(await narratorReferencesMedia("context", "source", MEDIA_ID)).toBe(true);
});
