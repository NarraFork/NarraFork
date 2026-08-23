/**
 * The write audience is NESTED inside the read audience.
 *
 * The two columns started out independent, which let 3 of the 9 combinations make
 * `visibility` lie: a session marked `private` with `writeAudience: "project"` was in
 * fact readable by the whole project, while the panel told the user "only you and the
 * people you share it with can open this session". Nesting removes those three pairs, and
 * with them the need for the read path to consult the write audience at all.
 *
 * The properties that have to hold:
 *
 *  1. **Write implies read.** For every legal pair × every kind of project membership,
 *     anyone who may drive a session may also open it. This is THE assertion of this
 *     suite: the read path no longer looks at `writeAudience`, so if the nesting were
 *     ever incomplete the result would be a session someone can drive but not see — and
 *     no other test would notice, because the row/SQL agreement tests compare two READ
 *     paths that would agree with each other on `false`.
 *  2. **The six legal pairs are settable; the three illegal ones are refused**, with a
 *     message naming the control to change first.
 *  3. **Narrowing the read audience clamps the write audience** instead of failing.
 *     Refusing would leave the user stuck at the wider setting they were backing out of.
 *  4. **The clamp stops at the widest legal tier**, so `public` → `project` lands on
 *     `project` rather than collapsing to `owner`.
 *  5. **Delegation is orthogonal**: a subagent follows its root's pair, and its own
 *     frozen columns play no part.
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/narrator-access-nesting.test.ts
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
	clampWriteAudience,
	isWriteAudienceAllowed,
	type NarratorVisibility,
	type NarratorWriteAudience,
	WRITE_AUDIENCE_BY_VISIBILITY,
} from "@shared/narrator-access";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { aclGrants, chapters, narrators, projects, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { canReadNarrator, canWriteNarrator, type NarratorPrincipal } from "../narrator-acl";
import {
	getNarratorAccess,
	setNarratorVisibility,
	setNarratorWriteAudience,
} from "../narrator-sharing";

const TAG = Date.now();

let owner: string;
/** Holds project write — the tier the `project` write audience requires. */
let writeMember: string;
/** Holds project read only. */
let readMember: string;
/** In no project. */
let outsider: string;

let projectId: string;
let chapterId: string;

const asUser = (userId: string): NarratorPrincipal => ({ userId, isAdmin: false });

async function makeUser(label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${TAG}-${generateId(6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return id;
}

async function grantProject(userId: string, capability: "read" | "write") {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: userId,
		capability,
		createdAt: new Date().toISOString(),
	});
}

/** Insert a narrator with an explicit pair. Callers here always pass legal ones. */
async function makeNarrator(options: {
	visibility: NarratorVisibility;
	writeAudience: NarratorWriteAudience;
	chapterId?: string | null;
	contextProjectId?: string | null;
}): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		title: `nest-${TAG}`,
		ownerUserId: owner,
		chapterId: options.chapterId ?? null,
		contextProjectId: options.contextProjectId ?? null,
		visibility: options.visibility,
		writeAudience: options.writeAudience,
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

async function rowOf(narratorId: string) {
	const row = await db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) });
	if (!row) throw new Error(`missing narrator ${narratorId}`);
	return row;
}

/** Every legal (visibility, writeAudience) pair, derived from the shared table. */
function legalPairs(): { visibility: NarratorVisibility; writeAudience: NarratorWriteAudience }[] {
	return Object.entries(WRITE_AUDIENCE_BY_VISIBILITY).flatMap(([visibility, audiences]) =>
		audiences.map((writeAudience) => ({
			visibility: visibility as NarratorVisibility,
			writeAudience,
		})),
	);
}

beforeAll(async () => {
	owner = await makeUser("nest-owner");
	writeMember = await makeUser("nest-write");
	readMember = await makeUser("nest-read");
	outsider = await makeUser("nest-outsider");

	projectId = generateId();
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id: projectId,
		name: `nest-project-${TAG}`,
		gitPath: `/tmp/nest-${TAG}`,
		ownerUserId: owner,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	chapterId = generateId();
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "nest-chapter",
		branch: `nest/${TAG}`,
		baseBranch: "main",
		createdAt: now,
		updatedAt: now,
	});

	await grantProject(writeMember, "write");
	await grantProject(readMember, "read");
});

