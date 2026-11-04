import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { ReplyContext } from "@shared/reply-context";
import { asc, eq } from "drizzle-orm";
import { historyStrings, rowsAsHistory } from "../../../tests/fixtures/model-input";
import { cleanDb } from "../../../tests/setup";
import {
	narratorBufferedMessages,
	narratorMessages,
	narrators,
	narratorToolCalls,
	userPreferences,
	users,
} from "../../db/schema";
import type { ChatParams, ProviderAdapter } from "../../lib/agent/provider";

// The real prefix worker must share preload's isolated FILE database, never :memory:.
const { db, sqlite } = await import("../../db");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const { settings } = await import("../../lib/settings");
const {
	acceptUserMessage,
	closeNarrator,
	continueNarrator,
	ensureNarrator,
	hasPendingBufferedWork,
	startBackgroundCompletionContinuationIfPossible,
} = await import("../narrator-session");
const { activeNarrators } = await import("../narrator-session-state");
const { getExecutionOwner, getRunControl } = await import("../agent-runtime/ownership");
const { enqueueInboxAgent, wakeInboxIfEligible } = await import("../agent-runtime/inbox");
const { createAgentMessageDelivery } = await import("../agent-message-delivery");
const { createAsyncQuestion, answerAsyncQuestion } = await import("../narrator-question-service");
const { backgroundTaskService } = await import("../background-task-service");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");

const recipient = "reply-context-recipient";
const sender = "reply-context-sender";
const model = "replycontextfixture:model";
const zh: ReplyContext = { locale: "zh-CN", replyInUserLanguage: false };
const en: ReplyContext = { locale: "en", replyInUserLanguage: true };
const time = "2026-11-03T00:00:00.000Z";
type CapturedRequest = {
	system: string;
	input: string;
	pair: ReplyContext;
	principal: string | null | undefined;
	runPrincipal: string | null | undefined;
	permissionMode: string | null;
};
const requests: CapturedRequest[] = [];
let beforeResponse: ((request: CapturedRequest, params: ChatParams) => Promise<void>) | undefined;
const releases = new Set<() => void>();
const adapter: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: rowsAsHistory,
	injectSystemPrompt: (history, systemPrompt) => {
		history.unshift({ role: "system", content: systemPrompt });
	},
	async *chat(params) {
		const active = activeNarrators.get(recipient);
		if (!active) throw new Error("Provider reached without a live recipient");
		const [system, ...history] = params.history as Array<{ role: string; content: string }>;
		expect(system?.role).toBe("system");
		const request: CapturedRequest = {
			system: system.content,
			input: `${historyStrings(history)}\n${params.content}`,
			pair: { locale: active.locale, replyInUserLanguage: active._replyInUserLanguage ?? false },
			principal: active._currentUserId,
			runPrincipal: getRunControl(recipient)?.principal,
			permissionMode: recipientRow().permissionMode,
		};
		requests.push(request);
		params.onRequestStart?.();
		await beforeResponse?.(request, params);
		yield { text: "fixture completed this turn" };
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const unregister = registerExternalProviderResolver({
	resolve: (name) => (name === "replycontextfixture" ? adapter : null),
	listReadiness: () => [],
});

function recipientRow() {
	const row = db.select().from(narrators).where(eq(narrators.id, recipient)).get();
	if (!row) throw new Error("Missing recipient fixture");
	return row;
}
function mailbox() {
	return db
		.select()
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, recipient))
		.orderBy(asc(narratorBufferedMessages.arrivalSeq))
		.all();
}
function languageUpdates(request: CapturedRequest) {
	return [...request.input.matchAll(/<context_update>[\s\S]*?<\/context_update>/g)]
		.map(([text]) => text)
		.filter((text) => text.includes("[language]\n"));
}
async function waitUntil(check: () => boolean, label: string) {
	const deadline = Date.now() + 8_000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error(`Timed out: ${label}; requests=${requests.length}`);
		await Bun.sleep(10);
	}
}
async function idle(count: number) {
	await waitUntil(
		() =>
			requests.length === count &&
			recipientRow().status === "idle" &&
			!getExecutionOwner(recipient) &&
			!hasPendingBufferedWork(recipient),
		"recipient idle",
	);
}
function gate(index: number) {
	const release = Promise.withResolvers<void>();
	releases.add(release.resolve);
	beforeResponse = async () => {
		if (requests.length !== index) return;
		await release.promise;
	};
	return {
		entered: () => waitUntil(() => requests.length >= index, `provider request ${index}`),
		release: release.resolve,
	};
}
function expectEnglish(request: CapturedRequest, baseline: string) {
	expect(request.system).toBe(baseline);
	expect(request.pair).toEqual(en);
	expect(recipientRow().replyContext).toEqual(en);
	expect(request.principal).toBe("user-b");
	expect(request.runPrincipal).toBe("user-b");
	expect(request.permissionMode).toBe("default");
	const changes = languageUpdates(request);
	expect(changes).toHaveLength(1);
	expect(changes[0]).toContain("English");
}
function seedTool(narratorId: string, id: string, toolName: string) {
	db.insert(narratorMessages)
		.values({
			id: `${id}-message`,
			narratorId,
			role: "assistant",
			contentJson: [],
			createdAt: time,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id,
			narratorId,
			messageId: `${id}-message`,
			toolUseId: `${id}-use`,
			toolName,
			executionAttempt: 1,
			executionIdentityVersion: 1,
			status: "running",
			createdAt: time,
		})
		.run();
}

