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
	gatewaySessionMappings,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	teamWorkEvents,
	userRecentTabs,
	userRecentTabsMeta,
	users,
} = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { eventBus } = await import("../../lib/event-bus");
const { narratorService } = await import("../../services/narrator-service");
const { pendingPermissions } = await import("../../services/narrator-session-state");
const { handleNarratorWS } = await import("../../websocket/narrator-ws");
const { asyncQuestionAnswerSchema, permissionDecisionSchema } = await import(
	"../../lib/validators"
);
const { outlinePlanDecisionSchema } = await import("../../lib/validators/outline");
const outlinePlanMode = await import("../../services/outline-plan-mode");
const { createAsyncQuestion, setQuestionServiceSeam } = await import(
	"../../services/narrator-question-service"
);
const { resolvePermissionOrDangerReflection } = await import("../../services/narrator-permission");
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
	setQuestionServiceSeam(null);
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
	test("tab holders are read most recent first: 205 onlooker tabs do not push out a recent admin (M1)", async () => {
		const now = new Date().toISOString();
		const holderTab = async (userId: string, lastVisitedAt: number) => {
			await db
				.insert(userRecentTabsMeta)
				.values({ userId, revision: 1, migratedAt: now, createdAt: now, updatedAt: now })
				.onConflictDoNothing();
			await db.insert(userRecentTabs).values({
				id: `fanout-tab-${userId}`,
				userId,
				tabKey: `subagent:${workerId}`,
				section: "work",
				type: "subagent",
				entityId: workerId,
				representedNarratorId: workerId,
				title: "worker one",
				lastVisitedAt,
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			});
		};
		const onlookers: string[] = [];
		for (let i = 0; i < 205; i++) {
			const userId = `a-fanout-onlooker-${String(i).padStart(3, "0")}`;
			onlookers.push(userId);
			await db
				.insert(users)
				.values({ id: userId, username: userId, passwordHash: "x", role: "user", createdAt: now });
			await holderTab(userId, 1);
		}
		await db.insert(users).values({
			id: "zz-fanout-admin",
			username: "zz-fanout-admin",
			passwordHash: "x",
			role: "admin",
			createdAt: now,
		});
		await holderTab("zz-fanout-admin", 99);
		const recorded: string[] = [];
		setRecordNotifications(async (inputs) => {
			for (const input of inputs) recorded.push(input.userId);
		});
		try {
			const pending = await pendingCall(workerId, "AskUserQuestion", { questions: [] });
			await notificationFanoutTesting.fanoutPermissionRequestNotifications({
				narratorId: workerId,
				requestId: pending.id,
			});
			expect(recorded).toContain("zz-fanout-admin");
			expect(recorded).toContain(OWNER);
			expect(recorded.some((id) => onlookers.includes(id))).toBe(false);
			pendingPermissions.delete(pending.id);
		} finally {
			setRecordNotifications(null);
			await db.delete(userRecentTabs).where(eq(userRecentTabs.representedNarratorId, workerId));
		}
	});

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

