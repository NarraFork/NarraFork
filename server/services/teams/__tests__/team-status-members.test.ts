/**
 * The people section of the coordinator's team status (docs/PROJECT_TEAMS-PLAN.md §二.2, §二.12;
 * M1): members and onlookers by name from the coordinator's ACL, when each member last spoke as
 * an absolute UTC minute, at most 12 listed and the rest counted, inside the 6 KB budget; a
 * member speaking alone never writes another status row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-team-status-members-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { db } = await import("../../../db");
const { and, eq, inArray } = await import("drizzle-orm");
const { aclGrants, narratorMessages, narrators, projects, users } = await import(
	"../../../db/schema"
);
const { generateId } = await import("../../../lib/id");
const { createTeam } = await import("../team-service");
const {
	formatSpokeAt,
	forgetTeamStatus,
	readTeamStatus,
	renderTeamStatus,
	setTeamStatusDelivery,
	writeTeamStatusAtPass,
} = await import("../team-status");
const { readTeamMembers, readLastSpoken } = await import("../team-members");
const { TEAM_STATUS_MAX_BYTES, TEAM_STATUS_MEMBERS_LIMIT } = await import("@shared/project-teams");

const OWNER = "people-owner";
const ALICE = "people-alice";
const BOB = "people-bob";
const CAROL = "people-carol";
const DAVE = "people-dave";
const repo = join(testHome, "repo");
let teamId: string;
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

afterAll(() => {
	setTeamStatusDelivery(null);
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

let projectId: string;

/** A user who can reach the project (the gate); access to the team is then the coordinator's. */
async function user(id: string, username = id) {
	await db.insert(users).values({
		id,
		username,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	if (projectId && id !== OWNER)
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId: id,
			capability: "read",
			createdAt: new Date().toISOString(),
		});
}

async function grant(userId: string, capability: "read" | "write") {
	const id = generateId();
	await db.insert(aclGrants).values({
		id,
		scopeType: "narrator",
		scopeId: teamId,
		principalType: "user",
		principalId: userId,
		capability,
		createdAt: new Date().toISOString(),
	});
	return id;
}

const spokenIds: string[] = [];
async function speak(userId: string, createdAt: string, extra: Record<string, unknown> = {}) {
	const id = generateId();
	await db.insert(narratorMessages).values({
		id,
		narratorId: teamId,
		role: "user",
		contentJson: [{ type: "text", text: "hello" }],
		createdBy: userId,
		origin: "user",
		createdAt,
		...extra,
	});
	spokenIds.push(id);
}

beforeAll(async () => {
	mkdirSync(repo, { recursive: true });
	await user(OWNER);
	projectId = generateId();
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id: projectId,
		name: "people project",
		gitPath: repo,
		defaultBranch: "main",
		ownerUserId: OWNER,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	for (const id of [ALICE, BOB, CAROL, DAVE]) await user(id);
	const team = await createTeam(
		{ projectId, name: "People team" },
		{ userId: OWNER, isAdmin: false },
	);
	teamId = team.id;
	// Only explicit grants decide here: the coordinator is private to its owner otherwise.
	await db
		.update(narrators)
		.set({ visibility: "private", writeAudience: "owner" })
		.where(eq(narrators.id, teamId));
	await grant(ALICE, "write");
	await grant(BOB, "write");
	await grant(CAROL, "read");
});

beforeEach(async () => {
	forgetTeamStatus();
	if (spokenIds.length)
		await db.delete(narratorMessages).where(inArray(narratorMessages.id, spokenIds.splice(0)));
});

const statusText = async (locale: "en" | "zh-CN" = "en") =>
	(await readTeamStatus(teamId, locale, { now: NOW }))?.text as string;

describe("the people of a team", () => {
	test("members (write) and onlookers (read) from the coordinator's ACL, owner first", async () => {
		const read = await readTeamMembers(teamId);
		expect(read?.members.map((m) => [m.userId, m.role, m.owner])).toEqual([
			[OWNER, "member", true],
			[ALICE, "member", false],
			[BOB, "member", false],
			[CAROL, "onlooker", false],
		]);
		// No access at all: not listed.
		expect(read?.members.some((m) => m.userId === DAVE)).toBe(false);
	});

	test("last spoke: a person's own top-level messages among the window, newest wins", async () => {
		await speak(ALICE, "2026-11-18T09:31:40.000Z");
		await speak(ALICE, "2026-11-18T10:05:00.000Z");
		await speak(BOB, "2026-11-17T23:59:00.000Z");
		// Not speaking: a system row written for someone, a subagent card's message.
		await speak(OWNER, "2026-11-18T11:00:00.000Z", { role: "sys", origin: "system" });
		await speak(OWNER, "2026-11-18T11:01:00.000Z", { parentToolUseId: "tool-use" });
		const spoken = readLastSpoken(teamId);
		expect(spoken.get(ALICE)).toBe("2026-11-18T10:05:00.000Z");
		expect(spoken.get(BOB)).toBe("2026-11-17T23:59:00.000Z");
		expect(spoken.has(OWNER)).toBe(false);
		// The window is bounded: outside the latest N messages a person reads as not recent.
		expect(readLastSpoken(teamId, 1).has(BOB)).toBe(false);
	});
});

