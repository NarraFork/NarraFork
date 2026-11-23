import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
	backgroundTasks,
	integrationAuthorities,
	integrationResourceBindings,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	oauthClients,
	remoteDevices,
	users,
} from "../db/schema";
import { stopTool } from "../lib/agent/tools/stop";
import type { ToolContext } from "../lib/agent/types";
import { generateId } from "../lib/id";
import type { OAuthClientPolicy } from "../lib/oauth-client-policy";
import { backgroundTaskService } from "./background-task-service";
import { integrationAuthorityService } from "./integration-authority-service";
import { integrationResourceBindingService } from "./integration-resource-binding-service";
import {
	handlePermission,
	type RuntimePermissionConstraint,
	recheckFinalToolExecutionPermission,
} from "./narrator-permission";
import * as subagents from "./narrator-subagent";
import { assertOAuthNarratorRuntimeActive } from "./oauth-narrator-runtime-policy";
import { authorizeStopTask } from "./stop-task-policy";

const ids = {
	user: generateId(),
	client: generateId(),
	grant: generateId(),
	narrator: generateId(),
	child: generateId(),
	device: generateId(),
};
const now = new Date().toISOString();
const policy: OAuthClientPolicy = {
	defaultPermissionMode: "readOnly",
	allowedPermissionModes: ["readOnly"],
	systemPromptMode: "managed",
	maxSystemPromptChars: 0,
	allowGlobalDevice: false,
	allowKnowledgeWrite: false,
	allowDangerReflectionPrompt: false,
	maxDangerReflectionPromptChars: 0,
	allowRobotDiagnosticPreset: false,
	deviceAccess: { host: "readOnly", global: "readOnly", selfRegistered: "readOnly" },
	messageDetail: "summary",
};
const constraint = (access = policy.deviceAccess): RuntimePermissionConstraint => ({
	permissionMode: "readOnly",
	allowKnowledgeWrite: false,
	deviceAccess: access,
	oauthClientId: ids.client,
	grantId: ids.grant,
});
const ctx = (): ToolContext => ({
	narratorId: ids.narrator,
	userId: ids.user,
	cwd: "/not-the-task-workspace",
	locale: "en",
	signal: new AbortController().signal,
	requestPermission: async () => ({ behavior: "allow" }),
});
let cancel: ReturnType<typeof spyOn>;
let cancelAgent: ReturnType<typeof spyOn>;
let sequence = 0;
beforeAll(async () => {
	await db
		.insert(users)
		.values({ id: ids.user, username: ids.user, passwordHash: "fixture", createdAt: now });
	await db.insert(oauthClients).values({
		id: ids.client,
		clientId: ids.client,
		name: "Stop policy fixture",
		redirectUris: [],
		scopes: ["narrator.send_message"],
		grantTypes: ["authorization_code"],
		publicClient: true,
		policyJson: policy,
		createdBy: ids.user,
		createdAt: now,
		updatedAt: now,
	});
	await integrationAuthorityService.create({
		id: ids.grant,
		kind: "oauth_grant",
		integrationType: "oauth_client",
		integrationId: ids.client,
		ownerUserId: ids.user,
		policyJson: policy,
		grants: [
			{
				capabilityId: "narrator.send_message",
				scope: { type: "narrator", id: ids.narrator },
				createdBy: { type: "user", id: ids.user },
			},
		],
	});
	await db.insert(remoteDevices).values({
		id: ids.device,
		name: "offline target",
		slug: `stop-${ids.device}`,
		tokenHash: "fixture",
		tokenPrefix: "fixture",
		connectionMode: "reverse",
		status: "offline",
		scope: "global",
		createdBy: ids.user,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narrators).values({
		id: ids.narrator,
		cwd: "/session",
		defaultDeviceId: ids.device,
		permissionMode: "readOnly",
		oauthPolicySnapshotJson: {
			version: 3,
			systemPrompt: null,
			policy,
			permissionMode: "readOnly",
			defaultDeviceId: ids.device,
			deviceIds: [ids.device],
		},
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narrators).values({
		id: ids.child,
		cwd: "/different-child-dir",
		defaultDeviceId: "different-device",
		parentNarratorId: ids.narrator,
		type: "subagent",
		variant: "subagent:general",
		createdAt: now,
		updatedAt: now,
	});
	for (const [resourceType, resourceId] of [
		["narrator", ids.narrator],
		["device", ids.device],
	] as const)
		await integrationResourceBindingService.create({
			resourceType,
			resourceId,
			sourceType: "oauth_client",
			sourceId: ids.client,
			authorityType: "oauth_grant",
			authorityId: ids.grant,
			state: "active",
		});
});
beforeEach(async () => {
	await db.update(oauthClients).set({ policyJson: policy }).where(eq(oauthClients.id, ids.client));
	cancel = spyOn(backgroundTaskService, "cancel").mockResolvedValue(true);
	cancelAgent = spyOn(subagents, "cancelBackgroundTask").mockResolvedValue(true);
});
afterEach(() => {
	cancel.mockRestore();
	cancelAgent.mockRestore();
});
afterAll(async () => {
	for (const id of [ids.child, ids.narrator]) {
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, id));
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, id));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, id));
	}
	await db.delete(narrators).where(eq(narrators.id, ids.child));
	await db.delete(narrators).where(eq(narrators.id, ids.narrator));
	await db
		.delete(integrationResourceBindings)
		.where(eq(integrationResourceBindings.authorityId, ids.grant));
	await db.delete(integrationAuthorities).where(eq(integrationAuthorities.id, ids.grant));
	await db.delete(remoteDevices).where(eq(remoteDevices.id, ids.device));
	await db.delete(oauthClients).where(eq(oauthClients.id, ids.client));
	await db.delete(users).where(eq(users.id, ids.user));
});
async function call(toolName: "Bash" | "Stop", input: Record<string, unknown>, deviceId?: string) {
	const id = generateId(),
		useId = generateId(),
		messageId = generateId();
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: ids.narrator,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: useId, name: toolName, input }],
		createdAt: now,
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId: ids.narrator, messageId, seq: ++sequence });
	await db.insert(narratorToolCalls).values({
		id,
		narratorId: ids.narrator,
		messageId,
		toolUseId: useId,
		toolName,
		inputJson: input,
		status: "running",
		executionIdentityVersion: 1,
		executionAttempt: 1,
		executionStartedAt: toolName === "Bash" ? now : null,
		executionDeviceId: deviceId,
		permissionDecidedBy: "auto",
		permissionDecidedAt: now,
		createdAt: now,
	});
	return { id, useId, binding: { toolCallId: id, attempt: 1 } };
}
async function task(deviceId: string | null = "local", type: "bash" | "agent" = "bash") {
	const id = generateId(),
		alias = `stop-${id}`;
	const source =
		type === "bash" && deviceId !== null
			? await call("Bash", { command: "long-running-work" }, deviceId)
			: undefined;
	await db.insert(backgroundTasks).values({
		id,
		parentNarratorId: ids.narrator,
		type,
		status: "running",
		subagentNarratorId: type === "agent" ? ids.child : null,
		toolCallId: source?.id,
		executionAttempt: source ? 1 : null,
		toolUseId: source?.useId,
		alias,
		command: "work",
		startedAt: now,
		createdAt: now,
		updatedAt: now,
	});
	return { id, alias, source };
}
async function permission(input: Record<string, unknown>, cap = constraint(), review = false) {
	const receipt = await call("Stop", input);
	const result = await handlePermission(
		ids.narrator,
		ctx().signal,
		"Stop",
		input,
		receipt.useId,
		ctx().cwd,
		"en",
		undefined,
		{ toolCallBinding: receipt.binding },
		undefined,
		cap,
		review,
	);
	return { result, receipt };
}
async function setAccess(access: OAuthClientPolicy["deviceAccess"]) {
	await db
		.update(oauthClients)
		.set({ policyJson: { ...policy, deviceAccess: access } })
		.where(eq(oauthClients.id, ids.client));
}

