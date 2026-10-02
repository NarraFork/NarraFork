import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators, userPreferences, users } from "../../db/schema";
import {
	ensureNonEmptySchema,
	resolveToolJsonSchema,
	toolRegistry,
} from "../../lib/agent/tool-registry";
import type { AgentConfig, ToolContext } from "../../lib/agent/types";
import { settings } from "../../lib/settings";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { listNotificationChannels, sendUserNotification } = await import("../notification-service");
const { notificationTool, notificationParameters } = await import(
	"../../lib/agent/tools/notification"
);
const { executeTool } = await import("../../lib/agent/tool-executor");
const originalFetch = globalThis.fetch;
const now = "2026-10-02T00:00:00.000Z";
const context: ToolContext = {
	narratorId: "caller",
	cwd: ".",
	locale: "en",
	signal: new AbortController().signal,
	requestPermission: async () => ({ behavior: "allow" }),
};
const requests: Array<{ url: string; init?: RequestInit }> = [];

beforeEach(() => {
	requests.length = 0;
	globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
		requests.push({ url: String(url), init });
		return new Response(String(url).includes("ding") ? '{"errcode":0}' : '{"code":0}');
	}) as unknown as typeof fetch;
	db.insert(users)
		.values([
			{ id: "u1", username: "Alice", passwordHash: "private-hash", createdAt: now },
			{ id: "u2", username: "Alice-other", passwordHash: "private-hash2", createdAt: now },
		])
		.run();
	db.insert(narrators)
		.values({
			id: context.narratorId,
			permissionMode: "default",
			relaxedPlan: false,
			traits: [],
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(userPreferences)
		.values({
			id: "pref-u1",
			userId: "u1",
			createdAt: now,
			updatedAt: now,
			notifyOnDone: false,
			notifyOnWaiting: false,
			notifyDingtalkEnabled: true,
			notifyDingtalkWebhook: "https://ding.test/hook?token=private-token",
			notifyDingtalkSecret: "private-ding-secret",
			notifyFeishuEnabled: true,
			notifyFeishuWebhook: "https://feishu.test/hook/private-token",
			notifyFeishuSecret: "private-feishu-secret",
		})
		.run();
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	cleanDb(sqlite);
});
afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

