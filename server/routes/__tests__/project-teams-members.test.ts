/**
 * Several people in one team (docs/PROJECT_TEAMS-PLAN.md §二.1, §二.12, decisions T5/T6; M1):
 *
 *  - membership is the coordinator's narrator ACL: write = member, read = onlooker. The members
 *    route lists both with their roles; access is granted and revoked through the ordinary
 *    narrator sharing routes;
 *  - any member approves, denies or answers a call anywhere in the tree, and the team records who
 *    (a team event, the approvals drawer's recent decisions, the activity log);
 *  - an onlooker or a stranger cannot approve or answer (the existing 403/404);
 *  - revoking access takes effect at once: for the next approval, for an approval already in
 *    flight, and for open WebSocket subscriptions of the coordinator and its subagents;
 *  - a call waiting in the tree notifies the team's members, not its onlookers.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-team-members-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { projectTeamRoutes } = await import("../project-teams");
const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { and, eq } = await import("drizzle-orm");
const {
	aclGrants,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	teamWorkEvents,
	users,
} = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { narratorService } = await import("../../services/narrator-service");
const { pendingPermissions } = await import("../../services/narrator-session-state");
const { handleNarratorWS } = await import("../../websocket/narrator-ws");
const { permissionDecisionSchema } = await import("../../lib/validators");
const { notificationFanoutTesting, setRecordNotifications } = await import(
	"../../services/notification-fanout"
);

const OWNER = "members-owner";
const MEMBER = "members-member"; // project write: a member through the project write audience
const GRANTED = "members-granted"; // project read + an explicit write grant on the coordinator
const READER = "members-reader"; // project read: an onlooker through the project read audience
const OUTSIDER = "members-outsider";

const repo = join(testHome, "repo");
let projectId: string;
let teamId: string;
let workerId: string;
let grantId: string;

afterAll(() => {
	setRecordNotifications(null);
	for (const [id, pending] of pendingPermissions)
		if ([teamId, workerId].includes(pending.narratorId)) pendingPermissions.delete(id);
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

function appAs(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	app.route("/projects", projectTeamRoutes);
	app.route("/narrators", narratorRoutes);
	return app;
}

async function call(
	userId: string,
	path: string,
	init: { method?: string; body?: unknown } = {},
	// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
): Promise<{ status: number; body: any }> {
	const { method = "GET", body } = init;
	const response = await appAs(userId).request(`http://localhost${path}`, {
		method,
		...(body === undefined
			? {}
			: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	return { status: response.status, body: await response.json() };
}

const teamPath = (suffix: string) => `/projects/${projectId}/teams/${teamId}/${suffix}`;

let clock = Date.now() + 60_000;
function tick() {
	clock += 1000;
	return new Date(clock).toISOString();
}

/** A pending call of `narratorId`, live in the permission registry; returns its decisions. */
async function pendingCall(
	narratorId: string,
	toolName = "Bash",
	input: Record<string, unknown> = { command: "git status" },
) {
	const id = generateId();
	const messageId = generateId();
	const at = tick();
	await db
		.insert(narratorMessages)
		.values({ id: messageId, narratorId, role: "assistant", contentJson: [], createdAt: at });
	await db.insert(narratorToolCalls).values({
		id,
		narratorId,
		messageId,
		toolUseId: `use-${id}`,
		toolName,
		status: "pending",
		inputJson: input,
		permissionStartedAt: at,
		createdAt: at,
	});
	const decisions: string[] = [];
	pendingPermissions.set(id, {
		narratorId,
		broadcastTargetId: teamId,
		toolName,
		toolUseId: `use-${id}`,
		input,
		cwd: repo,
		locale: "en",
		signal: new AbortController().signal,
		resolve: (result) => decisions.push(result.behavior),
		cleanup: () => {
			pendingPermissions.delete(id);
		},
	});
	return { id, decisions };
}

