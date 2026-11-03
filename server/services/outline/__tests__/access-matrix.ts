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
 * Every space holds one marker block, so the `agent` group can check what the outline tools show
 * a session of each kind (private, shared with people, project, public, shared by public link,
 * subagent, without a project, past the reader cap; with and without the turn's person) against
 * what the session may read: exactly the readable spaces are read, listed, searched and titled
 * in links, and everything else answers exactly as something that does not exist. The `listing`
 * group holds the session's listing of readable spaces to the same verdicts.
 *
 * Cases return data rather than asserting, so a PostgreSQL run can report every mismatch from
 * inside the harness callback.
 */
import { NotFoundError } from "@server/lib/errors";
import { canAgentWriteSpace, canReadSpace, canWriteSpace, listReadableSpaces } from "../access";
import { outlineAccessBackend, readNarratorTitle, readProjectName } from "../access-reads";
import { OUTLINE_ALL_SPACES, outlineRead, outlineSearch } from "../agent-read";
import { OutlineAgentScope } from "../agent-scope";
import { OUTLINE_TOOL_TEXT } from "../messages";
import {
	canSessionReadSpace,
	getSessionReadScope,
	invalidateSessionReadScopes,
	listSessionReadableSpaces,
	listSessionReadCandidates,
	OUTLINE_SESSION_LIST_LIMITS,
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
import { writeOutline } from "../write";

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
	/**
	 * File the narrator under a project by its working directory (the primary link). Only SQLite
	 * resolves a session's project from it so far; PostgreSQL knows the explicit project alone.
	 */
	linkProject(narratorId: string, projectId: string): Promise<void>;
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
	/** The sid of the marker block of every space, by the space's label. */
	markers: Record<string, string>;
	/** The sid of a block in the `open` space linking to marker blocks and to nothing. */
	links: string;
	/** People admitted to the cap projects, one more than the cap. */
	crowd: string[];
}

/** The word every marker block holds: `Zephyrine <label>.` */
export const MARKER = "Zephyrine";

const markerText = (label: string) => `${MARKER} ${label}.`;

/** An address no space has. */
const NOWHERE = "Nokey123/Zz9Zz9Zz";

/** Write the marker block of a space, as a person (nobody's access is checked on this path). */
async function writeMarker(space: OutlineSpaceRow, label: string, by: string): Promise<string> {
	const r = await writeOutline({
		spaceId: space.id,
		ops: [{ op: "insert", parent: null, content: markerText(label) }],
		actor: { kind: "human", id: by },
		responsibleUserId: by,
	});
	return r.results[0]?.sid as string;
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
		// Visible to a project only a grant to the `user` role opens: past the gate for everyone.
		roleOpenVis: await session(carol, "project", projects.roleOpen),
		// Visible to its project, which only its working directory names: Bob's private one.
		linkedForeign: await session(bob, "project", null),
	};
	await fx.linkProject(sessions.linkedForeign, projects.foreign);
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
		"shared",
		"otherOwnPriv",
		"bobPriv",
		"noProject",
		"roleOpenVis",
		"linkedForeign",
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
	// Marker blocks, written before the project and the user go.
	const markers: Record<string, string> = {};
	for (const [label, space] of Object.entries(spaces)) {
		markers[label] = await writeMarker(space, label, owner);
	}
	const linkTargets = ["foreign", "main", "ownerOnly", "open", "session:priv", "personalOwner"];
	const linkText = [
		...linkTargets.map((label) => `[[${spaces[label]?.key}/${markers[label]}]]`),
		`[[${NOWHERE}]]`,
	].join(" ");
	const links = (
		await writeOutline({
			spaceId: spaces.open.id,
			ops: [{ op: "insert", parent: null, content: `Links ${linkText}` }],
			actor: { kind: "human", id: carol },
			responsibleUserId: carol,
		})
	).results[0]?.sid as string;
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
		markers[label] = await writeMarker(spaces[label], label, owner);
	}
	return { people, projects, sessions, spaces, markers, links, crowd };
}

export interface AccessCase {
	group: "spaces" | "person" | "session" | "cap" | "list" | "listing" | "agent";
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
	agentCases(world, cases);
	return cases;
}

/** A session and the person its turn runs for (null: a routine or system turn). */
type Turn = readonly [session: string, executing: Person | null];

/** Every kind of session the read scope tells apart, in a turn of its owner unless noted. */
const TURNS: readonly Turn[] = [
	["priv", "owner"],
	["priv", "alice"],
	["priv", null],
	["grantA", "owner"],
	["grantBOutside", "owner"],
	["grantAdmin", "owner"],
	["roleUser", "owner"],
	["roleAdmin", "owner"],
	["projectVis", "owner"],
	["projectOpenMain", "owner"],
	["publicVis", "owner"],
	["shared", "owner"],
	["revokedShare", "owner"],
	["noProject", "owner"],
	["noProjectPublic", "owner"],
	["sub", "owner"],
	["subPriv", "owner"],
	["orphanSub", "owner"],
	["adminOwned", "admin"],
	["capAtLimit", "owner"],
	["capOver", "owner"],
	["grantedOver", "owner"],
];