describe("asynchronous questions (M1)", () => {
	/** An open asynchronous question of `narratorId`, delivered without a running loop. */
	async function openQuestion(narratorId: string) {
		const call = await pendingCall(narratorId, "AskUserQuestion", { questions: [] });
		pendingPermissions.delete(call.id);
		const toolUseId = `use-${call.id}`;
		const { record } = await createAsyncQuestion({
			narratorId,
			toolCallId: call.id,
			toolUseId,
			context: "Which part first? Work on the parser meanwhile.",
			questions: [{ id: "q1", header: "Which first?", options: [{ header: "Parser" }] }],
		});
		return record.id;
	}
	const questionPath = (narratorId: string, id: string, action: string) =>
		`/narrators/${narratorId}/questions/${id}/${action}`;

	beforeAll(() => {
		setQuestionServiceSeam({
			isLoopRunning: () => false,
			scheduleQuestionAnswerDelivery: async () => ({ ready: true, started: false }),
			broadcastToNarrator: () => {},
			emitAttention: () => {},
			emitAttentionResolved: () => {},
		});
	});

	test("members answer, dismiss, ignore and follow up, recorded with the person", async () => {
		const answered = await openQuestion(workerId);
		const response = await call(GRANTED, questionPath(workerId, answered, "answer"), {
			method: "POST",
			body: { answers: { q1: "Parser" } },
		});
		expect(response.status).toBe(200);
		const followUp = await call(MEMBER, questionPath(workerId, answered, "supplement"), {
			method: "POST",
			body: { text: "And keep the old API." },
		});
		expect(followUp.status).toBe(200);
		const dismissed = await openQuestion(teamId);
		expect(
			(await call(MEMBER, questionPath(teamId, dismissed, "dismiss"), { method: "POST" })).status,
		).toBe(200);
		const ignored = await openQuestion(teamId);
		expect(
			(await call(OWNER, questionPath(teamId, ignored, "ignore"), { method: "POST" })).status,
		).toBe(200);

		const events = await personEvents();
		const of = (questionId: string, kind: string) =>
			events.find((event) => event.detail?.questionId === questionId && event.kind === kind);
		expect(of(answered, "question.answered")).toMatchObject({
			actorId: GRANTED,
			detail: { narratorId: workerId, depth: 1, tool: "AskUserQuestion" },
		});
		expect(of(answered, "question.supplemented")).toMatchObject({ actorId: MEMBER });
		expect(of(dismissed, "question.dismissed")).toMatchObject({
			actorId: MEMBER,
			detail: { depth: 0 },
		});
		expect(of(ignored, "question.ignored")).toMatchObject({ actorId: OWNER });
		const recent = (await call(MEMBER, teamPath("approvals"))).body.recent.map(
			(d: { kind: string }) => d.kind,
		);
		for (const kind of [
			"question.answered",
			"question.supplemented",
			"question.dismissed",
			"question.ignored",
		])
			expect(recent).toContain(kind);
	});

	test("an onlooker or a stranger cannot answer, dismiss or ignore", async () => {
		const before = (await personEvents()).length;
		const question = await openQuestion(workerId);
		for (const user of [READER, OUTSIDER])
			for (const [action, body] of [
				["answer", { answers: { q1: "Parser" } }],
				["dismiss", undefined],
				["ignore", undefined],
			] as const) {
				const response = await call(user, questionPath(workerId, question, action), {
					method: "POST",
					body,
				});
				expect([403, 404]).toContain(response.status);
			}
		expect((await personEvents()).length).toBe(before);
	});

	test("an answer in flight when access is revoked is refused", async () => {
		const question = await openQuestion(workerId);
		let revokedInFlight = false;
		const parse = spyOn(asyncQuestionAnswerSchema, "safeParse").mockImplementation(((
			value: unknown,
		) => {
			db.delete(aclGrants).where(eq(aclGrants.id, grantId)).run();
			revokedInFlight = true;
			parse.mockRestore();
			return asyncQuestionAnswerSchema.safeParse(value);
		}) as typeof asyncQuestionAnswerSchema.safeParse);
		try {
			const response = await call(GRANTED, questionPath(workerId, question, "answer"), {
				method: "POST",
				body: { answers: { q1: "Parser" } },
			});
			expect(revokedInFlight).toBe(true);
			expect([403, 404]).toContain(response.status);
			expect((await personEvents()).some((event) => event.detail?.questionId === question)).toBe(
				false,
			);
		} finally {
			parse.mockRestore();
			grantId = await grantWrite(GRANTED);
		}
	});
});

