/**
 * `judgeNarratorAccessBatch` decides many principals at once with the narrator ACL's own rules
 * (`readVerdict` / `writeVerdict`, the project gate's `projectReadVerdict` / `projectWriteVerdict`),
 * only with the facts read in bulk. It must agree with `canReadNarrator` / `canWriteNarrator` on
 * every combination: narrator audiences, project visibility, project and narrator grants of each
 * capability, role grants, domain credentials (never access), owners, admins, subagents (judged
 * on their root, or denied with no root) and narrators outside any project.
 *
 * Also measures the batch for 100 candidates (the team members list's per-source limit).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-acl-batch-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { db } = await import("../../db");
const { eq } = await import("drizzle-orm");
const { aclGrants, narrators, projects, users } = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { canReadNarrator, canWriteNarrator, judgeNarratorAccessBatch, NARRATOR_ACL_COLUMNS } =
	await import("../narrator-acl");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

const now = new Date().toISOString();
const PROJECT_OWNER = "parity-project-owner";
const NARRATOR_OWNER = "parity-narrator-owner";
const ADMIN = "parity-admin";

/** Each subject's grants: [scope, capability] (or a domain credential). */
const SUBJECTS: Record<string, Array<["narrator" | "project", string, string?]>> = {
	"parity-none": [],
	"parity-n-read": [["narrator", "read"]],
	"parity-n-write": [["narrator", "write"]],
	"parity-n-manage": [["narrator", "manage"]],
	"parity-p-read": [["project", "read"]],
	"parity-p-write": [["project", "write"]],
	"parity-p-manage": [["project", "manage"]],
	"parity-p-read-n-write": [
		["project", "read"],
		["narrator", "write"],
	],
	"parity-p-write-n-read": [
		["project", "write"],
		["narrator", "read"],
	],
	"parity-p-manage-n-write": [
		["project", "manage"],
		["narrator", "write"],
	],
	// A knowledge-style domain credential: its capability column is a placeholder, never access.
	"parity-domain-only": [
		["project", "read", "tag"],
		["narrator", "write", "tag"],
	],
};

const VISIBILITIES = ["private", "project", "public"] as const;
const WRITE_AUDIENCES = ["owner", "project", "public"] as const;

let projectId: string;
let privateProjectId: string;

beforeAll(async () => {
	for (const id of [PROJECT_OWNER, NARRATOR_OWNER, ADMIN, ...Object.keys(SUBJECTS)])
		await db.insert(users).values({
			id,
			username: id,
			passwordHash: "x",
			role: id === ADMIN ? "admin" : "user",
			createdAt: now,
		});
	projectId = generateId();
	privateProjectId = generateId();
	for (const [id, visibility] of [
		[projectId, "public"],
		[privateProjectId, "private"],
	] as const)
		await db.insert(projects).values({
			id,
			name: id,
			gitPath: join(testHome, id),
			ownerUserId: PROJECT_OWNER,
			visibility,
			createdAt: now,
			updatedAt: now,
		});
	await grantAll("project", projectId);
	await grantAll("project", privateProjectId);
});

type NarratorInsert = typeof narrators.$inferInsert;
type GrantInsert = typeof aclGrants.$inferInsert;

async function narrator(
	project: string | null,
	visibility: string,
	writeAudience: string,
	extra: Partial<NarratorInsert> = {},
) {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: id,
		ownerUserId: NARRATOR_OWNER,
		visibility: visibility as NarratorInsert["visibility"],
		writeAudience: writeAudience as NarratorInsert["writeAudience"],
		contextProjectId: project,
		createdAt: now,
		updatedAt: now,
		...extra,
	});
	return id;
}

/** Each subject's grants on one scope (projects are granted once, in `beforeAll`). */
async function grantAll(scopeType: "narrator" | "project", scopeId: string) {
	for (const [userId, grants] of Object.entries(SUBJECTS))
		for (const [scope, capability, domainKind] of grants) {
			if (scope !== scopeType) continue;
			await db.insert(aclGrants).values({
				id: generateId(),
				scopeType: scope,
				scopeId,
				principalType: "user",
				principalId: userId,
				capability: capability as GrantInsert["capability"],
				...(domainKind
					? { domainKind: domainKind as GrantInsert["domainKind"], domainValue: "secret" }
					: {}),
				createdAt: now,
			});
		}
}

const principals = [PROJECT_OWNER, NARRATOR_OWNER, ADMIN, ...Object.keys(SUBJECTS)].map(
	(userId) => ({ userId, isAdmin: userId === ADMIN }),
);

async function expectParity(narratorId: string, label: string) {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: NARRATOR_ACL_COLUMNS,
	});
	if (!row) throw new Error("missing narrator");
	const batch = await judgeNarratorAccessBatch(row, principals);
	for (const principal of principals) {
		const single = {
			read: await canReadNarrator(row, principal),
			write: await canWriteNarrator(row, principal),
		};
		expect({ label, user: principal.userId, ...batch.get(principal.userId) }).toEqual({
			label,
			user: principal.userId,
			...single,
		});
	}
	return batch;
}