/**
 * What sessions list and their agents read across spaces: the verdicts of
 * `canSessionReadSpace` (pinned down case by case above) are what the listing and the outline
 * tools must follow, and a space a session may not read must answer exactly like one that does
 * not exist.
 */
function agentCases(world: AccessWorld, cases: AccessCase[]): void {
	const { people, sessions, spaces, markers } = world;
	const labelOf = new Map(Object.entries(spaces).map(([label, space]) => [space.id, label]));
	const keyLabel = new Map(Object.entries(spaces).map(([label, space]) => [space.key, label]));
	const userOf = (who: Person | null) => (who ? people[who] : null);
	const verdicts = async ([name, who]: Turn): Promise<Map<string, boolean>> => {
		const out = new Map<string, boolean>();
		for (const [label, space] of Object.entries(spaces)) {
			out.set(
				label,
				await canSessionReadSpace(sessions[name], space, { executingUserId: userOf(who) }),
			);
		}
		return out;
	};
	const readable = (may: Map<string, boolean>) =>
		[...may].filter(([, ok]) => ok).map(([label]) => label);
	const scopeFor = ([name, who]: Turn) =>
		OutlineAgentScope.open({ narratorId: sessions[name], userId: userOf(who) });

	// Explicit expectations for a few, so the listing is not only held to the verdicts.
	const explicit: Record<string, string[]> = {
		"publicVis/owner": ["session:publicVis", "open", "roleOpen"],
		"shared/owner": ["session:shared", "open", "roleOpen"],
		"noProject/owner": ["session:noProject", "personalOwner"],
		"noProjectPublic/owner": [],
		"orphanSub/owner": [],
		// Read by its owner alone, in a turn of someone else: all the owner reads, nothing personal.
		"priv/alice": [
			"session:priv",
			"main",
			"allMembers",
			"ownerOnly",
			"open",
			"roleOpen",
			"capAtLimit",
			"capOver",
			"capTarget",
			"session:grantA",
			"session:otherOwnPriv",
			"session:projectVis",
			"session:publicVis",
			"session:shared",
			"session:noProject",
			"session:roleOpenVis",
		],
	};
	/** The session whose space a session uses: its root, for a subagent. */
	const rootOf: Record<string, string> = { sub: "grantA", subPriv: "priv" };

	for (const turn of TURNS) {
		const [name, who] = turn;
		const label = `${name} (turn of ${who ?? "no user"})`;
		const key = `${name}/${who ?? "none"}`;

		cases.push({
			group: "listing",
			label: `${label} lists exactly the spaces it may read, its own first`,
			expected: { complete: true, extra: [], missing: [], ownFirst: true, explicit: true },
			actual: async () => {
				const may = await verdicts(turn);
				const listed = await listSessionReadableSpaces(sessions[name], {
					executingUserId: userOf(who),
					limit: OUTLINE_SESSION_LIST_LIMITS.maxSpaces,
					maxCandidates: OUTLINE_SESSION_LIST_LIMITS.maxCandidates,
				});
				const seen = listed.spaces
					.map((space) => labelOf.get(space.id))
					.filter((l): l is string => l !== undefined);
				const ownSession = `session:${rootOf[name] ?? name}`;
				const want = explicit[key];
				return {
					complete: listed.complete,
					extra: seen.filter((l) => !may.get(l)),
					missing: readable(may).filter((l) => !seen.includes(l)),
					ownFirst: !may.get(ownSession) || seen[0] === ownSession,
					explicit: want === undefined || [...want].sort().join() === [...seen].sort().join(),
				};
			},
		});

		cases.push({
			group: "listing",
			label: `${label}: the candidates a listing judges cover every space it may read`,
			expected: [],
			actual: async () => {
				const may = await verdicts(turn);
				const candidates = await listSessionReadCandidates(sessions[name], {
					executingUserId: userOf(who),
					max: 10_000,
				});
				const ids = new Set(candidates.map((space) => space.id));
				return readable(may).filter((l) => !ids.has(spaces[l]?.id as string));
			},
		});

		cases.push({
			group: "listing",
			label: `${label}: a session filed by its working directory under a project it cannot pass is no candidate`,
			expected: true,
			actual: async () => {
				const may = await verdicts(turn);
				// PostgreSQL resolves no project from the working directory: no gate there.
				if (outlineAccessBackend() === "postgres" || may.get("session:linkedForeign")) return true;
				const candidates = await listSessionReadCandidates(sessions[name], {
					executingUserId: userOf(who),
					max: 10_000,
				});
				return !candidates.some((space) => space.id === spaces["session:linkedForeign"]?.id);
			},
		});

		cases.push({
			group: "agent",
			label: `${label} reads, lists and searches by key exactly what it may; the rest answers as nothing`,
			expected: [],
			actual: async () => {
				const may = await verdicts(turn);
				const scope = await scopeFor(turn);
				const problems: string[] = [];
				for (const [spaceLabel, space] of Object.entries(spaces)) {
					const ok = may.get(spaceLabel) === true;
					const address = `${space.key}/${markers[spaceLabel]}`;
					const read = await outlineRead(scope, { address });
					const shown = !read.isError && read.output.includes(markerText(spaceLabel));
					if (shown !== ok) problems.push(`${spaceLabel}: read shows ${shown}, may ${ok}`);
					if (!ok && read.output !== OUTLINE_TOOL_TEXT.notFound(address)) {
						problems.push(`${spaceLabel}: read of what it may not read answers otherwise`);
					}
					const list = await outlineRead(scope, { address: `${space.key}/` });
					if (Boolean(list.isError) === ok) problems.push(`${spaceLabel}: space listing ${ok}`);
					if (!ok && list.output !== OUTLINE_TOOL_TEXT.noSuchSpace(space.key)) {
						problems.push(`${spaceLabel}: space listing answers otherwise`);
					}
					const search = await outlineSearch(scope, { query: MARKER, spaces: [space.key] });
					const found = search.output.includes(markerText(spaceLabel));
					if (found !== ok) problems.push(`${spaceLabel}: search finds ${found}, may ${ok}`);
					if (!ok && search.output !== OUTLINE_TOOL_TEXT.noSuchSpace(space.key)) {
						problems.push(`${spaceLabel}: search answers otherwise`);
					}
				}
				const nowhere = await outlineRead(scope, { address: NOWHERE });
				if (nowhere.output !== OUTLINE_TOOL_TEXT.notFound(NOWHERE)) {
					problems.push("an address of nothing answers otherwise");
				}
				return problems;
			},
		});

		cases.push({
			group: "agent",
			label: `${label}: the overview and the search of every space show what it may read`,
			expected: {
				overview: { extra: [], missing: [], leaked: [] },
				search: { extra: [], missing: [] },
			},
			actual: async () => {
				const may = await verdicts(turn);
				const scope = await scopeFor(turn);
				const overview = await outlineRead(scope, { address: OUTLINE_ALL_SPACES });
				const listed = ((overview.metadata.spaces ?? []) as Array<{ key: string }>)
					.map((entry) => keyLabel.get(entry.key))
					.filter((l): l is string => l !== undefined);
				const all = await outlineSearch(scope, {
					query: MARKER,
					spaces: [OUTLINE_ALL_SPACES],
					limit: 50,
				});
				const hits = Object.keys(spaces).filter((l) => all.output.includes(markerText(l)));
				const searchedAll = all.metadata.complete !== false;
				return {
					overview: {
						extra: listed.filter((l) => !may.get(l)),
						missing:
							overview.metadata.complete === false
								? []
								: readable(may).filter((l) => !listed.includes(l)),
						// Links keep the addresses they store; nothing the session may not read shows.
						leaked: Object.keys(spaces).filter(
							(l) => !may.get(l) && overview.output.includes(markerText(l)),
						),
					},
					search: {
						extra: hits.filter((l) => !may.get(l)),
						missing: searchedAll ? readable(may).filter((l) => !hits.includes(l)) : [],
					},
				};
			},
		});
	}

	// Links: titled where the session may read the target, otherwise as a link to nothing.
	const linkTargets = ["foreign", "main", "ownerOnly", "open", "session:priv", "personalOwner"];
	for (const turn of TURNS) {
		const [name, who] = turn;
		cases.push({
			group: "agent",
			label: `${name} (turn of ${who ?? "no user"}): links show a title only where it may read the target`,
			expected: [],
			actual: async () => {
				const may = await verdicts(turn);
				if (!may.get("open")) return [];
				const scope = await scopeFor(turn);
				const read = await outlineRead(scope, { address: `${spaces.open.key}/${world.links}` });
				const problems: string[] = [];
				for (const target of linkTargets) {
					const address = `${spaces[target]?.key}/${markers[target]}`;
					const titled = read.output.includes(`[[${address}|${markerText(target)}]]`);
					const bare = read.output.includes(`[[${address}]]`);
					if (titled !== may.get(target) || bare === may.get(target)) {
						problems.push(`${target}: titled ${titled}, may ${may.get(target)}`);
					}
				}
				if (!read.output.includes(`[[${NOWHERE}]]`)) problems.push("the link to nothing changed");
				return problems;
			},
		});
	}
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
