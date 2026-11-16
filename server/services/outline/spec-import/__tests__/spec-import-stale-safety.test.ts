/**
 * Taking away what an earlier, unfinished import left, safely (pageless outline A3, review round
 * 1, cases P1–P7b): a stale block goes only when nobody but the import ever touched anything that
 * was under it (owner rule, by change marks above the history floor); a person writing under it
 * while the bottom-up delete runs keeps what they wrote; every cap reached keeps the block; an
 * older `index.md` goes whole however wide; an attempt cut short before pages went resumes as one
 * block in order.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { specNamespaceFiles, specNamespaces } from "../../../../db/schema";
import { eventBus } from "../../../../lib/event-bus";
import { settings } from "../../../../lib/settings";
import { specIndexSid } from "../../../plugin-spec-compat";
import { invalidateTaskBackend } from "../../../task-source";
import { stopEditTextWorker } from "../../edit-text-runner";
import { convertNotes } from "../../report-text";
import { outlineStore } from "../../store";
import { type OutlineOp, writeOutline } from "../../write";
import {
	importSpecSession,
	resetSpecImportRecords,
	SPEC_IMPORT_LIMITS,
	specImportRecord,
} from "../importer";
import {
	OUTLINE_SPEC_IMPORT_ACTOR,
	planSpecFile,
	SPEC_IMPORT_TEXT,
	type SpecImportNode,
	specFileTag,
} from "../plan";
import { makeSession, writeNote, writeTasks } from "./fixtures";

const saved = { ...SPEC_IMPORT_LIMITS };
beforeEach(() => {
	settings.outline.enabled = true;
	settings.outline.specImport = "manual";
	invalidateTaskBackend();
	resetSpecImportRecords();
});
afterEach(() => Object.assign(SPEC_IMPORT_LIMITS as Record<string, number>, saved));
afterAll(() => stopEditTextWorker());

const run = (id: string) => importSpecSession(id, { trigger: "manual" });
const paras = (tag: string, n: number) =>
	Array.from({ length: n }, (_, i) => `${tag} paragraph ${i}`).join("\n\n");

async function spaceFor(id: string) {
	return await outlineStore.ensureSpace(
		{ kind: "session", narratorId: id },
		new Date().toISOString(),
	);
}

async function writeAsImport(
	spaceId: string,
	owner: string | null,
	id: string,
	nodes: SpecImportNode[],
) {
	for (let i = 0; i < nodes.length; i += 150) {
		const chunk = nodes.slice(i, i + 150);
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
				spaceId,
				ops,
				actor: { kind: "system", id: OUTLINE_SPEC_IMPORT_ACTOR },
				responsibleUserId: owner,
				narratorId: id,
			},
			{ kind: "import" },
		);
	}
}

/** A stale file block of `n` paragraphs from a revision that is gone. */
async function staleFile(id: string, owner: string | null, n: number, path = "big.md") {
	const space = await spaceFor(id);
	const stale = planSpecFile({
		narratorId: id,
		path,
		revisionId: "an-older-revision",
		blocks: convertNotes({ text: paras("old", n), continued: "(cont.)" }).blocks,
		locale: "en",
	});
	await writeAsImport(space.id, owner, id, stale.nodes);
	const [root] = await outlineStore.getBlockMetas(space.id, { sids: [stale.rootSid] });
	return { space, rootId: root?.id as string };
}

const human = (owner: string | null) => ({ kind: "human" as const, id: owner as string });