describe("revocation reaches every way of deciding (M1)", () => {
	test("a WebSocket decision from a member whose grant was revoked is dropped", async () => {
		const ws = {
			data: {
				channel: "narrator",
				connectedAt: Date.now(),
				lastPongAt: Date.now(),
				userId: GRANTED,
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
		const pending = await pendingCall(workerId);
		try {
			await revoke(grantId);
			await handleNarratorWS.message(ws, {
				type: "permission_decision",
				requestId: pending.id,
				decision: "allow",
			});
			await Bun.sleep(0);
			expect(pending.decisions).toEqual([]);
			expect(pendingPermissions.has(pending.id)).toBe(true);
		} finally {
			handleNarratorWS.close(ws);
			pendingPermissions.delete(pending.id);
			grantId = await grantWrite(GRANTED);
		}
	});

	test("the last check runs inside the decision, after any restart-recovery wait", async () => {
		const pending = await pendingCall(workerId);
		const refused = new Error("access revoked");
		await expect(
			resolvePermissionOrDangerReflection(pending.id, "allow", {
				decidedBy: "user",
				assertStillAllowed: async () => {
					throw refused;
				},
			}),
		).rejects.toBe(refused);
		expect(pending.decisions).toEqual([]);
		expect(pendingPermissions.has(pending.id)).toBe(true);
		pendingPermissions.delete(pending.id);
	});
});

describe("members outside the project's door (M1)", () => {
	test("a reader outside the project sees no one found only through the project", async () => {
		await db
			.update(narrators)
			.set({ visibility: "public", writeAudience: "project" })
			.where(eq(narrators.id, teamId));
		try {
			// OUTSIDER reads the coordinator only because it is public.
			const outside = await call(OUTSIDER, teamPath("members"));
			expect(outside.status).toBe(200);
			const listed = outside.body.members.map((m: { userId: string }) => m.userId);
			expect(listed).toContain(OWNER); // the coordinator's owner
			expect(listed).toContain(GRANTED); // an explicit grant on the coordinator
			// READER holds only a project grant and never spoke here. (MEMBER spoke in the
			// conversation earlier, dismissing a question, so anyone who reads it knows them.)
			expect(listed).not.toContain(READER);
			// A project member sees them all.
			const inside = (await call(MEMBER, teamPath("members"))).body.members.map(
				(m: { userId: string }) => m.userId,
			);
			expect(inside).toContain(READER);
		} finally {
			await db
				.update(narrators)
				.set({ visibility: "project", writeAudience: "project" })
				.where(eq(narrators.id, teamId));
		}
	});
});

describe("onlookers are not alerted (M1)", () => {
	test("the attention list leaves out team calls an onlooker cannot act on", async () => {
		const pending = await pendingCall(workerId);
		try {
			const ids = async (userId: string) =>
				(await call(userId, "/narrators/human-attention")).body.items
					.filter((item: unknown) => JSON.stringify(item).includes(pending.id))
					.map((item: { canAct: boolean }) => item.canAct);
			expect(await ids(MEMBER)).toEqual([true]);
			expect(await ids(READER)).toEqual([]);
		} finally {
			pendingPermissions.delete(pending.id);
		}
	});

	test("recent tabs of a team session mark the onlooker, so the client stays silent", async () => {
		const { enrichTabs } = await import("../../services/user-preferences-service");
		const other = await narratorService.create({ title: "not a team", cwd: repo });
		const tabs = () => [
			{ type: "narrator", id: teamId },
			{ type: "subagent", id: workerId },
			{ type: "narrator", id: other.id },
		];
		const marks = async (userId: string) =>
			(await enrichTabs(tabs(), userId)).map((tab) => tab.teamOnlooker === true);
		expect(await marks(READER)).toEqual([true, true, false]);
		expect(await marks(MEMBER)).toEqual([false, false, false]);
		// Every viewer learns which tabs are team sessions (project changes re-read those).
		for (const userId of [READER, MEMBER])
			expect((await enrichTabs(tabs(), userId)).map((tab) => tab.teamSession === true)).toEqual([
				true,
				true,
				false,
			]);
		// Promoted to member: the next read (the client re-reads on narrator_access_changed)
		// clears the flag; revoked again, it comes back.
		const id = await grantWrite(READER);
		expect(await marks(READER)).toEqual([false, false, false]);
		await revoke(id);
		expect(await marks(READER)).toEqual([true, true, false]);
	});
});

describe("IM gateway and team sessions (M1)", () => {
	const REFUSED_SESSION = "can only be used from NarraFork";
	const REFUSED_DECISION = "can't be approved, denied or answered from chat";

	async function imSetup(chatId: string) {
		const { gateway } = await import("../../gateway/gateway");
		const sent: string[] = [];
		// biome-ignore lint/suspicious/noExplicitAny: driving the gateway's private paths
		const im = gateway as any;
		im.adapters.set("telegram", {
			send: async (_chatId: string, text: string) => {
				sent.push(text);
			},
			sendAndGetId: async (_chatId: string, text: string) => {
				sent.push(text);
				return { messageId: `pushed-${sent.length}` };
			},
			sendTyping: async () => {},
			supportsEdit: false,
		});
		const msg = {
			platform: "telegram" as const,
			chatId,
			userId: `${chatId}-sender`,
			username: "im sender",
			text: "",
		};
		// The production path: a new chat gets its own session, its account auto-resolved (the
		// first admin or only user; never a binding the sender proved).
		const mapping = await im.createNewMapping(msg, new Date().toISOString());
		expect(mapping.appUserId).toBeTruthy();
		const boundTo = async () =>
			(
				await db
					.select({ narratorId: gatewaySessionMappings.narratorId })
					.from(gatewaySessionMappings)
					.where(eq(gatewaySessionMappings.id, mapping.id))
					.get()
			)?.narratorId;
		const cleanup = async () => {
			im.adapters.delete("telegram");
			await db.delete(gatewaySessionMappings).where(eq(gatewaySessionMappings.chatId, chatId));
		};
		return { im, sent, msg, mapping, boundTo, cleanup };
	}

	test("/switch lists but refuses a team session; the chat stays on its own", async () => {
		const { im, sent, msg, mapping, boundTo, cleanup } = await imSetup("chat-switch");
		try {
			for (const target of [teamId, workerId]) {
				await im.handleCommand({ cmd: "/switch", args: target }, msg);
				expect(sent.at(-1)).toContain(REFUSED_SESSION);
				expect(await boundTo()).toBe(mapping.narratorId);
			}
		} finally {
			await cleanup();
		}
	});

	test("a chat bound to a team session (from before M1) cannot drive it in any way", async () => {
		const { im, sent, msg, mapping, cleanup } = await imSetup("chat-legacy");
		const session = await import("../../services/narrator-session");
		const send = spyOn(session, "sendMessage");
		const interrupt = spyOn(session, "interruptNarrator");
		try {
			// A mapping made before M1 could point at the coordinator.
			await db
				.update(gatewaySessionMappings)
				.set({ narratorId: teamId })
				.where(eq(gatewaySessionMappings.id, mapping.id));
			const modelBefore = (
				await db
					.select({ model: narrators.model })
					.from(narrators)
					.where(eq(narrators.id, teamId))
					.get()
			)?.model;
			await im.handleInboundMessage({ ...msg, text: "please run the tests" });
			expect(sent.at(-1)).toContain(REFUSED_SESSION);
			await im.handleCommand({ cmd: "/stop", args: "" }, msg);
			expect(sent.at(-1)).toContain(REFUSED_SESSION);
			await im.handleCommand({ cmd: "/model", args: "openai:other" }, msg);
			expect(sent.at(-1)).toContain(REFUSED_SESSION);
			await im.handleCommand({ cmd: "/model", args: "" }, msg);
			expect(sent.at(-1)).toContain(REFUSED_SESSION);
			// An unknown command is forwarded as a message: refused too.
			await im.handleCommand({ cmd: "/whatever", args: "" }, { ...msg, text: "/whatever" });
			expect(sent.at(-1)).toContain(REFUSED_SESSION);
			expect(send).not.toHaveBeenCalled();
			expect(interrupt).not.toHaveBeenCalled();
			expect(
				(
					await db
						.select({ model: narrators.model })
						.from(narrators)
						.where(eq(narrators.id, teamId))
						.get()
				)?.model,
			).toBe(modelBefore);

			// /status, /approve and /deny reveal nothing (not even whether a call waits); quote
			// replies are refused; nothing is decided.
			const before = (await personEvents()).length;
			const pending = await pendingCall(teamId);
			for (const [cmd, args] of [
				["/status", ""],
				["/approve", ""],
				["/deny", "not now"],
			] as const) {
				const count = sent.length;
				await im.handleCommand({ cmd, args }, { ...msg, text: `${cmd} ${args}` });
				expect(sent.slice(count)).toEqual([expect.stringContaining(REFUSED_SESSION)]);
			}
			im.trackPermMessageId("perm-message-1", pending.id);
			const keyword = [...im.constructor.APPROVE_KEYWORDS][0] as string;
			expect(
				await im.handlePermissionByQuote({
					...msg,
					text: keyword,
					raw: { message_reference: { message_id: "perm-message-1" } },
				}),
			).toBe(true);
			expect(sent.at(-1)).toContain(REFUSED_DECISION);
			expect(pending.decisions).toEqual([]);
			expect((await personEvents()).length).toBe(before);

			// Nothing of a team session goes out to IM: no permission request, no tool messages, no
			// reply when it goes idle, no error, no recent-tab status ping.
			im.subscribeToEvents();
			const before2 = sent.length;
			for (const message of [
				{
					type: "permission_request",
					request: { id: pending.id, toolName: "Bash", inputJson: { command: "ls" } },
				},
				{ type: "tool_started", toolName: "Bash", toolUseId: "tu-1", input: { command: "ls" } },
				{ type: "tool_completed", toolName: "Bash", toolUseId: "tu-1", status: "success" },
				{ type: "message", message: { role: "assistant", contentText: "done" } },
			])
				eventBus.emit({ type: "narrator:message_broadcast", narratorId: teamId, message } as never);
			eventBus.emit({
				type: "narrator:status_changed",
				narratorId: teamId,
				status: "idle",
			} as never);
			eventBus.emit({ type: "narrator:error", narratorId: teamId, error: "boom" } as never);
			eventBus.emit({
				type: "narrator:attention",
				narratorId: teamId,
				reason: "waiting_permission",
			} as never);
			await im.notifyRecentTabStatusChange(teamId, "waiting_permission");
			await im.deliverToIM(teamId);
			await Bun.sleep(50);
			expect(sent.slice(before2)).toEqual([]);
			pendingPermissions.delete(pending.id);
		} finally {
			send.mockRestore();
			interrupt.mockRestore();
			await cleanup();
		}
	});

	test("quote replies on worker and helper calls are refused (the tree, both levels)", async () => {
		const { im, sent, msg, cleanup } = await imSetup("chat-nested");
		const helper = await narratorService.create({ title: "helper", cwd: repo });
		await db
			.update(narrators)
			.set({ type: "subagent", aclRootNarratorId: teamId, parentNarratorId: workerId })
			.where(eq(narrators.id, helper.id));
		try {
			for (const narratorId of [workerId, helper.id]) {
				const pending = await pendingCall(narratorId);
				im.trackPermMessageId(`nested-${pending.id}`, pending.id);
				expect(
					await im.handlePermissionByQuote({
						...msg,
						text: "y",
						raw: { message_reference: { message_id: `nested-${pending.id}` } },
					}),
				).toBe(true);
				expect(sent.at(-1)).toContain(REFUSED_DECISION);
				expect(pending.decisions).toEqual([]);
				expect(pendingPermissions.has(pending.id)).toBe(true);
				pendingPermissions.delete(pending.id);
			}
		} finally {
			await cleanup();
		}
	});

	test("recent-tab status pings: none for a team session (even to someone without access); others as before", async () => {
		const { im, sent, mapping, cleanup } = await imSetup("chat-ping");
		const holder = mapping.appUserId as string;
		const plain = await narratorService.create({ title: "plain session", cwd: repo });
		const now = new Date().toISOString();
		await db
			.insert(userRecentTabsMeta)
			.values({ userId: holder, revision: 1, migratedAt: now, createdAt: now, updatedAt: now })
			.onConflictDoNothing();
		for (const narratorId of [teamId, plain.id])
			await db.insert(userRecentTabs).values({
				id: `ping-${narratorId}`,
				userId: holder,
				tabKey: `narrator:${narratorId}`,
				section: "work",
				type: "narrator",
				entityId: narratorId,
				representedNarratorId: narratorId,
				title: "tab",
				lastVisitedAt: 1,
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			});
		const teamCall = await pendingCall(teamId);
		const plainCall = await pendingCall(plain.id);
		try {
			const before = sent.length;
			await im.notifyRecentTabStatusChange(teamId, "waiting_permission");
			await im.notifyRecentTabStatusChange(teamId, "done");
			expect(sent.slice(before)).toEqual([]);
			await im.notifyRecentTabStatusChange(plain.id, "waiting_permission");
			expect(sent.at(-1)).toContain(`[perm:${plainCall.id}]`);
		} finally {
			pendingPermissions.delete(teamCall.id);
			pendingPermissions.delete(plainCall.id);
			await db.delete(userRecentTabs).where(eq(userRecentTabs.userId, holder));
			await cleanup();
		}
	});

	test("broadcasts that send nothing never look up team-ness (stream deltas, unmapped sessions)", async () => {
		const { gateway } = await import("../../gateway/gateway");
		// biome-ignore lint/suspicious/noExplicitAny: driving the gateway's private paths
		const im = gateway as any;
		im.subscribeToEvents();
		const membership = await import("../../services/teams/team-membership");
		const lookups = spyOn(membership, "teamIdOfNarrator");
		const plain = await narratorService.create({ title: "unmapped", cwd: repo });
		try {
			for (const message of [
				{
					type: "stream_event",
					event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
				},
				{ type: "tool_use_chunk", toolUseId: "tu", chunk: "{" },
				{ type: "tool_started", toolName: "Bash", toolUseId: "tu", input: {} },
				{ type: "message", message: { role: "assistant", contentText: "hello" } },
			])
				eventBus.emit({
					type: "narrator:message_broadcast",
					narratorId: plain.id,
					message,
				} as never);
			await Bun.sleep(20);
			expect(lookups).not.toHaveBeenCalled();
		} finally {
			lookups.mockRestore();
		}
	});

	test("/list names team sessions without their status; others keep theirs", async () => {
		const { im, sent, msg, mapping, cleanup } = await imSetup("chat-list");
		const holder = mapping.appUserId as string;
		const plain = await narratorService.create({ title: "plain listed", cwd: repo });
		const now = new Date().toISOString();
		await db
			.insert(userRecentTabsMeta)
			.values({ userId: holder, revision: 1, migratedAt: now, createdAt: now, updatedAt: now })
			.onConflictDoNothing();
		const tabRows = [
			[teamId, "narrator", "Members team"],
			[workerId, "subagent", "worker one"],
			[plain.id, "narrator", "plain listed"],
		] as const;
		for (const [index, [narratorId, type, title]] of tabRows.entries())
			await db.insert(userRecentTabs).values({
				id: `list-${narratorId}`,
				userId: holder,
				tabKey: `${type}:${narratorId}`,
				section: "work",
				type,
				entityId: narratorId,
				representedNarratorId: narratorId,
				...(type === "subagent" ? { narratorId } : {}),
				title,
				lastVisitedAt: index,
				sortOrder: index,
				createdAt: now,
				updatedAt: now,
			} as never);
		try {
			await im.handleCommand({ cmd: "/list", args: "" }, { ...msg, text: "/list" });
			const listing = sent.at(-1) ?? "";
			const line = (title: string) => listing.split("\n").find((l) => l.includes(title)) ?? "";
			expect(line("Members team")).not.toBe("");
			expect(line("Members team")).not.toContain("(");
			expect(line("plain listed")).toMatch(/\((idle|working|waiting)\)/);
			expect(line("worker one")).not.toBe("");
			expect(line("worker one")).not.toContain("(");
		} finally {
			await db.delete(userRecentTabs).where(eq(userRecentTabs.userId, holder));
			await cleanup();
		}
	});

	test("a session outside any team is used from IM exactly as before", async () => {
		const { im, msg, mapping, cleanup } = await imSetup("chat-plain");
		try {
			const own = await pendingCall(mapping.narratorId);
			await im.handleCommand({ cmd: "/approve", args: "" }, { ...msg, text: "/approve" });
			expect(own.decisions).toEqual(["allow"]);
		} finally {
			await cleanup();
		}
	});
});

describe("plan decisions and answering later (M1)", () => {
	const planBody = (action: "return" | "draft" | "lock") => ({ action, seenSeq: 0 });

	test("a member's plan decision and a deferral are recorded; onlookers are refused", async () => {
		// The outline's own plan handling is not under test: it resolves the waiting call.
		const decide = spyOn(outlinePlanMode, "decideOutlinePlanRequest").mockImplementation(
			async ({ requestId, body }) => {
				pendingPermissions
					.get(requestId)
					?.resolve({ behavior: body.action === "return" ? "deny" : "allow" } as never);
				pendingPermissions.delete(requestId);
				return { commit: null };
			},
		);
		try {
			const returned = await pendingCall(workerId, "ExitPlanMode", { plan: "x" });
			for (const user of [READER, OUTSIDER]) {
				const refused = await call(user, `/narrators/permissions/${returned.id}/plan`, {
					method: "POST",
					body: planBody("draft"),
				});
				expect([403, 404]).toContain(refused.status);
			}
			expect(decide).not.toHaveBeenCalled();
			expect(
				(
					await call(MEMBER, `/narrators/permissions/${returned.id}/plan`, {
						method: "POST",
						body: planBody("return"),
					})
				).status,
			).toBe(200);
			const approved = await pendingCall(teamId, "ExitPlanMode", { plan: "y" });
			expect(
				(
					await call(GRANTED, `/narrators/permissions/${approved.id}/plan`, {
						method: "POST",
						body: planBody("draft"),
					})
				).status,
			).toBe(200);

			const asked = await pendingCall(workerId, "AskUserQuestion", { questions: [] });
			for (const user of [READER, OUTSIDER]) {
				const refused = await call(user, `/narrators/permissions/${asked.id}/defer`, {
					method: "POST",
				});
				expect([403, 404]).toContain(refused.status);
			}
			expect(asked.decisions).toEqual([]);
			expect(
				(await call(MEMBER, `/narrators/permissions/${asked.id}/defer`, { method: "POST" })).status,
			).toBe(200);
			expect(asked.decisions).toEqual(["allow"]);

			const events = await personEvents();
			const of = (requestId: string) => events.find((e) => e.detail?.requestId === requestId);
			expect(of(returned.id)).toMatchObject({
				kind: "approval.denied",
				actorId: MEMBER,
				detail: { tool: "ExitPlanMode", approvalKind: "plan" },
			});
			expect(of(approved.id)).toMatchObject({ kind: "approval.allowed", actorId: GRANTED });
			expect(of(asked.id)).toMatchObject({ kind: "question.deferred", actorId: MEMBER });
		} finally {
			decide.mockRestore();
		}
	});

	test("a plan decision or a deferral in flight when access is revoked is refused", async () => {
		const decide = spyOn(outlinePlanMode, "decideOutlinePlanRequest").mockImplementation(
			async () => ({ commit: null }),
		);
		try {
			const plan = await pendingCall(workerId, "ExitPlanMode", { plan: "z" });
			let revoked = false;
			const parse = spyOn(outlinePlanDecisionSchema, "safeParse").mockImplementation(((
				value: unknown,
			) => {
				db.delete(aclGrants).where(eq(aclGrants.id, grantId)).run();
				revoked = true;
				parse.mockRestore();
				return outlinePlanDecisionSchema.safeParse(value);
			}) as typeof outlinePlanDecisionSchema.safeParse);
			const response = await call(GRANTED, `/narrators/permissions/${plan.id}/plan`, {
				method: "POST",
				body: planBody("draft"),
			});
			parse.mockRestore();
			expect(revoked).toBe(true);
			expect([403, 404]).toContain(response.status);
			expect(decide).not.toHaveBeenCalled();
			pendingPermissions.delete(plan.id);
			grantId = await grantWrite(GRANTED);

			// Defer has no body: revoke while the call is read, just before the re-check.
			const asked = await pendingCall(workerId, "AskUserQuestion", { questions: [] });
			const decisions = await import("../../services/teams/team-decisions");
			const read = spyOn(decisions, "readDecisionTarget").mockImplementation(async () => {
				db.delete(aclGrants).where(eq(aclGrants.id, grantId)).run();
				return { narratorId: workerId, toolName: "AskUserQuestion" };
			});
			try {
				const deferred = await call(GRANTED, `/narrators/permissions/${asked.id}/defer`, {
					method: "POST",
				});
				expect(read).toHaveBeenCalled();
				expect([403, 404]).toContain(deferred.status);
				expect(asked.decisions).toEqual([]);
			} finally {
				read.mockRestore();
				pendingPermissions.delete(asked.id);
				grantId = await grantWrite(GRANTED);
			}
		} finally {
			decide.mockRestore();
		}
	});
});

describe("audience changes reach the coordinator's tab holders (M1)", () => {
	test("a visibility or write-audience change tells the people who have the coordinator open", async () => {
		const narratorWs = await import("../../websocket/narrator-ws");
		const now = new Date().toISOString();
		// MEMBER has only the worker (a subagent of the coordinator) open.
		await db
			.insert(userRecentTabsMeta)
			.values({ userId: MEMBER, revision: 1, migratedAt: now, createdAt: now, updatedAt: now })
			.onConflictDoNothing();
		await db.insert(userRecentTabs).values({
			id: `audience-tab-${MEMBER}`,
			userId: MEMBER,
			tabKey: `subagent:${workerId}`,
			section: "work",
			type: "subagent",
			entityId: workerId,
			representedNarratorId: workerId,
			title: "worker one",
			lastVisitedAt: 2,
			sortOrder: 0,
			createdAt: now,
			updatedAt: now,
		});
		for (const userId of [READER, OUTSIDER]) {
			await db
				.insert(userRecentTabsMeta)
				.values({ userId, revision: 1, migratedAt: now, createdAt: now, updatedAt: now })
				.onConflictDoNothing();
			await db.insert(userRecentTabs).values({
				id: `audience-tab-${userId}`,
				userId,
				tabKey: `narrator:${teamId}`,
				section: "work",
				type: "narrator",
				entityId: teamId,
				representedNarratorId: teamId,
				title: "Members team",
				lastVisitedAt: 1,
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			});
		}
		const sent = spyOn(narratorWs, "broadcastToUser");
		try {
			const told = () =>
				sent.mock.calls
					.filter(([, frame]) => (frame as { type: string }).type === "narrator_access_changed")
					.map(([userId]) => userId);
			expect(
				(
					await call(OWNER, `/narrators/${teamId}/write-audience`, {
						method: "PATCH",
						body: { writeAudience: "owner" },
					})
				).status,
			).toBe(200);
			expect(told().sort()).toEqual([MEMBER, OUTSIDER, READER].sort());
			sent.mockClear();
			expect(
				(
					await call(OWNER, `/narrators/${teamId}/visibility`, {
						method: "PATCH",
						body: { visibility: "public" },
					})
				).status,
			).toBe(200);
			expect(told().sort()).toEqual([MEMBER, OUTSIDER, READER].sort());
			// A narrator that is not a team coordinator: nobody named, nobody told (as before).
			sent.mockClear();
			const plain = await narratorService.create({ title: "plain", cwd: repo });
			await db.update(narrators).set({ ownerUserId: OWNER }).where(eq(narrators.id, plain.id));
			expect(
				(
					await call(OWNER, `/narrators/${plain.id}/visibility`, {
						method: "PATCH",
						body: { visibility: "private" },
					})
				).status,
			).toBe(200);
			expect(told()).toEqual([]);
		} finally {
			sent.mockRestore();
			await db
				.update(narrators)
				.set({ visibility: "project", writeAudience: "project" })
				.where(eq(narrators.id, teamId));
		}
	});
});

describe("asking the AI to answer (M1)", () => {
	test("a member's request is recorded as question.answered_by_ai; an onlooker cannot", async () => {
		const permission = await import("../../services/narrator-permission");
		const reflect = spyOn(permission, "reflectPendingAskUserQuestion").mockImplementation(
			async () => ({ ok: true, answers: { q: "a" } }),
		);
		try {
			const asked = await pendingCall(workerId, "AskUserQuestion", { questions: [] });
			for (const user of [READER, OUTSIDER])
				expect([403, 404]).toContain(
					(
						await call(user, `/narrators/permissions/${asked.id}/reflect-question`, {
							method: "POST",
						})
					).status,
				);
			expect(reflect).not.toHaveBeenCalled();
			expect(
				(
					await call(MEMBER, `/narrators/permissions/${asked.id}/reflect-question`, {
						method: "POST",
					})
				).status,
			).toBe(200);
			const recorded = (await personEvents()).find((e) => e.detail?.requestId === asked.id);
			expect(recorded).toMatchObject({
				kind: "question.answered_by_ai",
				actorId: MEMBER,
				detail: { tool: "AskUserQuestion", approvalKind: "question" },
			});
			pendingPermissions.delete(asked.id);
		} finally {
			reflect.mockRestore();
		}
	});
});

describe("project visibility changes reach team tab holders (M1)", () => {
	test("the people with a team session of the project open are told; nobody else", async () => {
		const narratorWs = await import("../../websocket/narrator-ws");
		const { setProjectVisibility } = await import("../../services/project-membership");
		const now = new Date().toISOString();
		const tabOn = async (userId: string, narratorId: string, type: "narrator" | "subagent") => {
			await db
				.insert(userRecentTabsMeta)
				.values({ userId, revision: 1, migratedAt: now, createdAt: now, updatedAt: now })
				.onConflictDoNothing();
			await db
				.insert(userRecentTabs)
				.values({
					id: `visibility-tab-${userId}-${narratorId}`,
					userId,
					tabKey: `${type}:${narratorId}`,
					section: "work",
					type,
					entityId: narratorId,
					representedNarratorId: narratorId,
					title: "tab",
					lastVisitedAt: 3,
					sortOrder: 0,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoNothing();
		};
		// READER has only the worker (a team subagent) open; the plain holder only a session of
		// the same project that is not a team's.
		await tabOn(READER, workerId, "subagent");
		const plainHolder = "visibility-plain-holder";
		await db
			.insert(users)
			.values({ id: plainHolder, username: plainHolder, passwordHash: "x", createdAt: now });
		const plain = await narratorService.create({ title: "plain", cwd: repo });
		await db
			.update(narrators)
			.set({ contextProjectId: projectId })
			.where(eq(narrators.id, plain.id));
		await tabOn(plainHolder, plain.id, "narrator");
		// A project without teams, whose session the same plain holder has open.
		const teamless = generateId();
		await db.insert(projects).values({
			id: teamless,
			name: "teamless",
			gitPath: join(testHome, "teamless"),
			defaultBranch: "main",
			ownerUserId: OWNER,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		});
		const teamlessSession = await narratorService.create({ title: "teamless", cwd: repo });
		await db
			.update(narrators)
			.set({ contextProjectId: teamless })
			.where(eq(narrators.id, teamlessSession.id));
		await tabOn(plainHolder, teamlessSession.id, "narrator");

		const sent = spyOn(narratorWs, "broadcastToUser");
		const told = () =>
			sent.mock.calls
				.filter(([, frame]) => (frame as { type: string }).type === "project_access_changed")
				.map(([userId]) => userId);
		try {
			await setProjectVisibility(projectId, "public", { userId: OWNER, isAdmin: false });
			expect(told()).toContain(READER);
			expect(told()).not.toContain(plainHolder);
			sent.mockClear();
			await setProjectVisibility(teamless, "public", { userId: OWNER, isAdmin: false });
			expect(told()).toEqual([]);
		} finally {
			sent.mockRestore();
			await setProjectVisibility(projectId, "private", { userId: OWNER, isAdmin: false });
		}
	});
});
