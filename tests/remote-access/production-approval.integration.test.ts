import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { z } from "zod/v4";
import { db } from "../../server/db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../server/db/schema";
import { executeTool } from "../../server/lib/agent/tool-executor";
import { toolRegistry } from "../../server/lib/agent/tool-registry";
import type { AgentConfig } from "../../server/lib/agent/types";
import { generateId } from "../../server/lib/id";
import { settings } from "../../server/lib/settings";
import { handlePermission } from "../../server/services/narrator-permission";
import { narratorPersistence } from "../../server/services/narrator-persistence";
import { closePrefixSnapshotStore } from "../../server/services/narrator-prefix-snapshots";
import { pendingPermissions } from "../../server/services/narrator-session-state";
import { buildFinalToolStartAuthorization } from "../../server/services/tool-final-start-authorization";
import type { RemoteClient } from "../../shared/remote-access/browser-client";
import {
	productionTestBrowserExecutable,
	startProductionRemoteTestRuntime,
	waitForProductionTest,
} from "./production-test-runtime";

const owner = generateId();
const toolName = "RemoteApprovalProbe";
const password = "isolated-approval-password";
const executions: string[] = [];
const controllers: AbortController[] = [];
let runtime: Awaited<ReturnType<typeof startProductionRemoteTestRuntime>>;
let browser: Browser | undefined;
let page: Page;
const previousContinuation = settings.agent.autoContinuationMode;
interface PageState {
	rtc: RemoteClient;
	token: string;
}

beforeAll(async () => {
	settings.agent.autoContinuationMode = "off";
	runtime = await startProductionRemoteTestRuntime();
	await db.insert(users).values({
		id: owner,
		username: owner,
		role: "admin",
		passwordHash: await Bun.password.hash(password),
		createdAt: new Date().toISOString(),
	});
	// Only the effect is a safe in-memory test tool. Permission policy, persistence,
	// final-start authorization and the RTC HTTP resolver are all production code.
	toolRegistry.register({
		name: toolName,
		description: "Approval acceptance probe with no OS effects",
		parameters: z.object({ marker: z.string() }),
		execute: async (input) => {
			executions.push(String(input.marker));
			return { output: "probe executed" };
		},
	});
	browser = await puppeteer.launch({
		executablePath: productionTestBrowserExecutable(),
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});
	page = await browser.newPage();
	await page.goto(runtime.coordinator.origin, { waitUntil: "networkidle0" });
	await page.evaluate(
		async ({ invitation, username, password }) => {
			const modulePath = "/client.js";
			const module = (await import(
				modulePath
			)) as typeof import("../../shared/remote-access/browser-client");
			const state = window as unknown as PageState;
			state.rtc = await module.RemoteClient.connect(invitation, {
				mode: "narrafork",
				allowLocalhost: true,
				expectedInstanceId: invitation.instanceId,
			});
			const response = await state.rtc.request("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username, password }),
			});
			if (!response.ok) throw new Error(`Login ${response.status}`);
			state.token = (await response.json()).token;
			await state.rtc.authenticate(state.token);
		},
		{ invitation: runtime.invitation, username: owner, password },
	);
}, 180_000);

afterAll(async () => {
	for (const controller of controllers) controller.abort();
	await browser?.close();
	await closePrefixSnapshotStore();
	await runtime?.stop();
	toolRegistry.unregister(toolName);
	settings.agent.autoContinuationMode = previousContinuation;
});

