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
 *  - attach puts the lost text on the file's imported page as one block at the top (nothing else
 *    changes), only for an imported session whose page is there; dismiss and reopen only change
 *    the finding; a finding decided already cannot be decided again; another session's finding
 *    is not found.
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
} from "../../../../db/schema";
import { AppError } from "../../../../lib/errors";
import { settings } from "../../../../lib/settings";
import { forkSpecNamespace, writeSpecFile } from "../../../spec-vfs-service";
import { invalidateTaskBackend } from "../../../task-source";
import { stopEditTextWorker } from "../../edit-text-runner";
import { outlineStore } from "../../store";
import { writeOutline } from "../../write";
import { importSpecSession, resetSpecImportRecords } from "../importer";
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

	test("it only reads: no spec revision and no outline commit is written", async () => {
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
		expect(await runSpecLossPass({ pauseMs: 0 })).toMatchObject({ scanned: 0, found: 0, left: 0 });
	});

	test("switched off: a pass does nothing and none can be asked for", async () => {
		const { id } = await makeSession();
		await swallowed(id);
		settings.outline.specImport = "off";
		expect(await runSpecLossPass({ pauseMs: 0 })).toEqual({
			sessions: 0,
			scanned: 0,
			found: 0,
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

describe("what a person does about a finding", () => {
	async function imported() {
		const owner = await makeUser("zh-CN");
		const { id } = await makeSession({ owner });
		await writeTasks(id, [{ text: "a task" }]);
		await swallowed(id);
		expect(await importSpecSession(id, { trigger: "manual" })).toMatchObject({
			status: "imported",
		});
		expect(await backendOf(id)).toBe("outline");
		await scanSpecSessionLossById(id);
		const [finding] = await open(id);
		return { id, owner, findingId: finding?.id as string };
	}

	test("attach: one block at the top of the file's page, the lost text under it", async () => {
		const { id, owner, findingId } = await imported();
		const before = (await pages(id)).find((page) => page.title === "design.md");
		const after = await decideSpecLossFinding({
			id: findingId,
			narratorId: id,
			action: "attach",
			userId: owner,
		});
		expect(after).toMatchObject({ status: "attached", attachable: false });
		expect(after.blockId).toBeTruthy();
		expect(after.spaceId).toBeTruthy();
		const page = (await pages(id)).find((p) => p.title === "design.md");
		// The page's own blocks are as they were, after the one new block.
		expect(page?.blocks.slice(1)).toEqual(before?.blocks as string[]);
		expect(page?.blocks[0]).toContain("可能丢失的内容");
		expect(page?.blocks[0]).toContain("1 张表格");
		const space = await outlineStore.findSpace({ kind: "session", narratorId: id });
		const under = await outlineStore.listChildren(space?.id as string, after.blockId as string, 50);
		const text = under.map((block) => block.content).join("\n");
		for (const cell of ["name", "value", "alpha", "beta"]) expect(text).toContain(cell);
		const block = await outlineStore.getBlock(after.blockId as string);
		const commit = (await outlineStore.listCommits(space?.id as string, { limit: 50 })).at(-1);
		// The table is one table block, as the import writes tables.
		expect(under.map((b) => b.content)).toEqual([TABLE]);
		expect(block?.spaceId).toBe(space?.id as string);
		expect(commit).toMatchObject({
			actorKind: "system",
			actorId: OUTLINE_SPEC_LOSS_ACTOR,
			responsibleUserId: owner,
		});
		// Decided: not again, by anyone.
		for (const action of ["attach", "dismiss", "reopen"] as const)
			expect(
				await code(() =>
					decideSpecLossFinding({ id: findingId, narratorId: id, action, userId: owner }),
				),
			).toBe("SPEC_LOSS_DECIDED");
		expect(await countSpecLossFindings(id)).toEqual({ open: 0, attached: 1, dismissed: 0 });
	});

	test("attach is refused while the session keeps Dynamic Spec, and when the page is gone", async () => {
		const spec = await makeSession();
		await swallowed(spec.id);
		await scanSpecSessionLossById(spec.id);
		const [specFinding] = await open(spec.id);
		expect(
			await code(() =>
				decideSpecLossFinding({
					id: specFinding?.id as string,
					narratorId: spec.id,
					action: "attach",
					userId: spec.owner as string,
				}),
			),
		).toBe("SPEC_LOSS_NOT_IMPORTED");

		const { id, owner, findingId } = await imported();
		const space = await outlineStore.findSpace({ kind: "session", narratorId: id });
		const page = (await pages(id)).find((p) => p.title === "design.md");
		await writeOutline({
			spaceId: space?.id as string,
			ops: [{ op: "delete", block: { sid: page?.sid as string } }],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		const commits = await commitCount(id);
		expect(
			await code(() =>
				decideSpecLossFinding({ id: findingId, narratorId: id, action: "attach", userId: owner }),
			),
		).toBe("SPEC_LOSS_NO_PAGE");
		expect(await commitCount(id)).toBe(commits);
		expect((await open(id))[0]?.status).toBe("open");
		// The text can still be read.
		expect((await specLossDetail(findingId, id)).parts[0]?.text).toBe(TABLE);
	});

	test("dismiss and reopen change the finding only; another session's is not found", async () => {
		const { id, owner } = await makeSession();
		await swallowed(id);
		await scanSpecSessionLossById(id);
		const [finding] = await open(id);
		const findingId = finding?.id as string;
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
		expect(dismissed.resolvedAt).toBeTruthy();
		const [row] = await db
			.select()
			.from(outlineSpecLossFindings)
			.where(eq(outlineSpecLossFindings.id, findingId));
		expect(row).toMatchObject({ status: "dismissed", resolvedBy: owner });
		expect(
			(await specLossPage({ status: "dismissed", narratorId: id, canAct: true })).items,
		).toHaveLength(1);
		const reopened = await decideSpecLossFinding({
			id: findingId,
			narratorId: null,
			action: "reopen",
			userId: owner as string,
		});
		expect(reopened).toMatchObject({ status: "open", resolvedAt: null });
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
		const all = await specLossPage({ status: "open", narratorId: null, limit: 50, canAct: true });
		expect(all.scan).toMatchObject({ running: false });
		expect(all.items.some((item) => item.narratorId === id)).toBe(true);
	});
});