// ─── 1. Write implies read ───────────────────────────────────────────────

describe("write implies read", () => {
	test("for every legal pair, every project membership, and every principal", async () => {
		// Three kinds of project attachment, because read and write once resolved "which
		// project" differently: read tested `chapterId` while write also accepted
		// `contextProjectId`, so a `project`/`project` session carrying only the latter was
		// drivable but unopenable. The contextProjectId row is what catches a regression.
		const attachments = [
			{ label: "chapter-bound", opts: { chapterId } },
			{ label: "contextProjectId-only", opts: { contextProjectId: projectId } },
			{ label: "no project", opts: {} },
		];
		const principals = [
			{ label: "project write member", principal: asUser(writeMember) },
			{ label: "project read member", principal: asUser(readMember) },
			{ label: "outsider", principal: asUser(outsider) },
			{ label: "owner", principal: asUser(owner) },
		];

		for (const pair of legalPairs()) {
			for (const attachment of attachments) {
				const row = await rowOf(await makeNarrator({ ...pair, ...attachment.opts }));
				for (const { label, principal } of principals) {
					const canWrite = await canWriteNarrator(row, principal);
					if (!canWrite) continue;
					const canRead = await canReadNarrator(row, principal);
					// Reported with full context: a bare `false` would not say which of the
					// 36 combinations broke.
					expect({
						pair,
						attachment: attachment.label,
						principal: label,
						canRead,
					}).toEqual({
						pair,
						attachment: attachment.label,
						principal: label,
						canRead: true,
					});
				}
			}
		}
	});

	test("the matrix actually exercises write access, so the implication is not vacuous", async () => {
		// Guards the loop above: if nothing could ever write, "write implies read" would
		// pass trivially.
		const row = await rowOf(
			await makeNarrator({ visibility: "project", writeAudience: "project", chapterId }),
		);
		expect(await canWriteNarrator(row, asUser(writeMember))).toBe(true);
	});
});

// ─── 2. Legal pairs settable, illegal ones refused ───────────────────────

describe("the nesting rule at the API boundary", () => {
	test("all six legal pairs can be set", async () => {
		for (const pair of legalPairs()) {
			const id = await makeNarrator({ visibility: "public", writeAudience: "owner", chapterId });
			// Visibility first, so the write audience is never momentarily too wide.
			await setNarratorVisibility(id, pair.visibility, asUser(owner));
			const view = await setNarratorWriteAudience(id, pair.writeAudience, asUser(owner));
			expect({ v: view.visibility, w: view.writeAudience }).toEqual({
				v: pair.visibility,
				w: pair.writeAudience,
			});
		}
	});

	test("widening the write audience past the read audience is refused, not auto-escalated", async () => {
		// Pulling visibility up implicitly would enlarge an audience the user did not ask
		// to enlarge, so this direction fails loudly.
		const priv = await makeNarrator({ visibility: "private", writeAudience: "owner", chapterId });
		await expect(setNarratorWriteAudience(priv, "project", asUser(owner))).rejects.toThrow(
			/visible/i,
		);
		await expect(setNarratorWriteAudience(priv, "public", asUser(owner))).rejects.toThrow(
			/visible/i,
		);
		// And nothing moved.
		const after = await getNarratorAccess(priv, asUser(owner));
		expect({ v: after.visibility, w: after.writeAudience }).toEqual({ v: "private", w: "owner" });

		const proj = await makeNarrator({ visibility: "project", writeAudience: "owner", chapterId });
		await expect(setNarratorWriteAudience(proj, "public", asUser(owner))).rejects.toThrow(
			/visible/i,
		);
	});

	test("the refusal names the control that has to change first", async () => {
		const id = await makeNarrator({ visibility: "private", writeAudience: "owner", chapterId });
		await expect(setNarratorWriteAudience(id, "public", asUser(owner))).rejects.toThrow(
			/set visibility to everyone/i,
		);
	});
});

// ─── 3 & 4. Narrowing clamps instead of failing ──────────────────────────

