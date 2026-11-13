/**
 * The swallowed-content scan and what people do about its findings (outline P2 PR 12c;
 * `loss-scan.ts`, `loss-store.ts`, `loss-findings.ts`).
 *
 * What must hold:
 *  - a person's save that dropped a table the current revision does not hold either is found,
 *    once, with the lost text; what was put back since, an agent's own removal, `tasks.json` and
 *    files that are not markdown are not;
 *  - the scan only reads: no Dynamic Spec revision and no outline commit is written by it, also
 *    for an imported session;
 *  - a session whose file pointers did not change is not scanned again; a scan run again adds
 *    nothing twice and keeps what a person decided; a fork is scanned along the revisions it
 *    shares with its parent;
 *  - a pass walks the sessions the scan looks at (no subagents), a few at a time, and goes on
 *    where it stopped; nothing runs while imports are switched off;
 *  - a pass attaches the findings of an IMPORTED session to the file's page, one block at the top
 *    with the lost text under it and nothing else changed, once (also after a stop between the
 *    write and its record); a session still in Dynamic Spec waits until a pass after its import;
 *  - not attached: content the current revision holds again, more than the cap per session in a
 *    pass (attached by later passes), more than the cap per page (left to a person), a page that
 *    is gone;
 *  - a block a system commit deleted is attached anew; one a person deleted stays deleted;
 *  - dismiss takes the block away when only the attach wrote it and keeps one someone wrote in;
 *    reopen attaches again; a person's attach is the retry of what was left out; a finding is
 *    not decided twice; another session's finding is not found;
 *  - a re-import after a move back is not held up by attached blocks, which follow to the new
 *    page.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import {
	outlineSpecLossFindings,
	outlineSpecLossScans,
	specFileRevisions,
	users,
} from "../../../../db/schema";
import { AppError } from "../../../../lib/errors";
import { settings } from "../../../../lib/settings";
import { forkSpecNamespace, writeSpecFile } from "../../../spec-vfs-service";
import { invalidateTaskBackend } from "../../../task-source";
import { stopEditTextWorker } from "../../edit-text-runner";
import { outlineStore } from "../../store";
import { writeOutline } from "../../write";
import { reimportSpecSession, revertSpecImport } from "../admin";
import { importSpecSession, resetSpecImportRecords } from "../importer";
import { SPEC_LOSS_ATTACH_LIMITS, specLossBlockSid } from "../loss-attach";
import { decideSpecLossFinding, specLossDetail, specLossPage } from "../loss-findings";
import {
	requestSpecLossPass,
	resetSpecLossScanState,
	runSpecLossPass,
	scanSpecSessionLossById,
	settleSpecLossPass,
	specLossScanStatus,
} from "../loss-scan";
import { countSpecLossFindings, readSpecLossScan, readSpecRevisionChain } from "../loss-store";
import { OUTLINE_SPEC_LOSS_ACTOR } from "../plan";
import { readSpecImportState } from "../state";
import { settleSpecImportRequests } from "../triggers";
import { backendOf, commitCount, makeSession, makeUser, pages, writeTasks } from "./fixtures";

const TABLE = "| name | value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |";
const WITH_TABLE = `# Design\n\nintro\n\n${TABLE}\n\noutro\n`;
const WITHOUT_TABLE = "# Design\n\nintro\n\noutro\n";

async function write(
	narratorId: string,
	path: string,
	content: string,
	by: "user" | "assistant",
): Promise<void> {
	await writeSpecFile(narratorId, `spec://${path}`, content, {
		actor: by === "user" ? "user" : "agent",
		createdBy: by,
	});
}

/** An agent wrote the table, then a person's save from the panel dropped it. */
async function swallowed(narratorId: string, path = "design.md"): Promise<void> {
	await write(narratorId, path, WITH_TABLE, "assistant");
	await write(narratorId, path, WITHOUT_TABLE, "user");
}