describe("Stop OAuth task-device authority", () => {
	for (const [device, group] of [
		["local", "host"],
		["unregistered-remote", "global"],
		[ids.device, "selfRegistered"],
	] as const) {
		for (const useAlias of [false, true]) {
			test(`denied ${group} ${useAlias ? "alias" : "id"} ignores spoofed device and never cancels`, async () => {
				const target = await task(device);
				const access = { ...policy.deviceAccess, [group]: "denied" };
				await setAccess(access);
				const input = {
					type: "bash",
					id: useAlias ? target.alias : target.id,
					device: "allowed-device",
				};
				const { result } = await permission(input, constraint(access));
				expect(result.behavior).toBe("deny");
				const executed = await stopTool.execute(input, ctx());
				expect(executed.isError).toBe(true);
				expect(executed.output).toContain("denies this device group");
				expect(cancel).not.toHaveBeenCalled();
			});
		}
	}
	for (const device of ["local", ids.device]) {
		test(`readOnly permits cancelling already-running ${device === "local" ? "local" : "offline remote"} work`, async () => {
			const target = await task(device);
			const { result } = await permission({ type: "bash", id: target.alias });
			expect(result.behavior).toBe("allow");
			if (result.behavior === "allow")
				expect(result.updatedInput).toEqual({ type: "bash", id: target.id });
			const executed = await stopTool.execute({ type: "bash", id: target.id }, ctx());
			expect(executed.isError).not.toBe(true);
			expect(cancel).toHaveBeenCalledWith(target.id, { assertAuthorized: expect.any(Function) });
		});
	}
	test("missing capability fails closed before auto-allow", async () => {
		const target = await task();
		const cap = { ...constraint(), deviceAccess: undefined };
		const { result } = await permission({ type: "bash", id: target.id }, cap);
		expect(result.behavior).toBe("deny");
		expect(cancel).not.toHaveBeenCalled();
	});
	test("legacy task without a durable binding cannot cancel under OAuth", async () => {
		const target = await task(null);
		const { result } = await permission({ type: "bash", id: target.id });
		expect(result.behavior).toBe("deny");
		const executed = await stopTool.execute({ type: "bash", id: target.id }, ctx());
		expect(executed.isError).toBe(true);
		expect(executed.output).toContain("Cannot reliably identify the target device");
		expect(cancel).not.toHaveBeenCalled();
	});
	for (const field of [
		"executionAttempt",
		"narratorId",
		"executionDeviceId",
		"executionOriginToolCallId",
	] as const) {
		test(`mismatched persisted ${field} is not trusted`, async () => {
			const target = await task();
			await db
				.update(narratorToolCalls)
				.set({
					[field]:
						field === "executionAttempt"
							? 2
							: field === "narratorId"
								? ids.child
								: field === "executionDeviceId"
									? null
									: generateId(),
				})
				.where(eq(narratorToolCalls.id, target.source?.id ?? "missing-source"));
			const executed = await stopTool.execute({ type: "bash", id: target.id }, ctx());
			expect(executed.isError).toBe(true);
			expect(cancel).not.toHaveBeenCalled();
		});
	}
	test("OAuth agent task has no reliable single-device authority", async () => {
		const target = await task(null, "agent");
		const { result } = await permission({ type: "agent", id: target.alias });
		expect(result.behavior).toBe("deny");
		const executed = await stopTool.execute({ type: "agent", id: target.id }, ctx());
		expect(executed.isError).toBe(true);
		expect(executed.output).toContain("Cannot reliably identify the target device");
		expect(cancelAgent).not.toHaveBeenCalled();
	});
	test("review remains denied even for readOnly allowed task", async () => {
		const target = await task();
		const { result } = await permission({ type: "bash", id: target.id }, constraint(), true);
		expect(result.behavior).toBe("deny");
		expect(cancel).not.toHaveBeenCalled();
	});
	test("final authorization rejects device access revoked after permission", async () => {
		const target = await task();
		const input = { type: "bash", id: target.id };
		const { result, receipt } = await permission(input);
		expect(result.behavior).toBe("allow");
		const access = { ...policy.deviceAccess, host: "denied" as const };
		await setAccess(access);
		let rejection: unknown;
		try {
			await recheckFinalToolExecutionPermission({
				narratorId: ids.narrator,
				toolName: "Stop",
				input,
				toolUseId: receipt.useId,
				binding: receipt.binding,
				cwd: ctx().cwd,
				runtimeConstraint: constraint(access),
			});
		} catch (error) {
			rejection = error;
		}
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toContain("denies this device group");
		expect(cancel).not.toHaveBeenCalled();
	});
	test("tool body rechecks live policy after final admission", async () => {
		const target = await task();
		const input = { type: "bash", id: target.id };
		const { receipt } = await permission(input);
		const fence = await recheckFinalToolExecutionPermission({
			narratorId: ids.narrator,
			toolName: "Stop",
			input,
			toolUseId: receipt.useId,
			binding: receipt.binding,
			cwd: ctx().cwd,
			runtimeConstraint: constraint(),
		});
		fence.assertStillCurrent();
		await setAccess({ ...policy.deviceAccess, host: "denied" });
		const executed = await stopTool.execute(input, ctx());
		expect(executed.isError).toBe(true);
		expect(cancel).not.toHaveBeenCalled();
		expect(() => fence.assertStillCurrent()).toThrow();
	});
	test("task binding mutation invalidates prepared cancellation fence", async () => {
		const target = await task();
		const fence = await authorizeStopTask(
			ids.narrator,
			{ type: "bash", id: target.id },
			constraint(),
		);
		await db
			.update(narratorToolCalls)
			.set({ executionDeviceId: "other-device" })
			.where(eq(narratorToolCalls.id, target.source?.id ?? "missing-source"));
		expect(() => fence.assertStillCurrent()).toThrow("authorization changed");
		expect(cancel).not.toHaveBeenCalled();
	});
	test("live OAuth policy mutation invalidates the synchronous cancellation fence", async () => {
		const target = await task();
		const fence = await authorizeStopTask(
			ids.narrator,
			{ type: "bash", id: target.id },
			constraint(),
		);
		await setAccess({ ...policy.deviceAccess, host: "denied" });
		expect(() => fence.assertStillCurrent()).toThrow("OAuth policy ceiling changed");
		expect(cancel).not.toHaveBeenCalled();
	});
	for (const mutation of ["policy", "binding"] as const) {
		test(`real cancel rechecks ${mutation} after its asynchronous task read before abort/kill/publication`, async () => {
			const target = await task();
			// Keep the real cancel body: its awaited getById is the vulnerable window.
			cancel.mockRestore();
			cancel = spyOn(backgroundTaskService, "cancel");
			const originalGetById = backgroundTaskService.getById.bind(backgroundTaskService);
			let reads = 0;
			const getById = spyOn(backgroundTaskService, "getById").mockImplementation(async (id) => {
				const row = await originalGetById(id);
				if (id === target.id && ++reads === 3) {
					if (mutation === "policy") await setAccess({ ...policy.deviceAccess, host: "denied" });
					else
						await db
							.update(narratorToolCalls)
							.set({ executionDeviceId: "changed-device" })
							.where(eq(narratorToolCalls.id, target.source?.id ?? "missing-source"));
				}
				return row;
			});
			const controller = new AbortController();
			const abort = spyOn(controller, "abort");
			const kill = mock(() => {});
			const markCancelled = spyOn(backgroundTaskService, "markCancelled");
			backgroundTaskService.registerAbortController(target.id, controller);
			backgroundTaskService.registerKillHandler(target.id, kill);
			try {
				const executed = await stopTool.execute({ type: "bash", id: target.id }, ctx());
				expect(reads).toBe(3);
				expect(executed.isError).toBe(true);
				expect(executed.output).toContain(
					mutation === "policy"
						? "OAuth policy ceiling changed"
						: "Stop target authorization changed",
				);
				expect(cancel).toHaveBeenCalledTimes(1);
				expect(abort).not.toHaveBeenCalled();
				expect(controller.signal.aborted).toBe(false);
				expect(kill).not.toHaveBeenCalled();
				expect(markCancelled).not.toHaveBeenCalled();
				const unchanged = await originalGetById(target.id);
				expect(unchanged?.status).toBe("running");
			} finally {
				getById.mockRestore();
				abort.mockRestore();
				markCancelled.mockRestore();
				backgroundTaskService.unregisterAbortController(target.id, controller);
			}
		});
	}
	test("OAuth candidate tool set includes Stop while a device group remains accessible", async () => {
		const runtime = await assertOAuthNarratorRuntimeActive(ids.narrator, ids.user);
		expect(runtime?.allowedTools.has("Stop")).toBe(true);
	});
});