describe("Notification service and tool", () => {
	it("advertises an object-root provider schema with required action and no dummy confirm", async () => {
		const rawSchema = notificationTool.rawJsonSchema;
		if (!rawSchema) throw new Error("Notification provider schema missing");
		const schema = resolveToolJsonSchema(notificationTool);
		expect(schema).toBe(rawSchema);
		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(["action"]);
		expect(schema.additionalProperties).toBe(false);
		const normalized = ensureNonEmptySchema(schema);
		expect(normalized).toBe(schema);
		expect(normalized.required).toEqual(["action"]);
		const properties = normalized.properties as Record<string, unknown>;
		expect(Object.keys(properties)).toEqual([
			"action",
			"user_id",
			"username",
			"title",
			"message",
			"channels",
		]);
		expect(properties).not.toHaveProperty("confirm");
		expect(properties.action).toMatchObject({ type: "string", enum: ["list_channels", "send"] });
		expect(properties.user_id).toMatchObject({ type: "string", minLength: 1, maxLength: 128 });
		expect(properties.username).toMatchObject({ type: "string", minLength: 1, maxLength: 128 });
		expect(properties.title).toMatchObject({ type: "string", minLength: 1, maxLength: 120 });
		expect(properties.message).toMatchObject({ type: "string", minLength: 1, maxLength: 4000 });
		expect(properties.channels).toMatchObject({
			type: "array",
			minItems: 1,
			maxItems: 2,
			items: { type: "string", enum: ["dingtalk", "feishu"] },
		});
		const args = { action: "list_channels", user_id: "u1" };
		expect(notificationParameters.safeParse(args).success).toBe(true);
		expect((await notificationTool.execute(args, context)).isError).not.toBe(true);
		expect(notificationParameters.safeParse({ ...args, confirm: true }).success).toBe(false);
		expect(requests).toHaveLength(0);
	});

	it("requires exactly one target and exact match; never lists users", async () => {
		for (const target of [{}, { user_id: "u1", username: "Alice" }, { user_id: "" }]) {
			expect(notificationParameters.safeParse({ action: "list_channels", ...target }).success).toBe(
				false,
			);
			await expect(listNotificationChannels(target)).rejects.toThrow();
		}
		for (const username of ["Ali", "alice", "%", "Alice%", "nonexistent"]) {
			await expect(listNotificationChannels({ username })).rejects.toThrow("User not found");
		}
		expect((await listNotificationChannels({ username: "Alice" })).user_id).toBe("u1");
		expect((await listNotificationChannels({ user_id: "u1" })).username).toBe("Alice");
	});

	it("selects only necessary public fields for channel lookup", async () => {
		const select = spyOn(db, "select");
		try {
			await listNotificationChannels({ user_id: "u1" });
			expect(Object.keys(select.mock.calls[0]?.[0] ?? {})).toEqual([
				"user_id",
				"username",
				"dingtalkEnabled",
				"dingtalkConfigured",
				"feishuEnabled",
				"feishuConfigured",
			]);
		} finally {
			select.mockRestore();
		}
	});

	it("lists only public identifiers and channel states without credentials", async () => {
		const result = await listNotificationChannels({ user_id: "u1" });
		expect(result).toEqual({
			user_id: "u1",
			username: "Alice",
			channels: [
				{ channel: "dingtalk", configured: true, enabled: true, available: true },
				{ channel: "feishu", configured: true, enabled: true, available: true },
			],
		});
		const output = JSON.stringify(result);
		for (const secret of ["private-", "webhook", "passwordHash", "notifyOnDone"])
			expect(output).not.toContain(secret);
		expect(requests).toHaveLength(0);
	});

	it("missing preferences expose no available channels and cannot send", async () => {
		const info = await listNotificationChannels({ user_id: "u2" });
		expect(
			info.channels.every(
				(channel) => !channel.available && !channel.configured && !channel.enabled,
			),
		).toBe(true);
		const result = await sendUserNotification(
			{ user_id: "u2", title: "Hi", message: "Hello" },
			context,
		);
		expect(result).toMatchObject({
			status: "not_sent",
			reason: "no_available_channels",
			results: [],
		});
		expect(requests).toHaveLength(0);
	});

	it("explicit send defaults to both available channels independently of automatic switches and recent tabs", async () => {
		const result = await sendUserNotification(
			{ username: "Alice", title: "Hi", message: "Hello" },
			context,
		);
		expect(result.status).toBe("success");
		expect(result.results).toHaveLength(2);
		expect(requests).toHaveLength(2);
		expect(
			requests.every((request) => request.init?.signal && request.init.redirect === "error"),
		).toBe(true);
	});

	it("deduplicates requested channels; unavailable selection is not redirected", async () => {
		await sendUserNotification(
			{ user_id: "u1", title: "Hi", message: "Hello", channels: ["dingtalk", "dingtalk"] },
			context,
		);
		expect(requests).toHaveLength(1);
		requests.length = 0;
		db.update(userPreferences)
			.set({ notifyDingtalkEnabled: false })
			.where(eq(userPreferences.userId, "u1"))
			.run();
		const result = await sendUserNotification(
			{ user_id: "u1", title: "Hi", message: "Hello", channels: ["dingtalk"] },
			context,
		);
		expect(result).toMatchObject({
			status: "not_sent",
			results: [{ channel: "dingtalk", status: "not_sent", reason: "disabled" }],
		});
		expect(requests).toHaveLength(0);
		db.update(userPreferences)
			.set({ notifyDingtalkWebhook: "" })
			.where(eq(userPreferences.userId, "u1"))
			.run();
		expect(
			(
				await sendUserNotification(
					{ user_id: "u1", title: "Hi", message: "Hello", channels: ["dingtalk"] },
					context,
				)
			).results[0]?.reason,
		).toBe("not_configured");
	});

	it("reports partial business failures and returns no upstream message or credentials", async () => {
		globalThis.fetch = mock(
			async (url: unknown) =>
				new Response(
					String(url).includes("ding")
						? '{"errcode":0}'
						: '{"code":100,"msg":"private-feishu-secret https://feishu.test"}',
				),
		) as unknown as typeof fetch;
		const result = await notificationTool.execute(
			{ action: "send", user_id: "u1", title: "Hi", message: "Hello" },
			context,
		);
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.output)).toMatchObject({
			status: "partial_failure",
			results: [
				{ channel: "dingtalk", status: "success" },
				{ channel: "feishu", status: "failed", reason: "business_error" },
			],
		});
		expect(result.output).not.toContain("private");
		expect(result.output).not.toContain("https://");
	});

	it("enforces lengths, channel count, action and strict fields before delivery", async () => {
		const base = { action: "send", user_id: "u1", title: "Hi", message: "Hello" };
		for (const invalid of [
			{ ...base, title: "a".repeat(121) },
			{ ...base, message: "a".repeat(4001) },
			{ ...base, title: " " },
			{ ...base, message: "" },
			{ ...base, channels: [] },
			{ ...base, channels: ["dingtalk", "feishu", "feishu"] },
			{ ...base, channels: ["email"] },
			{ ...base, webhook: "https://injected.test" },
			{ ...base, action: "list_users" },
		])
			expect((await notificationTool.execute(invalid, context)).isError).toBe(true);
		expect(
			notificationParameters.safeParse({
				...base,
				title: "a".repeat(120),
				message: "a".repeat(4000),
			}).success,
		).toBe(true);
		expect(requests).toHaveLength(0);
	});

	it("passes tool cancellation to delivery without sending or leaking identifiers", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await notificationTool.execute(
			{ action: "send", user_id: "u1", title: "Hi", message: "Hello" },
			{ ...context, signal: controller.signal },
		);
		expect(result.isError).toBe(true);
		expect(
			JSON.parse(result.output).results.every(
				(channel: { reason: string }) => channel.reason === "cancelled",
			),
		).toBe(true);
		expect(requests).toHaveLength(0);
	});
});

