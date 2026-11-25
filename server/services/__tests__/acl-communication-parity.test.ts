import { beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db, sqlite } from "../../db";
import { aclGrants, narratorProjectLinks, narrators, projects, users } from "../../db/schema";
import {
	canReadNarrator,
	canWriteNarrator,
	type NarratorPrincipal,
	narratorReadableWhere,
} from "../narrator-acl";
import {
	communicationReadPredicate,
	communicationWritePredicate,
} from "../narrator-communication/predicates";
import { projectReadableWhereForColumn } from "../project-acl";

const viewer = { userId: "parity-'viewer", isAdmin: false };
const owner = { userId: "parity-owner", isAdmin: false };
const admin = { userId: "parity-admin", isAdmin: true };
const now = "2026-11-24T00:00:00.000Z";

beforeAll(() => {
	for (const principal of [viewer, owner, admin]) {
		db.insert(users)
			.values({
				id: principal.userId,
				username: principal.userId,
				role: principal.isAdmin ? "admin" : "user",
				passwordHash: "unused",
				createdAt: now,
			})
			.run();
	}
});

function project(id: string, ownerUserId: string | null, visibility: "private" | "public") {
	db.insert(projects)
		.values({
			id,
			gitPath: `/parity/${id}`,
			name: id,
			ownerUserId,
			visibility,
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

function narrator(id: string, options: Partial<typeof narrators.$inferInsert> = {}) {
	db.insert(narrators)
		.values({
			id,
			title: id,
			ownerUserId: owner.userId,
			visibility: "private",
			writeAudience: "owner",
			createdAt: now,
			updatedAt: now,
			...options,
		})
		.run();
}

function grant(
	scopeType: "project" | "narrator",
	scopeId: string,
	capability: "read" | "write" | "manage",
	principalType: "user" | "role" = "user",
	principalId = principalType === "user" ? viewer.userId : "user",
	domainKind?: "tag",
) {
	const id = `${scopeType}:${scopeId}:${capability}:${principalType}:${principalId}:${domainKind ?? ""}`;
	db.insert(aclGrants)
		.values({
			id,
			scopeType,
			scopeId,
			principalType,
			principalId,
			capability,
			domainKind,
			domainValue: domainKind ? "unrelated" : null,
			createdAt: now,
		})
		.run();
	return id;
}

function sqlAllows(id: string, predicate: { sql: string; params: string[] }) {
	return !!sqlite
		.query(`SELECT 1 FROM narrators n WHERE n.id = ? AND ${predicate.sql}`)
		.get(id, ...predicate.params);
}

async function assertVerdict(
	id: string,
	read: boolean,
	write: boolean,
	principal: NarratorPrincipal = viewer,
) {
	const row = db.select().from(narrators).where(eq(narrators.id, id)).get();
	if (!row) throw new Error(`Missing fixture ${id}`);
	const js = [await canReadNarrator(row, principal), await canWriteNarrator(row, principal)];
	expect(js, `${id} JS verdict`).toEqual([read, write]);
	const readPredicate = communicationReadPredicate("n", principal);
	const writePredicate = communicationWritePredicate("n", principal);
	expect(readPredicate.sql).not.toContain(principal.userId);
	expect(writePredicate.sql).not.toContain(principal.userId);
	expect(
		[sqlAllows(id, readPredicate), sqlAllows(id, writePredicate)],
		`${id} communication SQL`,
	).toEqual(js);
	const listRow = db
		.select({ id: narrators.id })
		.from(narrators)
		.where(and(eq(narrators.id, id), narratorReadableWhere(principal)))
		.get();
	expect(!!listRow, `${id} narrator list SQL`).toBe(read);
}

function withLegacyReferences(insert: () => void) {
	// Populate corrupt legacy references without weakening FK enforcement elsewhere.
	sqlite.run("PRAGMA foreign_keys = OFF");
	try {
		insert();
	} finally {
		sqlite.run("PRAGMA foreign_keys = ON");
	}
}

test("role and user grants obey scope, capability and domain boundaries", async () => {
	narrator("role-read");
	grant("narrator", "role-read", "read", "role");
	await assertVerdict("role-read", true, false);

	narrator("user-write");
	grant("narrator", "user-write", "write");
	await assertVerdict("user-write", true, true);
	await assertVerdict("user-write", false, false, { userId: "someone-else", isAdmin: false });

	narrator("wrong-grants");
	grant("project", "wrong-grants", "write", "role");
	grant("narrator", "wrong-grants", "manage", "role");
	grant("narrator", "wrong-grants", "read", "role", "user", "tag");
	grant("narrator", "wrong-grants", "write", "role", "admin");
	await assertVerdict("wrong-grants", false, false);

	// The denied row sorts first. A predicate applied after the limit would lose the allowed row.
	const read = communicationReadPredicate("n", viewer);
	expect(
		sqlite
			.query(
				`SELECT n.id FROM narrators n WHERE n.id IN ('wrong-grants', 'role-read') AND ${read.sql} ORDER BY n.id DESC LIMIT 1`,
			)
			.all(...read.params),
	).toEqual([{ id: "role-read" }]);
});

test("project write audience uses project write, not project read; grants revoke immediately", async () => {
	project("team", null, "private");
	for (const writeAudience of ["owner", "project", "public"] as const) {
		narrator(`team-${writeAudience}`, {
			contextProjectId: "team",
			visibility: "project",
			writeAudience,
		});
	}
	narrator("team-private", { contextProjectId: "team" });
	grant("narrator", "team-private", "write", "role");
	grant("project", "team", "read", "role", "user", "tag");
	await assertVerdict("team-private", false, false); // private project with NULL owner
	await assertVerdict("team-public", false, false);

	const projectRead = grant("project", "team", "read", "role");
	expect(
		db
			.select({ id: projects.id })
			.from(projects)
			.where(and(eq(projects.id, "team"), projectReadableWhereForColumn(viewer, sql`projects.id`)))
			.get(),
	).toEqual({ id: "team" });
	await assertVerdict("team-owner", true, false);
	await assertVerdict("team-project", true, false);
	await assertVerdict("team-public", true, true);
	await assertVerdict("team-private", true, true);

	const projectWrite = grant("project", "team", "write", "role");
	await assertVerdict("team-project", true, true);
	db.delete(aclGrants).where(eq(aclGrants.id, projectWrite)).run();
	await assertVerdict("team-project", true, false);

	const projectManage = grant("project", "team", "manage");
	await assertVerdict("team-project", true, true);
	await assertVerdict("team-owner", true, false);
	db.delete(aclGrants).where(eq(aclGrants.id, projectManage)).run();
	db.delete(aclGrants).where(eq(aclGrants.id, projectRead)).run();
	await assertVerdict("team-private", false, false); // narrator grant survives, gate does not
	await assertVerdict("team-project", false, false);
	await assertVerdict("team-public", false, false);
});

test("project resolution distinguishes absent, dangling and readable projects", async () => {
	project("open-project", owner.userId, "public");
	project("closed-project", owner.userId, "private");
	narrator("standalone", { visibility: "project", writeAudience: "project" });
	narrator("standalone-public", { visibility: "public", writeAudience: "public" });
	narrator("linked", { visibility: "project", writeAudience: "project" });
	narrator("explicit", {
		contextProjectId: "closed-project",
		visibility: "project",
		writeAudience: "public",
	});
	db.insert(narratorProjectLinks)
		.values([
			{
				narratorId: "linked",
				projectId: "open-project",
				role: "primary",
				source: "cwd",
				updatedAt: now,
			},
			{
				narratorId: "explicit",
				projectId: "open-project",
				role: "primary",
				source: "cwd",
				updatedAt: now,
			},
			{
				narratorId: "standalone",
				projectId: "open-project",
				role: "additional",
				source: "cwd",
				updatedAt: now,
			},
		])
		.run();
	await assertVerdict("standalone", false, false);
	await assertVerdict("standalone-public", true, true);
	await assertVerdict("linked", true, false); // public project grants read only
	await assertVerdict("explicit", false, false);

	withLegacyReferences(() => {
		narrator("missing-project", {
			contextProjectId: "absent-project",
			visibility: "project",
			writeAudience: "public",
		});
		narrator("missing-project-public", {
			contextProjectId: "absent-project",
			visibility: "public",
			writeAudience: "public",
		});
	});
	grant("narrator", "missing-project", "write");
	await assertVerdict("missing-project", false, false);
	await assertVerdict("missing-project-public", true, false); // only read bypasses the gate
	await assertVerdict("missing-project", true, true, owner); // ownership bypasses both
});

test("delegation follows ACL root; missing root denies, primary fork is independent", async () => {
	narrator("root");
	narrator("child", { type: "subagent", parentNarratorId: "root", aclRootNarratorId: "root" });
	narrator("grandchild", {
		type: "subagent",
		parentNarratorId: "child",
		aclRootNarratorId: "root",
	});
	narrator("fork", { type: "primary", parentNarratorId: "root" });
	narrator("null-root", {
		type: "subagent",
		parentNarratorId: "root",
		ownerUserId: viewer.userId,
		visibility: "public",
		writeAudience: "public",
	});
	withLegacyReferences(() => {
		narrator("missing-root", {
			type: "subagent",
			parentNarratorId: "root",
			aclRootNarratorId: "absent-root",
			ownerUserId: viewer.userId,
			visibility: "public",
			writeAudience: "public",
		});
	});
	await assertVerdict("child", false, false);
	grant("narrator", "root", "write", "role");
	await assertVerdict("child", true, true);
	await assertVerdict("grandchild", true, true);
	await assertVerdict("fork", false, false);
	await assertVerdict("null-root", false, false);
	await assertVerdict("missing-root", false, false);
	await assertVerdict("missing-root", true, true, admin);
});