describe("stale removal data safety (pageless A3)", () => {
	test("P1 a person added a child then deleted it: is the stale block removed?", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "t" }]);
		const { space, rootId } = await staleFile(id, owner, 5);
		const r = await writeOutline({
			spaceId: space.id,
			ops: [{ op: "insert", parent: { id: rootId }, content: "mine" }],
			actor: human(owner),
			responsibleUserId: owner,
		});
		const mine = r.results[0]?.blockId as string;
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "delete", block: { id: mine } }],
			actor: human(owner),
			responsibleUserId: owner,
		});
		await writeNote(id, "big.md", "new");
		const out = await run(id);
		const [root] = await outlineStore.getBlockMetas(space.id, { ids: [rootId] });
		// Owner rule: a person touched what was under it (added a child, deleted it again): kept.
		expect(out.status).toBe("failed");
		expect(specImportRecord(id)?.reason).toEqual({ code: "kept_blocks", count: 1 });
		expect(root?.deleted).toBe(false);
	}, 60_000);

	test("P2 a person moved their block INTO the stale block: kept", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "t" }]);
		const { space, rootId } = await staleFile(id, owner, 5);
		const r = await writeOutline({
			spaceId: space.id,
			ops: [{ op: "insert", parent: null, content: "mine" }],
			actor: human(owner),
			responsibleUserId: owner,
		});
		const mine = r.results[0]?.blockId as string;
		const [child] = await outlineStore.listChildren(space.id, rootId, 5);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "move", block: { id: mine }, parent: { id: child?.id as string } }],
			actor: human(owner),
			responsibleUserId: owner,
		});
		await writeNote(id, "big.md", "new");
		expect((await run(id)).status).toBe("failed");
		const [m] = await outlineStore.getBlockMetas(space.id, { ids: [mine] });
		expect(specImportRecord(id)?.reason?.code).toBe("kept_blocks");
		expect(m?.deleted).toBe(false);
	}, 60_000);

	test("P3 a person edited text then reverted it by hand: kept", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "t" }]);
		const { space, rootId } = await staleFile(id, owner, 5);
		const [child] = await outlineStore.listChildren(space.id, rootId, 5);
		for (const content of ["edited", child?.content as string])
			await writeOutline({
				spaceId: space.id,
				ops: [{ op: "update", block: { id: child?.id as string }, content }],
				actor: human(owner),
				responsibleUserId: owner,
			});
		await writeNote(id, "big.md", "new");
		expect((await run(id)).status).toBe("failed");
		const [root] = await outlineStore.getBlockMetas(space.id, { ids: [rootId] });
		expect(specImportRecord(id)?.reason?.code).toBe("kept_blocks");
		expect(root?.deleted).toBe(false);
	}, 60_000);

	for (const [name, key, value] of [
		["blocks", "staleSubtreeBlocks", 10],
		["commits", "staleCommits", 0],
		["root versions", "staleRootVersions", 0],
	] as const) {
		test(`P5 cap ${name} hit: kept, nothing deleted`, async () => {
			const { id, owner } = await makeSession();
			await writeTasks(id, [{ text: "t" }]);
			const { space, rootId } = await staleFile(id, owner, 40);
			(SPEC_IMPORT_LIMITS as Record<string, number>)[key] = value;
			await writeNote(id, "big.md", "new");
			const out = await run(id);
			const [root] = await outlineStore.getBlockMetas(space.id, { ids: [rootId] });
			expect(out.status).toBe("failed");
			expect(specImportRecord(id)?.reason?.code).toBe("kept_blocks");
			expect(root?.deleted).toBe(false);
		}, 60_000);
	}

	test("P4 a person writes under the stale block WHILE the bottom-up delete runs", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "t" }]);
		const { space, rootId } = await staleFile(id, owner, 1500);
		await writeNote(id, "big.md", "new");
		let mine: string | null = null;
		let pending: Promise<unknown> | null = null;
		const handler = (e: { spaceId?: string; summary?: string }) => {
			if (pending) return;
			void e;
			pending = (async () => {
				const metas = await outlineStore.getBlockMetas(space.id, { ids: [rootId] });
				if (metas[0]?.deleted) return;
				// only once stale deletes have started
				const commitsNow = await outlineStore.listCommits(space.id, { limit: 5000 });
				if (!commitsNow.some((c) => c.summary === SPEC_IMPORT_TEXT.en.summaryStale)) {
					pending = null;
					return;
				}
				const r = await writeOutline({
					spaceId: space.id,
					ops: [
						{
							op: "insert",
							parent: { id: rootId },
							content: "a person's note written during the import",
						},
					],
					actor: human(owner),
					responsibleUserId: owner,
				});
				mine = r.results[0]?.blockId ?? null;
			})();
		};
		eventBus.on("outline:committed", handler as never);
		const out = await run(id);
		eventBus.off("outline:committed", handler as never);
		await pending;
		const [m] = mine ? await outlineStore.getBlockMetas(space.id, { ids: [mine] }) : [];
		// The person's write landed while the deletes ran: it stays, and the import stops there.
		expect(mine).not.toBeNull();
		expect(m?.deleted).toBe(false);
		expect(out.status).toBe("failed");
		expect(specImportRecord(id)?.reason?.code).toBe("kept_blocks");
	}, 180_000);

	test("P7 index.md of an older revision grouped (>2000 children): old groups go", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "t" }]);
		const space = await spaceFor(id);
		const stale = planSpecFile({
			narratorId: id,
			path: "index.md",
			revisionId: "older-index",
			blocks: convertNotes({ text: paras("old", 2100), continued: "(cont.)" }).blocks,
			locale: "en",
			rootSid: specIndexSid(),
		});
		await writeAsImport(space.id, owner, id, stale.nodes);
		await writeNote(id, "index.md", "brand new index");
		const out = await run(id);
		const [index] = await outlineStore.getBlockMetas(space.id, { sids: [specIndexSid()] });
		const kids = await outlineStore.listChildren(space.id, index?.id as string, 50);
		expect(out.status).toBe("imported");
		expect(kids.map((k) => k.content)).toEqual(["brand new index"]);
	}, 180_000);

	test("P7b index.md of an older revision with 1,500 children (ungrouped): all go", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "t" }]);
		const space = await spaceFor(id);
		const stale = planSpecFile({
			narratorId: id,
			path: "index.md",
			revisionId: "older-index",
			blocks: convertNotes({ text: paras("old", 1500), continued: "(cont.)" }).blocks,
			locale: "en",
			rootSid: specIndexSid(),
		});
		await writeAsImport(space.id, owner, id, stale.nodes);
		await writeNote(id, "index.md", "brand new index");
		const out = await run(id);
		const [index] = await outlineStore.getBlockMetas(space.id, { sids: [specIndexSid()] });
		const kids = await outlineStore.listChildren(space.id, index?.id as string, 2000);
		expect(out.status).toBe("imported");
		expect(kids.map((k) => k.content)).toEqual(["brand new index"]);
	}, 180_000);

	test("P6 an import cut short BEFORE the upgrade (old pages of 1,500) goes on", async () => {
		const { id, owner } = await makeSession();
		const N = 1600;
		await writeNote(id, "big.md", paras("p", N));
		const ns = await db.query.specNamespaces.findFirst({
			where: eq(specNamespaces.narratorId, id),
		});
		const file = await db.query.specNamespaceFiles.findFirst({
			where: and(
				eq(specNamespaceFiles.namespaceId, ns?.id as string),
				eq(specNamespaceFiles.path, "big.md"),
			),
		});
		const revisionId = file?.revisionId as string;
		const t = specFileTag(id, "big.md", revisionId);
		const blocks = convertNotes({
			text: paras("p", N),
			continued: SPEC_IMPORT_TEXT.en.continued,
		}).blocks;
		expect(blocks.length).toBe(N);
		// The OLD planner (base of this PR): page sp<t>, part page sp<t>p1, sb<t><n> depth first.
		const nodes: SpecImportNode[] = [{ sid: `sp${t}`, parentSid: null, content: "big.md (1/2)" }];
		for (let i = 0; i < 1500; i++)
			nodes.push({
				sid: `sb${t}${i.toString(36)}`,
				parentSid: `sp${t}`,
				content: blocks[i]?.content as never,
			});
		nodes.push({ sid: `sp${t}p1`, parentSid: null, content: "big.md (2/2)" });
		// cut short: only 50 of the second part written
		for (let i = 1500; i < 1550; i++)
			nodes.push({
				sid: `sb${t}${i.toString(36)}`,
				parentSid: `sp${t}p1`,
				content: blocks[i]?.content as never,
			});
		const space = await spaceFor(id);
		await writeAsImport(space.id, owner, id, nodes);
		const out = await run(id);
		const top = await outlineStore.listChildren(space.id, null, 50);
		const desc = [] as string[];
		for (const b of top) {
			const kids = await outlineStore.listChildren(space.id, b.id, 3000);
			desc.push(`${b.sid.slice(0, 2)}${b.sid.slice(14)}:${b.content}:${kids.length}`);
		}
		expect(out.status).toBe("imported");
		// One block, titled with the path, every block under it in order; the part page went.
		expect(desc).toEqual([`sp:big.md:${N}`]);
		const [root] = top;
		const kids = await outlineStore.listChildren(space.id, root?.id as string, 3000);
		expect(kids.map((k) => k.content)).toEqual(blocks.map((b) => b.content));
		expect(kids.map((k) => k.sid)).toEqual(blocks.map((_, i) => `sb${t}${i.toString(36)}`));
	}, 180_000);
});