beforeEach(async () => {
	backgroundOccupancyStore.resetForTests();
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	await backgroundOccupancyStore.start();
	(await import("../task-source/backend")).invalidateTaskBackend();
	settings.agent.autoContinuationMode = "off";
	requests.length = 0;
	beforeResponse = undefined;
	for (const [id, pair] of [
		["user-a", zh],
		["user-b", en],
		["answerer", zh],
	] as const) {
		db.insert(users).values({ id, username: id, passwordHash: "fixture", createdAt: time }).run();
		db.insert(userPreferences)
			.values({
				id: `preferences-${id}`,
				userId: id,
				language: pair.locale,
				replyInUserLanguage: pair.replyInUserLanguage,
				createdAt: time,
				updatedAt: time,
			})
			.run();
	}
	for (const id of [recipient, sender]) {
		db.insert(narrators)
			.values({
				id,
				type: "primary",
				variant: "primary",
				traits: ["standalone"],
				title: "Reply context runtime fixture",
				model,
				ownerUserId: "user-a",
				permissionMode: "default",
				autoContinuationOverride: "off",
				status: "idle",
				cwd: process.env.HOME,
				createdAt: time,
				updatedAt: time,
				// Only the sender is preconfigured; the recipient must adopt through real admission.
				replyContext: id === sender ? zh : null,
			})
			.run();
		backgroundOccupancyStore.refreshNarrator(id);
	}
	await backgroundOccupancyStore.flush();
});
afterEach(async () => {
	for (const release of releases) release();
	releases.clear();
	beforeResponse = undefined;
	for (const id of [recipient, sender]) closeNarrator(id);
	await waitUntil(() => !getExecutionOwner(recipient), "test run cleanup");
	for (const id of [recipient, sender]) activeNarrators.delete(id);
	await backgroundOccupancyStore.flush();
	mock.restore();
});
afterAll(async () => {
	await closePrefixSnapshotStore();
	backgroundOccupancyStore.resetForTests();
	unregister();
});

