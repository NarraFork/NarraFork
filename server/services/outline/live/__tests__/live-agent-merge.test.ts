/**
 * An agent's `OutlineEdit` into a page someone is typing in (P1b, design §6.5): the real tool
 * against a real live session, the editor's client engine over the in-process network.
 *
 *   - The person types; the text is in the session, not committed. The agent, which read the
 *     block before, replaces it with a change elsewhere in the text. The barrier commits the
 *     person's text first, the agent's change is merged onto it, and the merged commit reaches
 *     every client as a remote change: both changes stay, everyone converges, and the person goes
 *     on typing where they were, nothing doubled; undo takes back only their own typing.
 *   - The same with keystrokes still on their way when the agent writes.
 *   - The agent's change overlaps what the person typed: the call writes nothing and the person's
 *     text stays, live and committed.
 *   - The agent deletes a block while the person types in a block under it: refused, nothing
 *     deleted, the typing stays.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; each test makes its own page.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { LiveClient } from "@frontend/components/outline/editor/live-client";
import { db } from "../../../../db";
import { aclGrants, narrators, projects, users } from "../../../../db/schema";
import "../../../../lib/agent/tools";
import { outlineEditTool, outlineReadTool } from "../../../../lib/agent/tools/outline";
import type { ToolContext, ToolResult } from "../../../../lib/agent/types";
import { generateId } from "../../../../lib/id";
import { settings } from "../../../../lib/settings";
import { stopEditTextWorker } from "../../edit-text-runner";
import { OUTLINE_CHANGE } from "../../model";
import { clearOutlineReads } from "../../read-ledger";
import { invalidateSessionReadScopes } from "../../session-scope";
import { ensureProjectSpace } from "../../spaces";
import { outlineStore } from "../../store";
import type { OutlineSpaceRow } from "../../store/port";
import { writeOutline } from "../../write";
import { closeAllLiveSessions, liveSessionOf, runInLane } from "../registry";
import { OUTLINE_LIVE_TIMING } from "../session";
import { client, settle, TestLink, type, waitFor } from "./harness";

const NOW = "2026-10-27T00:00:00.000Z";
const saved = { ...OUTLINE_LIVE_TIMING };

let owner: string;
let writer: string;
let session: string;
let space: OutlineSpaceRow;
const clients: LiveClient[] = [];
const links: TestLink[] = [];

async function user(label: string) {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

function open(userId: string): { link: TestLink; page: (pageId: string) => LiveClient } {
	const l = new TestLink(userId, userId);
	links.push(l);
	return {
		link: l,
		page: (pageId) => {
			const c = client(l, pageId, "edit");
			clients.push(c);
			return c;
		},
	};
}

/** A page with blocks `texts`, written by the owner; the page id and the blocks' ids and sids. */
async function page(texts: string[]) {
	const r = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Page" },
			...texts.map((content, i) => ({
				op: "insert" as const,
				tempId: `b${i}`,
				parent: { tempId: "p" },
				content,
			})),
		],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	const [p, ...rest] = r.results;
	return {
		pageId: p?.blockId as string,
		pageSid: p?.sid as string,
		blocks: rest.map((b) => ({ id: b.blockId, sid: b.sid })),
	};
}

function agent(): ToolContext {
	return {
		narratorId: session,
		cwd: "/",
		signal: new AbortController().signal,
		locale: "en",
		userId: owner,
		requestPermission: async () => ({ behavior: "allow" }),
	} as ToolContext;
}

async function content(id: string): Promise<string> {
	return (await outlineStore.getBlock(id))?.content ?? "<missing>";
}

/** Everyone's text of a block: the clients', the session's and, once committed, the table's. */
async function everywhere(clientsOf: LiveClient[], pageId: string, id: string) {
	// Commit what is still typed (the flush timers are long here), as the session's timer would.
	await runInLane(space.id, async () => {
		await liveSessionOf(pageId)?.flushContent();
	});
	await settle();
	expect(liveSessionOf(pageId)?.hasUnflushed).toBe(false);
	return {
		clients: [...new Set(clientsOf.map((c) => c.textOf(id)))],
		session: liveSessionOf(pageId)?.textOf(id),
		stored: await content(id),
	};
}

beforeAll(async () => {
	owner = await user("owner");
	writer = await user("writer");
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Merge project",
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: writer,
		capability: "write",
		createdAt: NOW,
	});
	session = generateId();
	await db.insert(narrators).values({
		id: session,
		title: "merging agent",
		ownerUserId: owner,
		visibility: "private",
		contextProjectId: projectId,
		createdAt: NOW,
		updatedAt: NOW,
	});
	space = await ensureProjectSpace(projectId);
});

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateSessionReadScopes();
	clearOutlineReads();
	Object.assign(OUTLINE_LIVE_TIMING, {
		// The person's text stays in the session until the agent's write commits it.
		flushIdleMs: 60_000,
		flushMaxMs: 60_000,
		persistMs: 20,
		idleCloseMs: 150,
	});
});