async function grantWrite(userId: string): Promise<string> {
	const granted = await call(OWNER, `/narrators/${teamId}/grants`, {
		method: "POST",
		body: { userIds: [userId], access: "write" },
	});
	expect(granted.status).toBe(200);
	const row = await db
		.select({ id: aclGrants.id })
		.from(aclGrants)
		.where(
			and(
				eq(aclGrants.scopeType, "narrator"),
				eq(aclGrants.scopeId, teamId),
				eq(aclGrants.principalId, userId),
			),
		)
		.get();
	return row?.id as string;
}

async function revoke(id: string) {
	expect(
		(await call(OWNER, `/narrators/${teamId}/grants/${id}`, { method: "DELETE" })).status,
	).toBe(200);
}

async function personEvents() {
	return (
		await db
			.select({
				kind: teamWorkEvents.kind,
				actorKind: teamWorkEvents.actorKind,
				actorId: teamWorkEvents.actorId,
				detail: teamWorkEvents.detailJson,
			})
			.from(teamWorkEvents)
			.where(eq(teamWorkEvents.teamId, teamId))
	).filter((event) => event.actorKind === "person" && event.kind !== "team.created");
}

beforeAll(async () => {
	mkdirSync(repo, { recursive: true });
	const now = new Date().toISOString();
	for (const id of [OWNER, MEMBER, GRANTED, READER, OUTSIDER])
		await db
			.insert(users)
			.values({ id, username: `${id}-name`, passwordHash: "x", role: "user", createdAt: now });
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "members project",
		gitPath: repo,
		defaultBranch: "main",
		ownerUserId: OWNER,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	for (const [principalId, capability] of [
		[MEMBER, "write"],
		[GRANTED, "read"],
		[READER, "read"],
	] as const)
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId,
			capability,
			createdAt: now,
		});
	const created = await call(OWNER, `/projects/${projectId}/teams`, {
		method: "POST",
		body: { name: "Members team" },
	});
	expect(created.status).toBe(201);
	teamId = created.body.id;
	await db
		.update(narrators)
		.set({ visibility: "project", writeAudience: "project" })
		.where(eq(narrators.id, teamId));
	const worker = await narratorService.create({ title: "worker one", cwd: repo });
	workerId = worker.id;
	await db
		.update(narrators)
		.set({ type: "subagent", aclRootNarratorId: teamId, parentNarratorId: teamId })
		.where(eq(narrators.id, workerId));
	grantId = await grantWrite(GRANTED);
});

describe("members", () => {
	test("the coordinator's ACL: members (write) and onlookers (read), owner first", async () => {
		const response = await call(OWNER, teamPath("members"));
		expect(response.status).toBe(200);
		expect(
			response.body.members.map((m: { userId: string; role: string; owner: boolean }) => [
				m.userId,
				m.role,
				m.owner,
			]),
		).toEqual([
			[OWNER, "member", true],
			[GRANTED, "member", false],
			[MEMBER, "member", false],
			[READER, "onlooker", false],
		]);
		expect(response.body).toMatchObject({
			more: false,
			visibility: "project",
			writeAudience: "project",
			canManage: true,
		});
		// Onlookers see who is in the team too; only the owner manages it.
		const reader = await call(READER, teamPath("members"));
		expect(reader.status).toBe(200);
		expect(reader.body.canManage).toBe(false);
		expect((await call(MEMBER, teamPath("members"))).body.canManage).toBe(false);
		expect((await call(OUTSIDER, teamPath("members"))).status).toBe(404);
		expect((await call(OWNER, `/projects/other/teams/${teamId}/members`)).status).toBe(404);
	});

	test("granting and revoking through the narrator sharing routes changes the list", async () => {
		const id = await grantWrite(OUTSIDER);
		// A write grant without the project door is no access: still not listed.
		let listed = (await call(OWNER, teamPath("members"))).body.members.map(
			(m: { userId: string }) => m.userId,
		);
		expect(listed).not.toContain(OUTSIDER);
		const door = generateId();
		await db.insert(aclGrants).values({
			id: door,
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId: OUTSIDER,
			capability: "read",
			createdAt: new Date().toISOString(),
		});
		listed = (await call(OWNER, teamPath("members"))).body.members.map(
			(m: { userId: string; role: string }) => `${m.userId}:${m.role}`,
		);
		expect(listed).toContain(`${OUTSIDER}:member`);
		await revoke(id);
		listed = (await call(OWNER, teamPath("members"))).body.members.map(
			(m: { userId: string; role: string }) => `${m.userId}:${m.role}`,
		);
		// The project door alone leaves an onlooker (the coordinator is project-readable).
		expect(listed).toContain(`${OUTSIDER}:onlooker`);
		await db.delete(aclGrants).where(eq(aclGrants.id, door));
		expect((await call(OUTSIDER, teamPath("members"))).status).toBe(404);
	});
});

