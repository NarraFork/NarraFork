/**
 * Recent-tab cleanup after a project access change.
 *
 * Recent tabs are persisted server-side, so revoking someone's project membership
 * otherwise leaves them holding tabs that 404 on click. These tests pin the three
 * properties that make the cleanup safe rather than merely aggressive:
 *
 *  1. tabs pointing into the lost project are removed — including chapter and session
 *     tabs, which carry no projectId of their own
 *  2. tabs the user can STILL open are kept, even inside that same project (an explicit
 *     narrator grant, or a project that is public anyway) — the prune asks the gate, it
 *     does not pattern-match on ids
 *  3. tabs in other projects are untouched
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/project-tab-prune.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-tab-prune-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { db } = await import("../../db");
const { aclGrants, chapters, narrators, projects, users } = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { listAllRecentTabs, pruneUnreadableProjectTabs, upsertRecentTab } = await import(
	"../recent-tabs-service"
);

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

let memberId: string;
let outsiderId: string;
let ownerId: string;

async function makeUser(role: "admin" | "user", label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${generateId(6)}`,
		passwordHash: "x",
		role,
		createdAt: new Date().toISOString(),
	});
	return id;
}

async function makeProject(visibility: "private" | "public"): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id,
		name: `prune-${generateId(6)}`,
		gitPath: join(testHome, `repo-${generateId(6)}`),
		ownerUserId: ownerId,
		visibility,
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

async function makeChapter(projectId: string): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(chapters).values({
		id,
		projectId,
		title: `chapter-${generateId(6)}`,
		branch: `br-${generateId(6)}`,
		baseBranch: "main",
		status: "active",
		role: "branch",
		axisOffset: 0,
		crossOffset: 0,
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

async function addMember(
	projectId: string,
	userId: string,
	capability: "read" | "write" | "manage",
): Promise<void> {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: userId,
		capability,
		grantedBy: ownerId,
		createdAt: new Date().toISOString(),
	});
}

async function addTab(
	userId: string,
	type: "project" | "chapter" | "narrator",
	id: string,
): Promise<void> {
	await upsertRecentTab(userId, {
		type,
		id,
		title: `${type}-tab`,
		lastVisitedAt: Date.now(),
	});
}

async function tabKeysOf(userId: string): Promise<Set<string>> {
	const tabs = await listAllRecentTabs(userId);
	return new Set(tabs.map((tab) => `${tab.type}:${tab.id}`));
}

beforeAll(async () => {
	ownerId = await makeUser("user", "prune-owner");
	memberId = await makeUser("user", "prune-member");
	outsiderId = await makeUser("user", "prune-outsider");
});

describe("pruning tabs a user can no longer open", () => {
	test("a project tab behind a lost gate is removed", async () => {
		const projectId = await makeProject("private");
		await addTab(outsiderId, "project", projectId);
		expect(await tabKeysOf(outsiderId)).toContain(`project:${projectId}`);

		await pruneUnreadableProjectTabs(outsiderId, projectId);
		expect(await tabKeysOf(outsiderId)).not.toContain(`project:${projectId}`);
	});

	test("chapter tabs inside the lost project are removed too", async () => {
		const projectId = await makeProject("private");
		const chapterId = await makeChapter(projectId);
		await addTab(outsiderId, "chapter", chapterId);

		// The chapter tab carries no projectId; the prune has to resolve it.
		await pruneUnreadableProjectTabs(outsiderId, projectId);
		expect(await tabKeysOf(outsiderId)).not.toContain(`chapter:${chapterId}`);
	});

	test("a member keeps their tabs — the gate still opens for them", async () => {
		const projectId = await makeProject("private");
		const chapterId = await makeChapter(projectId);
		await addMember(projectId, memberId, "read");
		await addTab(memberId, "project", projectId);
		await addTab(memberId, "chapter", chapterId);

		// Running the prune against a user who still has access must be a no-op: this is
		// what makes it safe to call on the whole tab-holder set for a visibility change.
		await pruneUnreadableProjectTabs(memberId, projectId);
		const keys = await tabKeysOf(memberId);
		expect(keys).toContain(`project:${projectId}`);
		expect(keys).toContain(`chapter:${chapterId}`);
	});

	test("a public project's tabs survive for a non-member", async () => {
		const projectId = await makeProject("public");
		await addTab(outsiderId, "project", projectId);

		// Membership is not the only way through the gate. Matching on projectId alone
		// would have deleted a tab that still works.
		await pruneUnreadableProjectTabs(outsiderId, projectId);
		expect(await tabKeysOf(outsiderId)).toContain(`project:${projectId}`);
	});

	test("tabs in other projects are untouched", async () => {
		const lost = await makeProject("private");
		const kept = await makeProject("public");
		await addTab(outsiderId, "project", lost);
		await addTab(outsiderId, "project", kept);

		await pruneUnreadableProjectTabs(outsiderId, lost);
		const keys = await tabKeysOf(outsiderId);
		expect(keys).not.toContain(`project:${lost}`);
		expect(keys).toContain(`project:${kept}`);
	});

	test("an admin keeps everything", async () => {
		const adminId = await makeUser("admin", "prune-admin");
		const projectId = await makeProject("private");
		await addTab(adminId, "project", projectId);

		await pruneUnreadableProjectTabs(adminId, projectId);
		expect(await tabKeysOf(adminId)).toContain(`project:${projectId}`);
	});
});
