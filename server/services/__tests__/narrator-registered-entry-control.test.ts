import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { cleanDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import type { ToolContext } from "../../lib/agent/types";
import { AppError } from "../../lib/errors";
import { withRuntimePolicyTrait } from "../../lib/runtime-policy-trait";
import type { RuntimeRegistration } from "../../lib/validators/runtime-registration";

// The snapshot worker shares the preload-isolated file-backed database.
const { db, sqlite } = await import("../../db");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
const { agentTool } = await import("../../lib/agent/tools/task");
const { narratorRoutes } = await import("../../routes/narrators");
const { narratorService } = await import("../narrator-service");
const session = await import("../narrator-session");
const { resumeRecoverySubagents } = await import("../narrator-subagent-recovery");
const { setRunControl, setRunHold, getExecutionOwner, tryClaimExecution } = await import(
	"../agent-runtime/ownership"
);
const { runtimePublication } = await import("../agent-runtime/publication");
const { startNarratorRun } = await import("../agent-runtime/run");
const executor = await import("../narrator-executor");
const { settings } = await import("../../lib/settings");
const { compileDelegationPolicy } = await import("../agent-runtime/policy");
const { resetTraitLayerCaches, resolveNarratorRuntimePolicy } = await import(
	"../trait-layer-service"
);
const { clearAliasRegistry } = await import("../subagent-alias");
const NOW = new Date().toISOString();
const ids = new Set<string>();

function app() {
	const result = new Hono();
	result.use("*", async (c, next) => {
		c.set("user", { sub: "human", role: "admin", iat: 0, exp: 2_147_483_647 });
		await next();
	});
	result.onError(
		(error) =>
			new Response(JSON.stringify({ error: error.message }), {
				status: error instanceof AppError ? error.statusCode : 500,
			}),
	);
	result.route("/narrators", narratorRoutes);
	return result;
}

async function narrator(id: string, extra: Partial<typeof narrators.$inferInsert> = {}) {
	ids.add(id);
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		title: id,
		ownerUserId: "human",
		visibility: "private",
		writeAudience: "owner",
		status: "idle",
		cwd: process.cwd(),
		runtimeRegistrationJson: { version: 1 },
		createdAt: NOW,
		updatedAt: NOW,
		...extra,
	});
}

function registration(withDestination = false): RuntimeRegistration {
	return {
		version: 1,
		controller: { narratorId: "controller", actions: ["steer", "stop", "archive"] },
		...(withDestination
			? {
					run: {
						logicalRunId: "registered-run",
						deliverTo: {
							narratorId: "controller",
							toolUseId: "same-provider-id",
							toolCallId: "registered-target",
							attempt: 1,
						},
						principal: { userId: "human" },
					},
				}
			: {}),
	};
}

async function toolRow(id: string, seq: number) {
	const messageId = `${id}-message`;
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: "controller",
		role: "assistant",
		contentJson: [{ type: "tool_use", id: "same-provider-id", name: "Agent", input: {} }],
		createdAt: NOW,
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: `${id}-ref`, narratorId: "controller", messageId, seq });
	await db.insert(narratorToolCalls).values({
		id,
		narratorId: "controller",
		messageId,
		toolUseId: "same-provider-id",
		toolName: "Agent",
		executionIdentityVersion: 1,
		executionAttempt: 1,
		status: "success",
		outputJson: `unchanged ${id}`,
		createdAt: NOW,
	});
}

function liveRun(id: string) {
	const owner = tryClaimExecution(id, "run");
	if (!owner) throw new Error("Fixture run is already owned");
	const cancel = new AbortController();
	setRunControl(owner, {
		startedAt: Date.now(),
		cancel,
		timedOut: false,
		terminal: Promise.resolve({} as never),
	});
	return cancel;
}

beforeEach(async () => {
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	runtimePublication.stop();
	await db.insert(users).values({
		id: "human",
		username: "human",
		role: "admin",
		passwordHash: "fixture",
		createdAt: NOW,
	});
	await narrator("controller");
});
afterEach(() => {
	mock.restore();
	resetTraitLayerCaches();
	for (const id of ids) {
		getExecutionOwner(id)?.release();
		setRunHold(id, undefined);
		clearAliasRegistry(id);
	}
	ids.clear();
});
afterAll(async () => {
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
});