describe("narrowing the read audience", () => {
	test("public+public down to private clamps the write audience to owner", async () => {
		const id = await makeNarrator({ visibility: "public", writeAudience: "public", chapterId });
		const view = await setNarratorVisibility(id, "private", asUser(owner));
		expect({ v: view.visibility, w: view.writeAudience }).toEqual({ v: "private", w: "owner" });
	});

	test("public+public down to project clamps to project, not all the way to owner", async () => {
		// The clamp lands on the widest tier the new read audience allows: collapsing to
		// `owner` would silently revoke collaboration the user never asked to revoke.
		const id = await makeNarrator({ visibility: "public", writeAudience: "public", chapterId });
		const view = await setNarratorVisibility(id, "project", asUser(owner));
		expect({ v: view.visibility, w: view.writeAudience }).toEqual({ v: "project", w: "project" });
	});

	test("an already-legal write audience is left alone", async () => {
		const id = await makeNarrator({ visibility: "public", writeAudience: "owner", chapterId });
		const view = await setNarratorVisibility(id, "project", asUser(owner));
		expect({ v: view.visibility, w: view.writeAudience }).toEqual({ v: "project", w: "owner" });
	});

	test("narrowing is never refused for producing an illegal pair", async () => {
		// The safety-critical direction: a user tightening access must always succeed.
		const id = await makeNarrator({ visibility: "public", writeAudience: "public", chapterId });
		expect((await setNarratorVisibility(id, "private", asUser(owner))).visibility).toBe("private");
	});

	test("the clamp is recorded as a consequence, not as a direct request", async () => {
		const id = await makeNarrator({ visibility: "public", writeAudience: "public", chapterId });
		await setNarratorVisibility(id, "private", asUser(owner));
		// Audit rows are written fire-and-forget, so allow the insert to land.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const events = await db.query.aclEvents.findMany({
			where: (e, { and, eq: eqFn }) => and(eqFn(e.scopeType, "narrator"), eqFn(e.scopeId, id)),
		});
		const clamped = events.find((e) => e.eventType === "narrator_write_audience_changed");
		expect(clamped?.detailJson).toMatchObject({
			from: "public",
			to: "owner",
			reason: "clamped_by_visibility",
		});
	});
});

// ─── 5. Delegation is orthogonal ─────────────────────────────────────────

describe("subagent delegation", () => {
	test("a subagent follows its root's pair, not its own frozen columns", async () => {
		const root = await makeNarrator({
			visibility: "project",
			writeAudience: "project",
			chapterId,
		});
		const subId = generateId();
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: subId,
			title: `nest-sub-${TAG}`,
			type: "subagent",
			subagentType: "general",
			parentNarratorId: root,
			aclRootNarratorId: root,
			ownerUserId: owner,
			// Pinned to the strictest values, as `createSubagent` writes them.
			visibility: "private",
			writeAudience: "owner",
			createdAt: now,
			updatedAt: now,
		});

		const sub = await rowOf(subId);
		expect(await canWriteNarrator(sub, asUser(writeMember))).toBe(true);
		expect(await canReadNarrator(sub, asUser(writeMember))).toBe(true);
		// The read member follows the root too: readable, not drivable.
		expect(await canReadNarrator(sub, asUser(readMember))).toBe(true);
		expect(await canWriteNarrator(sub, asUser(readMember))).toBe(false);
	});
});

// ─── The shared rule itself ──────────────────────────────────────────────

describe("WRITE_AUDIENCE_BY_VISIBILITY", () => {
	test("permits exactly six pairs and rejects the three that made visibility lie", () => {
		expect(legalPairs()).toHaveLength(6);
		expect(isWriteAudienceAllowed("private", "project")).toBe(false);
		expect(isWriteAudienceAllowed("private", "public")).toBe(false);
		expect(isWriteAudienceAllowed("project", "public")).toBe(false);
	});

	test("unknown values on either side are refused rather than defaulted", () => {
		expect(isWriteAudienceAllowed("nonsense", "owner")).toBe(false);
		expect(isWriteAudienceAllowed("public", "nonsense")).toBe(false);
	});

	test("clamping an unknown visibility falls back to the narrowest tier", () => {
		expect(clampWriteAudience("nonsense", "public")).toBe("owner");
	});
});