test("adopts queued human pairs only on consumption; Send, answers, completion and cold rebuild preserve them", async () => {
	const first = gate(1);
	await acceptUserMessage(recipient, "中文用户 A 启动", {
		userId: "user-a",
		locale: "zh-CN",
		replyInUserLanguage: false,
		humanReplyContext: zh,
	});
	await first.entered();
	const baseline = requests[0].system;
	expect(baseline).toContain("## Context: language");
	expect(baseline).toContain("简体中文");
	expect(requests[0].pair).toEqual(zh);
	expect(requests[0].principal).toBe("user-a");
	expect(languageUpdates(requests[0])).toHaveLength(0);

	// Admission freezes B's complete pair without touching the in-flight A request.
	const accepted = await acceptUserMessage(recipient, "English user B takes the next turn", {
		userId: "user-b",
		locale: "en",
		replyInUserLanguage: true,
		humanReplyContext: en,
	});
	expect(accepted.buffered).toBe(true);
	expect(mailbox().at(-1)).toMatchObject({ state: "queued" });
	expect(JSON.parse(mailbox().at(-1)?.metadataJson ?? "{}").humanReplyContext).toEqual(en);
	expect(requests[0].input).not.toContain("English user B takes the next turn");
	expect(recipientRow().replyContext).toEqual(zh);
	expect(activeNarrators.get(recipient)).toMatchObject({
		locale: "zh-CN",
		_replyInUserLanguage: false,
		_currentUserId: "user-a",
	});
	expect(requests).toHaveLength(1);
	const second = gate(2);
	first.release();
	await second.entered();
	expectEnglish(requests[1], baseline);
	expect(requests[1].input).toContain("English user B takes the next turn");
	expect(
		mailbox()
			.filter((row) => row.kind === "user_input")
			.every((row) => row.state === "materialized"),
	).toBe(true);
	second.release();
	await idle(2);

	// The real Send agent lane has sender provenance, not a human language adoption.
	seedTool(sender, "send-source", "Send");
	const text = "中文发送者的消息，不应替换收件会话语言";
	const delivery = createAgentMessageDelivery(
		recipient,
		{
			id: sender,
			title: "中文发送者",
			label: "sender",
			type: "general",
			isParent: false,
		},
		"send-source-use",
		text,
		{ toolCallId: "send-source", attempt: 1 },
	);
	await enqueueInboxAgent(delivery, text, { createdBy: "user-a" });
	await wakeInboxIfEligible(recipient, "zh-CN");
	await idle(3);
	expect(requests[2].input).toContain(text);
	expectEnglish(requests[2], baseline);

	// Another human answers a recorded question. Attribution and display locale differ
	// from the execution principal and already adopted reply policy.
	seedTool(recipient, "question-source", "AskUserQuestion");
	const question = await createAsyncQuestion({
		narratorId: recipient,
		toolCallId: "question-source",
		toolUseId: "question-source-use",
		questions: [{ id: "choice", header: "Choice", options: [{ header: "Yes" }, { header: "No" }] }],
		context: "Confirm the next step without changing the reply recipient.",
		executionPrincipal: { version: 1, userId: "user-b" },
	});
	await answerAsyncQuestion(question.record.id, {
		answers: { choice: "Yes" },
		userId: "answerer",
		locale: "zh-CN",
	});
	await idle(4);
	expect(requests[3].input).toContain("Yes");
	expect(requests[3].input).toContain("answerer");
	expectEnglish(requests[3], baseline);
	expect(mailbox().some((row) => row.kind === "task_notice" && row.state === "materialized")).toBe(
		true,
	);

	// Real completion publication, no process/network and no mocked inbox consumer.
	await backgroundTaskService.createBashTask({
		id: "reply-background",
		parentNarratorId: recipient,
		command: "fixture only; never spawned",
	});
	await backgroundTaskService.markCompleted("reply-background", "后台任务已完成", 0);
	await startBackgroundCompletionContinuationIfPossible(recipient, "zh-CN", false);
	await idle(5);
	expect(requests[4].input).toContain("后台任务已完成");
	expectEnglish(requests[4], baseline);

	closeNarrator(recipient);
	activeNarrators.delete(recipient);
	await closePrefixSnapshotStore();
	const rebuilt = await ensureNarrator(recipient, "zh-CN", false);
	expect(rebuilt).toMatchObject({ locale: "en", _replyInUserLanguage: true });
	// A non-human continuation passes obsolete presentation defaults intentionally.
	await continueNarrator(recipient, "zh-CN", false);
	await idle(6);
	expectEnglish(requests[5], baseline);
}, 30_000);

