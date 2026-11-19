/**
 * The coordinator's team status (docs/PROJECT_TEAMS-PLAN.md §二.2, P2): a deterministic `sys`
 * row in the history — at run start, right after a compaction, and at most every ten minutes
 * of a long run — never in the system prompt; at most 6 KB.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-team-status-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { db, sqlite } = await import("../../../db");
const { and, eq } = await import("drizzle-orm");
const {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
	teamWorkEvents,
	teamWorkItems,
	users,
} = await import("../../../db/schema");
const { generateId } = await import("../../../lib/id");
const { TEAM_TRAIT } = await import("../../../lib/narrator-utils");
const { narratorService } = await import("../../narrator-service");
const { pendingPermissions } = await import("../../narrator-session-state");
const { runtimeBasePrompt } = await import("../../agent-runtime/orchestrator");
const { resolveRuntimePolicy } = await import("../../agent-runtime/policy");
const { createTeam, updateTeam } = await import("../team-service");
const status = await import("../team-status");
const {
	forgetTeamStatus,
	readTeamStatus,
	setTeamStatusDelivery,
	TEAM_STATUS_SOURCE,
	teamWeekStart,
	writeTeamStatusAtBoundary,
	writeTeamStatusAtPass,
} = status;
const { TEAM_STATUS_CADENCE_MS, TEAM_STATUS_MAX_BYTES } = await import("@shared/project-teams");
const { readTestMessageContent } = await import("../../../../tests/setup");

const OWNER = "status-owner";
const OWNER_NAME = `${OWNER}-${Date.now()}`;
const repo = join(testHome, "repo");
let projectId: string;
let teamId: string;
let workerId: string;
let strangerId: string;
const principal = { userId: OWNER, isAdmin: false };

// Wednesday 2026-11-18 12:00 UTC; its week starts on Monday 2026-11-16.
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

beforeAll(async () => {
	mkdirSync(repo, { recursive: true });
	const now = new Date().toISOString();
	await db.insert(users).values({
		id: OWNER,
		username: OWNER_NAME,
		passwordHash: "x",
		role: "user",
		createdAt: now,
	});
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "status project",
		gitPath: repo,
		defaultBranch: "main",
		ownerUserId: OWNER,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	const team = await createTeam(
		{ projectId, name: "Status team", brief: "Always run the targeted tests." },
		principal,
	);
	teamId = team.id;
	const worker = await narratorService.create({ title: "worker one", cwd: repo });
	workerId = worker.id;
	await db
		.update(narrators)
		.set({ type: "subagent", aclRootNarratorId: teamId, parentNarratorId: teamId })
		.where(eq(narrators.id, workerId));
	const stranger = await narratorService.create({ title: "someone else", cwd: repo });
	strangerId = stranger.id;
});

const addedPermissions: string[] = [];
function addPermission(narratorId: string, toolName: string, input: Record<string, unknown>) {
	const key = `perm-${String(addedPermissions.length).padStart(4, "0")}`;
	pendingPermissions.set(key, {
		narratorId,
		toolName,
		input,
		toolUseId: `tu-${key}`,
		signal: new AbortController().signal,
	} as never);
	addedPermissions.push(key);
	return key;
}

function addItem(title: string, state: string, extra: Record<string, unknown> = {}) {
	const at = new Date(NOW - 1000 + addedItems.length).toISOString();
	const id = generateId();
	db.insert(teamWorkItems)
		.values({
			id,
			teamId,
			projectId,
			title,
			state: state as never,
			createdAt: at,
			updatedAt: at,
			...extra,
		})
		.run();
	addedItems.push(id);
	return id;
}
const addedItems: string[] = [];

function addEvent(kind: string, createdAt: string, detail: Record<string, unknown> | null = null) {
	db.insert(teamWorkEvents)
		.values({
			id: generateId(),
			teamId,
			workItemId: null,
			kind,
			actorKind: "agent",
			actorId: teamId,
			detailJson: detail,
			createdAt,
		})
		.run();
}

function resetState() {
	for (const key of addedPermissions.splice(0)) pendingPermissions.delete(key);
	for (const id of addedItems.splice(0))
		db.delete(teamWorkItems).where(eq(teamWorkItems.id, id)).run();
	db.delete(teamWorkEvents)
		.where(and(eq(teamWorkEvents.teamId, teamId)))
		.run();
	forgetTeamStatus();
}

beforeEach(resetState);
afterEach(() => {
	setTeamStatusDelivery(null);
});

const read = (locale: "en" | "zh-CN" = "en", contextPercent?: number) =>
	readTeamStatus(teamId, locale, { now: NOW, contextPercent }).then(
		(status) => status?.text as string,
	);

describe("the status text", () => {
	test("names the team, carries the brief and every section", async () => {
		addItem("Build the parser", "in_progress", {
			branchName: "team/parser",
			workerNarratorId: workerId,
		});
		addItem("Review the API", "in_review");
		addItem("Old thing", "merged");
		addPermission(workerId, "Bash", { command: "git push origin team/parser" });
		addPermission(teamId, "Edit", { file_path: "src/app.ts" });
		addPermission(strangerId, "Bash", { command: "rm -rf /elsewhere" });
		addEvent("coordinator.overrun.editLines", "2026-11-17T09:00:00.000Z", { size: 80 });
		addEvent("coordinator.overrun.editLines", "2026-11-16T00:00:00.000Z", { size: 40 });
		addEvent("coordinator.overrun.bashOutputBytes", "2026-11-18T08:00:00.000Z", { size: 9000 });
		// Last week: not counted.
		addEvent("coordinator.overrun.readLines", "2026-11-15T23:59:59.999Z", { size: 900 });
		addEvent("team.decision", "2026-11-17T10:00:00.000Z", {
			summary: "Chose SQLite for the cache",
		});
		const text = await read();
		expect(text).toBe(
			[
				'[Team status] Team "Status team", base branch main. Written by the system, not by a person.',
				"",
				"Team brief (shared rules for you and every subagent):\nAlways run the targeted tests.",
				"",
				"Your suggested limits were exceeded 3 times this week (since 2026-11-16, UTC): edit size 2, command output 1.",
				"",
				"Waiting for a person's approval: 2.",
				"- Bash by worker one: git push origin team/parser",
				"- Edit by you: src/app.ts",
				"",
				"Work items: in progress 1, in review 1, 1 finished.",
				"- [in progress] Build the parser — branch team/parser — worker one",
				"- [in review] Review the API",
				"",
				'People: members 1, onlookers 0 (members speak to you, approve and answer; onlookers only read). "Last spoke" is a member\'s latest message here, in UTC.',
				"Everyone with write access to the project is a member too.",
				"Everyone in the project may look on.",
				`- ${OWNER_NAME} — member (owner), no recent message`,
				"",
				"Recent decisions you took on people's behalf (they can overturn them):",
				"- 2026-11-17: Chose SQLite for the cache",
			].join("\n"),
		);
		expect(text).not.toContain("elsewhere");
	});

	test("zh-CN", async () => {
		const text = await read("zh-CN");
		expect(text).toContain("[团队状态] 团队「Status team」，基线分支 main。");
		expect(text).toContain("工作项：还没有。");
		expect(text).toContain("本周（自 2026-11-16 起，UTC）没有超出建议上限。");
	});

	test("byte-identical for identical state; different when the state changes", async () => {
		addItem("One", "queued");
		addPermission(workerId, "Read", { file_path: "a.ts" });
		const first = await read();
		expect(await read()).toBe(first);
		addItem("Two", "queued");
		const second = await read();
		expect(second).not.toBe(first);
		expect(await read()).toBe(second);
	});

	test("a context note above the team's suggested share only", async () => {
		expect(await read("en", 59)).not.toContain("Context use");
		expect(await read("en", 60)).toContain(
			"Context use is above the team's suggested 60%: compact when the work allows.",
		);
	});

	test("capped at 6 KB: the brief stays whole, lists are cut and counted", async () => {
		const brief = "规".repeat(1365); // 4,095 bytes
		await updateTeam(teamId, principal, { brief });
		try {
			for (let i = 0; i < 45; i++)
				addItem(`${"长".repeat(78)} ${i}`, i % 2 ? "in_progress" : "queued", {
					branchName: `team/${"b".repeat(150)}-${i}`,
				});
			for (let i = 0; i < 30; i++)
				addPermission(workerId, "Bash", { command: `${"x".repeat(300)} ${i}` });
			for (let i = 0; i < 8; i++)
				addEvent("team.decision", `2026-11-17T10:00:0${i}.000Z`, { summary: "d".repeat(400) });
			const text = await read();
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(TEAM_STATUS_MAX_BYTES);
			expect(text).toContain(brief);
			expect(text).toContain("Waiting for a person's approval: 30.");
			expect(text).toContain("Work items: queued 23, in progress 22.");
			expect(text).toMatch(/- … and \d+ more/);
			expect(await read()).toBe(text);
		} finally {
			await updateTeam(teamId, principal, { brief: "Always run the targeted tests." });
		}
	});

	test("a team-less narrator has no status", async () => {
		expect(await readTeamStatus(strangerId, "en", { now: NOW })).toBeNull();
	});

	test("the week starts on Monday, UTC", () => {
		expect(teamWeekStart(NOW).toISOString()).toBe("2026-11-16T00:00:00.000Z");
		expect(teamWeekStart(Date.UTC(2026, 10, 16, 0, 0, 0)).toISOString()).toBe(
			"2026-11-16T00:00:00.000Z",
		);
		expect(teamWeekStart(Date.UTC(2026, 10, 22, 23, 59, 59)).toISOString()).toBe(
			"2026-11-16T00:00:00.000Z",
		);
	});
});

describe("when the status is written", () => {
	interface Row {
		content: string;
		schedule: string;
	}
	let rows: Row[];
	let inHistory: Set<string>;

	function seam() {
		rows = [];
		inHistory = new Set();
		setTeamStatusDelivery({
			async deliver(_narratorId, row) {
				const messageId = `m${rows.length}`;
				rows.push({ content: row.content, schedule: row.schedule });
				inHistory.add(messageId);
				return { messageId, turnText: row.schedule === "onNextTurn" ? row.content : null };
			},
			async stillInHistory(_narratorId, messageId) {
				return inHistory.has(messageId);
			},
		});
	}

	const pass = (runStart: boolean, compactSeq: number | null, now = NOW) =>
		writeTeamStatusAtPass({ narratorId: teamId, locale: "en", compactSeq, runStart, now });
	const boundary = (now: number) =>
		writeTeamStatusAtBoundary({ narratorId: teamId, locale: "en", now });

	test("at run start, before the history is read (a plain row)", async () => {
		seam();
		expect(await pass(true, null)).toBe(true);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.schedule).toBe("none");
		expect(rows[0]?.content).toContain("[Team status]");
	});

	test("a later pass of the same run with no compaction writes nothing", async () => {
		seam();
		await pass(true, null);
		expect(await pass(false, null)).toBe(false);
		expect(rows).toHaveLength(1);
	});

	test("right after a compaction or a clear, even mid-run and with nothing changed", async () => {
		seam();
		await pass(true, 4);
		expect(await pass(false, 9)).toBe(true);
		expect(rows).toHaveLength(2);
		expect(rows[1]?.content).toBe(rows[0]?.content);
		expect(rows[1]?.schedule).toBe("none");
	});

	test("a new run with the same text already in context writes nothing; changes are written", async () => {
		seam();
		await pass(true, 4);
		expect(await pass(true, 4)).toBe(false);
		addItem("New work", "queued");
		expect(await pass(true, 4)).toBe(true);
		expect(rows).toHaveLength(2);
		// The earlier row left the history (a rewind): written again even though unchanged.
		inHistory.clear();
		expect(await pass(true, 4)).toBe(true);
		expect(rows).toHaveLength(3);
	});

	test("a new process (nothing remembered) writes at its first pass", async () => {
		seam();
		await pass(true, 4);
		forgetTeamStatus(teamId);
		expect(await pass(false, 4)).toBe(true);
	});

	test("at tool boundaries: at most every ten minutes, and only when the text changed", async () => {
		seam();
		await pass(true, null, NOW);
		addItem("Changed", "queued");
		expect(await boundary(NOW + TEAM_STATUS_CADENCE_MS - 1)).toBeNull();
		const due = await boundary(NOW + TEAM_STATUS_CADENCE_MS);
		expect(due?.turnText).toContain("Changed");
		expect(rows.at(-1)?.schedule).toBe("onNextTurn");
		// Ten more minutes with nothing new: nothing written.
		expect(await boundary(NOW + 2 * TEAM_STATUS_CADENCE_MS)).toBeNull();
		// A change right after that look waits for the next ten minutes.
		addItem("Changed again", "queued");
		expect(await boundary(NOW + 2 * TEAM_STATUS_CADENCE_MS + 1000)).toBeNull();
		expect(await boundary(NOW + 3 * TEAM_STATUS_CADENCE_MS)).not.toBeNull();
		expect(rows).toHaveLength(3);
	});

	test("the brief is written once per compaction cycle, not in every row (review S4)", async () => {
		const brief = Array(600).fill("Rule.").join(" "); // 3,599 bytes
		await updateTeam(teamId, principal, { brief });
		try {
			seam();
			await pass(true, 4);
			expect(rows[0]?.content).toContain(brief);
			// Next run: only this week's overrun count changed.
			addEvent("coordinator.overrun.editLines", "2026-11-17T09:00:00.000Z", { size: 80 });
			expect(await pass(true, 4)).toBe(true);
			const second = rows[1]?.content as string;
			expect(second).not.toContain(brief);
			expect(second).toContain(
				"Team brief: unchanged since an earlier team status in this conversation showed it (3599 bytes).",
			);
			expect(Buffer.byteLength(second, "utf8")).toBeLessThan(1024);
			// At a tool boundary as well.
			addEvent("coordinator.overrun.readLines", "2026-11-17T09:00:00.000Z", { size: 900 });
			const due = await boundary(NOW + TEAM_STATUS_CADENCE_MS);
			expect(due?.turnText).not.toContain(brief);
			// After a compaction the brief comes back whole.
			expect(await pass(false, 9)).toBe(true);
			expect(rows.at(-1)?.content).toContain(brief);
			// A changed brief is written whole at once.
			await updateTeam(teamId, principal, { brief: `${brief}New rule.` });
			expect(await pass(true, 9)).toBe(true);
			expect(rows.at(-1)?.content).toContain(`${brief}New rule.`);
			// The row that carried it left the history (a rewind): whole again.
			inHistory.clear();
			addEvent("coordinator.overrun.readLines", "2026-11-17T10:00:00.000Z", { size: 901 });
			expect(await pass(true, 9)).toBe(true);
			expect(rows.at(-1)?.content).toContain(`${brief}New rule.`);
		} finally {
			await updateTeam(teamId, principal, { brief: "Always run the targeted tests." });
		}
	});

	test("a session that never had a status (not a coordinator) is never looked at", async () => {
		seam();
		expect(
			await writeTeamStatusAtBoundary({ narratorId: strangerId, locale: "en", now: NOW * 2 }),
		).toBeNull();
		expect(rows).toHaveLength(0);
	});
});

describe("through the real injection path", () => {
	test("a team_status sys row in the coordinator's history; the system prompt never changes", async () => {
		const policy = resolveRuntimePolicy([]);
		const promptOf = async () => {
			const row = await narratorService.getById(teamId);
			expect(row.traits).toContain(TEAM_TRAIT);
			return runtimeBasePrompt(row, "en", policy);
		};
		const before = await promptOf();
		expect(
			await writeTeamStatusAtPass({
				narratorId: teamId,
				locale: "en",
				compactSeq: null,
				runStart: true,
				now: NOW,
			}),
		).toBe(true);
		const refs = db
			.select({ messageId: narratorMessageRefs.messageId })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, teamId))
			.all();
		const statusIds = refs
			.map((ref) => ref.messageId)
			.filter((id) =>
				readTestMessageContent(sqlite, id).some(
					(block) =>
						(block as { type?: string }).type === "system_injection" &&
						(block as { source?: string }).source === TEAM_STATUS_SOURCE,
				),
			);
		expect(statusIds).toHaveLength(1);
		const message = db
			.select({ role: narratorMessages.role })
			.from(narratorMessages)
			.where(eq(narratorMessages.id, statusIds[0] as string))
			.get();
		expect(message?.role).toBe("sys");
		const text = JSON.stringify(readTestMessageContent(sqlite, statusIds[0] as string));
		expect(text).toContain("[Team status]");
		expect(text).toContain("Always run the targeted tests.");
		// The same state at the next run start: the row is still in history, nothing new.
		expect(
			await writeTeamStatusAtPass({
				narratorId: teamId,
				locale: "en",
				compactSeq: null,
				runStart: true,
				now: NOW,
			}),
		).toBe(false);
		addItem("Something new", "queued");
		expect(
			await writeTeamStatusAtPass({
				narratorId: teamId,
				locale: "en",
				compactSeq: null,
				runStart: true,
				now: NOW,
			}),
		).toBe(true);
		const after = await promptOf();
		expect(after).toBe(before);
		expect(after ?? "").not.toContain("[Team status]");
	});

	test("the orchestrator writes it before the pass reads its history, coordinators only", async () => {
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(
			join(import.meta.dir, "../../agent-runtime/orchestrator.ts"),
			"utf8",
		);
		const write = source.indexOf("await writeTeamStatusAtPass({");
		expect(write).toBeGreaterThan(-1);
		expect(write).toBeLessThan(
			source.indexOf("const preparedPrefix = await preparePrefixRequest("),
		);
		expect(source.slice(source.indexOf("const teamCoordinator ="), write)).toContain(
			'!placement && freshNarrator.type === "primary" && isTeamNarrator(freshNarrator.traits)',
		);
		const session = readFileSync(join(import.meta.dir, "../../narrator-session.ts"), "utf8");
		expect(session).toContain("await writeTeamStatusAtBoundary({");
	});
});

describe("the reader's label", () => {
	test("team_status rows are headed 'Team status' / '团队状态'", async () => {
		const { readFileSync } = await import("node:fs");
		const root = join(import.meta.dir, "../../../..");
		const adapter = readFileSync(join(root, "shared/pretext-layout/segment-adapter.ts"), "utf8");
		expect(adapter).toContain('team_status: "sidecarSourceTeamStatus",');
		expect(adapter).toContain('sidecarSourceTeamStatus: "Team status",');
		const labels = readFileSync(
			join(root, "frontend/components/narrator/vlist/useVListLabels.ts"),
			"utf8",
		);
		expect(labels).toContain('sidecarSourceTeamStatus: t("sidecar.sources.team_status"),');
		for (const [locale, text] of [
			["en", "Team status"],
			["zh-CN", "团队状态"],
		]) {
			const json = JSON.parse(
				readFileSync(join(root, `frontend/locales/${locale}/narrator.json`), "utf8"),
			);
			expect(json.sidecar.sources.team_status).toBe(text);
		}
	});
});