afterEach(async () => {
	for (const c of clients.splice(0)) c.dispose();
	for (const l of links.splice(0)) if (l.connected) l.disconnect();
	await closeAllLiveSessions("ended");
	Object.assign(OUTLINE_LIVE_TIMING, saved);
	invalidateSessionReadScopes();
	stopEditTextWorker();
});

afterAll(() => {
	Object.assign(OUTLINE_LIVE_TIMING, saved);
});

async function edit(edits: unknown[]): Promise<ToolResult> {
	return await outlineEditTool.execute({ edits }, agent());
}

describe("an agent writing into a page being typed in", () => {
	test("text typed and not committed yet, and the agent's change elsewhere, both stay", async () => {
		const { pageId, pageSid, blocks } = await page(["The token lifetime is one hour."]);
		const block = blocks[0] as { id: string; sid: string };
		// The agent reads the page before anyone types.
		const read = await outlineReadTool.execute({ address: pageSid }, agent());
		expect(read.output).toContain(`- [${block.sid}] The token lifetime is one hour.`);

		const alice = open(owner);
		const bob = open(writer);
		const a = alice.page(pageId);
		const b = bob.page(pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		type(a, block.id, " Refresh early");
		await settle();
		expect(liveSessionOf(pageId)?.hasUnflushed).toBe(true);
		expect(await content(block.id)).toBe("The token lifetime is one hour.");

		const result = await edit([
			{ replace: block.sid, text: "The access token lifetime is one hour." },
		]);
		expect(result.isError).toBeUndefined();
		const merged = "The access token lifetime is one hour. Refresh early";
		expect(result.output).toContain(`- [${block.sid}] ${merged}`);
		await settle(40);
		expect(await everywhere([a, b], pageId, block.id)).toEqual({
			clients: [merged],
			session: merged,
			stored: merged,
		});
		// The person's text went in as their own commit, then the agent's merge on top of it.
		const [mergedVersion, typedVersion] = await outlineStore.listBlockHistory(block.id, {
			limit: 2,
		});
		expect((mergedVersion?.changeFlags ?? 0) & OUTLINE_CHANGE.MERGE).toBe(OUTLINE_CHANGE.MERGE);
		const commits = await outlineStore.getCommitsBySeqs(space.id, [
			mergedVersion?.fromSeq as number,
			typedVersion?.fromSeq as number,
		]);
		expect(commits.map((c) => [c.actorKind, c.actorId]).sort()).toEqual(
			[
				["agent", session],
				["human", owner],
			].sort(),
		);

		// She goes on typing where she was: nothing doubles, and her undo takes back only hers.
		type(a, block.id, "!", a.textOf(block.id).indexOf("Refresh early") + "Refresh early".length);
		await settle();
		const after = `${merged}!`;
		expect(a.textOf(block.id)).toBe(after);
		expect(b.textOf(block.id)).toBe(after);
		while (a.canUndo()) a.undo();
		await settle();
		expect(b.textOf(block.id)).toBe("The access token lifetime is one hour.");
		expect(await everywhere([a, b], pageId, block.id)).toEqual({
			clients: ["The access token lifetime is one hour."],
			session: "The access token lifetime is one hour.",
			stored: "The access token lifetime is one hour.",
		});
	});

	test("an emoji and Chinese text: the merge reaches the live text whole", async () => {
		const { pageId, pageSid, blocks } = await page([
			"Build status 🔴 today",
			"这是重点内容。",
			"家人 👨‍👩‍👧 合影",
		]);
		const [status, zh, family] = blocks as Array<{ id: string; sid: string }>;
		await outlineReadTool.execute({ address: pageSid }, agent());
		const alice = open(owner);
		const bob = open(writer);
		const a = alice.page(pageId);
		const b = bob.page(pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		type(a, status.id, "!");
		type(a, zh.id, "明天继续。");
		type(b, family.id, " 🎉");
		await settle();
		const result = await edit([
			// 🔴 → 🟢 share their first UTF-16 half: the live patch must not split it.
			{ replace: status.sid, text: "Build status 🟢 today" },
			{ replace: zh.sid, text: "这是要点内容。" },
			{ replace: family.sid, text: "家人 👨‍👩‍👦 合影" },
		]);
		expect(result.isError).toBeUndefined();
		await settle(40);
		const want = {
			[status.id]: "Build status 🟢 today!",
			[zh.id]: "这是要点内容。明天继续。",
			[family.id]: "家人 👨‍👩‍👦 合影 🎉",
		};
		for (const [id, text] of Object.entries(want)) {
			expect(await everywhere([a, b], pageId, id)).toEqual({
				clients: [text],
				session: text,
				stored: text,
			});
		}
		// Typing on keeps every character whole, in the session and once committed.
		type(a, status.id, "?");
		await settle();
		expect(await everywhere([a, b], pageId, status.id)).toEqual({
			clients: ["Build status 🟢 today!?"],
			session: "Build status 🟢 today!?",
			stored: "Build status 🟢 today!?",
		});
		for (const id of Object.keys(want)) expect(await content(id)).not.toContain("\uFFFD");
	});

	test("keystrokes still on their way when the agent writes land after its merge", async () => {
		const { pageId, pageSid, blocks } = await page(["alpha beta gamma"]);
		const block = blocks[0] as { id: string; sid: string };
		await outlineReadTool.execute({ address: pageSid }, agent());
		const alice = open(owner);
		const bob = open(writer);
		const a = alice.page(pageId);
		const b = bob.page(pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		// Bob's typing reached the session; Alice's is held on her link.
		type(b, block.id, " delta");
		await settle();
		alice.link.hold(true);
		type(a, block.id, "Note: ", 0);
		const result = await edit([{ replace: block.sid, text: "alpha BETA gamma" }]);
		expect(result.isError).toBeUndefined();
		alice.link.hold(false);
		await settle(60);
		const want = "Note: alpha BETA gamma delta";
		expect(await everywhere([a, b], pageId, block.id)).toEqual({
			clients: [want],
			session: want,
			stored: want,
		});
	});

	test("an overlap with what is being typed writes nothing, and the typing stays", async () => {
		const { pageId, pageSid, blocks } = await page(["one two three", "untouched"]);
		const [block, other] = blocks as Array<{ id: string; sid: string }>;
		await outlineReadTool.execute({ address: pageSid }, agent());
		const alice = open(owner);
		const bob = open(writer);
		const a = alice.page(pageId);
		const b = bob.page(pageId);
		await waitFor(() => a.ready && b.ready, 3000, "joined");
		await settle();
		// She retypes the word the agent is about to change.
		type(a, block.id, "s", "one two".length);
		await settle();
		const typed = "one twos three";
		expect(b.textOf(block.id)).toBe(typed);

		const result = await edit([
			{ replace: block.sid, text: "one TWO three" },
			{ replace: other.sid, text: "touched by the agent" },
		]);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Nothing was written");
		expect(result.output).toContain(`[${block.sid}] was changed by a person`);
		expect(result.output).toContain("your change and theirs overlap at «two»");
		expect(result.output).toContain(`it now reads: ${typed}`);
		await settle(40);
		expect(await everywhere([a, b], pageId, block.id)).toEqual({
			clients: [typed],
			session: typed,
			stored: typed,
		});
		expect(await content(other.id)).toBe("untouched");
		type(a, block.id, "!");
		await settle();
		expect(b.textOf(block.id)).toBe(`${typed}!`);
	});

	test("a delete of a block whose child is being typed in writes nothing; the typing stays", async () => {
		const r = await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "insert", tempId: "p", parent: null, content: "Page" },
				{ op: "insert", tempId: "s", parent: { tempId: "p" }, content: "Section" },
				{ op: "insert", tempId: "d", parent: { tempId: "s" }, content: "detail" },
			],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		const [p, section, detail] = r.results as Array<{ blockId: string; sid: string }>;
		if (!p || !section || !detail) throw new Error("no blocks");
		await outlineReadTool.execute({ address: p.sid }, agent());
		const alice = open(owner);
		const a = alice.page(p.blockId);
		await waitFor(() => a.ready, 3000, "joined");
		await settle();
		type(a, detail.blockId, ", being worked out");
		await settle();
		expect(liveSessionOf(p.blockId)?.hasUnflushed).toBe(true);

		const result = await edit([{ delete: section.sid }]);
		expect(result.isError).toBe(true);
		expect(result.output).toContain(`[${detail.sid}] was changed by a person`);
		expect(result.output).toContain(`it is under [${section.sid}], which you are deleting with it`);
		expect(result.output).toContain(`- [${detail.sid}] detail, being worked out`);
		await settle(40);
		expect(await everywhere([a], p.blockId, detail.blockId)).toEqual({
			clients: ["detail, being worked out"],
			session: "detail, being worked out",
			stored: "detail, being worked out",
		});
		expect((await outlineStore.getBlock(section.blockId))?.deleted).toBe(false);
		type(a, detail.blockId, "!");
		await settle();
		expect(a.textOf(detail.blockId)).toBe("detail, being worked out!");
	});
});