test("rejected human input cannot adopt its pair or change the current execution principal", async () => {
	const first = gate(1);
	await acceptUserMessage(recipient, "保持当前中文回合", {
		userId: "user-a",
		locale: "zh-CN",
		humanReplyContext: zh,
	});
	await first.entered();
	const baseline = requests[0].system;
	const count = mailbox().length;
	await expect(
		acceptUserMessage(recipient, "text disagrees with the composer", {
			userId: "user-b",
			locale: "en",
			replyInUserLanguage: true,
			humanReplyContext: en,
			composerDocument: {
				version: 1,
				assets: [],
				paragraphs: [{ children: [{ type: "text", text: "different text" }] }],
			},
		}),
	).rejects.toThrow("Composer document does not match text or file references");
	expect(mailbox()).toHaveLength(count);
	expect(recipientRow().replyContext).toEqual(zh);
	expect(activeNarrators.get(recipient)).toMatchObject({
		locale: "zh-CN",
		_replyInUserLanguage: false,
		_currentUserId: "user-a",
	});
	expect(getRunControl(recipient)?.principal).toBe("user-a");
	expect(recipientRow().permissionMode).toBe("default");
	expect(requests).toHaveLength(1);
	expect(requests[0].system).toBe(baseline);
	expect(languageUpdates(requests[0])).toHaveLength(0);
	first.release();
	await idle(1);
}, 15_000);

async function initialChineseTurn() {
	await acceptUserMessage(recipient, "中文基线", {
		userId: "user-a",
		locale: "zh-CN",
		humanReplyContext: zh,
	});
	await idle(1);
	return requests[0].system;
}
async function persistUnfinishedAwait() {
	const { narratorService } = await import("../narrator-service");
	return narratorService.persistAssistantMessage(recipient, {
		uuid: "recovery-await-message",
		session_id: "recovery-await-session",
		parent_tool_use_id: null,
		message: {
			content: [
				{
					type: "tool_use",
					id: "recovery-await",
					name: "Await",
					input: { type: "agent", id: "fixture-missing-agent" },
				},
			],
		},
	});
}
async function ownerRoutes() {
	const { Hono } = await import("hono");
	const { narratorRoutes } = await import("../../routes/narrators");
	const app = new Hono();
	app.use("*", async (c, next) => {
		// Trusted authentication boundary; the real route ACL and run admission remain active.
		const now = Math.floor(Date.now() / 1000);
		c.set("user", { sub: "user-a", role: "user", iat: now, exp: now + 3600 });
		await next();
	});
	app.onError((error, c) => c.json({ error: error.message }, 400));
	app.route("/", narratorRoutes);
	return app;
}
async function englishOwnerPreference() {
	db.update(userPreferences)
		.set({ language: "en", replyInUserLanguage: true })
		.where(eq(userPreferences.userId, "user-a"))
		.run();
}
function expectRecoveredEnglish(baseline: string) {
	const last = requests.at(-1);
	if (!last) throw new Error("No provider request captured");
	expect(last.system).toBe(baseline);
	expect(last.pair).toEqual(en);
	expect(recipientRow().replyContext).toEqual(en);
	expect(last.principal).toBe("user-a");
	expect(last.runPrincipal).toBe("user-a");
	expect(last.permissionMode).toBe("default");
	expect(languageUpdates(last)).toHaveLength(1);
}

test("HTTP Continue adopts at unfinished Await recovery admission, not at a delayed continuation", async () => {
	const baseline = await initialChineseTurn();
	await persistUnfinishedAwait();
	await englishOwnerPreference();
	const communication = await import("../agent-communication");
	const release = Promise.withResolvers<void>();
	releases.add(release.resolve);
	const wait = spyOn(communication, "awaitAgentResultDetailed").mockImplementation(async () => {
		await release.promise;
		throw new Error("Fixture missing agent");
	});
	const app = await ownerRoutes();
	const response = await app.request(`/${recipient}/continue`, { method: "POST" });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ recovering: 1 });
	expect(wait).toHaveBeenCalledTimes(1);
	expect(recipientRow().replyContext).toEqual(en);
	expect(requests).toHaveLength(1);
	// A second rejected click cannot replace the accepted pair.
	await db
		.update(userPreferences)
		.set({ language: "zh-CN", replyInUserLanguage: false })
		.where(eq(userPreferences.userId, "user-a"));
	const rejected = await app.request(`/${recipient}/continue`, { method: "POST" });
	expect(rejected.status).toBe(400);
	expect(recipientRow().replyContext).toEqual(en);
	release.resolve();
	await idle(2);
	expectRecoveredEnglish(baseline);
}, 15_000);