describe("Notification retry permission ceiling", () => {
	const sendInput = {
		action: "send",
		user_id: "u1",
		title: "Retry",
		message: "Explicitly approved retry",
		channels: ["dingtalk" as const],
	};

	function retryConfig(permissionHandler: AgentConfig["permissionHandler"]): AgentConfig {
		return {
			narratorId: context.narratorId,
			conversationId: "notification-retry",
			provider: "codex",
			model: "test",
			cwd: context.cwd,
			locale: "en",
			signal: new AbortController().signal,
			permissionHandler,
		};
	}

	it.each([
		{ permissionMode: "readOnly" as const, traits: [] },
		{ permissionMode: "default" as const, traits: ["plan"] },
	])("blocks pre-approved retries after switching to $permissionMode / $traits", async (mode) => {
		const permissionHandler = mock(async () => ({ behavior: "deny" as const }));
		const config = retryConfig(permissionHandler);
		toolRegistry.register(notificationTool);
		try {
			const toolUse = { name: "Notification", toolUseId: "notification-retry", input: sendInput };
			expect((await executeTool(toolUse, config)).isError).toBe(true);
			expect(permissionHandler).toHaveBeenCalledTimes(1);
			expect(requests).toHaveLength(0);

			db.update(narrators)
				.set({ ...mode, traits: [...mode.traits], relaxedPlan: false })
				.where(eq(narrators.id, context.narratorId))
				.run();
			for (const allowSend of [false, true]) {
				settings.agent.notificationPolicy = { allowSend };
				const result = await executeTool(toolUse, config, {
					preGrantedPermission: { behavior: "allow" },
				});
				expect(result.isError).toBe(true);
				expect(result.output).toContain("read-only or strict plan mode");
				expect(permissionHandler).toHaveBeenCalledTimes(1);
				expect(requests).toHaveLength(0);
			}
		} finally {
			toolRegistry.unregister("Notification");
		}
	});

	it("retains explicit retry approval in writable and relaxed-plan sessions", async () => {
		const permissionHandler = mock(async () => ({ behavior: "deny" as const }));
		toolRegistry.register(notificationTool);
		try {
			for (const mode of [
				{ permissionMode: "default" as const, traits: [], relaxedPlan: false },
				{ permissionMode: "default" as const, traits: ["plan"], relaxedPlan: true },
				{ permissionMode: "bypassPermissions" as const, traits: ["plan"], relaxedPlan: false },
			]) {
				db.update(narrators).set(mode).where(eq(narrators.id, context.narratorId)).run();
				requests.length = 0;
				const result = await executeTool(
					{ name: "Notification", toolUseId: "notification-approved-retry", input: sendInput },
					retryConfig(permissionHandler),
					{ preGrantedPermission: { behavior: "allow" } },
				);
				expect(result.isError).not.toBe(true);
				expect(requests).toHaveLength(1);
			}
			expect(permissionHandler).not.toHaveBeenCalled();
		} finally {
			toolRegistry.unregister("Notification");
		}
	});

	it("keeps channel queries available while direct sends fail closed", async () => {
		db.update(narrators)
			.set({ permissionMode: "readOnly" })
			.where(eq(narrators.id, context.narratorId))
			.run();
		expect(
			(await notificationTool.execute({ action: "list_channels", user_id: "u1" }, context)).isError,
		).not.toBe(true);
		await expect(sendUserNotification(sendInput, context)).rejects.toThrow(
			"read-only or strict plan mode",
		);
		db.delete(narrators).where(eq(narrators.id, context.narratorId)).run();
		expect((await notificationTool.execute(sendInput, context)).isError).toBe(true);
		expect(requests).toHaveLength(0);
	});
});