describe("the status section", () => {
	test("names, roles and absolute last-spoken times; deterministic", async () => {
		await speak(ALICE, "2026-11-18T09:31:40.000Z");
		const text = await statusText();
		expect(text).toContain(
			'People: members 3, onlookers 1 (members speak to you, approve and answer; onlookers only read). "Last spoke" is a member\'s latest message here, in UTC.\n' +
				`- ${OWNER} — member (owner), no recent message\n` +
				`- ${ALICE} — member, last spoke 2026-11-18 09:31 UTC\n` +
				`- ${BOB} — member, no recent message\n` +
				`- ${CAROL} — onlooker`,
		);
		expect(text).not.toContain(DAVE);
		expect(text).not.toMatch(/ago|minutes? before|刚刚/);
		expect(await statusText()).toBe(text);
		expect(formatSpokeAt("2026-01-02T03:04:59.999Z")).toBe("2026-01-02 03:04 UTC");
	});

	test("zh-CN", async () => {
		await speak(BOB, "2026-11-18T08:00:00.000Z");
		const text = await statusText("zh-CN");
		expect(text).toContain("团队里的人：成员 3 人，旁观者 1 人");
		expect(text).toContain(`- ${BOB} — 成员，最近发言 2026-11-18 08:00 UTC`);
		expect(text).toContain(`- ${CAROL} — 旁观者`);
	});

	test("a revoked person leaves the section", async () => {
		const id = await grant(DAVE, "write");
		expect(await statusText()).toContain(`- ${DAVE} — member`);
		await db.delete(aclGrants).where(eq(aclGrants.id, id));
		expect(await statusText()).not.toContain(DAVE);
	});

	test("capped: at most 12 listed and the rest counted, inside 6 KB", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 30; i++) {
			const id = `people-many-${String(i).padStart(2, "0")}`;
			await user(id, `${"名".repeat(50)}-${String(i).padStart(2, "0")}`);
			ids.push(await grant(id, "write"));
		}
		try {
			const text = await statusText();
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(TEAM_STATUS_MAX_BYTES);
			expect(text).toContain("People: members 33, onlookers 1");
			const lines = text.split("\n").filter((line) => / — (member|onlooker)/.test(line));
			expect(lines).toHaveLength(TEAM_STATUS_MEMBERS_LIMIT);
			expect(text).toContain(`- … and ${34 - TEAM_STATUS_MEMBERS_LIMIT} more`);
		} finally {
			await db.delete(aclGrants).where(inArray(aclGrants.id, ids));
		}
	});

	test("capped by bytes too: a huge people list never pushes the status past 6 KB", () => {
		const list = Array.from({ length: 40 }, (_, i) => ({
			name: `${"長".repeat(60)}${i}`,
			role: (i % 3 ? "member" : "onlooker") as "member" | "onlooker",
			owner: i === 0,
			spokeAt: "2026-11-18T09:31:00.000Z",
		}));
		const text = renderTeamStatus(
			{
				name: "Big",
				baseBranch: "main",
				brief: "规".repeat(1365),
				contextLimit: 60,
				openItems: [],
				openCounts: {},
				openTotal: 0,
				finished: 0,
				approvals: [],
				weekStart: "2026-11-16",
				overruns: {},
				overrunTotal: 0,
				decisions: [],
				overlap: null,
				people: { list, more: true, visibility: "project", writeAudience: "project" },
			},
			"en",
		);
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(TEAM_STATUS_MAX_BYTES);
		expect(text).toContain("People: members 26+, onlookers 14+");
		expect(text).toMatch(/- … and \d+\+ more/);
	});

	test("speaking alone never writes another row; a change to the people does", async () => {
		const rows: string[] = [];
		const kept = new Set<string>();
		setTeamStatusDelivery({
			async deliver(_id, row) {
				const messageId = `row-${rows.length}`;
				rows.push(row.content);
				kept.add(messageId);
				return { messageId, turnText: null };
			},
			async stillInHistory(_id, messageId) {
				return kept.has(messageId);
			},
		});
		const pass = () =>
			writeTeamStatusAtPass({
				narratorId: teamId,
				locale: "en",
				compactSeq: null,
				runStart: true,
				now: NOW,
			});
		await speak(ALICE, "2026-11-18T09:00:00.000Z");
		expect(await pass()).toBe(true);
		// Alice speaks again: only her time moved, so the next run writes nothing.
		await speak(ALICE, "2026-11-18T09:45:00.000Z");
		expect(await pass()).toBe(false);
		expect(rows).toHaveLength(1);
		// Someone joins: written, with the times as they are now.
		const id = await grant(DAVE, "read");
		try {
			expect(await pass()).toBe(true);
			expect(rows[1]).toContain(`- ${ALICE} — member, last spoke 2026-11-18 09:45 UTC`);
			expect(rows[1]).toContain(`- ${DAVE} — onlooker`);
		} finally {
			await db.delete(aclGrants).where(and(eq(aclGrants.id, id)));
		}
	});
});
