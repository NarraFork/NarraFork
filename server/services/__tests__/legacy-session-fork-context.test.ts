import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";
import {
	aclGrants,
	chapters,
	integrationResourceBindings,
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	projects,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";

// This worktree intentionally has no migration directory. Build only a disposable
// in-memory fixture from typed declarations; never bootstrap a real database here.
const sqlite = new Database(":memory:");
const dialect = new SQLiteSyncDialect();
for (const table of Object.values(schema)) {
	let config: ReturnType<typeof getTableConfig>;
	try {
		config = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
	} catch {
		continue;
	}
	if (!config?.name || !config.columns) continue;
	const columns = config.columns.map((column) => {
		const value = column.default;
		const sqlDefault =
			value === undefined
				? ""
				: ` DEFAULT ${
						typeof value === "object" && value !== null && "queryChunks" in value
							? dialect.sqlToQuery(value as Parameters<typeof dialect.sqlToQuery>[0]).sql
							: typeof value === "string"
								? `'${value.replaceAll("'", "''")}'`
								: typeof value === "boolean"
									? Number(value)
									: value === null
										? "NULL"
										: typeof value === "object"
											? `'${JSON.stringify(value).replaceAll("'", "''")}'`
											: value
					}`;
		return `${column.name} ${column.getSQLType()} ${column.primary ? "PRIMARY KEY" : ""}${sqlDefault}`;
	});
	sqlite.run(`CREATE TABLE IF NOT EXISTS ${config.name} (${columns.join(",")})`);
}
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
mock.module("../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
const { canReadNarrator, canWriteNarrator } = await import("../narrator-acl");
const { narratorService } = await import("../narrator-service");
const { resolveSkillContextForNarrator } = await import("../skill-service");

const now = new Date().toISOString();
const owner = generateId();
const friend = generateId();
const stranger = generateId();
const projectId = generateId();
const otherProjectId = generateId();
const chapterId = generateId();
const projectPath = `${process.env.NARRAFORK_HOME}/original-project`;
const worktreePath = `${process.env.NARRAFORK_HOME}/original-worktree`;

beforeAll(async () => {
	for (const id of [owner, friend, stranger])
		await db
			.insert(users)
			.values({ id, username: id, passwordHash: "test", role: "user", createdAt: now });
	for (const [id, gitPath] of [
		[projectId, projectPath],
		[otherProjectId, `${projectPath}-other`],
	])
		await db.insert(projects).values({
			id,
			name: id,
			gitPath,
			ownerUserId: owner,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		});
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: friend,
		capability: "read",
		createdAt: now,
	});
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "old resource",
		branch: "old-resource",
		baseBranch: "main",
		worktreePath,
		createdAt: now,
		updatedAt: now,
	});
});

async function parent(fields: Partial<typeof narrators.$inferInsert> = {}) {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		ownerUserId: owner,
		visibility: "private",
		writeAudience: "owner",
		traits: ["standalone", "disabledTools:dangerous-tool"],
		enabledTools: ["terminal"],
		permissionMode: "readOnly",
		createdAt: now,
		updatedAt: now,
		...fields,
	});
	return id;
}

async function rules(id: string) {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "narrator",
		scopeId: id,
		principalType: "user",
		principalId: friend,
		capability: "read",
		createdAt: now,
	});
	await db.insert(narratorWhitelistDirs).values({
		id: generateId(),
		narratorId: id,
		path: "/safe",
		accessLevel: "readOnly",
		targetKind: "host",
		targetValue: "local",
		createdAt: now,
	});
	await db.insert(narratorBlacklistDirs).values({
		id: generateId(),
		narratorId: id,
		path: "/secret",
		denyLevel: "denyAll",
		targetKind: "device",
		targetValue: "device-original",
		createdAt: now,
	});
	await db.insert(narratorWhitelistCmds).values({
		id: generateId(),
		narratorId: id,
		pattern: "git status",
		enabled: false,
		createdAt: now,
	});
	await db.insert(narratorBlacklistCmds).values({
		id: generateId(),
		narratorId: id,
		pattern: "rm *",
		denyPrompt: "no deletion",
		createdAt: now,
	});
}

async function assertInherited(parentId: string, childId: string, cwd: string) {
	const child = await db.query.narrators.findFirst({ where: eq(narrators.id, childId) });
	expect(child).toMatchObject({
		cwd,
		defaultDeviceId: "device-original",
		contextProjectId: projectId,
		ownerUserId: owner,
		visibility: "private",
		writeAudience: "owner",
		permissionMode: "readOnly",
	});
	expect(child?.traits).toContain("disabledTools:dangerous-tool");
	expect(child?.enabledTools).toEqual(["terminal"]);
	if (!child) throw new Error("missing fork");
	expect(await canReadNarrator(child, { userId: friend, isAdmin: false })).toBe(true);
	expect(await canWriteNarrator(child, { userId: friend, isAdmin: false })).toBe(false);
	expect(await canReadNarrator(child, { userId: stranger, isAdmin: false })).toBe(false);
	const inheritedGrant = await db.query.aclGrants.findFirst({
		where: and(
			eq(aclGrants.scopeType, "narrator"),
			eq(aclGrants.scopeId, childId),
			eq(aclGrants.principalId, friend),
		),
	});
	expect(inheritedGrant?.capability).toBe("read");
	expect(
		await db.query.narratorWhitelistDirs.findFirst({
			where: eq(narratorWhitelistDirs.narratorId, childId),
		}),
	).toMatchObject({
		path: "/safe",
		accessLevel: "readOnly",
		targetKind: "host",
		targetValue: "local",
	});
	expect(
		await db.query.narratorBlacklistDirs.findFirst({
			where: eq(narratorBlacklistDirs.narratorId, childId),
		}),
	).toMatchObject({
		path: "/secret",
		denyLevel: "denyAll",
		targetKind: "device",
		targetValue: "device-original",
	});
	expect(
		await db.query.narratorWhitelistCmds.findFirst({
			where: eq(narratorWhitelistCmds.narratorId, childId),
		}),
	).toMatchObject({ pattern: "git status", enabled: false });
	expect(
		await db.query.narratorBlacklistCmds.findFirst({
			where: eq(narratorBlacklistCmds.narratorId, childId),
		}),
	).toMatchObject({ pattern: "rm *", denyPrompt: "no deletion" });
	expect((await narratorService.getById(parentId)).id).toBe(parentId);
}

describe("skill project context", () => {
	test("standalone explicit project retains project skills and fallback directory", async () => {
		const id = await parent({ contextProjectId: projectId, cwd: null });
		expect(await resolveSkillContextForNarrator(id)).toEqual({
			projectGitPath: projectPath,
			cwd: projectPath,
		});
	});
	test("chapter project wins over conflicting explicit context", async () => {
		const id = await parent({ chapterId, contextProjectId: otherProjectId, cwd: null });
		expect(await resolveSkillContextForNarrator(id)).toEqual({
			projectGitPath: projectPath,
			cwd: worktreePath,
		});
	});
	test("an arbitrary directory never infers project membership", async () => {
		const id = await parent({ cwd: projectPath });
		expect(await resolveSkillContextForNarrator(id)).toEqual({
			projectGitPath: null,
			cwd: projectPath,
		});
	});
});

describe("ordinary session fork context and constraints", () => {
	test("ask-in-passing read-only lock is retained while named/task identity is not duplicated", async () => {
		const id = await parent({
			contextProjectId: projectId,
			isAskInPassing: true,
			traits: ["standalone", "ask-in-passing", "named", "scheduled", "background"],
		});
		const child = await narratorService.forkNarrator(id, null, { inheritMode: "fresh" });
		expect(child.isAskInPassing).toBe(true);
		expect(child.permissionMode).toBe("readOnly");
		expect(child.traits).toEqual(["standalone", "ask-in-passing"]);
		expect(child.handle).toBeNull();
	});
	test("stale prepared workspace contexts cannot override the current directory", async () => {
		const id = await parent({
			contextProjectId: projectId,
			defaultDeviceId: "device-original",
			cwd: "/current",
			workspaceRevision: 2,
			workspaceContext: {
				revision: 1,
				deviceId: "device-original",
				cwd: "/stale",
				pathFlavor: "posix",
				contextKey: "stale",
				capabilities: { switchDirectory: true },
			},
		});
		await rules(id);
		const child = await narratorService.forkNarrator(id, null, { inheritMode: "fresh" });
		await assertInherited(id, child.id, "/current");
	});
	test("a matching committed execution context is retained when legacy cwd is absent", async () => {
		const id = await parent({
			contextProjectId: projectId,
			defaultDeviceId: "device-original",
			cwd: null,
			workspaceRevision: 2,
			workspaceContext: {
				revision: 2,
				deviceId: "device-original",
				cwd: "/committed",
				pathFlavor: "posix",
				contextKey: "committed",
				capabilities: { switchDirectory: true },
			},
		});
		await rules(id);
		const child = await narratorService.forkNarrator(id, null, { inheritMode: "fresh" });
		await assertInherited(id, child.id, "/committed");
	});
	test.each([
		"fresh",
		"full",
	] as const)("%s standalone fork inherits effective project cwd and ACL without widening", async (inheritMode) => {
		const id = await parent({
			contextProjectId: projectId,
			defaultDeviceId: "device-original",
			cwd: null,
		});
		await rules(id);
		const child = await narratorService.forkNarrator(id, null, { inheritMode });
		await assertInherited(id, child.id, projectPath);
	});
	test("forking an old chapter session keeps its project gate and actual worktree, without unbinding the parent", async () => {
		const id = await parent({
			chapterId,
			contextProjectId: otherProjectId,
			defaultDeviceId: "device-original",
			cwd: null,
		});
		await rules(id);
		const child = await narratorService.forkNarrator(id, null, {
			standalone: true,
			inheritMode: "fresh",
		});
		await assertInherited(id, child.id, worktreePath);
		expect((await narratorService.getById(id)).chapterId).toBe(chapterId);
	});
	test("selected-message forks inherit the same access and execution profile", async () => {
		const id = await parent({
			contextProjectId: projectId,
			defaultDeviceId: "device-original",
			cwd: "/chosen",
		});
		await rules(id);
		const messageId = generateId();
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId: id,
			role: "user",
			contentJson: [{ type: "text", text: "keep" }],
			createdAt: now,
		});
		await db
			.insert(narratorMessageRefs)
			.values({ id: generateId(), narratorId: id, messageId, seq: 1 });
		const child = await narratorService.forkFromMessages(id, [messageId]);
		await assertInherited(id, child.id, "/chosen");
	});
	test("fresh tool forks preserve context and honor model override", async () => {
		const id = await parent({ contextProjectId: projectId, defaultDeviceId: "device-original" });
		await rules(id);
		const child = await narratorService.forkStandaloneFromTool(id, "fresh", {
			model: "custom-model",
		});
		await assertInherited(id, child.id, projectPath);
		expect(child.model).toBe("custom-model");
	});
	test("frozen OAuth policy keeps its revoked authority provenance, not an unrestricted ordinary child", async () => {
		const snapshot = { test: "frozen constraint" };
		const id = await parent({
			contextProjectId: projectId,
			defaultDeviceId: "device-original",
			oauthPolicySnapshotJson: snapshot,
		});
		await db.insert(integrationResourceBindings).values({
			id: generateId(),
			resourceType: "narrator",
			resourceId: id,
			sourceType: "oauth_client",
			sourceId: "client",
			authorityType: "oauth_grant",
			authorityId: "authority",
			state: "revoked",
			createdAt: now,
			updatedAt: now,
		});
		const child = await narratorService.forkNarrator(id, null, { inheritMode: "fresh" });
		expect(child.oauthPolicySnapshotJson).toEqual(snapshot);
		expect(
			await db.query.integrationResourceBindings.findFirst({
				where: eq(integrationResourceBindings.resourceId, child.id),
			}),
		).toMatchObject({ authorityId: "authority", state: "revoked", provisionKey: null });
	});
});