describe("registered ordinary session archive", () => {
	test("the controller's Agent.archive cancels and archives an ordinary session", async () => {
		await narrator("ordinary", { runtimeRegistrationJson: registration() });
		const cancel = liveRun("ordinary");
		const context: ToolContext = {
			narratorId: "controller",
			userId: "human",
			cwd: process.cwd(),
			locale: "en",
			signal: new AbortController().signal,
			requestPermission: async () => ({ behavior: "allow" }),
		};
		const result = await agentTool.execute({ archive: "ordinary" }, context);
		expect(result.isError).toBeFalsy();
		expect(cancel.signal.aborted).toBe(true);
		expect((await narratorService.getById("ordinary")).status).toBe("archived");
	});

	test("real unified run finalizing after HTTP archive cannot unarchive its session", async () => {
		const providers = settings.anthropicProviders;
		settings.anthropicProviders = [
			{
				id: "archive-test",
				name: "Archive",
				prefix: "archivetest",
				apiKey: "test",
				baseUrl: "https://example.invalid",
				defaultModel: "claude-sonnet-4",
			},
		];
		const entered = Promise.withResolvers<void>();
		const exit = Promise.withResolvers<void>();
		const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async () => {
			entered.resolve();
			await exit.promise;
			return { finalText: "", hasError: false, aborted: true, shouldUpdateTitle: false };
		});
		try {
			await narrator("ordinary", {
				runtimeRegistrationJson: registration(),
				model: "archivetest:claude-sonnet-4",
				autoContinuationOverride: "off",
			});
			const run = await startNarratorRun({
				narratorId: "ordinary",
				locale: "en",
				text: "work",
				principal: "human",
			});
			await entered.promise;
			const response = await app().request("/narrators/ordinary/archive", { method: "PATCH" });
			expect(response.status).toBe(200);
			expect((await narratorService.getById("ordinary")).status).toBe("archived");
			exit.resolve();
			await run.completion;
			expect((await narratorService.getById("ordinary")).status).toBe("archived");
		} finally {
			exit.resolve();
			execute.mockRestore();
			settings.anthropicProviders = providers;
		}
	});

	test("HTTP archive cancels an ordinary run even without a deliverTo relationship", async () => {
		await narrator("ordinary", { runtimeRegistrationJson: registration() });
		const cancel = liveRun("ordinary");
		const response = await app().request("/narrators/ordinary/archive", { method: "PATCH" });
		expect(response.status).toBe(200);
		expect(cancel.signal.aborted).toBe(true);
		expect((await narratorService.getById("ordinary")).status).toBe("archived");
	});
});

test("HTTP conclusion updates the registered exact call, not the legacy origin or duplicate provider id", async () => {
	await toolRow("old-origin", 1);
	await toolRow("registered-target", 2);
	await narrator("ordinary", {
		originToolCallId: "old-origin",
		runtimeRegistrationJson: registration(true),
	});
	await db.insert(narratorMessages).values({
		id: "ordinary-result",
		narratorId: "ordinary",
		role: "assistant",
		contentText: "precise registered conclusion",
		contentJson: [{ type: "text", text: "precise registered conclusion" }],
		createdAt: NOW,
	});
	await db.insert(narratorMessageRefs).values({
		id: "ordinary-result-ref",
		narratorId: "ordinary",
		messageId: "ordinary-result",
		seq: 1,
	});
	const response = await app().request("/narrators/ordinary/update-conclusion", { method: "POST" });
	expect(response.status).toBe(200);
	expect(
		(await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, "old-origin") }))
			?.outputJson,
	).toBe("unchanged old-origin");
	expect(
		JSON.stringify(
			(
				await db.query.narratorToolCalls.findFirst({
					where: eq(narratorToolCalls.id, "registered-target"),
				})
			)?.outputJson,
		),
	).toContain("precise registered conclusion");
});

test("recovery resumes a registered ordinary session with no parent or legacy origin messages", async () => {
	await toolRow("registered-target", 1);
	const failedAt = Date.now();
	await db
		.update(narrators)
		.set({ turnStartedAt: new Date(failedAt - 60_000).toISOString() })
		.where(eq(narrators.id, "controller"));
	await narrator("ordinary", {
		runtimeRegistrationJson: registration(true),
		substatus: JSON.stringify(["error", `turn_pause_started_ms:${failedAt}`]),
		createdAt: new Date(failedAt - 30_000).toISOString(),
	});
	const resume = spyOn(session, "continueNarrator").mockResolvedValue({
		ok: true,
		terminal: Promise.resolve(),
	});
	const result = await resumeRecoverySubagents({
		narratorId: "controller",
		subagentIds: ["ordinary"],
		locale: "en",
		userId: "human",
	});
	expect(result.skipped).toEqual([]);
	expect(result.resumed).toHaveLength(1);
	expect(resume.mock.calls[0]?.[0]).toBe("ordinary");
	expect((await narratorService.getById("ordinary")).runtimeRegistrationJson).toMatchObject({
		run: { deliverTo: { toolCallId: "registered-target" } },
	});
});

test("spawn admission follows capability traits rather than ordinary/delegated identity", async () => {
	const input = {
		subagentOriginKind: "standalone" as const,
		subagentType: "general",
		cwd: process.cwd(),
	};
	const ordinaryChild = await narratorService.createSubagent({
		...input,
		parentNarratorId: "controller",
	});
	ids.add(ordinaryChild.id);
	expect((await resolveNarratorRuntimePolicy("controller")).capabilities.spawnAgent).toBe(true);
	expect((await resolveNarratorRuntimePolicy(ordinaryChild.id)).capabilities.spawnAgent).toBe(
		false,
	);
	// A delegated-looking row with an explicit unrestricted registration/traits may spawn.
	await narrator("capable-delegated", {
		type: "subagent",
		variant: "subagent:general",
		parentNarratorId: "controller",
		traits: withRuntimePolicyTrait(["standalone"], { version: 1 }),
	});
	const child = await narratorService.createSubagent({
		...input,
		parentNarratorId: "capable-delegated",
	});
	ids.add(child.id);
	expect(child.parentNarratorId).toBe("capable-delegated");
	await expect(
		narratorService.createSubagent({ ...input, parentNarratorId: ordinaryChild.id }),
	).rejects.toThrow("capability ceiling");
	await narrator("restricted-ordinary", {
		traits: withRuntimePolicyTrait(
			["standalone"],
			compileDelegationPolicy({ template: "general" }),
		),
	});
	await expect(
		narratorService.createSubagent({ ...input, parentNarratorId: "restricted-ordinary" }),
	).rejects.toThrow("capability ceiling");
});
