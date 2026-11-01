/**
 * The project and narrator rules restated in `access.ts` give the same answers as the originals
 * they restate: `canReadProject` / `canWriteProject` (`project-acl.ts`) and `canReadNarrator` /
 * `canWriteNarrator` (`narrator-acl.ts`).
 *
 * The restatement exists because the originals read through the SQLite handle; this test is what
 * keeps it from drifting. It walks every combination of the inputs those rules read (visibility,
 * write audience, owner, project gate by explicit project or by working directory, user grants,
 * grants to the `user` and `admin` roles, subagent delegation, out-of-range values) for people in
 * every position, and compares the two answers for each. The session read scope's list of a
 * session's readers is held to `canReadNarrator` the same way.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { aclGrants, narratorProjectLinks, narrators, projects, users } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { canReadNarrator, canWriteNarrator, NARRATOR_ACL_COLUMNS } from "../../narrator-acl";
import { canReadProject, canWriteProject } from "../../project-acl";
import { canReadSpace, canWriteSpace, type OutlinePrincipal } from "../access";
import { getSessionReadScope } from "../session-scope";
import type { OutlineSpaceRow } from "../store/port";

const NOW = "2026-10-26T00:00:00.000Z";

const ROLES = ["owner", "reader", "writer", "manager", "granteeR", "granteeW", "outsider"] as const;
type Role = (typeof ROLES)[number];
const people = {} as Record<Role, string>;
const principals = (): OutlinePrincipal[] => [
	...ROLES.map((role) => ({ userId: people[role], isAdmin: false })),
	{ userId: "parity-admin", isAdmin: true },
];

async function user(label: string): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `parity-${label}-${id}`, passwordHash: "x", createdAt: NOW });
	return id;
}

async function grant(
	scopeType: "project" | "narrator",
	scopeId: string,
	principal: { user: string } | { role: string },
	capability: "read" | "write" | "manage",
) {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType,
		scopeId,
		principalType: "user" in principal ? "user" : "role",
		principalId: "user" in principal ? principal.user : principal.role,
		capability,
		createdAt: NOW,
	});
}

async function project(options: {
	owner: string | null;
	visibility: string;
	roleGrant?: { role: string; capability: "read" | "write" | "manage" };
}): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `parity-${id}`,
		ownerUserId: options.owner,
		visibility: options.visibility as "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	await grant("project", id, { user: people.reader }, "read");
	await grant("project", id, { user: people.writer }, "write");
	await grant("project", id, { user: people.manager }, "manage");
	if (options.roleGrant) {
		await grant("project", id, { role: options.roleGrant.role }, options.roleGrant.capability);
	}
	return id;
}

function space(fields: Partial<OutlineSpaceRow> & Pick<OutlineSpaceRow, "kind">): OutlineSpaceRow {
	return {
		id: generateId(),
		key: "parity",
		projectId: null,
		narratorId: null,
		ownerUserId: null,
		nextSeq: 1,
		createdAt: NOW,
		inProcessEpoch: 0,
		...fields,
	};
}

beforeAll(async () => {
	for (const role of ROLES) people[role] = await user(role);
});

describe("outline access restates the project rules", () => {
	test("for every visibility, owner and grant shape", async () => {
		const mismatches: string[] = [];
		for (const visibility of ["private", "public", "bogus"]) {
			for (const owner of [people.owner, null]) {
				for (const roleGrant of [
					undefined,
					{ role: "user", capability: "read" as const },
					{ role: "user", capability: "write" as const },
					{ role: "user", capability: "manage" as const },
					{ role: "admin", capability: "write" as const },
				]) {
					const id = await project({ owner, visibility, roleGrant });
					const row = await db.query.projects.findFirst({ where: eq(projects.id, id) });
					if (!row) throw new Error("project vanished");
					const projectSpace = space({ kind: "project", projectId: id });
					for (const principal of principals()) {
						const expected = [
							await canReadProject(row, principal),
							await canWriteProject(row, principal),
						];
						const actual = [
							await canReadSpace(principal, projectSpace),
							await canWriteSpace(principal, projectSpace),
						];
						if (expected.join() !== actual.join()) {
							mismatches.push(
								`${visibility}/${owner ? "owned" : "unowned"}/${JSON.stringify(roleGrant)}/` +
									`${principal.userId}: expected ${expected}, got ${actual}`,
							);
						}
					}
				}
			}
		}
		expect(mismatches).toEqual([]);
	});
});

describe("outline access restates the narrator rules", () => {
	test("for every audience pair, project gate, grant shape and delegation", async () => {
		const gates = {
			none: null as string | null,
			privateExplicit: await project({ owner: people.owner, visibility: "private" }),
			publicExplicit: await project({ owner: people.owner, visibility: "public" }),
			privateByDirectory: await project({ owner: people.owner, visibility: "private" }),
		};
		const grantShapes: Record<string, (narratorId: string) => Promise<void>> = {
			none: async () => {},
			users: async (id) => {
				await grant("narrator", id, { user: people.granteeR }, "read");
				await grant("narrator", id, { user: people.granteeW }, "write");
				await grant("narrator", id, { user: people.writer }, "write");
			},
			roleRead: async (id) => grant("narrator", id, { role: "user" }, "read"),
			roleWrite: async (id) => grant("narrator", id, { role: "user" }, "write"),
			manageOnly: async (id) => grant("narrator", id, { user: people.granteeR }, "manage"),
		};
		const mismatches: string[] = [];
		const compare = async (narratorId: string, label: string) => {
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: NARRATOR_ACL_COLUMNS,
			});
			if (!row) throw new Error("narrator vanished");
			const sessionSpace = space({ kind: "session", narratorId });
			const readers: string[] = [];
			for (const principal of principals()) {
				const expected = [
					await canReadNarrator(row, principal),
					await canWriteNarrator(row, principal),
				];
				const actual = [
					await canReadSpace(principal, sessionSpace),
					await canWriteSpace(principal, sessionSpace),
				];
				if (expected.join() !== actual.join()) {
					mismatches.push(`${label}/${principal.userId}: expected ${expected}, got ${actual}`);
				}
				if (expected[0] && !principal.isAdmin) readers.push(principal.userId);
			}
			// The session read scope enumerates the same readers.
			const { rootNarratorId, audience } = await getSessionReadScope(narratorId);
			const enumerated =
				rootNarratorId === null
					? []
					: audience.kind === "everyone"
						? ROLES.map((role) => people[role])
						: audience.kind === "people"
							? audience.userIds
							: ["too many"];
			if ([...enumerated].sort().join() !== [...readers].sort().join()) {
				mismatches.push(`${label}: readers ${readers}, enumerated ${enumerated}`);
			}
		};
		let compared = 0;
		for (const visibility of ["private", "project", "public", "bogus"]) {
			for (const writeAudience of ["owner", "project", "public", "bogus"]) {
				for (const [gateName, gate] of Object.entries(gates)) {
					for (const [shape, apply] of Object.entries(grantShapes)) {
						const owner = shape === "none" && gateName === "none" ? null : people.owner;
						const id = generateId();
						await db.insert(narrators).values({
							id,
							title: "parity",
							ownerUserId: owner,
							visibility: visibility as "private",
							writeAudience: writeAudience as "owner",
							contextProjectId: gateName === "privateByDirectory" ? null : gate,
							createdAt: NOW,
							updatedAt: NOW,
						});
						if (gateName === "privateByDirectory" && gate) {
							await db.insert(narratorProjectLinks).values({
								narratorId: id,
								projectId: gate,
								role: "primary",
								source: "cwd",
								directory: `/tmp/parity/${id}`,
								updatedAt: NOW,
							});
						}
						await apply(id);
						const label = `${visibility}/${writeAudience}/${gateName}/${shape}`;
						await compare(id, label);
						compared++;
						// A subagent is judged on this narrator.
						if (shape !== "manageOnly") {
							const sub = generateId();
							await db.insert(narrators).values({
								id: sub,
								title: "parity sub",
								ownerUserId: people.outsider,
								visibility: "public",
								writeAudience: "public",
								type: "subagent",
								aclRootNarratorId: id,
								createdAt: NOW,
								updatedAt: NOW,
							});
							await compare(sub, `subagent of ${label}`);
						}
					}
				}
			}
		}
		// A subagent whose root is unknown denies everyone but admins.
		const lost = generateId();
		await db.insert(narrators).values({
			id: lost,
			title: "parity lost",
			ownerUserId: people.owner,
			visibility: "public",
			type: "subagent",
			aclRootNarratorId: null,
			createdAt: NOW,
			updatedAt: NOW,
		});
		await compare(lost, "subagent without a root");
		expect(compared).toBe(4 * 4 * 4 * 5);
		expect(mismatches).toEqual([]);
	}, 60_000);
});