describe("judgeNarratorAccessBatch agrees with canReadNarrator / canWriteNarrator", () => {
	let compared = 0;
	let anyWrite = 0;
	let anyReadOnly = 0;
	const matrix = (["public project", "private project", "standalone"] as const).flatMap(
		(projectKind) =>
			VISIBILITIES.flatMap((visibility) =>
				WRITE_AUDIENCES.map((writeAudience) => [projectKind, visibility, writeAudience] as const),
			),
	);
	test.each(
		matrix,
	)("%s %s/%s agrees for every grant combination", async (projectKind, visibility, writeAudience) => {
		const project =
			projectKind === "standalone"
				? null
				: projectKind === "public project"
					? projectId
					: privateProjectId;
		const id = await narrator(project, visibility, writeAudience);
		try {
			await grantAll("narrator", id);
			const batch = await expectParity(id, `${projectKind} ${visibility}/${writeAudience}`);
			expect(batch.size).toBe(principals.length);
			compared += principals.length;
			for (const verdict of batch.values()) {
				if (verdict.write) anyWrite++;
				else if (verdict.read) anyReadOnly++;
			}
		} finally {
			await db.delete(aclGrants).where(eq(aclGrants.scopeId, id));
			await db.delete(narrators).where(eq(narrators.id, id));
		}
	});

	test("the complete audience matrix exercises write and read-only outcomes", () => {
		expect(compared).toBe(3 * 3 * 3 * principals.length);
		expect(anyWrite).toBeGreaterThan(50);
		expect(anyReadOnly).toBeGreaterThan(50);
	});

	test("role grants apply to everyone holding the role", async () => {
		const id = await narrator(privateProjectId, "project", "owner");
		await grantAll("narrator", id);
		for (const [scope, capability] of [
			["narrator", "write"],
			["project", "read"],
		] as const)
			await db.insert(aclGrants).values({
				id: generateId(),
				scopeType: scope,
				scopeId: scope === "narrator" ? id : privateProjectId,
				principalType: "role",
				principalId: "user",
				capability,
				createdAt: now,
			});
		const batch = await expectParity(id, "role grants");
		expect(batch.get("parity-none")).toEqual({ read: true, write: true });
	});

	test("a subagent is judged on its root; one without a root is denied (admins aside)", async () => {
		const root = await narrator(projectId, "project", "project");
		await grantAll("narrator", root);
		const child = await narrator(null, "private", "owner", {
			type: "subagent",
			aclRootNarratorId: root,
			parentNarratorId: root,
		});
		await expectParity(child, "subagent");
		const orphan = await narrator(null, "public", "public", {
			type: "subagent",
			aclRootNarratorId: null,
		});
		const batch = await expectParity(orphan, "orphan subagent");
		expect(batch.get(ADMIN)).toEqual({ read: true, write: true });
		expect(batch.get(NARRATOR_OWNER)).toEqual({ read: false, write: false });
	});

	test("100 candidates in a few milliseconds", async () => {
		const id = await narrator(projectId, "project", "project");
		const many: { userId: string; isAdmin: boolean }[] = [];
		for (let i = 0; i < 100; i++) {
			const userId = `parity-many-${String(i).padStart(3, "0")}`;
			await db
				.insert(users)
				.values({ id: userId, username: userId, passwordHash: "x", role: "user", createdAt: now });
			await db.insert(aclGrants).values({
				id: generateId(),
				scopeType: i % 2 ? "narrator" : "project",
				scopeId: i % 2 ? id : projectId,
				principalType: "user",
				principalId: userId,
				capability: i % 3 ? "write" : "read",
				createdAt: now,
			});
			many.push({ userId, isAdmin: false });
		}
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, id),
			columns: NARRATOR_ACL_COLUMNS,
		});
		if (!row) throw new Error("missing narrator");
		await judgeNarratorAccessBatch(row, many); // warm up statements
		const runs: number[] = [];
		for (let run = 0; run < 5; run++) {
			const started = performance.now();
			await judgeNarratorAccessBatch(row, many);
			runs.push(performance.now() - started);
		}
		const started = performance.now();
		for (const principal of many) {
			await canWriteNarrator(row, principal);
			await canReadNarrator(row, principal);
		}
		const oneByOne = performance.now() - started;
		const best = Math.min(...runs);
		console.log(
			`judgeNarratorAccessBatch, 100 candidates: best ${best.toFixed(2)} ms, median ${[...runs]
				.sort((a, b) => a - b)[2]
				?.toFixed(2)} ms; one by one: ${oneByOne.toFixed(2)} ms`,
		);
		// Generous bound for slow CI machines; the measured time is reported above.
		expect(best).toBeLessThan(50);
	});
});
