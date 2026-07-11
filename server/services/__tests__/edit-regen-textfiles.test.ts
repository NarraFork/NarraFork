import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";

// In-memory DB from real migrations (mirrors tests/setup.ts).
const DRIZZLE_DIR = join(import.meta.dir, "..", "..", "..", "drizzle");
const sqlite = new Database(":memory:");
sqlite.run("PRAGMA foreign_keys = OFF");
for (const file of readdirSync(DRIZZLE_DIR)
	.filter((f) => f.endsWith(".sql"))
	.sort()) {
	const sql = readFileSync(join(DRIZZLE_DIR, file), "utf-8");
	for (const stmt of sql
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter(Boolean)) {
		try {
			sqlite.run(stmt);
		} catch (err) {
			if (!String(err).includes("already exists")) throw err;
		}
	}
}
sqlite.run("PRAGMA foreign_keys = ON");
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
mock.module("../../db", () => ({ db, sqlite }));

const { editAndRegenerate } = await import("../narrator-session");
const { narratorMessages, narratorMessageRefs, narrators } = schema;
afterAll(() => mock.restore());
const now = new Date().toISOString();

type Block = Record<string, unknown>;

function seed(cwd: string, blocks: Block[]) {
	sqlite.run("DELETE FROM narrator_message_refs");
	sqlite.run("DELETE FROM narrator_messages");
	sqlite.run("DELETE FROM narrators");
	db.insert(narrators)
		.values({
			id: "n1",
			chapterId: null,
			type: "primary",
			variant: "primary",
			inheritMode: "fresh",
			cwd,
			status: "idle",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narratorMessages)
		.values({
			id: "m1",
			narratorId: "n1",
			role: "user",
			contentJson: blocks,
			contentText: "old",
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: "ref-m1", narratorId: "n1", messageId: "m1", seq: 0, isCompact: 0 })
		.run();
}

async function runEdit(opts: Parameters<typeof editAndRegenerate>[6]) {
	// editAndRegenerate persists the rebuilt contentJson before the (failing in
	// this bare harness) agent loop runs, so we can inspect the persisted result.
	try {
		await editAndRegenerate("n1", "m1", "new", "en", false, false, opts);
	} catch {
		/* expected: agent loop cannot run without a real provider */
	}
	const msg = await db.query.narratorMessages.findFirst({ where: eq(narratorMessages.id, "m1") });
	return (msg?.contentJson as Block[]) ?? [];
}

describe("editAndRegenerate text_file management", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "nf-edit-"));
	});

	test("keeps all text files when keepTextFilePaths is undefined (backward compatible)", async () => {
		seed(cwd, [
			{ type: "text_file", filename: "a.md", size: 1, filePath: "/x/.narrafork/attached/a.md" },
			{ type: "text", text: "old" },
		]);
		const blocks = await runEdit({ userId: null });
		expect(blocks.filter((b) => b.type === "text_file")).toHaveLength(1);
	});

	test("drops text files not in keepTextFilePaths", async () => {
		seed(cwd, [
			{ type: "text_file", filename: "a.md", size: 1, filePath: "/x/a.md" },
			{ type: "text_file", filename: "b.md", size: 2, filePath: "/x/b.md" },
			{ type: "text", text: "old" },
		]);
		const blocks = await runEdit({ keepTextFilePaths: ["/x/a.md"], userId: null });
		const files = blocks.filter((b) => b.type === "text_file");
		expect(files).toHaveLength(1);
		expect(files[0].filePath).toBe("/x/a.md");
	});

	test("preserves legacy fileId on kept blocks", async () => {
		seed(cwd, [
			{ type: "text_file", fileId: "F1", filename: "a.js", size: 3, filePath: "n1/text/F1.js" },
			{ type: "text", text: "old" },
		]);
		const blocks = await runEdit({ keepTextFilePaths: ["n1/text/F1.js"], userId: null });
		const file = blocks.find((b) => b.type === "text_file");
		expect(file?.fileId).toBe("F1");
	});

	test("appends newly uploaded text files (saved into the worktree)", async () => {
		seed(cwd, [{ type: "text", text: "old" }]);
		const newFile = new File(["hello world"], "fresh.md", { type: "text/markdown" });
		const blocks = await runEdit({
			keepTextFilePaths: [],
			newTextFiles: [newFile],
			userId: null,
		});
		const files = blocks.filter((b) => b.type === "text_file");
		expect(files).toHaveLength(1);
		expect(files[0].filename).toBe("fresh.md");
		// File was physically written under the worktree's .narrafork/attached dir.
		expect(String(files[0].filePath)).toContain(".narrafork/attached");
		expect(readFileSync(String(files[0].filePath), "utf-8")).toBe("hello world");
	});
});
