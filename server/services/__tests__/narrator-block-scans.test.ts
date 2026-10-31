/**
 * Scans that find envelopes by what their bodies hold read the block tables when block
 * reads are on (docs/BLOCK_STORAGE-DESIGN.md §10.1). Each must find exactly what its
 * content_json scan finds, answer from the rows where they are current, and fall back to
 * content_json for queued and legacy envelopes.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
await import("../narrator-service");
const { settings } = await import("../../lib/settings");
const blockSync = await import("../narrator-block-sync");
const backfill = await import("../narrator-block-backfill");
const { runBlockBackfillSlice, runBlockVerifySlice, runBlockReindexSlice } = await import(
	"../../lib/db-worker/block-backfill-query"
);

/** Legacy envelopes, as the partial index holds them. */
const legacyIndexed = () =>
	(
		sqlite
			.prepare(
				"SELECT count(*) AS n FROM narrator_messages INDEXED BY idx_messages_legacy_body WHERE body_format = 1",
			)
			.get() as { n: number }
	).n;
const { referencedUploadOwnerIds } = await import("../storage-service");
const { compactToolLoadingEpoch } = await import("../narrator-epochs");

const inline = {
	backfill: async (params: Parameters<typeof runBlockBackfillSlice>[1]) =>
		runBlockBackfillSlice(sqlite, params),
	verify: async (params: Parameters<typeof runBlockVerifySlice>[1]) =>
		runBlockVerifySlice(sqlite, params),
	reindex: async (params: Parameters<typeof runBlockReindexSlice>[1]) =>
		runBlockReindexSlice(sqlite, params),
};

/** Convert every legacy envelope to block format, as the backfill does. */
async function convert(): Promise<void> {
	while (await backfill.runBlockJobSlice(inline));
}

/** The same read with block reads off (the content_json scan) and on. */
async function both<T>(read: () => T | Promise<T>): Promise<{ off: T; on: T }> {
	settings.narratorBlocks.read = false;
	const off = await read();
	settings.narratorBlocks.read = true;
	return { off, on: await read() };
}

let seq = 0;

