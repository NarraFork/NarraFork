import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolveRuntimePolicy } from "@server/services/agent-runtime/policy";
import { toolRegistry, zodToJsonSchema } from "../../tool-registry";
import type { ToolContext } from "../../types";

const calls: Array<Record<string, unknown>> = [];
const frames: unknown[] = [];
const sends: Array<Record<string, unknown>> = [];
let dispatchFailure: string | undefined;
const target = {
	id: "peer",
	title: "Peer",
	status: "working",
	deliveryMessageId: "delivery",
	injectionId: "injection",
	injectionStatus: "pending" as const,
};
let failure: string | undefined;
const realPeer = { ...(await import("@server/services/narrator-peer-communication")) };
const realResolution = { ...(await import("@server/services/send-delivery-resolution")) };
const realSession = { ...(await import("@server/services/narrator-session")) };
mock.module("@server/services/narrator-peer-communication", () => ({
	...realPeer,
	listPeerNarrators: async (input: Record<string, unknown>) => {
		calls.push(input);
		if (failure) throw new Error(failure);
		return {
			narrators: [{ id: "peer", title: "Peer", handle: "peer", status: "working", canSend: true }],
			nextCursor: "next",
		};
	},
	authorizePeerNarratorMessage: async (input: Record<string, unknown>) => {
		calls.push(input);
		if (failure) throw new Error(failure);
		return {
			kind: "agent",
			narratorId: input.id,
			message: input.message,
			sender: { id: input.callerNarratorId, label: "Primary", title: "Primary", isParent: false },
			userId: input.userId,
			toolUseId: input.toolUseId,
			toolCallBinding: input.toolCallBinding,
			signal: input.signal,
		};
	},
}));
mock.module("@server/services/narrator-session", () => ({
	...realSession,
	sendMessage: async (input: Record<string, unknown>) => {
		sends.push(input);
		if (dispatchFailure) throw new Error(dispatchFailure);
		return { accepted: true, target, duplicate: true, wakeError: "queued; wake unavailable" };
	},
}));
mock.module("@server/services/send-delivery-resolution", () => ({
	...realResolution,
	broadcastSendDeliveryResolved: async (...args: unknown[]) => {
		frames.push(args);
	},
}));
const { narratorListTool } = await import("../narrator-list");
const { narratorSendTool } = await import("../narrator-send");
const { OPTIONAL_TOOLS } = await import("../index");
const { resolvePermissionDecision } = await import("@server/services/narrator-permission");
const binding = { toolCallId: "call", attempt: 1 };
const ctx = {
	narratorId: "primary",
	userId: "actor",
	currentToolUseId: "send-id",
	toolCallBinding: binding,
	signal: new AbortController().signal,
	locale: "en",
	runtimePolicy: resolveRuntimePolicy({ variant: "primary" }),
} as ToolContext;

beforeEach(() => {
	calls.length = 0;
	frames.length = 0;
	sends.length = 0;
	failure = undefined;
	dispatchFailure = undefined;
});
afterAll(() => {
	mock.module("@server/services/narrator-peer-communication", () => realPeer);
	mock.module("@server/services/send-delivery-resolution", () => realResolution);
	mock.module("@server/services/narrator-session", () => realSession);
});

