/**
 * The outline access cases, written once and run against SQLite (`access.test.ts`) and
 * PostgreSQL (`tests/server/services/outline/pg-outline-access.test.ts`, `PG_INTEGRATION=1`).
 *
 * One world of people, projects, sessions and spaces is built through backend-specific fixtures;
 * the cases then go through the production modules only (`spaces.ts`, `access.ts`,
 * `session-scope.ts`), which read through whichever executor and store are injected.
 *
 * Every session's project comes from `context_project_id`: a project derived from the working
 * directory lives in the SQLite link index, which PostgreSQL does not have yet, and is covered in
 * `access.test.ts`.
 *
 * Cases return data rather than asserting, so a PostgreSQL run can report every mismatch from
 * inside the harness callback.
 */
import { NotFoundError } from "@server/lib/errors";
import { canAgentWriteSpace, canReadSpace, canWriteSpace, listReadableSpaces } from "../access";
import { readNarratorTitle, readProjectName } from "../access-reads";
import {
	canSessionReadSpace,
	getSessionReadScope,
	invalidateSessionReadScopes,
	OUTLINE_SESSION_READER_CAP,
} from "../session-scope";
import {
	ensurePersonalSpace,
	ensureProjectSpace,
	ensureSessionSpace,
	findSessionSpace,
	isOrphanedSpace,
	resolveNarratorSpaces,
} from "../spaces";
import { outlineStore } from "../store";
import type { OutlineSpaceRow } from "../store/port";

export type GrantPrincipal = { user: string } | { role: "user" | "admin" };

export interface AccessFixtures {
	user(label: string, role?: "admin" | "user"): Promise<string>;
	project(options: { owner: string | null; visibility: "private" | "public" }): Promise<string>;
	/** `subagentOf`: undefined for a primary narrator, a root id or null for a subagent. */
	narrator(options: {
		owner: string | null;
		visibility: string;
		writeAudience?: string;
		projectId?: string | null;
		subagentOf?: string | null;
	}): Promise<string>;
	grant(
		scope: { type: "project" | "narrator"; id: string },
		principal: GrantPrincipal,
		capability: "read" | "write" | "manage",
	): Promise<void>;
	shareLink(narratorId: string, options: { revoked: boolean; createdBy: string }): Promise<void>;
	deleteProject(id: string): Promise<void>;
	deleteUser(id: string): Promise<void>;
}

const PEOPLE = ["owner", "alice", "bob", "carol", "dave", "admin"] as const;
type Person = (typeof PEOPLE)[number];

export interface AccessWorld {
	people: Record<Person, string>;
	projects: Record<string, string>;
	sessions: Record<string, string>;
	spaces: Record<string, OutlineSpaceRow>;
	/** People admitted to the cap projects, one more than the cap. */
	crowd: string[];
}

async function reread(space: OutlineSpaceRow): Promise<OutlineSpaceRow> {
	const row = await outlineStore.getSpace(space.id);
	if (!row) throw new Error(`space ${space.id} disappeared`);
	return row;
}

/**
 * Projects (o = owner, r/w = member grants):
 *   main        private  o:owner  r:alice  w:dave
 *   allMembers  private  o:owner  r:alice  r:dave        (everyone in main can read it)
 *   ownerOnly   private  o:owner
 *   foreign     private  o:bob
 *   open        public   o:carol
 *   roleOpen    private  o:carol  role user:read
 *   gone        deleted after its space exists (orphaned space)
 */