describe("who decided", () => {
	test("approve, deny and answer anywhere in the tree are recorded with the person", async () => {
		const bash = await pendingCall(workerId);
		const edit = await pendingCall(teamId, "Edit", { file_path: "src/a.ts" });
		const question = await pendingCall(teamId, "AskUserQuestion", {
			questions: [{ question: "Which first?", options: [] }],
		});
		expect(
			(
				await call(MEMBER, `/narrators/permissions/${bash.id}/approve`, {
					method: "POST",
					body: {},
				})
			).status,
		).toBe(200);
		expect(
			(await call(GRANTED, `/narrators/permissions/${edit.id}/deny`, { method: "POST", body: {} }))
				.status,
		).toBe(200);
		expect(
			(
				await call(OWNER, `/narrators/permissions/${question.id}/approve`, {
					method: "POST",
					body: { answers: { "Which first?": "The parser" } },
				})
			).status,
		).toBe(200);
		expect([bash.decisions, edit.decisions, question.decisions]).toEqual([
			["allow"],
			["deny"],
			["allow"],
		]);

		const events = await personEvents();
		const byRequest = new Map(events.map((event) => [event.detail?.requestId, event]));
		expect(byRequest.get(bash.id)).toMatchObject({
			kind: "approval.allowed",
			actorId: MEMBER,
			detail: { narratorId: workerId, depth: 1, tool: "Bash", approvalKind: "tool" },
		});
		expect(byRequest.get(edit.id)).toMatchObject({
			kind: "approval.denied",
			actorId: GRANTED,
			detail: { narratorId: teamId, depth: 0, tool: "Edit" },
		});
		expect(byRequest.get(question.id)).toMatchObject({
			kind: "question.answered",
			actorId: OWNER,
			detail: { tool: "AskUserQuestion", approvalKind: "question" },
		});

		// The approvals drawer: the latest decisions, newest first, with names.
		const approvals = await call(MEMBER, teamPath("approvals"));
		expect(approvals.status).toBe(200);
		expect(
			approvals.body.recent
				.slice(0, 3)
				.map((d: { kind: string; actorName: string; toolName: string; agentTitle: string }) => [
					d.kind,
					d.actorName,
					d.toolName,
				]),
		).toEqual([
			["question.answered", `${OWNER}-name`, "AskUserQuestion"],
			["approval.denied", `${GRANTED}-name`, "Edit"],
			["approval.allowed", `${MEMBER}-name`, "Bash"],
		]);
		expect(approvals.body.recent[2]).toMatchObject({ agentId: workerId, agentTitle: "worker one" });
		// The activity log has them too, with the person.
		const activity = await call(READER, teamPath("events"));
		const decided = activity.body.events.filter((event: { kind: string }) =>
			["approval.allowed", "approval.denied", "question.answered"].includes(event.kind),
		);
		expect(decided.map((event: { actorName: string }) => event.actorName)).toEqual([
			`${OWNER}-name`,
			`${GRANTED}-name`,
			`${MEMBER}-name`,
		]);
	});

	test("a decision over the WebSocket is recorded too; an onlooker's frame is dropped", async () => {
		const socket = (userId: string) => {
			const ws = {
				data: {
					channel: "narrator",
					connectedAt: Date.now(),
					lastPongAt: Date.now(),
					userId,
					userRole: "user",
					subscribedNarrators: new Set<string>(),
					catchingUpNarrators: new Map(),
					catchUpBuffers: new Map(),
				},
				getBufferedAmount: () => 0,
				close: () => {},
				send: (payload: string) => payload.length,
			} as unknown as Parameters<typeof handleNarratorWS.open>[0];
			handleNarratorWS.open(ws);
			return ws;
		};
		const reader = socket(READER);
		const member = socket(GRANTED);
		try {
			const pending = await pendingCall(workerId);
			await handleNarratorWS.message(reader, {
				type: "permission_decision",
				requestId: pending.id,
				decision: "allow",
			});
			expect(pending.decisions).toEqual([]);
			await handleNarratorWS.message(member, {
				type: "permission_decision",
				requestId: pending.id,
				decision: "deny",
			});
			for (let i = 0; i < 100 && pending.decisions.length === 0; i++) await Bun.sleep(5);
			expect(pending.decisions).toEqual(["deny"]);
			let recorded: Awaited<ReturnType<typeof personEvents>>[number] | undefined;
			for (let i = 0; i < 100 && !recorded; i++) {
				recorded = (await personEvents()).find((event) => event.detail?.requestId === pending.id);
				if (!recorded) await Bun.sleep(5);
			}
			expect(recorded).toMatchObject({ kind: "approval.denied", actorId: GRANTED });
		} finally {
			handleNarratorWS.close(reader);
			handleNarratorWS.close(member);
		}
	});

	test("an onlooker or a stranger cannot approve, deny or answer", async () => {
		const before = (await personEvents()).length;
		const call1 = await pendingCall(workerId);
		const ask = await pendingCall(teamId, "AskUserQuestion", { questions: [] });
		for (const user of [READER, OUTSIDER]) {
			for (const [request, action, body] of [
				[call1.id, "approve", {}],
				[call1.id, "deny", {}],
				[ask.id, "approve", { answers: { q: "a" } }],
			] as const) {
				const response = await call(user, `/narrators/permissions/${request}/${action}`, {
					method: "POST",
					body,
				});
				expect([403, 404]).toContain(response.status);
			}
		}
		expect(call1.decisions).toEqual([]);
		expect(ask.decisions).toEqual([]);
		expect((await personEvents()).length).toBe(before);
		pendingPermissions.delete(call1.id);
		pendingPermissions.delete(ask.id);
	});
});