describe("ordinary peer tools", () => {
	test("registered core schemas expose only discovery and single-target asynchronous sending", () => {
		expect(toolRegistry.get("NarratorList")).toBe(narratorListTool);
		expect(toolRegistry.get("NarratorSend")).toBe(narratorSendTool);
		expect(OPTIONAL_TOOLS.has("NarratorList")).toBe(false);
		expect(OPTIONAL_TOOLS.has("NarratorSend")).toBe(false);
		expect(Object.keys(zodToJsonSchema(narratorListTool.parameters).properties as object)).toEqual([
			"query",
			"limit",
			"cursor",
		]);
		expect(Object.keys(zodToJsonSchema(narratorSendTool.parameters).properties as object)).toEqual([
			"id",
			"message",
		]);
	});
	test("discovery passes only server-resolved caller identity and returns safe projection", async () => {
		const result = await narratorListTool.execute(
			{ query: " peer ", limit: 4, cursor: "cursor" },
			ctx,
		);
		expect(result.isError).not.toBe(true);
		expect(calls[0]).toMatchObject({
			callerNarratorId: "primary",
			userId: "actor",
			query: "peer",
			limit: 4,
			cursor: "cursor",
			runtimePolicy: ctx.runtimePolicy,
		});
		expect(JSON.parse(result.output)).toMatchObject({
			nextCursor: "next",
			narrators: [{ id: "peer", canSend: true }],
		});
	});
	test("sending preserves durable coordinates, duplicate fact and wake failure without claiming a reply", async () => {
		const result = await narratorSendTool.execute({ id: "peer", message: "hello" }, ctx);
		expect(result.isError).not.toBe(true);
		expect(calls[0]).toMatchObject({
			callerNarratorId: "primary",
			userId: "actor",
			toolCallBinding: binding,
			toolUseId: "send-id",
			id: "peer",
			message: "hello",
			signal: ctx.signal,
		});
		expect(result.metadata).toMatchObject({
			kind: "send",
			targets: [target],
			targetCount: 1,
			await: false,
			doInterrupt: false,
			duplicate: true,
			wakeError: "queued; wake unavailable",
		});
		expect(sends).toHaveLength(1);
		expect(sends[0]).toMatchObject({
			kind: "agent",
			narratorId: "peer",
			message: "hello",
			sender: { id: "primary", isParent: false },
			userId: "actor",
			toolUseId: "send-id",
			toolCallBinding: binding,
			signal: ctx.signal,
		});
		expect(JSON.parse(result.output).accepted).toBe(true);
		expect(frames).toEqual([["primary", "send-id", [target], binding, 1]]);
	});
	test("ordinary forks are primary even with a parent reference", async () => {
		const fork = { ...ctx, parentNarratorId: "fork-origin" };
		expect((await narratorListTool.execute({}, fork)).isError).not.toBe(true);
		expect(
			(await narratorSendTool.execute({ id: "peer", message: "hello" }, fork)).isError,
		).not.toBe(true);
	});
	for (const subagentType of ["general", "explore", "plan", "review", "search", "custom"]) {
		test(`${subagentType} cannot escape through explicit custom peer tool allowlist`, async () => {
			const child = {
				...ctx,
				runtimePolicy: resolveRuntimePolicy({
					variant: "subagent",
					subagentType,
					customDefinition: { toolAccess: "custom", customTools: ["NarratorList", "NarratorSend"] },
				}),
			};
			expect((await narratorListTool.execute({}, child)).isError).toBe(true);
			expect(
				(await narratorSendTool.execute({ id: "peer", message: "hello" }, child)).isError,
			).toBe(true);
			expect(calls).toHaveLength(0);
		});
	}
	test("read-only primary can discover but cannot send", async () => {
		const readOnly = {
			...ctx,
			runtimePolicy: resolveRuntimePolicy({ variant: "primary", readOnly: true }),
		};
		expect((await narratorListTool.execute({}, readOnly)).isError).not.toBe(true);
		expect(
			(await narratorSendTool.execute({ id: "peer", message: "hello" }, readOnly)).isError,
		).toBe(true);
		expect(calls).toHaveLength(1);
	});
	for (const args of [
		{ id: "peer", message: " " },
		{ id: "", message: "hi" },
		{ id: "peer", message: "界".repeat(90_000) },
		{ id: "peer", message: "hello", userId: "admin" },
		{ id: "peer", message: "hello", sender: "admin" },
		{ id: "peer", message: "hello", await: true },
		{ id: "peer", message: "hello", replyTo: "receipt" },
	]) {
		test(`invalid or forged sending fields are rejected: ${Object.keys(args).join(",")}`, async () => {
			expect((await narratorSendTool.execute(args, ctx)).isError).toBe(true);
			expect(calls).toHaveLength(0);
		});
	}
	for (const args of [
		{ limit: 0 },
		{ limit: 101 },
		{ limit: 1.5 },
		{ query: "x".repeat(257) },
		{ cursor: "" },
		{ userId: "admin" },
	]) {
		test(`invalid discovery fields are rejected: ${JSON.stringify(args)}`, async () => {
			expect((await narratorListTool.execute(args, ctx)).isError).toBe(true);
			expect(calls).toHaveLength(0);
		});
	}
	test("sending without bound execution fails before service effects", async () => {
		for (const missing of [{ currentToolUseId: undefined }, { toolCallBinding: undefined }]) {
			expect(
				(await narratorSendTool.execute({ id: "peer", message: "hello" }, { ...ctx, ...missing }))
					.isError,
			).toBe(true);
		}
		expect(calls).toHaveLength(0);
	});
	test("authorization rejection does not manufacture a delivery event", async () => {
		failure = "Peer unavailable";
		const result = await narratorSendTool.execute({ id: "peer", message: "hello" }, ctx);
		expect(result).toEqual({ output: "NarratorSend error: Peer unavailable", isError: true });
		expect(sends).toHaveLength(0);
		expect(frames).toHaveLength(0);
	});
	test("shared admission rejection produces no accepted navigation event", async () => {
		dispatchFailure = "Inbox full";
		const result = await narratorSendTool.execute({ id: "peer", message: "hello" }, ctx);
		expect(result).toEqual({ output: "NarratorSend error: Inbox full", isError: true });
		expect(sends).toHaveLength(1);
		expect(frames).toHaveLength(0);
	});
});

describe("peer side-effect approval boundary", () => {
	const decision = (toolName: string, permMode: string, planMode = false, relaxedPlan = false) =>
		resolvePermissionDecision({
			toolName,
			input: { id: "peer", message: "hello" },
			cwd: "/fixture",
			permMode,
			planMode,
			relaxedPlan,
		});
	for (const mode of ["default", "acceptEdits", "delegate"])
		test(`${mode} asks before sending`, () => expect(decision("NarratorSend", mode)).toBe("ask"));
	test("bypass can approve a send but not its plan/read-only ceiling", () => {
		expect(decision("NarratorSend", "bypassPermissions")).toBe("allow");
		expect(decision("NarratorSend", "bypassPermissions", true, true)).toBe("deny");
		expect(decision("NarratorSend", "bypassPermissions", true, false)).toBe("deny");
		expect(decision("NarratorSend", "readOnly")).toBe("deny");
		expect(decision("NarratorSend", "dontAsk")).toBe("deny");
	});
	test("discovery is read-only, including plan mode", () => {
		expect(decision("NarratorList", "readOnly")).toBe("allow");
		expect(decision("NarratorList", "default", true)).toBe("allow");
	});
});