export async function buildAccessWorld(fx: AccessFixtures): Promise<AccessWorld> {
	invalidateSessionReadScopes();
	const people = {} as Record<Person, string>;
	for (const person of PEOPLE) {
		people[person] = await fx.user(person, person === "admin" ? "admin" : "user");
	}
	const { owner, alice, bob, carol, dave, admin } = people;
	const project = (o: string | null, visibility: "private" | "public" = "private") =>
		fx.project({ owner: o, visibility });
	const projects: Record<string, string> = {
		main: await project(owner),
		allMembers: await project(owner),
		ownerOnly: await project(owner),
		foreign: await project(bob),
		open: await project(carol, "public"),
		roleOpen: await project(carol),
		gone: await project(owner),
	};
	const member = (projectId: string, user: string, cap: "read" | "write" | "manage") =>
		fx.grant({ type: "project", id: projectId }, { user }, cap);
	await member(projects.main, alice, "read");
	await member(projects.main, dave, "write");
	await member(projects.allMembers, alice, "read");
	await member(projects.allMembers, dave, "read");
	await fx.grant({ type: "project", id: projects.roleOpen }, { role: "user" }, "read");

	const session = (
		o: string | null,
		visibility: string,
		projectId: string | null,
		writeAudience = "owner",
	) => fx.narrator({ owner: o, visibility, projectId, writeAudience });
	const main = projects.main;
	const sessions: Record<string, string> = {
		priv: await session(owner, "private", main),
		grantA: await session(owner, "private", main),
		grantBOutside: await session(owner, "private", main),
		grantAdmin: await session(owner, "private", main),
		roleUser: await session(owner, "private", main),
		roleAdmin: await session(owner, "private", main),
		projectVis: await session(owner, "project", main, "project"),
		projectOpenMain: await session(owner, "project", projects.open),
		publicVis: await session(owner, "public", main),
		shared: await session(owner, "private", main),
		revokedShare: await session(owner, "private", main),
		noProject: await session(owner, "private", null),
		noProjectPublic: await session(owner, "public", null),
		otherOwnPriv: await session(owner, "private", main),
		bobPriv: await session(bob, "private", null),
		adminOwned: await session(admin, "private", main),
	};
	sessions.sub = await fx.narrator({ owner, visibility: "private", subagentOf: sessions.grantA });
	sessions.subPriv = await fx.narrator({ owner, visibility: "private", subagentOf: sessions.priv });
	sessions.orphanSub = await fx.narrator({ owner, visibility: "private", subagentOf: null });

	const shareGrant = (narratorId: string, principal: GrantPrincipal) =>
		fx.grant({ type: "narrator", id: narratorId }, principal, "read");
	await shareGrant(sessions.grantA, { user: alice });
	await shareGrant(sessions.grantBOutside, { user: bob });
	await shareGrant(sessions.grantAdmin, { user: admin });
	await shareGrant(sessions.roleUser, { role: "user" });
	await shareGrant(sessions.roleAdmin, { role: "admin" });
	await fx.shareLink(sessions.shared, { revoked: false, createdBy: owner });
	await fx.shareLink(sessions.revokedShare, { revoked: true, createdBy: owner });

	const spaces: Record<string, OutlineSpaceRow> = {};
	for (const [label, id] of Object.entries(projects)) spaces[label] = await ensureProjectSpace(id);
	spaces.personalOwner = await ensurePersonalSpace(owner);
	spaces.personalAlice = await ensurePersonalSpace(alice);
	spaces.personalAdmin = await ensurePersonalSpace(admin);
	for (const label of [
		"priv",
		"grantA",
		"projectVis",
		"publicVis",
		"otherOwnPriv",
		"bobPriv",
		"noProject",
	]) {
		spaces[`session:${label}`] = await ensureSessionSpace(sessions[label]);
	}
	// A space a subagent with no root holds directly, as an older writer could have made it.
	spaces["session:orphanSub"] = await outlineStore.ensureSpace(
		{ kind: "session", narratorId: sessions.orphanSub },
		new Date().toISOString(),
	);
	const departed = await fx.user("departed");
	spaces.personalGone = await ensurePersonalSpace(departed);
	await fx.deleteProject(projects.gone);
	await fx.deleteUser(departed);
	spaces.gone = await reread(spaces.gone);
	spaces.personalGone = await reread(spaces.personalGone);

	// The reader cap: `capMain` sessions are read by the owner plus their members.
	const crowd: string[] = [];
	for (let i = 0; i <= OUTLINE_SESSION_READER_CAP; i++) crowd.push(await fx.user(`crowd${i}`));
	projects.capAtLimit = await project(owner);
	projects.capOver = await project(owner);
	projects.capTarget = await project(owner);
	for (const user of crowd.slice(0, OUTLINE_SESSION_READER_CAP - 1)) {
		await member(projects.capAtLimit, user, "read");
	}
	// An admin member does not count towards the cap.
	await member(projects.capAtLimit, admin, "read");
	for (const user of crowd.slice(0, OUTLINE_SESSION_READER_CAP)) {
		await member(projects.capOver, user, "read");
		await member(projects.capTarget, user, "read");
	}
	sessions.capAtLimit = await session(owner, "project", projects.capAtLimit, "project");
	sessions.capOver = await session(owner, "project", projects.capOver, "project");
	sessions.grantedOver = await session(owner, "private", projects.capTarget);
	for (const user of crowd.slice(0, OUTLINE_SESSION_READER_CAP)) {
		await shareGrant(sessions.grantedOver, { user });
	}
	for (const label of ["capAtLimit", "capOver", "capTarget"]) {
		spaces[label] = await ensureProjectSpace(projects[label]);
	}
	return { people, projects, sessions, spaces, crowd };
}