test("recovery without candidates or with a live owner never adopts the human pair", async () => {
	await initialChineseTurn();
	const { resumeIncompleteAgentWorkForContinue, startRecoveryAwaitBatch } = await import(
		"../narrator-subagent-recovery"
	);
	const input = {
		narratorId: recipient,
		locale: "en" as const,
		replyInUserLanguage: true,
		userId: "user-a",
		humanReplyContext: en,
	};
	expect(await resumeIncompleteAgentWorkForContinue(input)).toEqual({
		recovering: false,
		items: [],
	});
	expect(recipientRow().replyContext).toEqual(zh);
	const { tryClaimExecution } = await import("../agent-runtime/ownership");
	const owner = tryClaimExecution(recipient, "run");
	if (!owner) throw new Error("Could not claim fixture owner");
	try {
		await expect(startRecoveryAwaitBatch({ ...input, aliases: ["missing"] })).rejects.toThrow(
			"already running",
		);
		expect(recipientRow().replyContext).toEqual(zh);
	} finally {
		owner.release();
	}
	expect(requests).toHaveLength(1);
}, 15_000);

test.each([
	true,
	false,
])("recovery await batch adopts only explicit human policy (human=%s)", async (human) => {
	const baseline = await initialChineseTurn();
	const { startRecoveryAwaitBatch } = await import("../narrator-subagent-recovery");
	await startRecoveryAwaitBatch({
		narratorId: recipient,
		aliases: ["fixture-missing-agent"],
		locale: "en",
		replyInUserLanguage: true,
		userId: "user-a",
		...(human ? { humanReplyContext: en } : {}),
	});
	await idle(2);
	if (human) expectRecoveredEnglish(baseline);
	else {
		expect(recipientRow().replyContext).toEqual(zh);
		expect(requests[1].pair).toEqual(zh);
		expect(requests[1].system).toBe(baseline);
		expect(languageUpdates(requests[1])).toHaveLength(0);
	}
}, 15_000);

test("idle HTTP goal adopts through the mailbox message transaction before its first provider request", async () => {
	const baseline = await initialChineseTurn();
	await englishOwnerPreference();
	const app = await ownerRoutes();
	const response = await app.request(`/${recipient}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "/goal Verify the accepted reply context" }),
	});
	expect(await response.json()).toMatchObject({ specGoal: true, added: true, started: true });
	expect(response.status).toBe(200);
	await idle(2);
	expectRecoveredEnglish(baseline);
	const consumed = mailbox().at(-1);
	expect(consumed).toMatchObject({ state: "materialized" });
	expect(
		db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.id, consumed?.recipientMessageId ?? ""))
			.get(),
	).toMatchObject({
		role: "user",
		commandText: "/goal Verify the accepted reply context",
		createdBy: "user-a",
	});
}, 15_000);

test("refused outline goal leaves the adopted language and mailbox unchanged", async () => {
	await initialChineseTurn();
	await englishOwnerPreference();
	settings.outline.enabled = true;
	// Outline sessions take `/goal`; only an outline subagent refuses it.
	db.update(narrators)
		.set({ taskBackend: "outline", type: "subagent" })
		.where(eq(narrators.id, recipient))
		.run();
	(await import("../task-source/backend")).invalidateTaskBackend(recipient);
	const before = mailbox().length;
	const response = await (await ownerRoutes()).request(`/${recipient}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "/goal This must be refused" }),
	});
	expect(response.status).toBe(400);
	expect(mailbox()).toHaveLength(before);
	expect(recipientRow().replyContext).toEqual(zh);
	expect(requests).toHaveLength(1);
}, 15_000);

function markRecipientDelivering() {
	seedTool(sender, "external-agent-call", "Agent");
	const registration = recipientRow().runtimeRegistrationJson;
	if (!registration?.run) throw new Error("Missing persisted run registration");
	db.update(narrators)
		.set({
			status: "working",
			runtimeRegistrationJson: {
				...registration,
				run: {
					...registration.run,
					deliverTo: {
						narratorId: sender,
						toolUseId: "external-agent-call-use",
						toolCallId: "external-agent-call",
					},
				},
			},
		})
		.where(eq(narrators.id, recipient))
		.run();
	db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, sender)).run();
}
async function waitForRestartManifestCleanup() {
	const { existsSync } = await import("node:fs");
	const { getNarraforkPath } = await import("../../lib/narrafork-home");
	await waitUntil(
		() => !existsSync(getNarraforkPath("restart-recovery.json")),
		"restart manifest cleanup",
	);
}