/** A legacy envelope (`body_format = 1`) and its ref; `convert` gives it block rows. */
function envelope(
	id: string,
	content: unknown[],
	options: { narratorId?: string; role?: string; createdAt?: string; compact?: boolean } = {},
): void {
	const narratorId = options.narratorId ?? "n1";
	sqlite.run(
		`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		[
			id,
			narratorId,
			options.role ?? "system",
			JSON.stringify(content),
			options.createdAt ?? "2026-10-01T00:00:00.000Z",
		],
	);
	sqlite.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq, is_compact) VALUES (?, ?, ?, ?, ?)",
		[`ref-${id}`, narratorId, id, ++seq, options.compact ? 1 : 0],
	);
}

/** Rewrite content_json outside the store: the envelope is queued for the block sync. */
function rewrite(id: string, content: unknown[]): void {
	sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = ?", [
		JSON.stringify(content),
		id,
	]);
}

/** Make content_json alone disagree with rows that count as current, to see who answers. */
function diverge(id: string, content: unknown[]): void {
	rewrite(id, content);
	sqlite.run("DELETE FROM narrator_block_sync_queue WHERE message_id = ?", [id]);
}

const queued = (id: string) =>
	!!sqlite.prepare("SELECT 1 FROM narrator_block_sync_queue WHERE message_id = ?").get(id);

const bodyFormat = (id: string) =>
	(
		sqlite
			.prepare("SELECT body_format AS bodyFormat FROM narrator_messages WHERE id = ?")
			.get(id) as {
			bodyFormat: number;
		}
	).bodyFormat;

function reset(): void {
	cleanDb(sqlite);
	seq = 0;
	const now = "2026-10-01T00:00:00.000Z";
	for (const id of ["n1", "n2", "n3"])
		sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			id,
			id,
			now,
			now,
		]);
	sqlite.run("DELETE FROM narrator_block_backfill");
	sqlite.run("DELETE FROM narrator_block_diagnostics");
}

beforeEach(reset);
afterEach(() => {
	settings.narratorBlocks.read = true;
	settings.narratorBlocks.write = true;
});
afterAll(() => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

describe("upload owners", () => {
	const image = (imageId: string) => ({
		type: "image",
		imageId,
		filename: `${imageId}.png`,
		mediaType: "image/png",
	});
	const owners = () => [...referencedUploadOwnerIds([])].sort();

	test("image owners match the content_json scan, from asset rows", async () => {
		envelope("i1", [{ type: "text", text: "look" }, image("img1")], { role: "user" });
		// The literal in text is escaped in JSON; an image without an id is no upload.
		envelope("i2", [{ type: "text", text: '"type":"image"' }], { role: "user", narratorId: "n2" });
		envelope("i3", [{ type: "image", filename: "x.png" }], { role: "user", narratorId: "n3" });
		await convert();
		const { off, on } = await both(owners);
		expect(off).toEqual(["n1"]);
		expect(on).toEqual(off);

		diverge("i1", [{ type: "text", text: "look" }]);
		const after = await both(owners);
		expect(after.off).toEqual([]);
		expect(after.on).toEqual(["n1"]);
	});

	test("finds legacy envelopes written after the backfill finished, through the index", async () => {
		envelope("i1", [image("img1")], { role: "user" });
		await convert();
		expect(backfill.blockBackfillStatus().convert?.complete).toBe(true);
		expect(legacyIndexed()).toBe(0);
		// An import, or a write while block writes were off: legacy again, job long done.
		envelope("i2", [image("img2")], { role: "user", narratorId: "n2" });
		expect(legacyIndexed()).toBe(1);
		const { off, on } = await both(owners);
		expect(on).toEqual(off);
		expect(on).toEqual(["n1", "n2"]);
		const plan = sqlite
			.prepare(
				"EXPLAIN QUERY PLAN SELECT id FROM narrator_messages WHERE body_format = 1 AND content_json LIKE '%x%'",
			)
			.all() as Array<{ detail: string }>;
		expect(plan.map((row) => row.detail).join("\n")).toContain("idx_messages_legacy_body");
	});

	test("queued and legacy envelopes are checked on content_json", async () => {
		envelope("i1", [{ type: "text", text: "look" }], { role: "user" });
		await convert();
		rewrite("i1", [image("img1")]);
		expect(queued("i1")).toBe(true);
		settings.narratorBlocks.write = false;
		envelope("i2", [image("img2")], { role: "user", narratorId: "n2" });
		const { off, on } = await both(owners);
		expect(off).toEqual(["n1", "n2"]);
		expect(on).toEqual(off);
	});
});

describe("compact epoch", () => {
	const compact = (toolNames: string[]) => [
		{
			type: "compact",
			status: "compacted",
			summary: "x".repeat(2000),
			epoch: { reason: "compact", target: "anthropic:model", toolNames },
		},
	];

	test("the latest compact's epoch matches the content_json read, from its block", async () => {
		envelope("k1", compact(["Grep"]), { compact: true });
		envelope("k2", compact(["Grep", "WebFetch"]), { compact: true });
		await convert();
		expect(bodyFormat("k2")).toBe(2);
		const { off, on } = await both(() => compactToolLoadingEpoch("n1"));
		expect(off).toEqual({
			markerId: "k2",
			reason: "compact",
			toolNames: ["Grep", "WebFetch"],
			target: "anthropic:model",
			definitionSnapshots: undefined,
		});
		expect(on).toEqual(off);

		diverge("k2", compact(["Read"]));
		const after = await both(() => compactToolLoadingEpoch("n1")?.toolNames);
		expect(after.off).toEqual(["Read"]);
		expect(after.on).toEqual(["Grep", "WebFetch"]);
	});

	test("a queued or legacy compact is read from content_json", async () => {
		envelope("k1", compact(["Grep"]), { compact: true });
		await convert();
		rewrite("k1", compact(["Read"]));
		expect(queued("k1")).toBe(true);
		let reads = await both(() => compactToolLoadingEpoch("n1")?.toolNames);
		expect(reads.on).toEqual(reads.off);
		expect(reads.on).toEqual(["Read"]);

		settings.narratorBlocks.write = false;
		envelope("k2", compact(["Bash"]), { compact: true });
		expect(bodyFormat("k2")).toBe(1);
		reads = await both(() => compactToolLoadingEpoch("n1")?.toolNames);
		expect(reads.on).toEqual(reads.off);
		expect(reads.on).toEqual(["Bash"]);
	});
});