export interface AccessCase {
	group: "spaces" | "person" | "session" | "cap" | "list";
	label: string;
	expected: unknown;
	actual: () => Promise<unknown>;
}

const ids = (spaces: OutlineSpaceRow[]) => spaces.map((space) => space.id).sort();

async function walkPages(
	principal: { userId: string; isAdmin: boolean },
	limit: number,
): Promise<string[]> {
	const seen: string[] = [];
	let cursor: string | null = null;
	for (let pages = 0; pages < 10_000; pages++) {
		const page = await listReadableSpaces(principal, { limit, cursor });
		seen.push(...page.spaces.map((space) => space.id));
		if (!page.nextCursor) return seen;
		cursor = page.nextCursor;
	}
	throw new Error("listing did not end");
}

export function accessCases(world: AccessWorld): AccessCase[] {
	const { people, sessions, spaces } = world;
	const cases: AccessCase[] = [];
	const as = (person: Person) => ({ userId: people[person], isAdmin: person === "admin" });

	// ── Spaces ────────────────────────────────────────────────────────────────
	const spaceCase = (label: string, expected: unknown, actual: () => Promise<unknown>) =>
		cases.push({ group: "spaces", label, expected, actual });
	spaceCase(
		"spaces are named by their project's name and their session's title",
		{
			project: `outline-access-${world.projects.main}`,
			session: "outline access",
			missing: [null, null],
		},
		async () => ({
			project: await readProjectName(world.projects.main),
			session: await readNarratorTitle(sessions.grantA),
			missing: [await readProjectName("missing"), await readNarratorTitle("missing")],
		}),
	);
	spaceCase("get-or-create returns the same project space", spaces.main.id, async () => {
		return (await ensureProjectSpace(world.projects.main)).id;
	});
	spaceCase("a subagent uses its root's session space", spaces["session:grantA"].id, async () => {
		return (await ensureSessionSpace(sessions.sub)).id;
	});
	spaceCase("a subagent finds its root's session space", spaces["session:grantA"].id, async () => {
		return (await findSessionSpace(sessions.sub))?.id;
	});
	spaceCase("a subagent without a root has no session space", "NotFoundError", async () => {
		try {
			await ensureSessionSpace(sessions.orphanSub);
			return "created";
		} catch (error) {
			return error instanceof NotFoundError ? "NotFoundError" : String(error);
		}
	});
	spaceCase(
		"a subagent's default spaces are its root's",
		{ root: sessions.grantA, session: spaces["session:grantA"].id, project: spaces.main.id },
		async () => {
			const resolved = await resolveNarratorSpaces(sessions.sub, { create: true });
			return {
				root: resolved?.rootNarratorId,
				session: resolved?.session?.id,
				project: resolved?.project?.id,
			};
		},
	);
	spaceCase("a session without a project has no project space", null, async () => {
		return (await resolveNarratorSpaces(sessions.noProject))?.project ?? null;
	});
	spaceCase("an unknown project has no space", "NotFoundError", async () => {
		try {
			await ensureProjectSpace("no-such-project");
			return "created";
		} catch (error) {
			return error instanceof NotFoundError ? "NotFoundError" : String(error);
		}
	});
	spaceCase("an unknown user has no personal space", "NotFoundError", async () => {
		try {
			await ensurePersonalSpace("no-such-user");
			return "created";
		} catch (error) {
			return error instanceof NotFoundError ? "NotFoundError" : String(error);
		}
	});
	spaceCase("spaces of a deleted project or user are orphaned", [true, true, false], async () => [
		isOrphanedSpace(spaces.gone),
		isOrphanedSpace(spaces.personalGone),
		isOrphanedSpace(spaces.main),
	]);

	// ── Per person ────────────────────────────────────────────────────────────
	const person = (who: Person, label: string, read: boolean, write: boolean) =>
		cases.push({
			group: "person",
			label: `${who} on ${label}: read ${read}, write ${write}`,
			expected: [read, write],
			actual: async () => [
				await canReadSpace(as(who), spaces[label]),
				await canWriteSpace(as(who), spaces[label]),
			],
		});
	person("owner", "main", true, true);
	person("alice", "main", true, false);
	person("dave", "main", true, true);
	person("bob", "main", false, false);
	person("admin", "main", true, true);
	person("bob", "open", true, false);
	person("carol", "open", true, true);
	person("bob", "roleOpen", true, false);
	person("owner", "personalOwner", true, true);
	person("alice", "personalOwner", false, false);
	person("admin", "personalOwner", false, false);
	person("admin", "personalAdmin", true, true);
	person("owner", "session:priv", true, true);
	person("alice", "session:priv", false, false);
	person("admin", "session:priv", true, true);
	person("alice", "session:grantA", true, false);
	person("alice", "session:projectVis", true, false);
	person("dave", "session:projectVis", true, true);
	person("bob", "session:projectVis", false, false);
	person("bob", "session:publicVis", true, false);
	person("owner", "session:orphanSub", false, false);
	person("admin", "session:orphanSub", true, true);
	person("owner", "gone", false, false);
	person("admin", "gone", true, false);
	person("admin", "personalGone", true, false);
	cases.push({
		group: "person",
		label: "agent writes follow the acting user; no user, no write",
		expected: [false, true, false, true],
		actual: async () => [
			await canAgentWriteSpace(null, spaces.main),
			await canAgentWriteSpace(as("owner"), spaces.main),
			await canAgentWriteSpace(as("alice"), spaces.main),
			await canAgentWriteSpace(as("dave"), spaces.main),
		],
	});

	// ── Session read scope ───────────────────────────────────────────────────
	const session = (
		name: string,
		expectations: Record<string, boolean>,
		executing: Person | null = "owner",
		group: AccessCase["group"] = "session",
	) => {
		for (const [label, expected] of Object.entries(expectations)) {
			cases.push({
				group,
				label: `${name} reads ${label}${executing ? ` (turn of ${executing})` : " (no user)"}`,
				expected,
				actual: () =>
					canSessionReadSpace(sessions[name], spaces[label], {
						executingUserId: executing ? people[executing] : null,
					}),
			});
		}
	};
	session("priv", {
		"session:priv": true,
		main: true,
		allMembers: true,
		ownerOnly: true,
		foreign: false,
		open: true,
		roleOpen: true,
		gone: false,
		personalOwner: true,
		personalAlice: false,
		personalGone: false,
		"session:otherOwnPriv": true,
		"session:projectVis": true,
		"session:bobPriv": false,
		"session:orphanSub": false,
	});
	session("priv", { personalOwner: false }, "alice");
	session("priv", { personalOwner: false, main: true }, null);
	session("grantA", {
		"session:grantA": true,
		main: true,
		allMembers: true,
		ownerOnly: false,
		open: true,
		personalOwner: false,
		"session:projectVis": true,
		"session:otherOwnPriv": false,
	});
	session("grantBOutside", { ownerOnly: true, personalOwner: true });
	session("grantAdmin", { ownerOnly: true, personalOwner: true });
	session("roleUser", { allMembers: true, ownerOnly: false, personalOwner: false });
	session("roleAdmin", { ownerOnly: true, personalOwner: true });
	session("projectVis", {
		"session:projectVis": true,
		main: true,
		allMembers: true,
		ownerOnly: false,
		open: true,
		roleOpen: true,
		personalOwner: false,
	});
	session("projectOpenMain", {
		open: true,
		roleOpen: true,
		main: false,
		personalOwner: false,
		"session:otherOwnPriv": false,
	});
	session("publicVis", {
		"session:publicVis": true,
		main: false,
		allMembers: false,
		open: true,
		roleOpen: true,
		personalOwner: false,
		"session:priv": false,
	});
	session("shared", { main: false, ownerOnly: false, open: true, personalOwner: false });
	session("revokedShare", { main: true, ownerOnly: true, personalOwner: true });
	session("noProject", {
		"session:noProject": true,
		main: false,
		open: false,
		personalOwner: true,
		"session:otherOwnPriv": false,
	});
	session("noProjectPublic", { open: false, personalOwner: false });
	session("sub", {
		"session:grantA": true,
		allMembers: true,
		ownerOnly: false,
		personalOwner: false,
	});
	session("subPriv", { "session:priv": true, ownerOnly: true, personalOwner: true });
	session("orphanSub", {
		"session:orphanSub": false,
		open: false,
		"session:priv": false,
		personalOwner: false,
	});
	session("adminOwned", { foreign: true, personalAdmin: true, personalOwner: false }, "admin");

	cases.push({
		group: "session",
		label: "a subagent reports its root's scope",
		expected: { root: sessions.grantA, audience: "people", singleUser: false },
		actual: async () => {
			const scope = await getSessionReadScope(sessions.sub);
			return {
				root: scope.rootNarratorId,
				audience: scope.audience.kind,
				singleUser: scope.singleUser,
			};
		},
	});

	// ── Reader cap ────────────────────────────────────────────────────────────
	session(
		"capAtLimit",
		{ capAtLimit: true, capTarget: true, open: true, ownerOnly: false },
		"owner",
		"cap",
	);
	session(
		"capOver",
		{ capOver: true, capTarget: false, open: true, roleOpen: true, ownerOnly: false },
		"owner",
		"cap",
	);
	session(
		"grantedOver",
		{ capTarget: true, open: true, ownerOnly: false, personalOwner: false },
		"owner",
		"cap",
	);
	cases.push({
		group: "cap",
		label: `readers are counted up to ${OUTLINE_SESSION_READER_CAP}, admins left out`,
		expected: [
			{ kind: "people", count: OUTLINE_SESSION_READER_CAP },
			{ kind: "too_many", count: 0 },
			{ kind: "too_many", count: 0 },
		],
		actual: async () => {
			const out = [];
			for (const name of ["capAtLimit", "capOver", "grantedOver"]) {
				const { audience } = await getSessionReadScope(sessions[name]);
				out.push({
					kind: audience.kind,
					count: audience.kind === "people" ? audience.userIds.length : 0,
				});
			}
			return out;
		},
	});

	// ── Listing ───────────────────────────────────────────────────────────────
	const worldIds = new Set(Object.values(spaces).map((space) => space.id));
	const listed = async (who: Person) =>
		(await walkPages(as(who), 200)).filter((id) => worldIds.has(id)).sort();
	cases.push({
		group: "list",
		label: "alice lists what she can read through user grants and audiences",
		expected: ids([
			spaces.main,
			spaces.allMembers,
			spaces.open,
			spaces.personalAlice,
			spaces["session:grantA"],
			spaces["session:projectVis"],
			spaces["session:publicVis"],
		]),
		actual: () => listed("alice"),
	});
	cases.push({
		group: "list",
		label: "every listed space passes the per-person check",
		expected: [],
		actual: async () => {
			const refused: string[] = [];
			for (const who of PEOPLE) {
				for (const id of await listed(who)) {
					const space = Object.values(spaces).find((candidate) => candidate.id === id);
					if (space && !(await canReadSpace(as(who), space))) refused.push(`${who}:${id}`);
				}
			}
			return refused;
		},
	});
	cases.push({
		group: "list",
		label: "admins list orphaned spaces and their own personal space, not other people's",
		expected: [true, true, true, false, false],
		actual: async () => {
			const seen = new Set(await listed("admin"));
			return [
				seen.has(spaces.gone.id),
				seen.has(spaces.personalGone.id),
				seen.has(spaces.personalAdmin.id),
				seen.has(spaces.personalOwner.id),
				seen.has(spaces.personalAlice.id),
			];
		},
	});
	cases.push({
		group: "list",
		label: "small pages add up to the whole listing, without repeats",
		expected: true,
		actual: async () => {
			const whole = await walkPages(as("owner"), 200);
			const paged = await walkPages(as("owner"), 3);
			return (
				paged.length === new Set(paged).size &&
				JSON.stringify([...paged].sort()) === JSON.stringify([...whole].sort())
			);
		},
	});
	cases.push({
		group: "list",
		label: "the kind filter keeps only that kind",
		expected: ["project"],
		actual: async () => {
			const page = await listReadableSpaces(as("alice"), { kind: "project", limit: 200 });
			return [...new Set(page.spaces.map((space) => space.kind))];
		},
	});
	return cases;
}

/** Run cases one after another; the mismatches, described. */
export async function runAccessCases(cases: AccessCase[]): Promise<string[]> {
	const failures: string[] = [];
	for (const testCase of cases) {
		let actual: unknown;
		try {
			actual = await testCase.actual();
		} catch (error) {
			actual = `threw ${error instanceof Error ? error.message : String(error)}`;
		}
		if (!Bun.deepEquals(actual, testCase.expected)) {
			failures.push(
				`${testCase.group}: ${testCase.label}: expected ${JSON.stringify(
					testCase.expected,
				)}, got ${JSON.stringify(actual)}`,
			);
		}
	}
	return failures;
}