async function beginTool(marker: string) {
	const narratorId = generateId();
	const messageId = generateId();
	const toolCallId = generateId();
	const toolUseId = generateId();
	const now = new Date().toISOString();
	const input = { marker };
	await db.insert(narrators).values({
		id: narratorId,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		ownerUserId: owner,
		cwd: runtime.directory,
		permissionMode: "default",
		autoContinuationOverride: "off",
		status: "working",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: toolUseId, name: toolName, input }],
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({ id: generateId(), narratorId, messageId, seq: 0 });
	await db.insert(narratorToolCalls).values({
		id: toolCallId,
		narratorId,
		messageId,
		toolUseId,
		toolName,
		inputJson: input,
		status: "initializing",
		executionAttempt: 1,
		executionIdentityVersion: 1,
		createdAt: now,
	});
	const controller = new AbortController();
	controllers.push(controller);
	const config: AgentConfig = {
		narratorId,
		conversationId: generateId(),
		model: "test:approval",
		provider: "test",
		cwd: runtime.directory,
		userId: owner,
		signal: controller.signal,
		requireToolCallBinding: true,
		permissionHandler: (name, input, useId, options) =>
			handlePermission(
				narratorId,
				controller.signal,
				name,
				input,
				useId,
				runtime.directory,
				"en",
				undefined,
				options,
			),
		onExecutionTargetResolved: (useId, target, receipt) =>
			narratorPersistence.updateToolCallExecutionTarget(narratorId, useId, target, receipt),
		onExecutionPlanResolved: (useId, plan, receipt) =>
			narratorPersistence.updateToolCallExecutionPlan(narratorId, useId, plan, receipt),
		onToolExecutionStarting: (useId, receipt, startedAt) =>
			narratorPersistence.claimToolCallExecution(narratorId, useId, receipt, startedAt),
	};
	config.onToolExecutionFinalAuthorization = buildFinalToolStartAuthorization(config);
	const result = executeTool({ name: toolName, toolUseId, input }, config, {
		toolCallBinding: { toolCallId, attempt: 1 },
	});
	void result.catch(() => {});
	await waitForProductionTest(
		() => pendingPermissions.has(toolCallId),
		"real persisted pending permission",
	);
	const persisted = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, toolCallId),
	});
	expect(persisted?.status).toBe("pending");
	return { narratorId, toolCallId, result };
}
async function decide(toolCallId: string, decision: "approve" | "deny") {
	return page.evaluate(
		async ({ toolCallId, decision }) => {
			const response = await (window as unknown as PageState).rtc.request(
				`/api/narrators/permissions/${toolCallId}/${decision}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(decision === "deny" ? { message: "RTC acceptance denied" } : {}),
				},
			);
			return { status: response.status, body: await response.json() };
		},
		{ toolCallId, decision },
	);
}

test("RTC reads a real pending approval, approve executes exactly once, replay never executes again", async () => {
	const pending = await beginTool("approved");
	expect(executions).toEqual([]);
	const visible = await page.evaluate(async (id) => {
		const response = await (window as unknown as PageState).rtc.request(
			`/api/narrators/${id}/permissions`,
		);
		return { status: response.status, body: await response.text() };
	}, pending.narratorId);
	expect(visible.status).toBe(200);
	expect(visible.body).toContain(pending.toolCallId);
	expect((await decide(pending.toolCallId, "approve")).status).toBe(200);
	const result = await pending.result;
	expect(result.isError).not.toBe(true);
	expect(executions).toEqual(["approved"]);
	const replay = await decide(pending.toolCallId, "approve");
	expect(replay.status).not.toBe(200);
	expect(executions).toEqual(["approved"]);
	const persisted = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, pending.toolCallId),
	});
	expect(persisted?.permissionDecidedBy).toBe("user");
	expect(persisted?.executionStartedAt).not.toBeNull();
}, 30_000);

test("RTC deny resolves the persisted permission without executing the tool", async () => {
	const before = [...executions];
	const pending = await beginTool("denied");
	expect((await decide(pending.toolCallId, "deny")).status).toBe(200);
	const result = await pending.result;
	expect(result.isError).toBe(true);
	expect(executions).toEqual(before);
	const persisted = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, pending.toolCallId),
	});
	expect(persisted?.permissionDecidedBy).toBe("user");
	expect(persisted?.executionStartedAt).toBeNull();
	expect(pendingPermissions.has(pending.toolCallId)).toBe(false);
}, 30_000);