async function open(narratorId: string) {
	return (await specLossPage({ status: "open", narratorId, canAct: true })).items;
}

async function code(run: () => Promise<unknown>): Promise<string | undefined> {
	try {
		await run();
	} catch (error) {
		if (error instanceof AppError) return error.messageCode ?? error.code;
		throw error;
	}
	return "no error";
}

beforeEach(async () => {
	settings.outline.enabled = true;
	settings.outline.specImport = "manual";
	invalidateTaskBackend();
	resetSpecImportRecords();
	resetSpecLossScanState();
	// Passes walk every session: earlier cases' rows would be scanned again.
	await db.delete(outlineSpecLossScans);
});
afterAll(async () => {
	await settleSpecLossPass();
	await settleSpecImportRequests();
	stopEditTextWorker();
});

describe("the scan", () => {
	test("a person's save that dropped a table is found, with the lost text", async () => {
		const { id } = await makeSession();
		await swallowed(id);
		const result = await scanSpecSessionLossById(id);
		expect(result).toEqual({ saves: 1, findings: 1, added: 1, note: null });
		const [finding] = await open(id);
		expect(finding).toMatchObject({
			narratorId: id,
			path: "design.md",
			kinds: { table: 1 },
			status: "open",
			truncated: false,
			attachable: false,
			blockId: null,
		});
		expect(finding?.savedAt).toBeTruthy();
		const detail = await specLossDetail(finding?.id as string, id);
		expect(detail.parts).toEqual([{ kind: "table", text: TABLE }]);
		expect(await readSpecLossScan(id)).toMatchObject({ saves: 1, findings: 1, note: null });
	});

	test("a large file goes through the worker and reads the same", async () => {
		const { id } = await makeSession();
		const filler = "一段很长的正文。".repeat(400);
		await write(id, "big.md", `${filler}\n\n${TABLE}\n\n${filler}\n`, "assistant");
		await write(id, "big.md", `${filler}\n\n${filler}\n`, "user");
		expect(await scanSpecSessionLossById(id)).toMatchObject({ findings: 1, added: 1 });
		const [finding] = await open(id);
		expect((await specLossDetail(finding?.id as string, id)).parts[0]?.text).toBe(TABLE);
	});

	test("scanning only reads: no spec revision and no outline commit is written", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a task" }]);
		await swallowed(id);
		expect(await importSpecSession(id, { trigger: "manual" })).toMatchObject({
			status: "imported",
		});
		const revisions = async () =>
			(await db.select({ id: specFileRevisions.id }).from(specFileRevisions)).length;
		const before = { revisions: await revisions(), commits: await commitCount(id) };
		const design = (await pages(id)).find((page) => page.title === "design.md");
		expect(await scanSpecSessionLossById(id)).toMatchObject({ findings: 1 });
		expect({ revisions: await revisions(), commits: await commitCount(id) }).toEqual(before);
		expect((await pages(id)).find((page) => page.title === "design.md")).toEqual(design);
		expect((await open(id))[0]?.attachable).toBe(true);
	});

	test("put back since, removed by the agent, tasks.json, not markdown: not found", async () => {
		const { id } = await makeSession();
		// Put back by a later revision.
		await swallowed(id, "restored.md");
		await write(id, "restored.md", WITH_TABLE, "assistant");
		// The agent removed it itself.
		await write(id, "agent.md", WITH_TABLE, "user");
		await write(id, "agent.md", WITHOUT_TABLE, "assistant");
		// Not markdown.
		await write(id, "data.yaml", TABLE, "assistant");
		await write(id, "data.yaml", "a: 1", "user");
		await writeTasks(id, [{ text: "t" }], "user");
		const result = await scanSpecSessionLossById(id);
		expect(result).toMatchObject({ findings: 0, added: 0 });
		expect(await open(id)).toEqual([]);
	});

	test("lost several revisions ago and never put back: still found", async () => {
		const { id } = await makeSession();
		await swallowed(id);
		await write(id, "design.md", `${WITHOUT_TABLE}\nmore\n`, "assistant");
		await write(id, "design.md", `${WITHOUT_TABLE}\nmore still\n`, "user");
		expect(await scanSpecSessionLossById(id)).toMatchObject({ saves: 2, findings: 1 });
	});

	test("unchanged: not scanned again; scanned again: nothing twice, a decision kept", async () => {
		const { id, owner } = await makeSession();
		await swallowed(id);
		await scanSpecSessionLossById(id);
		expect(await scanSpecSessionLossById(id)).toBe("skipped");
		const [finding] = await open(id);
		await decideSpecLossFinding({
			id: finding?.id as string,
			narratorId: id,
			action: "dismiss",
			userId: owner as string,
		});
		expect(await scanSpecSessionLossById(id, { force: true })).toMatchObject({
			findings: 1,
			added: 0,
		});
		expect(await countSpecLossFindings(id)).toEqual({ open: 0, attached: 0, dismissed: 1 });
		// A change to the session's files: scanned again.
		await write(id, "other.md", "x", "assistant");
		expect(await scanSpecSessionLossById(id)).toMatchObject({ added: 0 });
	});

	test("a fork is scanned along the revisions it shares with its parent", async () => {
		const parent = await makeSession();
		await swallowed(parent.id);
		const child = await makeSession({ owner: parent.owner });
		await forkSpecNamespace(parent.id, child.id);
		expect(await scanSpecSessionLossById(child.id)).toMatchObject({ findings: 1, added: 1 });
		expect(await scanSpecSessionLossById(parent.id)).toMatchObject({ findings: 1, added: 1 });
		const [a] = await open(child.id);
		const [b] = await open(parent.id);
		expect(a?.id).not.toBe(b?.id as string);
	});

	test("the chain is read a page a statement, newest first", async () => {
		const { id } = await makeSession();
		for (let n = 0; n < 5; n++) await write(id, "n.md", `v${n}`, n % 2 ? "user" : "assistant");
		const [latest] = await db
			.select({ id: specFileRevisions.id })
			.from(specFileRevisions)
			.where(eq(specFileRevisions.content, "v4"));
		const chain = await readSpecRevisionChain(latest?.id as string);
		expect(chain.map((r) => r.createdBy)).toEqual([
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(chain.map((r) => r.chars)).toEqual([2, 2, 2, 2, 2]);
		expect(chain[4]?.parentRevisionId).toBeNull();
		expect(await readSpecRevisionChain("missing")).toEqual([]);
	});
});

describe("passes", () => {
	test("sessions are scanned a few a pass, the next goes on; subagents are not looked at", async () => {
		const made: string[] = [];
		for (let n = 0; n < 3; n++) {
			const { id } = await makeSession();
			await swallowed(id);
			made.push(id);
		}
		const root = made[0] as string;
		const sub = await makeSession({ type: "subagent", root });
		await swallowed(sub.id);
		const scannedOf = async () =>
			(await Promise.all(made.map((id) => readSpecLossScan(id)))).filter(Boolean).length;
		// Other cases' sessions are in the same database: only this case's are counted.
		let scans = 0;
		for (let pass = 0; pass < 50 && (await scannedOf()) < made.length; pass++) {
			const result = await runSpecLossPass({ pauseMs: 0, maxScans: 2 });
			expect(result.scanned).toBeLessThanOrEqual(2);
			scans += result.scanned;
		}
		expect(await scannedOf()).toBe(3);
		expect(scans).toBeGreaterThanOrEqual(3);
		expect(await readSpecLossScan(sub.id)).toBeNull();
		for (const id of made) expect(await open(id)).toHaveLength(1);
		// Everything scanned and unchanged: a full pass scans nothing.
		for (let pass = 0; pass < 50; pass++)
			if ((await runSpecLossPass({ pauseMs: 0 })).left === 0) break;
		expect(await runSpecLossPass({ pauseMs: 0 })).toMatchObject({
			scanned: 0,
			found: 0,
			attached: 0,
			left: 0,
		});
	});

	test("switched off: a pass does nothing and none can be asked for", async () => {
		const { id } = await makeSession();
		await swallowed(id);
		settings.outline.specImport = "off";
		expect(await runSpecLossPass({ pauseMs: 0 })).toEqual({
			sessions: 0,
			scanned: 0,
			found: 0,
			attached: 0,
			left: 0,
		});
		expect(await code(async () => requestSpecLossPass())).toBe("SPEC_IMPORT_OFF");
		expect(await readSpecLossScan(id)).toBeNull();
	});

	test("asked for: answered at once, run in the background", async () => {
		const { id } = await makeSession();
		await swallowed(id);
		const status = requestSpecLossPass();
		expect(status.running).toBe(true);
		// Not scanned on the request.
		expect(await readSpecLossScan(id)).toBeNull();
		await settleSpecLossPass();
		expect(specLossScanStatus()).toMatchObject({ running: false });
		expect(specLossScanStatus().lastPass?.found).toBeGreaterThanOrEqual(1);
		expect(await open(id)).toHaveLength(1);
	});
});

/** Passes until this case's sessions have nothing left to attach (other cases' are in the way). */
async function passes(done: () => Promise<boolean>): Promise<void> {
	for (let n = 0; n < 60; n++) {
		await runSpecLossPass({ pauseMs: 0 });
		if (await done()) return;
	}
	throw new Error("the passes did not get there");
}

async function all(narratorId: string, status: "open" | "attached" | "dismissed") {
	return (await specLossPage({ status, narratorId, limit: 50, canAct: true })).items;
}

async function spaceOf(narratorId: string): Promise<string> {
	const space = await outlineStore.findSpace({ kind: "session", narratorId });
	return space?.id as string;
}

const designPage = async (narratorId: string, title = "design.md") =>
	(await pages(narratorId)).find((page) => page.title === title);

/** An imported session whose owner's save dropped a table, scanned (nothing attached yet). */
async function imported(options: { language?: "en" | "zh-CN" } = {}) {
	const owner = await makeUser(options.language ?? "zh-CN");
	const { id } = await makeSession({ owner });
	await writeTasks(id, [{ text: "a task" }]);
	await swallowed(id);
	expect(await importSpecSession(id, { trigger: "manual" })).toMatchObject({ status: "imported" });
	expect(await backendOf(id)).toBe("outline");
	await scanSpecSessionLossById(id);
	const [finding] = await open(id);
	return { id, owner, findingId: finding?.id as string };
}

/** The same, with the finding attached by a pass. */
async function attached(options: { language?: "en" | "zh-CN" } = {}) {
	const made = await imported(options);
	await passes(async () => (await all(made.id, "attached")).length === 1);
	const [finding] = await all(made.id, "attached");
	return { ...made, blockId: finding?.blockId as string };
}

describe("the automatic attach", () => {
	test("a pass puts the finding on the file's page: one block at the top, the lost text under it", async () => {
		const { id, owner } = await imported();
		const before = await designPage(id);
		const commits = await commitCount(id);
		await passes(async () => (await all(id, "attached")).length === 1);
		const [finding] = await all(id, "attached");
		expect(finding).toMatchObject({ status: "attached", attachNote: null, attachable: false });
		expect(finding?.spaceId).toBe(await spaceOf(id));
		const page = await designPage(id);
		// The page's own blocks are as they were, after the one new block.
		expect(page?.blocks.slice(1)).toEqual(before?.blocks as string[]);
		expect(page?.blocks[0]).toContain("可能丢失的内容");
		expect(page?.blocks[0]).toContain("1 张表格");
		const under = await outlineStore.listChildren(
			await spaceOf(id),
			finding?.blockId as string,
			50,
		);
		// The table is one table block, as the import writes tables.
		expect(under.map((b) => b.content)).toEqual([TABLE]);
		const commit = (await outlineStore.listCommits(await spaceOf(id), { limit: 50 })).at(-1);
		expect(commit).toMatchObject({
			actorKind: "system",
			actorId: OUTLINE_SPEC_LOSS_ACTOR,
			responsibleUserId: owner,
		});
		expect(await commitCount(id)).toBe(commits + 1);
		// Once: later passes write nothing.
		await runSpecLossPass({ pauseMs: 0 });
		await runSpecLossPass({ pauseMs: 0 });
		expect(await commitCount(id)).toBe(commits + 1);
		expect(await countSpecLossFindings(id)).toEqual({ open: 0, attached: 1, dismissed: 0 });
	});

	test("a session still in Dynamic Spec waits; a pass after its import attaches", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a task" }]);
		await swallowed(id);
		await passes(async () => (await readSpecLossScan(id)) !== null);
		await runSpecLossPass({ pauseMs: 0 });
		expect(await open(id)).toMatchObject([{ status: "open", attachNote: null, attachable: false }]);
		expect(await commitCount(id)).toBe(0);
		expect(await importSpecSession(id, { trigger: "manual" })).toMatchObject({
			status: "imported",
		});
		await passes(async () => (await all(id, "attached")).length === 1);
		expect((await designPage(id))?.blocks[0]).toContain("Possibly lost content");
	});

	test("written but not recorded (a stop in between): recorded, never written twice", async () => {
		const { id, findingId, blockId } = await attached();
		const commits = await commitCount(id);
		await db
			.update(outlineSpecLossFindings)
			.set({ status: "open", blockId: null })
			.where(eq(outlineSpecLossFindings.id, findingId));
		await passes(async () => (await all(id, "attached")).length === 1);
		expect((await all(id, "attached"))[0]?.blockId).toBe(blockId);
		expect(await commitCount(id)).toBe(commits);
		const [block] = await outlineStore.getBlockMetas(await spaceOf(id), {
			sids: [specLossBlockSid(findingId)],
		});
		expect(block?.id).toBe(blockId);
	});

	test("the current revision holds the content again: not attached, and said so", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a task" }]);
		await swallowed(id);
		await scanSpecSessionLossById(id);
		expect(await open(id)).toHaveLength(1);
		// Put back before the import.
		await write(id, "design.md", WITH_TABLE, "assistant");
		expect(await importSpecSession(id, { trigger: "manual" })).toMatchObject({
			status: "imported",
		});
		const commits = await commitCount(id);
		await passes(async () => (await open(id))[0]?.attachNote === "restored");
		expect(await commitCount(id)).toBe(commits);
		expect(await countSpecLossFindings(id)).toEqual({ open: 1, attached: 0, dismissed: 0 });
		// Not tried again by later passes.
		await runSpecLossPass({ pauseMs: 0 });
		expect(await commitCount(id)).toBe(commits);
	});

	test("so many a session in one pass, the rest by later passes", async () => {
		const perPass = SPEC_LOSS_ATTACH_LIMITS.perSessionPass;
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a task" }]);
		for (let n = 0; n < perPass + 2; n++) await swallowed(id, `note-${n}.md`);
		expect(await importSpecSession(id, { trigger: "manual" })).toMatchObject({
			status: "imported",
		});
		await scanSpecSessionLossById(id);
		const commits = await commitCount(id);
		const first = await runSpecLossPass({ pauseMs: 0 });
		expect(first.left).toBeGreaterThanOrEqual(1);
		expect(await countSpecLossFindings(id)).toEqual({ open: 2, attached: perPass, dismissed: 0 });
		expect(await commitCount(id)).toBe(commits + perPass);
		expect((await open(id)).map((f) => f.attachNote)).toEqual(["session_cap", "session_cap"]);
		await passes(async () => (await open(id)).length === 0);
		expect(await countSpecLossFindings(id)).toEqual({
			open: 0,
			attached: perPass + 2,
			dismissed: 0,
		});
	});

	test("so many on one page; more are left to a person, who may still attach one", async () => {
		const perPage = SPEC_LOSS_ATTACH_LIMITS.perPage;
		const total = perPage + 2;
		const owner = await makeUser("en");
		const { id } = await makeSession({ owner });
		await writeTasks(id, [{ text: "a task" }]);
		const table = (n: number) => `| t${n} |\n| --- |\n| v${n} |`;
		const doc = (from: number) =>
			`# Many\n\n${Array.from({ length: total - from }, (_, k) => table(from + k)).join("\n\n")}\n`;
		await write(id, "many.md", doc(0), "assistant");
		// Each save of the person drops one more table.
		for (let n = 1; n <= total; n++) await write(id, "many.md", doc(n), "user");
		expect(await importSpecSession(id, { trigger: "manual" })).toMatchObject({
			status: "imported",
		});
		expect(await scanSpecSessionLossById(id)).toMatchObject({ findings: total });
		await passes(
			async () => (await open(id)).filter((f) => f.attachNote === "page_cap").length === 2,
		);
		expect(await countSpecLossFindings(id)).toEqual({ open: 2, attached: perPage, dismissed: 0 });
		const commits = await commitCount(id);
		await runSpecLossPass({ pauseMs: 0 });
		expect(await commitCount(id)).toBe(commits);
		// A person asks for one of them.
		const [left] = await open(id);
		const result = await decideSpecLossFinding({
			id: left?.id as string,
			narratorId: id,
			action: "attach",
			userId: owner,
		});
		expect(result).toMatchObject({ status: "attached", attachNote: null });
		expect(await commitCount(id)).toBe(commits + 1);
	}, 30_000);

	test("the page is gone: said so, and a person's attach is refused with the reason", async () => {
		const { id, owner, findingId } = await imported();
		const page = await designPage(id);
		await writeOutline({
			spaceId: await spaceOf(id),
			ops: [{ op: "delete", block: { sid: page?.sid as string } }],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		const commits = await commitCount(id);
		await passes(async () => (await open(id))[0]?.attachNote === "no_page");
		expect(await commitCount(id)).toBe(commits);
		expect(
			await code(() =>
				decideSpecLossFinding({ id: findingId, narratorId: id, action: "attach", userId: owner }),
			),
		).toBe("SPEC_LOSS_NO_PAGE");
		expect(await commitCount(id)).toBe(commits);
		// The text can still be read.
		expect((await specLossDetail(findingId, id)).parts[0]?.text).toBe(TABLE);
	});

	test("a block a system commit deleted is attached anew; one a person deleted stays deleted", async () => {
		const bySystem = await attached();
		await writeOutline({
			spaceId: await spaceOf(bySystem.id),
			ops: [{ op: "delete", block: { id: bySystem.blockId } }],
			actor: { kind: "system", id: "plugin:some.plugin" },
			responsibleUserId: bySystem.owner,
		});
		await passes(async () => {
			const [finding] = await all(bySystem.id, "attached");
			return finding !== undefined && finding.blockId !== bySystem.blockId;
		});
		const [again] = await all(bySystem.id, "attached");
		const [block] = await outlineStore.getBlockMetas(await spaceOf(bySystem.id), {
			ids: [again?.blockId as string],
		});
		expect(block).toMatchObject({ deleted: false, sid: specLossBlockSid(bySystem.findingId, 1) });
		expect((await designPage(bySystem.id))?.blocks[0]).toContain("可能丢失的内容");

		const byPerson = await attached();
		await writeOutline({
			spaceId: await spaceOf(byPerson.id),
			ops: [{ op: "delete", block: { id: byPerson.blockId } }],
			actor: { kind: "human", id: byPerson.owner },
			responsibleUserId: byPerson.owner,
		});
		const commits = await commitCount(byPerson.id);
		await runSpecLossPass({ pauseMs: 0 });
		await runSpecLossPass({ pauseMs: 0 });
		expect(await commitCount(byPerson.id)).toBe(commits);
		expect((await all(byPerson.id, "attached"))[0]?.blockId).toBe(byPerson.blockId);
		expect((await designPage(byPerson.id))?.blocks[0]).not.toContain("可能丢失的内容");
	});

	test("a re-import after a move back is not held up by the attached block, which follows to the new page", async () => {
		const { id, owner, findingId, blockId } = await attached();
		await db.update(users).set({ role: "admin" }).where(eq(users.id, owner));
		const oldPage = await designPage(id);
		await revertSpecImport(id, owner);
		// Moved back: the block stays where it is, the finding stays attached.
		await runSpecLossPass({ pauseMs: 0 });
		expect((await all(id, "attached"))[0]?.blockId).toBe(blockId);
		// The session works in Dynamic Spec again: the file changes (the table still gone).
		await write(id, "design.md", `${WITHOUT_TABLE}\nmore\n`, "assistant");
		await reimportSpecSession(id, owner);
		await settleSpecImportRequests();
		expect((await readSpecImportState(id))?.status).toBe("imported");
		expect(await backendOf(id)).toBe("outline");
		await passes(async () => {
			const [finding] = await all(id, "attached");
			return finding !== undefined && finding.blockId !== blockId;
		});
		const page = await designPage(id);
		expect(page?.blocks[0]).toContain("可能丢失的内容");
		// The page of the file's new revision, not the one the block was on.
		expect(page?.sid).not.toBe(oldPage?.sid as string);
		expect((await all(id, "attached"))[0]?.id).toBe(findingId);
	});
});

describe("what a person does about a finding", () => {
	test("dismiss takes the block away when only the attach wrote it; reopen attaches again", async () => {
		const { id, owner, findingId, blockId } = await attached();
		const before = await designPage(id);
		const dismissed = await decideSpecLossFinding({
			id: findingId,
			narratorId: id,
			action: "dismiss",
			userId: owner,
		});
		expect(dismissed).toMatchObject({ status: "dismissed", blockId: null });
		expect(dismissed.resolvedAt).toBeTruthy();
		const page = await designPage(id);
		expect(page?.blocks).toEqual(before?.blocks.slice(1) as string[]);
		const [gone] = await outlineStore.getBlockMetas(await spaceOf(id), { ids: [blockId] });
		expect(gone?.deleted).toBe(true);
		expect(await outlineStore.listChildren(await spaceOf(id), blockId, 10)).toEqual([]);
		// Dismissed: passes leave it alone.
		const commits = await commitCount(id);
		await runSpecLossPass({ pauseMs: 0 });
		expect(await commitCount(id)).toBe(commits);
		expect(
			await code(() =>
				decideSpecLossFinding({ id: findingId, narratorId: id, action: "dismiss", userId: owner }),
			),
		).toBe("SPEC_LOSS_DECIDED");
		expect(
			await code(() =>
				decideSpecLossFinding({ id: findingId, narratorId: id, action: "attach", userId: owner }),
			),
		).toBe("SPEC_LOSS_DECIDED");

		const reopened = await decideSpecLossFinding({
			id: findingId,
			narratorId: null,
			action: "reopen",
			userId: owner,
		});
		expect(reopened).toMatchObject({ status: "attached", resolvedAt: null });
		expect(reopened.blockId).not.toBe(blockId);
		expect(await designPage(id)).toEqual(before);
		expect(
			await code(() =>
				decideSpecLossFinding({ id: findingId, narratorId: id, action: "reopen", userId: owner }),
			),
		).toBe("SPEC_LOSS_DECIDED");
	});

	test("dismiss keeps a block someone wrote in, and the finding is dismissed all the same", async () => {
		for (const change of ["child", "edit"] as const) {
			const { id, owner, findingId, blockId } = await attached();
			await writeOutline({
				spaceId: await spaceOf(id),
				ops: [
					change === "child"
						? { op: "insert", parent: { id: blockId }, content: "my note about this table" }
						: { op: "update", block: { id: blockId }, content: "I looked at this" },
				],
				actor: { kind: "human", id: owner },
				responsibleUserId: owner,
			});
			const commits = await commitCount(id);
			const dismissed = await decideSpecLossFinding({
				id: findingId,
				narratorId: id,
				action: "dismiss",
				userId: owner,
			});
			expect(dismissed).toMatchObject({ status: "dismissed", blockId });
			expect(await commitCount(id)).toBe(commits);
			const [kept] = await outlineStore.getBlockMetas(await spaceOf(id), { ids: [blockId] });
			expect(kept?.deleted).toBe(false);
			// Reopened: the block that is there is the one, nothing is written.
			const reopened = await decideSpecLossFinding({
				id: findingId,
				narratorId: id,
				action: "reopen",
				userId: owner,
			});
			expect(reopened).toMatchObject({ status: "attached", blockId });
			expect(await commitCount(id)).toBe(commits);
		}
	});

	test("a session still in Dynamic Spec: dismiss and reopen change the finding only; attach is refused", async () => {
		const { id, owner } = await makeSession();
		await swallowed(id);
		await scanSpecSessionLossById(id);
		const [finding] = await open(id);
		const findingId = finding?.id as string;
		expect(
			await code(() =>
				decideSpecLossFinding({
					id: findingId,
					narratorId: id,
					action: "attach",
					userId: owner as string,
				}),
			),
		).toBe("SPEC_LOSS_NOT_IMPORTED");
		const other = await makeSession();
		expect(
			await code(() =>
				decideSpecLossFinding({
					id: findingId,
					narratorId: other.id,
					action: "dismiss",
					userId: other.owner as string,
				}),
			),
		).toBe("RESOURCE_NOT_FOUND");
		expect(await code(() => specLossDetail(findingId, other.id))).toBe("RESOURCE_NOT_FOUND");
		const dismissed = await decideSpecLossFinding({
			id: findingId,
			narratorId: id,
			action: "dismiss",
			userId: owner as string,
		});
		expect(dismissed).toMatchObject({ status: "dismissed" });
		const [row] = await db
			.select()
			.from(outlineSpecLossFindings)
			.where(eq(outlineSpecLossFindings.id, findingId));
		expect(row).toMatchObject({ status: "dismissed", resolvedBy: owner });
		const reopened = await decideSpecLossFinding({
			id: findingId,
			narratorId: null,
			action: "reopen",
			userId: owner as string,
		});
		expect(reopened).toMatchObject({ status: "open", resolvedAt: null, attachNote: null });
		expect(await commitCount(id)).toBe(0);
	});

	test("the list is paged, newest first, without the lost text; the admin's has the scan", async () => {
		const { id } = await makeSession();
		for (const path of ["a.md", "b.md", "c.md"]) await swallowed(id, path);
		await scanSpecSessionLossById(id);
		const first = await specLossPage({ status: "open", narratorId: id, limit: 2, canAct: false });
		expect(first.items).toHaveLength(2);
		expect(first.next).toBeTruthy();
		expect(first.counts.open).toBe(3);
		expect(first.canAct).toBe(false);
		expect(first.scan).toBeUndefined();
		expect(JSON.stringify(first)).not.toContain("alpha");
		const second = await specLossPage({
			status: "open",
			narratorId: id,
			limit: 2,
			cursor: first.next,
			canAct: false,
		});
		expect(second.items).toHaveLength(1);
		expect(second.next).toBeNull();
		expect(new Set([...first.items, ...second.items].map((item) => item.path))).toEqual(
			new Set(["a.md", "b.md", "c.md"]),
		);
		const everyone = await specLossPage({
			status: "open",
			narratorId: null,
			limit: 50,
			canAct: true,
		});
		expect(everyone.scan).toMatchObject({ running: false });
		expect(everyone.items.some((item) => item.narratorId === id)).toBe(true);
	});
});
