import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	gatewaySessionMappings,
	narrators,
	userPreferences,
	userRecentTabs,
	userRecentTabsMeta,
	users,
} from "../../db/schema";
import type { InboundMessage, PlatformAdapter } from "../types";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../db", () => ({ db, sqlite }));
mock.module("../../websocket/narrator-ws", () => ({
	broadcastToUser: () => {},
	getNarratorPresenceBatch: () => new Map(),
}));

const { gateway } = await import("../gateway");
const NOW = "2026-07-19T00:00:00.000Z";

interface GatewayTestAccess {
	adapters: Map<string, PlatformAdapter>;
	notifyRecentTabStatusChange(
		narratorId: string,
		reason: "waiting_permission" | "done" | "error",
	): Promise<void>;
	handleListCommand(
		msg: InboundMessage,
		adapter: PlatformAdapter,
		locale: "en" | "zh-CN",
	): Promise<void>;
}

function createAdapter(sent: Array<{ chatId: string; text: string }>): PlatformAdapter {
	return {
		platform: "webhook",
		maxMessageLength: 10_000,
		supportsEdit: false,
		connect: async () => true,
		disconnect: async () => {},
		send: async (chatId, text) => {
			sent.push({ chatId, text });
		},
		sendAndGetId: async () => ({ success: true }),
		editMessage: async () => ({ success: true }),
		sendTyping: async () => {},
		onMessage: () => {},
	};
}

function seedRecentTab(input: {
	id: string;
	tabKey: string;
	type: "workspace" | "narrator" | "project";
	entityId: string;
	title: string;
	sortOrder: number;
	workspaceId?: string;
	representedNarratorId?: string;
}): void {
	db.insert(userRecentTabs)
		.values({
			id: input.id,
			userId: "gateway-user",
			tabKey: input.tabKey,
			section: input.type === "project" ? "projects" : "work",
			type: input.type,
			entityId: input.entityId,
			representedNarratorId: input.representedNarratorId ?? null,
			workspaceId: input.workspaceId ?? null,
			title: input.title,
			lastVisitedAt: 100 - input.sortOrder,
			sortOrder: input.sortOrder,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedFixture(): void {
	db.insert(users)
		.values({
			id: "gateway-user",
			username: "gateway-user",
			passwordHash: "test-password-hash",
			role: "user",
			createdAt: NOW,
		})
		.run();
	db.insert(userPreferences)
		.values({
			id: "gateway-pref",
			userId: "gateway-user",
			recentTabs: "[]",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(userRecentTabsMeta)
		.values({
			userId: "gateway-user",
			revision: 4,
			migratedAt: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(narrators)
		.values([
			{
				id: "gateway-target",
				title: "Target narrator",
				status: "working",
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: "gateway-current",
				title: "Current narrator",
				status: "idle",
				createdAt: NOW,
				updatedAt: NOW,
			},
		])
		.run();
	db.insert(gatewaySessionMappings)
		.values({
			id: "gateway-mapping",
			platform: "webhook",
			chatId: "chat-1",
			userId: "im-user",
			username: "IM User",
			narratorId: "gateway-current",
			appUserId: "gateway-user",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	seedRecentTab({
		id: "tab-workspace",
		tabKey: "workspace:workspace-1",
		type: "workspace",
		entityId: "workspace-1",
		title: "Workspace One",
		sortOrder: 0,
	});
	seedRecentTab({
		id: "tab-target",
		tabKey: "narrator:gateway-target",
		type: "narrator",
		entityId: "gateway-target",
		title: "Target narrator",
		sortOrder: 1,
		workspaceId: "workspace-1",
		representedNarratorId: "gateway-target",
	});
	seedRecentTab({
		id: "tab-project",
		tabKey: "project:project-1",
		type: "project",
		entityId: "project-1",
		title: "Project One",
		sortOrder: 2,
	});
}

afterEach(() => {
	(gateway as unknown as GatewayTestAccess).adapters.clear();
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

describe("gateway normalized recent-tabs consumers", () => {
	it("uses indexed membership for attention and authoritative ordering for /list", async () => {
		seedFixture();
		const sent: Array<{ chatId: string; text: string }> = [];
		const adapter = createAdapter(sent);
		const instance = gateway as unknown as GatewayTestAccess;
		instance.adapters.set("webhook", adapter);

		await instance.notifyRecentTabStatusChange("gateway-target", "done");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.text).toContain("Target narrator");

		sent.length = 0;
		await instance.handleListCommand(
			{
				platform: "webhook",
				chatId: "chat-1",
				userId: "im-user",
				username: "IM User",
				text: "/list",
			},
			adapter,
			"en",
		);

		expect(sent).toHaveLength(1);
		const output = sent[0]?.text ?? "";
		expect(output).toContain("Workspace One");
		expect(output).toContain("Target narrator (working)");
		expect(output).toContain("Project One");
		expect(output.indexOf("Workspace One")).toBeLessThan(output.indexOf("Target narrator"));
		expect(output.indexOf("Target narrator")).toBeLessThan(output.indexOf("Project One"));
	});
});