test("manual restart Continue adopts only after registrations succeed and only for its recipient", async () => {
	const baseline = await initialChineseTurn();
	await persistUnfinishedAwait();
	await englishOwnerPreference();
	db.update(narratorToolCalls)
		.set({ status: "running", executionAttempt: 1, executionIdentityVersion: 1 })
		.where(eq(narratorToolCalls.toolUseId, "recovery-await"))
		.run();
	markRecipientDelivering();
	const restart = await import("../restart-recovery-service");
	const handoff = await import("../recovery-handoff");
	const coordinator = await import("../update-coordinator");
	const session = await import("../narrator-session");
	const { tryClaimExecution } = await import("../agent-runtime/ownership");
	const oldArgs = [...process.argv];
	process.argv.push(restart.NO_AUTO_RESUME_FLAG);
	restart.resetRestartRecoveryForTests();
	handoff.resetRecoveryHandoffForTests();
	coordinator.resetUpdateCoordinationForTests();
	try {
		const prepared = await restart.prepareOrdinaryRestartRecovery({
			narratorIds: new Set(),
			toolCallIds: new Set(),
			backgroundTaskIds: new Set(),
		});
		expect(prepared.manifest).not.toBeNull();
		expect(await restart.manuallyResumeRestartRecovery("missing", en)).toBe(false);
		const owner = tryClaimExecution(recipient, "run");
		if (!owner) throw new Error("Could not claim recovery fixture owner");
		try {
			await expect(restart.manuallyResumeRestartRecovery(recipient, en)).rejects.toThrow(
				"already running",
			);
			expect(recipientRow().replyContext).toEqual(zh);
		} finally {
			owner.release();
		}
		const registration = spyOn(
			session,
			"registerPlannedUpdateRecoveryController",
		).mockImplementation(() => {
			throw new Error("fixture registration failed");
		});
		try {
			await expect(restart.manuallyResumeRestartRecovery(recipient, en)).rejects.toThrow(
				"fixture registration failed",
			);
			expect(recipientRow().replyContext).toEqual(zh);
		} finally {
			registration.mockRestore();
		}
		const response = await (await ownerRoutes()).request(`/${recipient}/continue`, {
			method: "POST",
		});
		expect(await response.json()).toMatchObject({ ok: true, recovering: true });
		expect(response.status).toBe(200);
		await idle(2);
		expectRecoveredEnglish(baseline);
		expect(db.select().from(narrators).where(eq(narrators.id, sender)).get()?.replyContext).toEqual(
			zh,
		);
		await waitForRestartManifestCleanup();
	} finally {
		process.argv = oldArgs;
		restart.resetRestartRecoveryForTests();
		handoff.resetRecoveryHandoffForTests();
		coordinator.resetUpdateCoordinationForTests();
	}
}, 20_000);

