import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { cleanDb } from "../../../tests/setup";
import {
	gatewaySessionMappings,
	narrators,
	userPreferences,
	userRecentTabs,
	userRecentTabsMeta,
	users,
} from "../../db/schema";
import {
	closeRuntimeTestDb,
	drainRuntimeTestWork,
	getRuntimeTestDb,
} from "../../services/__tests__/agent-runtime-test-database";
import type { InboundMessage, PlatformAdapter } from "../types";

const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
const realDbModule = { ...(await import("../../db")) };
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../db", () => ({ db, sqlite }));
mock.module("../../websocket/narrator-ws", () => ({
	broadcastToUser: () => {},
	getNarratorPresenceBatch: () => new Map(),
}));

const { gateway } = await import("../gateway");
const { eventBus } = await import("../../lib/event-bus");
const NOW = "2026-07-19T00:00:00.000Z";

interface GatewayTestAccess {
	adapters: Map<string, PlatformAdapter>;
	pendingWork: Set<Promise<void>>;
	subscribeToEvents(): void;
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
	type: "workspace" | "narrator" | "project" | "team";
	entityId: string;
	title: string;
	sortOrder: number;
	workspaceId?: string;
	representedNarratorId?: string;
	pinned?: boolean;
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
			pinned: input.pinned ?? false,
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
	// A pinned project row of the retired `projects` section: it joins the list (an unpinned
	// one would be dropped by the one-time conversion).
	seedRecentTab({
		id: "tab-project",
		tabKey: "project:project-1",
		type: "project",
		entityId: "project-1",
		title: "Project One",
		sortOrder: 2,
		pinned: true,
	});
}

/** A pinned team tab: what a team tab looks like in the store (no represented narrator). */
function seedTeamTab(): void {
	seedRecentTab({
		id: "tab-team",
		tabKey: "team:team-coordinator",
		type: "team",
		entityId: "team-coordinator",
		title: "Secret team",
		sortOrder: 3,
		pinned: true,
	});
}

function listMessage(): InboundMessage {
	return {
		platform: "webhook",
		chatId: "chat-1",
		userId: "im-user",
		username: "IM User",
		text: "/list",
	};
}

async function drainGatewayWork(): Promise<void> {
	const { pendingWork } = gateway as unknown as GatewayTestAccess;
	while (pendingWork.size) await Promise.all([...pendingWork]);
}

afterEach(async () => {
	await drainGatewayWork();
	await drainRuntimeTestWork();
	(gateway as unknown as GatewayTestAccess).adapters.clear();
	cleanDb(sqlite);
});

afterAll(async () => {
	await gateway.stop();
	await closeRuntimeTestDb(sqlite);
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
		// Pinned, the project leads the list (the folder conversion regroups pinned units first).
		expect(output.indexOf("Project One")).toBeLessThan(output.indexOf("Workspace One"));
		expect(output.indexOf("Workspace One")).toBeLessThan(output.indexOf("Target narrator"));
	});

	it("never lists a team tab in /list, not even by name", async () => {
		seedFixture();
		seedTeamTab();
		const sent: Array<{ chatId: string; text: string }> = [];
		const adapter = createAdapter(sent);
		const instance = gateway as unknown as GatewayTestAccess;
		instance.adapters.set("webhook", adapter);

		await instance.handleListCommand(listMessage(), adapter, "en");
		expect(sent).toHaveLength(1);
		const output = sent[0]?.text ?? "";
		expect(output).toContain("Target narrator (working)");
		expect(output).toContain("Project One");
		expect(output).not.toContain("Secret team");
		expect(output).not.toContain("team-coordinator");
		expect(output).not.toContain("👥");
	});

	it("answers 'no recent tabs' when the only tab is a team", async () => {
		seedFixture();
		db.delete(userRecentTabs).run();
		seedTeamTab();
		const sent: Array<{ chatId: string; text: string }> = [];
		const adapter = createAdapter(sent);
		const instance = gateway as unknown as GatewayTestAccess;
		instance.adapters.set("webhook", adapter);

		await instance.handleListCommand(listMessage(), adapter, "en");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.text).not.toContain("Secret team");
		expect(sent[0]?.text).not.toContain("[1]");
	});

	it("suppresses the recent-tab IM ping when the done event carries backgroundWorkActive", async () => {
		seedFixture();
		const sent: Array<{ chatId: string; text: string }> = [];
		const instance = gateway as unknown as GatewayTestAccess;
		instance.adapters.set("webhook", createAdapter(sent));
		// The attention listener is registered from start() in production; the test
		// gateway is never started, so register it explicitly.
		instance.subscribeToEvents();

		eventBus.emit({
			type: "narrator:attention",
			narratorId: "gateway-target",
			reason: "done",
			backgroundWorkActive: true,
		});
		await drainGatewayWork();
		expect(sent).toHaveLength(0);

		// The unflagged done (e.g. the wake-up turn after the last background task)
		// still pings exactly as before.
		eventBus.emit({ type: "narrator:attention", narratorId: "gateway-target", reason: "done" });
		await drainGatewayWork();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.text).toContain("Target narrator");
	});
});
