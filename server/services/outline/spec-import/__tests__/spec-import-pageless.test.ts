/**
 * The import without pages (pageless outline, A3): a file is ONE top-level block however large,
 * written in bounded commits; an earlier attempt's file block of any size is taken away in
 * bounded commits; an attempt cut short goes on with the same short ids.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eventBus } from "../../../../lib/event-bus";
import { settings } from "../../../../lib/settings";
import { invalidateTaskBackend } from "../../../task-source";
import { stopEditTextWorker } from "../../edit-text-runner";
import { convertNotes } from "../../report-text";
import { outlineStore } from "../../store";
import { type OutlineOp, writeOutline } from "../../write";
import { importSpecSession, resetSpecImportRecords, SPEC_IMPORT_LIMITS } from "../importer";
import { OUTLINE_SPEC_IMPORT_ACTOR, planSpecFile, SPEC_IMPORT_TEXT } from "../plan";
import { backendOf, makeSession, writeNote, writeTasks } from "./fixtures";

beforeEach(() => {
	settings.outline.enabled = true;
	settings.outline.specImport = "auto";
	invalidateTaskBackend();
	resetSpecImportRecords();
});
afterAll(() => stopEditTextWorker());

const PARAGRAPHS = 2600;
const text = (tag: string) =>
	Array.from({ length: PARAGRAPHS }, (_, i) => `${tag} paragraph ${i}`).join("\n\n");

async function spaceOf(narratorId: string) {
	const space = await outlineStore.findSpace({ kind: "session", narratorId });
	if (!space) throw new Error("no session space");
	return space;
}

/** Every live block under `rootId`, breadth first. */
async function under(spaceId: string, rootId: string) {
	const read = await outlineStore.listSubtreeAt(spaceId, rootId, { asOf: null, limit: 10_000 });
	expect(read.truncated).toBe(false);
	return read.rows;
}

/** Commits of a space, oldest first. */
async function commits(spaceId: string) {
	return await outlineStore.listCommits(spaceId, { limit: 1000 });
}

describe("a file of more than 1,500 blocks", () => {
	test("is one top-level block with everything under it, written in bounded commits", async () => {
		const { id } = await makeSession();
		await writeNote(id, "big.md", text("new"));
		const outcome = await importSpecSession(id, { trigger: "manual" });
		expect(outcome).toMatchObject({ status: "imported", notes: 1 });
		const space = await spaceOf(id);
		const top = await outlineStore.listChildren(space.id, null, 50);
		expect(top.map((b) => b.content)).toEqual(["big.md"]);
		const rows = await under(space.id, top[0]?.id as string);
		// Two groups of at most 2,000 under the file's block, every paragraph once, in order.
		const groups = rows.filter((r) => r.parentId === top[0]?.id);
		expect(groups).toHaveLength(2);
		const heads = await outlineStore.getContentHeads(
			rows.map((r) => r.id),
			80,
		);
		const paragraphs = rows
			.filter((r) => r.parentId !== top[0]?.id)
			.map((r) => heads.get(r.id) as string);
		expect(paragraphs).toEqual(Array.from({ length: PARAGRAPHS }, (_, i) => `new paragraph ${i}`));
		// Every commit within the import's own operation limit.
		const written = await commits(space.id);
		expect(written.length).toBeGreaterThanOrEqual(
			Math.ceil(PARAGRAPHS / SPEC_IMPORT_LIMITS.opsPerCommit),
		);
		for (const commit of written) {
			const versions = await outlineStore.listCommitVersions(commit.id, 1000);
			expect(versions.length).toBeLessThanOrEqual(SPEC_IMPORT_LIMITS.opsPerCommit);
		}
	}, 120_000);

	test("an attempt cut short goes on: every block once", async () => {
		const { id } = await makeSession();
		await writeNote(id, "big.md", text("cut"));
		const cut = new AbortController();
		let seen = 0;
		const count = () => {
			if (++seen === 5) cut.abort(new Error("cut"));
		};
		eventBus.on("outline:committed", count);
		const first = await importSpecSession(id, { trigger: "manual", signal: cut.signal });
		eventBus.off("outline:committed", count);
		expect(first.status).toBe("failed");
		expect(await backendOf(id)).toBe("spec");
		expect((await importSpecSession(id, { trigger: "manual" })).status).toBe("imported");
		const space = await spaceOf(id);
		const top = await outlineStore.listChildren(space.id, null, 50);
		expect(top).toHaveLength(1);
		expect(await under(space.id, top[0]?.id as string)).toHaveLength(PARAGRAPHS + 2);
	}, 120_000);

	test("an earlier attempt's block of a revision since replaced goes, bottom up, in bounded commits", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "a task" }]);
		const space = await outlineStore.ensureSpace(
			{ kind: "session", narratorId: id },
			new Date().toISOString(),
		);
		// What an earlier attempt wrote from a revision that is not there any more.
		const stale = planSpecFile({
			narratorId: id,
			path: "big.md",
			revisionId: "an-older-revision",
			blocks: convertNotes({ text: text("old"), continued: "(cont.)" }).blocks,
			locale: "en",
		});
		for (let i = 0; i < stale.nodes.length; i += 150) {
			const chunk = stale.nodes.slice(i, i + 150);
			const inChunk = new Set(chunk.map((n) => n.sid));
			const ops: OutlineOp[] = chunk.map((node) => ({
				op: "insert",
				tempId: node.sid,
				sid: node.sid,
				parent:
					node.parentSid === null
						? null
						: inChunk.has(node.parentSid)
							? { tempId: node.parentSid }
							: { sid: node.parentSid },
				content: node.content,
			}));
			await writeOutline(
				{
					spaceId: space.id,
					ops,
					actor: { kind: "system", id: OUTLINE_SPEC_IMPORT_ACTOR },
					responsibleUserId: owner,
					narratorId: id,
				},
				{ kind: "import" },
			);
		}
		const [oldRoot] = await outlineStore.getBlockMetas(space.id, { sids: [stale.rootSid] });
		expect(await under(space.id, oldRoot?.id as string)).toHaveLength(PARAGRAPHS + 2);
		const before = (await commits(space.id)).length;

		await writeNote(id, "big.md", text("new"));
		expect((await importSpecSession(id, { trigger: "manual" })).status).toBe("imported");
		const [gone] = await outlineStore.getBlockMetas(space.id, { ids: [oldRoot?.id as string] });
		expect(gone?.deleted).toBe(true);
		const top = (await outlineStore.listChildren(space.id, null, 50)).map((b) => b.content);
		expect(top.sort()).toEqual(["Tasks", "big.md"].sort());
		// More than one write path commit's rows: taken away in several commits, none too large.
		const removed = (await commits(space.id))
			.slice(before)
			.filter((c) => c.summary === SPEC_IMPORT_TEXT.en.summaryStale);
		expect(removed.length).toBeGreaterThanOrEqual(
			Math.ceil((PARAGRAPHS + 3) / SPEC_IMPORT_LIMITS.staleDeleteBlocks),
		);
		for (const commit of removed) {
			const versions = await outlineStore.listCommitVersions(commit.id, 5000);
			expect(versions.length).toBeLessThanOrEqual(SPEC_IMPORT_LIMITS.staleDeleteBlocks);
		}
	}, 180_000);
});