test.each([
	"valid",
	"stale",
	"cancelled",
] as const)("carried restart target adopts only when its own run is accepted (%s)", async (state) => {
	const baseline = await initialChineseTurn();
	markRecipientDelivering();
	const restart = await import("../restart-recovery-service");
	const handoff = await import("../recovery-handoff");
	const coordinator = await import("../update-coordinator");
	const oldArgs = [...process.argv];
	process.argv.push(restart.NO_AUTO_RESUME_FLAG);
	restart.resetRestartRecoveryForTests();
	handoff.resetRecoveryHandoffForTests();
	coordinator.resetUpdateCoordinationForTests();
	try {
		const prepared = await restart.prepareOrdinaryRestartRecovery({
			narratorIds: new Set(),
			toolCallIds: new Set(),
			backgroundTaskIds: new Set(),
		});
		expect(prepared.manifest).not.toBeNull();
		if (state === "stale")
			db.update(narrators)
				.set({ logicalRunId: "superseded-run" })
				.where(eq(narrators.id, recipient))
				.run();
		if (state === "cancelled")
			db.update(narrators)
				.set({ status: "idle", substatus: '["cancelled"]' })
				.where(eq(narrators.id, recipient))
				.run();
		expect(await restart.manuallyResumeRestartRecovery(recipient, en)).toBe(true);
		if (state === "valid") {
			await idle(2);
			expectRecoveredEnglish(baseline);
		} else {
			expect(recipientRow().replyContext).toEqual(zh);
			expect(requests).toHaveLength(1);
		}
		expect(db.select().from(narrators).where(eq(narrators.id, sender)).get()?.replyContext).toEqual(
			zh,
		);
		await waitForRestartManifestCleanup();
	} finally {
		process.argv = oldArgs;
		restart.resetRestartRecoveryForTests();
		handoff.resetRecoveryHandoffForTests();
		coordinator.resetUpdateCoordinationForTests();
	}
}, 15_000);

test("idle goal transaction failure remains one accepted queued input and adopts only on later consumption", async () => {
	const baseline = await initialChineseTurn();
	await englishOwnerPreference();
	const inbox = await import("../agent-runtime/inbox");
	const realWake = inbox.wakeInboxIfEligible;
	const release = Promise.withResolvers<void>();
	releases.add(release.resolve);
	const wake = spyOn(inbox, "wakeInboxIfEligible").mockImplementation(async (...args) => {
		await release.promise;
		return realWake(...args);
	});
	// Fail the REAL user-message insertion inside its SQLite transaction, not the
	// reply-context helper. The temporary trigger cannot touch another test DB.
	sqlite.run(`CREATE TEMP TRIGGER reject_reply_goal BEFORE INSERT ON narrator_messages
		WHEN NEW.command_text = '/goal Retry the committed inbox entry'
		BEGIN SELECT RAISE(ABORT, 'fixture goal write failed'); END`);
	try {
		const response = await (await ownerRoutes()).request(`/${recipient}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "/goal Retry the committed inbox entry" }),
		});
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ buffered: true, specGoalQueued: true });
		expect(mailbox()).toHaveLength(2);
		expect(mailbox().at(-1)).toMatchObject({ state: "queued" });
		expect(recipientRow().replyContext).toEqual(zh);
		expect(requests).toHaveLength(1);
		expect(wake).toHaveBeenCalledTimes(1);
		sqlite.run("DROP TRIGGER reject_reply_goal");
		release.resolve();
		await idle(2);
		expectRecoveredEnglish(baseline);
		expect(mailbox()).toHaveLength(2);
		expect(mailbox().at(-1)).toMatchObject({ state: "materialized" });
	} finally {
		sqlite.run("DROP TRIGGER IF EXISTS reject_reply_goal");
		release.resolve();
		wake.mockRestore();
	}
}, 15_000);

test("goal failure after message consumption acknowledges acceptance without claiming it is queued", async () => {
	await initialChineseTurn();
	await englishOwnerPreference();
	const spec = await import("../spec-vfs-service");
	const ws = await import("../../websocket/narrator-ws");
	const broadcast = spyOn(ws, "broadcastToNarrator");
	const append = spyOn(spec.specVfsService, "appendProtectedSpecTask").mockRejectedValue(
		new Error("fixture goal task write failed"),
	);
	try {
		const response = await (await ownerRoutes()).request(`/${recipient}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "/goal Already consumed command" }),
		});
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			accepted: true,
			buffered: false,
			started: false,
			goalError: "Error: fixture goal task write failed",
		});
		expect(append).toHaveBeenCalledTimes(1);
		expect(broadcast).toHaveBeenCalledWith(
			recipient,
			expect.objectContaining({
				type: "narrator_error",
				error: expect.stringContaining("input was accepted, but goal processing failed"),
			}),
		);
		expect(mailbox()).toHaveLength(2);
		expect(mailbox().at(-1)).toMatchObject({ state: "materialized" });
		expect(recipientRow().replyContext).toEqual(en);
		expect(requests).toHaveLength(1);
	} finally {
		append.mockRestore();
	}
}, 15_000);