describe("revoking access takes effect at once", () => {
	test("the next approval is refused", async () => {
		const first = await pendingCall(workerId);
		expect(
			(
				await call(GRANTED, `/narrators/permissions/${first.id}/approve`, {
					method: "POST",
					body: {},
				})
			).status,
		).toBe(200);
		await revoke(grantId);
		const second = await pendingCall(workerId);
		const refused = await call(GRANTED, `/narrators/permissions/${second.id}/approve`, {
			method: "POST",
			body: {},
		});
		expect([403, 404]).toContain(refused.status);
		expect(second.decisions).toEqual([]);
		pendingPermissions.delete(second.id);
		grantId = await grantWrite(GRANTED);
	});

	test("an approval already in flight when access is revoked is refused", async () => {
		// Revoke after the route's access gate has passed, while the handler reads the request:
		// the decision must be checked again and refused, for approve and deny alike.
		for (const action of ["approve", "deny"] as const) {
			const pending = await pendingCall(workerId);
			let revokedInFlight = false;
			const parse = spyOn(permissionDecisionSchema, "safeParse").mockImplementation(((
				value: unknown,
			) => {
				db.delete(aclGrants).where(eq(aclGrants.id, grantId)).run();
				revokedInFlight = true;
				parse.mockRestore();
				return permissionDecisionSchema.safeParse(value);
			}) as typeof permissionDecisionSchema.safeParse);
			try {
				const response = await call(GRANTED, `/narrators/permissions/${pending.id}/${action}`, {
					method: "POST",
					body: {},
				});
				expect(revokedInFlight).toBe(true);
				expect([403, 404]).toContain(response.status);
				expect(pending.decisions).toEqual([]);
			} finally {
				parse.mockRestore();
				pendingPermissions.delete(pending.id);
				grantId = await grantWrite(GRANTED);
			}
		}
	});

	test("open subscriptions of the coordinator and its subagents are dropped", async () => {
		const sent: string[] = [];
		const ws = {
			data: {
				channel: "narrator",
				connectedAt: Date.now(),
				lastPongAt: Date.now(),
				userId: GRANTED,
				userRole: "user",
				subscribedNarrators: new Set([teamId, workerId]),
				catchingUpNarrators: new Map(),
				catchUpBuffers: new Map(),
			},
			getBufferedAmount: () => 0,
			close: () => {},
			send: (payload: string) => {
				sent.push(payload);
				return payload.length;
			},
		} as unknown as Parameters<typeof handleNarratorWS.open>[0];
		handleNarratorWS.open(ws);
		// An onlooker keeps watching: the project door still lets them read.
		const onlooker = {
			...ws,
			data: { ...ws.data, userId: READER, subscribedNarrators: new Set([teamId, workerId]) },
			send: () => 1,
		} as unknown as Parameters<typeof handleNarratorWS.open>[0];
		handleNarratorWS.open(onlooker);
		try {
			// Remove the project door too, so revoking the grant leaves no access at all.
			await db
				.delete(aclGrants)
				.where(
					and(
						eq(aclGrants.scopeType, "project"),
						eq(aclGrants.scopeId, projectId),
						eq(aclGrants.principalId, GRANTED),
					),
				);
			await revoke(grantId);
			expect(ws.data.subscribedNarrators.has(teamId)).toBe(false);
			expect(ws.data.subscribedNarrators.has(workerId)).toBe(false);
			const denied = sent
				.map((payload) => JSON.parse(payload) as { type: string; narratorId?: string })
				.filter((frame) => frame.type === "subscribe_denied")
				.map((frame) => frame.narratorId)
				.sort();
			expect(denied).toEqual([teamId, workerId].sort());
			expect(onlooker.data.subscribedNarrators.has(teamId)).toBe(true);
			expect(onlooker.data.subscribedNarrators.has(workerId)).toBe(true);
		} finally {
			handleNarratorWS.close(ws);
			handleNarratorWS.close(onlooker);
			await db.insert(aclGrants).values({
				id: generateId(),
				scopeType: "project",
				scopeId: projectId,
				principalType: "user",
				principalId: GRANTED,
				capability: "read",
				createdAt: new Date().toISOString(),
			});
			grantId = await grantWrite(GRANTED);
		}
	});
});

describe("notifications", () => {
	test("a call waiting in the tree notifies the members, not the onlookers", async () => {
		const recorded: Array<{ userId: string; kind: string; sourceKey: string | null }> = [];
		setRecordNotifications(async (inputs) => {
			for (const input of inputs)
				recorded.push({
					userId: input.userId,
					kind: input.kind,
					sourceKey: input.sourceKey ?? null,
				});
		});
		try {
			const pending = await pendingCall(workerId, "AskUserQuestion", { questions: [] });
			await notificationFanoutTesting.fanoutPermissionRequestNotifications({
				narratorId: workerId,
				requestId: pending.id,
			});
			expect(recorded.every((row) => row.sourceKey === pending.id)).toBe(true);
			expect(recorded.map((row) => row.userId).sort()).toEqual([OWNER, GRANTED, MEMBER].sort());
			pendingPermissions.delete(pending.id);
		} finally {
			setRecordNotifications(null);
		}
	});
});
