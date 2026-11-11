import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import type { PersistedRecentTab, RecentTabsMutationResult } from "@shared/recent-tabs";
import { Hono } from "hono";
import { userPreferences, userRecentTabs, users } from "../../../server/db/schema";
import type { SessionPayload } from "../../../server/lib/auth";
import { updateUserPreferencesSchema } from "../../../server/lib/validators/settings";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../server/db")) };
const realSettingsModule = { ...(await import("../../../server/lib/settings")) };
const testSettings = {
	...realSettingsModule.settings,
	setupWizardCompleted: undefined as boolean | undefined,
};
const saveTestSettings = mock((next: typeof realSettingsModule.settings) => {
	Object.assign(testSettings, next);
});
mock.module("../../../server/lib/settings", () => ({
	...realSettingsModule,
	settings: testSettings,
	saveSettings: saveTestSettings,
}));
const realNarratorWsModule = { ...(await import("../../../server/websocket/narrator-ws")) };
mock.module("../../../server/db", () => ({ db, sqlite }));
mock.module("../../../server/websocket/narrator-ws", () => ({
	broadcastToUser: () => {},
	getNarratorPresenceBatch: () => new Map(),
}));

const { userPreferencesRoutes } = await import("../../../server/routes/user-preferences");

const authUser: SessionPayload = {
	sub: "user-1",
	role: "user",
	iat: 1735689600,
	exp: 1736294400,
};

const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", authUser);
	await next();
});
app.route("/", userPreferencesRoutes);

const NOW = "2026-07-19T00:00:00.000Z";

function tab(id: string, overrides: Partial<PersistedRecentTab> = {}): PersistedRecentTab {
	return {
		type: "narrator",
		id,
		title: `Tab ${id}`,
		lastVisitedAt: 100,
		...overrides,
	};
}

function seedUser(): void {
	db.insert(users)
		.values({
			id: "user-1",
			username: "user-1",
			passwordHash: "test-password-hash",
			role: "user",
			createdAt: NOW,
		})
		.run();
}

function seedPreferences(
	tabs: PersistedRecentTab[],
	overrides: Partial<typeof userPreferences.$inferInsert> = {},
): void {
	seedUser();
	db.insert(userPreferences)
		.values({
			id: "pref-user-1",
			userId: "user-1",
			recentTabs: JSON.stringify(tabs),
			createdAt: NOW,
			updatedAt: NOW,
			...overrides,
		})
		.run();
}

async function requestJson(
	path: string,
	init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
	const response = await app.request(path, init);
	return { status: response.status, body: await response.json() };
}

afterEach(() => {
	cleanDb(sqlite);
	authUser.sub = "user-1";
	authUser.role = "user";
	testSettings.setupWizardCompleted = undefined;
	saveTestSettings.mockClear();
});

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.module("../../../server/lib/settings", () => realSettingsModule);
	mock.module("../../../server/websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

describe("auxiliary content display preference", () => {
	async function patch(body: Record<string, unknown>) {
		return requestJson("/", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("defaults to compact display before and after an unrelated first save", async () => {
		seedUser();
		expect((await requestJson("/")).body).toMatchObject({ compactAuxiliaryContent: true });
		expect((await patch({ wordWrapCode: false })).status).toBe(200);
		expect((await requestJson("/")).body).toMatchObject({ compactAuxiliaryContent: true });
	});

	it("persists an explicit legacy choice on first save and across clients", async () => {
		seedUser();
		const saved = await patch({ compactAuxiliaryContent: false });
		expect(saved.status).toBe(200);
		expect(saved.body).toMatchObject({ compactAuxiliaryContent: false });
		// A separate request reads the account preference, not browser-local state.
		expect((await requestJson("/")).body).toMatchObject({ compactAuxiliaryContent: false });
		expect((await patch({ wordWrapCode: false })).status).toBe(200);
		expect((await requestJson("/")).body).toMatchObject({
			compactAuxiliaryContent: false,
			wordWrapCode: false,
		});
		expect((await patch({ compactAuxiliaryContent: true })).status).toBe(200);
		expect((await requestJson("/")).body).toMatchObject({ compactAuxiliaryContent: true });
	});

	it("updates existing preferences without changing another user's choice", async () => {
		seedPreferences([]);
		expect((await patch({ compactAuxiliaryContent: false })).status).toBe(200);
		db.insert(users)
			.values({
				id: "other-user",
				username: "other-user",
				passwordHash: "test",
				role: "user",
				createdAt: NOW,
			})
			.run();
		authUser.sub = "other-user";
		expect((await requestJson("/")).body).toMatchObject({ compactAuxiliaryContent: true });
		expect((await patch({ compactAuxiliaryContent: true })).status).toBe(200);
		authUser.sub = "user-1";
		expect((await requestJson("/")).body).toMatchObject({ compactAuxiliaryContent: false });
	});

	it("accepts only boolean choices", () => {
		for (const value of [true, false]) {
			expect(
				updateUserPreferencesSchema.safeParse({ compactAuxiliaryContent: value }).success,
			).toBe(true);
		}
		for (const value of ["false", 0, null, {}]) {
			expect(
				updateUserPreferencesSchema.safeParse({ compactAuxiliaryContent: value }).success,
			).toBe(false);
		}
	});
});

describe("local access preference", () => {
	async function patch(body: Record<string, unknown>) {
		return requestJson("/", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("defaults to false with and without a stored preferences row", async () => {
		seedUser();
		expect((await requestJson("/")).body).toMatchObject({ treatAsLocalAccess: false });
		const saved = await patch({ wordWrapCode: false });
		expect(saved.status).toBe(200);
		expect((await requestJson("/")).body).toMatchObject({ treatAsLocalAccess: false });
	});

	it("persists opt-in on first insert and preserves it across unrelated patches", async () => {
		seedUser();
		expect((await patch({ treatAsLocalAccess: true })).status).toBe(200);
		expect((await requestJson("/")).body).toMatchObject({ treatAsLocalAccess: true });
		expect((await patch({ wordWrapCode: false })).status).toBe(200);
		expect((await requestJson("/")).body).toMatchObject({
			treatAsLocalAccess: true,
			wordWrapCode: false,
		});
		expect((await patch({ treatAsLocalAccess: false })).status).toBe(200);
		expect((await requestJson("/")).body).toMatchObject({
			treatAsLocalAccess: false,
			wordWrapCode: false,
		});
	});

	it("updates existing preferences and keeps the override scoped to its user", async () => {
		seedPreferences([]);
		expect((await patch({ treatAsLocalAccess: true })).status).toBe(200);
		expect((await requestJson("/")).body).toMatchObject({ treatAsLocalAccess: true });
		db.insert(users)
			.values({
				id: "other-user",
				username: "other-user",
				passwordHash: "test",
				role: "user",
				createdAt: NOW,
			})
			.run();
		authUser.sub = "other-user";
		expect((await requestJson("/")).body).toMatchObject({ treatAsLocalAccess: false });
	});

	it("accepts only boolean opt-ins, not truthy strings or numbers", () => {
		for (const value of ["true", "false", 1, 0, null]) {
			expect(updateUserPreferencesSchema.safeParse({ treatAsLocalAccess: value }).success).toBe(
				false,
			);
		}
		for (const value of [true, false]) {
			expect(updateUserPreferencesSchema.safeParse({ treatAsLocalAccess: value }).success).toBe(
				true,
			);
		}
	});
});

describe("instance setup wizard completion", () => {
	async function patch(body: Record<string, unknown>) {
		return requestJson("/", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("migrates legacy completion for a newly promoted admin without preferences and survives deletion", async () => {
		seedPreferences([], { setupWizardCompleted: true });
		db.insert(users)
			.values({
				id: "new-admin",
				username: "new-admin",
				passwordHash: "test",
				role: "admin",
				createdAt: NOW,
			})
			.run();
		authUser.sub = "new-admin";
		authUser.role = "admin";
		expect(await requestJson("/")).toMatchObject({
			status: 200,
			body: { setupWizardCompleted: true },
		});
		expect(saveTestSettings).toHaveBeenCalledWith(
			expect.objectContaining({ setupWizardCompleted: true }),
		);
		sqlite.run("DELETE FROM user_preferences WHERE user_id = 'user-1'");
		sqlite.run("DELETE FROM users WHERE id = 'user-1'");
		expect(await patch({ language: "zh-CN" })).toMatchObject({
			status: 200,
			body: { setupWizardCompleted: true },
		});
		expect(await patch({ setupWizardCompleted: false })).toMatchObject({
			status: 200,
			body: { setupWizardCompleted: true },
		});
		expect(await requestJson("/")).toMatchObject({ body: { setupWizardCompleted: true } });
	});

	it("returns explicit false on a fresh instance with no preferences", async () => {
		seedUser();
		authUser.role = "admin";
		expect(await requestJson("/")).toMatchObject({
			status: 200,
			body: { setupWizardCompleted: false },
		});
		expect(await patch({ language: "zh-CN" })).toMatchObject({
			status: 200,
			body: { setupWizardCompleted: false },
		});
	});

	it("allows admin completion and ignores attempts to reset it", async () => {
		seedUser();
		authUser.role = "admin";
		expect(await patch({ setupWizardCompleted: true })).toMatchObject({
			status: 200,
			body: { setupWizardCompleted: true },
		});
		expect(testSettings.setupWizardCompleted).toBe(true);
		expect(await patch({ setupWizardCompleted: false })).toMatchObject({
			status: 200,
			body: { setupWizardCompleted: true },
		});
	});

	it("does not let ordinary preference writes complete setup, even after legacy migration is retried", async () => {
		seedUser();
		expect(await patch({ setupWizardCompleted: true })).toMatchObject({
			status: 200,
			body: { setupWizardCompleted: false },
		});
		expect(db.select().from(userPreferences).get()?.setupWizardCompleted).toBe(false);
		testSettings.setupWizardCompleted = undefined;
		authUser.role = "admin";
		expect(await requestJson("/")).toMatchObject({ body: { setupWizardCompleted: false } });
	});

	it("migrates legacy completion before PATCH false overwrites its only evidence", async () => {
		seedPreferences([], { setupWizardCompleted: true });
		authUser.role = "admin";
		expect(await patch({ setupWizardCompleted: false })).toMatchObject({
			status: 200,
			body: { setupWizardCompleted: true },
		});
		expect(testSettings.setupWizardCompleted).toBe(true);
	});
});

const storedSecrets = {
	notifyDingtalkWebhook: "https://example.com/dingtalk/123456",
	notifyDingtalkSecret: "dingtalk-secret-abcdef",
	notifyFeishuWebhook: "https://example.com/feishu/654321",
	notifyFeishuSecret: "feishu-secret-fedcba",
};

const storedGatewayConfig = {
	enabled: true,
	platforms: [
		{
			platform: "telegram" as const,
			enabled: true,
			token: "telegram-token-1111",
			botToken: "slack-bot-token-2222",
			appToken: "slack-app-token-3333",
			appSecret: "feishu-app-secret-4444",
			secret: "webhook-secret-5555",
			clientSecret: "qq-client-secret-6666",
			stt: {
				apiKey: "stt-api-key-7777",
				baseUrl: "https://stt.example.com",
				model: "whisper-test",
			},
			allowedUsers: ["user-1"],
		},
	],
};

function expectMaskedSecrets(preferences: Record<string, unknown>): void {
	expect(preferences.notifyDingtalkWebhook).toBe("********3456");
	expect(preferences.notifyDingtalkSecret).toBe("********cdef");
	expect(preferences.notifyFeishuWebhook).toBe("********4321");
	expect(preferences.notifyFeishuSecret).toBe("********dcba");

	const gatewayConfig = preferences.gatewayConfig as {
		platforms: Array<Record<string, unknown>>;
	};
	expect(gatewayConfig.platforms[0]).toMatchObject({
		platform: "telegram",
		enabled: true,
		token: "********1111",
		botToken: "********2222",
		appToken: "********3333",
		appSecret: "********4444",
		secret: "********5555",
		clientSecret: "********6666",
		stt: {
			apiKey: "********7777",
			baseUrl: "https://stt.example.com",
			model: "whisper-test",
		},
		allowedUsers: ["user-1"],
	});
}

describe("user preferences secret serialization", () => {
	it("safely serializes GET fields and masks nested gateway secrets", async () => {
		seedPreferences([], {
			...storedSecrets,
			commands: JSON.stringify([{ name: "hello", prompt: "Hello" }]),
			gatewayConfig: JSON.stringify(storedGatewayConfig),
			navLayout: JSON.stringify({ items: [{ id: "projects" }] }),
		});

		const { status, body } = await requestJson("/");
		expect(status).toBe(200);
		const preferences = body as Record<string, unknown>;
		expect(preferences.commands).toEqual([{ name: "hello", prompt: "Hello" }]);
		expect(preferences.navLayout).toEqual({ items: [{ id: "projects" }] });
		expectMaskedSecrets(preferences);

		const stored = db.select().from(userPreferences).get();
		expect(stored).toMatchObject(storedSecrets);
		expect(JSON.parse(stored?.gatewayConfig ?? "{}")).toEqual(storedGatewayConfig);
	});

	it("returns a masked PATCH response while keeping plaintext values in the database", async () => {
		seedPreferences([]);
		const { status, body } = await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...storedSecrets,
				commands: [{ name: "hello", prompt: "Hello" }],
				gatewayConfig: storedGatewayConfig,
				navLayout: { items: [{ id: "projects" }] },
			}),
		});

		expect(status).toBe(200);
		const preferences = body as Record<string, unknown>;
		expect(preferences.commands).toEqual([{ name: "hello", prompt: "Hello" }]);
		expect(preferences.navLayout).toEqual({ items: [{ id: "projects" }] });
		expectMaskedSecrets(preferences);

		const stored = db.select().from(userPreferences).get();
		expect(stored).toMatchObject(storedSecrets);
		expect(JSON.parse(stored?.gatewayConfig ?? "{}")).toEqual(storedGatewayConfig);
	});

	it("preserves existing plaintext secrets when masked values round-trip through PATCH", async () => {
		seedPreferences([], {
			...storedSecrets,
			gatewayConfig: JSON.stringify(storedGatewayConfig),
		});
		const getResult = await requestJson("/");
		const masked = getResult.body as Record<string, unknown>;

		const { status, body } = await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				notifyDingtalkWebhook: masked.notifyDingtalkWebhook,
				notifyDingtalkSecret: masked.notifyDingtalkSecret,
				notifyFeishuWebhook: masked.notifyFeishuWebhook,
				notifyFeishuSecret: masked.notifyFeishuSecret,
				gatewayConfig: masked.gatewayConfig,
			}),
		});

		expect(status).toBe(200);
		expectMaskedSecrets(body as Record<string, unknown>);
		const stored = db.select().from(userPreferences).get();
		expect(stored).toMatchObject(storedSecrets);
		expect(JSON.parse(stored?.gatewayConfig ?? "{}")).toEqual(storedGatewayConfig);
	});

	it("uses the latest stored secrets when a masked PATCH races with secret rotation", async () => {
		seedPreferences([], {
			...storedSecrets,
			gatewayConfig: JSON.stringify(storedGatewayConfig),
		});
		const getResult = await requestJson("/");
		const masked = getResult.body as Record<string, unknown>;
		const preferenceQuery = db.query.userPreferences;
		const originalFindFirst = preferenceQuery.findFirst.bind(preferenceQuery);
		let releaseStaleRead!: () => void;
		const staleReadReleased = new Promise<void>((resolve) => {
			releaseStaleRead = resolve;
		});
		let markStaleReadStarted!: () => void;
		const staleReadStarted = new Promise<void>((resolve) => {
			markStaleReadStarted = resolve;
		});
		let interceptNextRead = true;
		preferenceQuery.findFirst = (async (...args: Parameters<typeof originalFindFirst>) => {
			if (!interceptNextRead) return originalFindFirst(...args);
			interceptNextRead = false;
			const staleRow = await originalFindFirst(...args);
			markStaleReadStarted();
			await staleReadReleased;
			return staleRow;
		}) as typeof preferenceQuery.findFirst;

		try {
			const maskedPatch = requestJson("/", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ gatewayConfig: masked.gatewayConfig, language: "zh-CN" }),
			});
			await staleReadStarted;

			const rotatedGatewayConfig = structuredClone(storedGatewayConfig);
			rotatedGatewayConfig.platforms[0].clientSecret = "rotated-client-secret-8888";
			rotatedGatewayConfig.platforms[0].stt.apiKey = "rotated-stt-api-key-9999";
			const rotationPatch = requestJson("/", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ gatewayConfig: rotatedGatewayConfig }),
			});

			await new Promise((resolve) => setTimeout(resolve, 10));
			releaseStaleRead();
			const [maskedResult, rotationResult] = await Promise.all([maskedPatch, rotationPatch]);
			expect(maskedResult.status).toBe(200);
			expect(rotationResult.status).toBe(200);

			const stored = db.select().from(userPreferences).get();
			const gatewayConfig = JSON.parse(stored?.gatewayConfig ?? "{}") as typeof storedGatewayConfig;
			expect(gatewayConfig.platforms[0].clientSecret).toBe("rotated-client-secret-8888");
			expect(gatewayConfig.platforms[0].stt.apiKey).toBe("rotated-stt-api-key-9999");
		} finally {
			releaseStaleRead();
			preferenceQuery.findFirst = originalFindFirst as typeof preferenceQuery.findFirst;
		}
	});

	it("falls back safely for corrupted JSON in both GET and PATCH responses", async () => {
		seedPreferences([], {
			commands: "{broken",
			gatewayConfig: "{broken",
			navLayout: "{broken",
		});

		const getResult = await requestJson("/");
		expect(getResult.status).toBe(200);
		expect(getResult.body).toMatchObject({ commands: [], gatewayConfig: {}, navLayout: {} });

		const patchResult = await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ language: "zh-CN" }),
		});
		expect(patchResult.status).toBe(200);
		expect(patchResult.body).toMatchObject({
			language: "zh-CN",
			commands: [],
			gatewayConfig: {},
			navLayout: {},
		});
	});
});

/**
 * The upsert in PATCH / is one hand-written statement with a column list, a placeholder
 * count, an ON CONFLICT SET clause and TWO positional value arrays. A new column that
 * misses any of those four places fails silently: the request still returns 200 and the value
 * simply never changes, or worse lands in the neighbouring column.
 */
describe("recent tabs group mode preference", () => {
	it("persists the mode and returns it from GET", async () => {
		seedPreferences([]);

		const patchResult = await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ recentTabsGroupMode: "directory" }),
		});
		expect(patchResult.status).toBe(200);
		expect(patchResult.body).toMatchObject({ recentTabsGroupMode: "directory" });

		const getResult = await requestJson("/");
		expect(getResult.body).toMatchObject({ recentTabsGroupMode: "directory" });
	});

	it("defaults to flat so existing users keep the sortable list", async () => {
		seedPreferences([]);
		const { body } = await requestJson("/");
		expect(body).toMatchObject({ recentTabsGroupMode: "flat" });
	});

	/*
	 * `narrator_toolbar_layout` is the newest column threaded through that same
	 * hand-written upsert, so it is exposed to the four-place trap described above:
	 * column list, placeholder count, ON CONFLICT SET clause, and BOTH positional
	 * value arrays. Every failure mode is silent — a 200 with the value unchanged,
	 * or the value landing in the neighbouring column (`nav_layout`, which would
	 * scramble the sidebar instead).
	 */
	it("persists the narrator toolbar layout and returns it from GET", async () => {
		seedPreferences([]);
		const layout = { items: [{ id: "git" }, { id: "__divider__" }, { id: "details" }] };

		const patchResult = await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ narratorToolbarLayout: layout }),
		});
		expect(patchResult.status).toBe(200);
		expect(patchResult.body).toMatchObject({ narratorToolbarLayout: layout });

		const getResult = await requestJson("/");
		expect(getResult.body).toMatchObject({ narratorToolbarLayout: layout });
	});

	it("keeps the toolbar layout and the nav layout in separate columns", async () => {
		// A placeholder off by one would write one into the other; both are JSON
		// objects, so nothing would throw and the symptom would be a scrambled
		// sidebar after customizing the toolbar.
		seedPreferences([]);
		const navLayout = { items: [{ id: "projects" }] };
		const toolbarLayout = { items: [{ id: "search" }] };

		const { status, body } = await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ navLayout, narratorToolbarLayout: toolbarLayout }),
		});
		expect(status).toBe(200);
		expect(body).toMatchObject({ navLayout, narratorToolbarLayout: toolbarLayout });
	});

	it("leaves the stored toolbar layout alone when a PATCH omits it", async () => {
		seedPreferences([], {
			narratorToolbarLayout: JSON.stringify({ items: [{ id: "browser" }] }),
		});

		const { status, body } = await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ terminalFontSize: 18 }),
		});
		expect(status).toBe(200);
		expect(body).toMatchObject({
			terminalFontSize: 18,
			narratorToolbarLayout: { items: [{ id: "browser" }] },
		});
	});

	it("falls back to an empty object for a corrupted toolbar layout", async () => {
		seedPreferences([], { narratorToolbarLayout: "{broken" });
		const { status, body } = await requestJson("/");
		expect(status).toBe(200);
		expect(body).toMatchObject({ narratorToolbarLayout: {} });
	});

	it("leaves the stored mode alone when a PATCH omits it", async () => {
		// This is what COALESCE(?, recent_tabs_group_mode) buys; a misplaced positional
		// argument would show up here as the mode resetting on an unrelated settings change.
		seedPreferences([], { recentTabsGroupMode: "directory" });

		const patchResult = await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ terminalFontSize: 18 }),
		});
		expect(patchResult.status).toBe(200);
		expect(patchResult.body).toMatchObject({
			terminalFontSize: 18,
			recentTabsGroupMode: "directory",
		});
	});

	it("rejects an unknown mode instead of storing it", async () => {
		seedPreferences([], { recentTabsGroupMode: "flat" });
		// Asserted through a raw request: this test app mounts the routes without the
		// global AppError handler, so the rejection body is not JSON.
		const response = await app.request("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ recentTabsGroupMode: "by-project" }),
		});
		expect(response.status).not.toBe(200);

		const { body } = await requestJson("/");
		expect(body).toMatchObject({ recentTabsGroupMode: "flat" });
	});

	it("creates a row with the requested mode when none exists yet", async () => {
		// The INSERT branch has its own value array, separate from the UPDATE one.
		seedUser();
		const patchResult = await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ recentTabsGroupMode: "directory" }),
		});
		expect(patchResult.status).toBe(200);
		expect(patchResult.body).toMatchObject({ recentTabsGroupMode: "directory" });
	});
});

/**
 * The four typography columns are the worst case for the upsert described above: they are
 * ADJACENT and share one type (integer percent). A positional argument off by one does not
 * throw and does not fail validation — it silently writes the line-height value into the
 * paragraph column, so the user's "line height" slider moves their paragraph spacing.
 *
 * They also caught the other half of the same hazard: adding them to the column list without
 * updating the hand-written placeholder count produced `39 values for 43 columns`, failing
 * EVERY first preference write. The placeholder count is now derived from `INSERT_COLUMNS`,
 * and the distinct-values test below is what makes a future off-by-one visible.
 */
describe("narrator typography preferences", () => {
	it("gives each of the four columns its own distinct value", async () => {
		// Four different numbers: any pair of swapped positional arguments changes which
		// field reports which number, and no two are interchangeable.
		seedPreferences([]);

		const typography = {
			narratorFontScalePercent: 111,
			narratorLetterSpacingPercent: 7,
			narratorParagraphScalePercent: 133,
			narratorLineHeightV2Percent: 144,
		};
		const patchResult = await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(typography),
		});
		expect(patchResult.status).toBe(200);
		// The old-scale column carries the mirror (144 × 1.2), not a neighbour's value.
		expect(patchResult.body).toMatchObject({ ...typography, narratorLineHeightScalePercent: 173 });

		const getResult = await requestJson("/");
		expect(getResult.body).toMatchObject({ ...typography, narratorLineHeightScalePercent: 173 });
	});

	it("creates a row carrying all four values when none exists yet", async () => {
		// The INSERT branch — the one that used to fail outright on the placeholder count.
		seedUser();
		const typography = {
			narratorFontScalePercent: 90,
			narratorLetterSpacingPercent: -3,
			narratorParagraphScalePercent: 120,
			narratorLineHeightV2Percent: 80,
		};
		const patchResult = await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(typography),
		});
		expect(patchResult.status).toBe(200);
		expect(patchResult.body).toMatchObject(typography);
	});

	it("leaves the stored typography alone when a PATCH omits it", async () => {
		seedPreferences([], {
			narratorFontScalePercent: 125,
			narratorLetterSpacingPercent: 5,
			narratorParagraphScalePercent: 115,
			narratorLineHeightScalePercent: 162,
			narratorLineHeightV2Percent: 135,
		});

		const patchResult = await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ terminalFontSize: 18 }),
		});
		expect(patchResult.status).toBe(200);
		expect(patchResult.body).toMatchObject({
			terminalFontSize: 18,
			narratorFontScalePercent: 125,
			narratorLetterSpacingPercent: 5,
			narratorParagraphScalePercent: 115,
			narratorLineHeightScalePercent: 162,
			narratorLineHeightV2Percent: 135,
		});
	});

	it("rejects an out-of-range value instead of storing it", async () => {
		seedPreferences([], { narratorFontScalePercent: 100 });
		const response = await app.request("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ narratorFontScalePercent: 10_000 }),
		});
		expect(response.status).not.toBe(200);

		const { body } = await requestJson("/");
		expect(body).toMatchObject({ narratorFontScalePercent: 100 });
	});
});

/**
 * The line-height rescale (the old 120% is the new 100%, LINE_HEIGHT_BASELINE_PERCENT).
 *
 * The old column is never rewritten by the rescale: the new value is derived from it on
 * read until the reader saves on the new scale. So the rescale cannot run twice, a
 * downgrade still finds its own column, and a client built before the rescale (still
 * sending `narratorLineHeightScalePercent`) has its value converted on write.
 */
describe("narrator line height across the rescale", () => {
	const v2Of = async () =>
		((await requestJson("/")).body as { narratorLineHeightV2Percent: number })
			.narratorLineHeightV2Percent;

	it("reads the new default for a reader with no preferences row", async () => {
		seedUser();
		expect(await requestJson("/")).toMatchObject({
			status: 200,
			body: { narratorLineHeightV2Percent: 100, narratorLineHeightScalePercent: 100 },
		});
	});

	it("gives a row saved before the rescale at the old default the NEW (taller) default", async () => {
		// Every pre-rescale row carries 100 in the old column whether or not the reader ever
		// touched the slider (the INSERT writes the default); 100 is also what reset wrote.
		seedPreferences([], { narratorLineHeightScalePercent: 100 });
		expect(await v2Of()).toBe(100);
	});

	it("keeps the effective line height of every custom value saved on the old scale", async () => {
		for (const [legacy, expected] of [
			[120, 100], // the decision's own example: old 120% is the new 100%
			[150, 125],
			[110, 92],
			[75, 63], // the old floor still has a place on the new scale
			[220, 183], // and so does the old ceiling
		] as const) {
			cleanDb(sqlite);
			seedPreferences([], { narratorLineHeightScalePercent: legacy });
			expect(await v2Of()).toBe(expected);
		}
	});

	it("never rescales twice: reads and unrelated writes leave both columns as they were", async () => {
		seedPreferences([], { narratorLineHeightScalePercent: 150 });
		for (let i = 0; i < 3; i++) expect(await v2Of()).toBe(125);
		await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ terminalFontSize: 16 }),
		});
		expect(await v2Of()).toBe(125);
		const row = db.select().from(userPreferences).all()[0];
		expect(row?.narratorLineHeightScalePercent).toBe(150);
		expect(row?.narratorLineHeightV2Percent).toBeNull();
	});

	it("stores a new-scale value as given, mirrored onto the old column for a downgrade", async () => {
		seedPreferences([], { narratorLineHeightScalePercent: 150 });
		const { body } = await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ narratorLineHeightV2Percent: 92 }),
		});
		expect(body).toMatchObject({
			narratorLineHeightV2Percent: 92,
			narratorLineHeightScalePercent: 110,
		});
		// Once saved on the new scale, the old column no longer decides anything.
		expect(await v2Of()).toBe(92);
	});

	it("converts an old-scale value from a client built before the rescale", async () => {
		seedPreferences([], { narratorLineHeightV2Percent: 100 });
		const { body } = await requestJson("/", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ narratorLineHeightScalePercent: 130 }),
		});
		expect(body).toMatchObject({
			narratorLineHeightScalePercent: 130,
			narratorLineHeightV2Percent: 108,
		});
	});

	it("takes a change made by an older build after a downgrade (the old column is newer)", async () => {
		// The pair this build wrote: 92 on the new scale, its mirror 110 on the old one.
		seedPreferences([], { narratorLineHeightScalePercent: 110, narratorLineHeightV2Percent: 92 });
		expect(await v2Of()).toBe(92);
		// A build from before the rescale (a downgrade) changes the line height: it writes only
		// the old column. Back on this build, that newer choice is what the reader sees.
		db.update(userPreferences).set({ narratorLineHeightScalePercent: 130 }).run();
		expect(await v2Of()).toBe(108);
		// A reset there (old 100) reads as the new default.
		db.update(userPreferences).set({ narratorLineHeightScalePercent: 100 }).run();
		expect(await v2Of()).toBe(100);
		// Reading wrote nothing: the stale new-scale value is still stored.
		expect(db.select().from(userPreferences).all()[0]?.narratorLineHeightV2Percent).toBe(92);
	});

	it("keeps every pair this build writes, at the edges of both ranges too", async () => {
		const {
			legacyLineHeightPercentFrom,
			lineHeightPercentFromLegacy,
			lineHeightPercentFromStored: readLineHeightV2,
		} = await import("@shared/pretext-layout/typography");
		for (let v2 = 60; v2 <= 185; v2++) {
			expect(readLineHeightV2(v2, legacyLineHeightPercentFrom(v2))).toBe(v2);
		}
		for (let legacy = 75; legacy <= 220; legacy++) {
			const v2 = lineHeightPercentFromLegacy(legacy);
			expect(readLineHeightV2(v2, legacy)).toBe(v2);
		}
	});

	it("validates each field on its own scale", async () => {
		seedPreferences([]);
		for (const payload of [
			{ narratorLineHeightV2Percent: 59 },
			{ narratorLineHeightV2Percent: 186 },
			{ narratorLineHeightScalePercent: 74 },
			{ narratorLineHeightScalePercent: 221 },
		]) {
			const response = await app.request("/", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(response.status).not.toBe(200);
		}
		// 60 / 185 and 75 / 220 are the inclusive bounds.
		for (const payload of [
			{ narratorLineHeightV2Percent: 60 },
			{ narratorLineHeightV2Percent: 185 },
			{ narratorLineHeightScalePercent: 75 },
			{ narratorLineHeightScalePercent: 220 },
		]) {
			const response = await app.request("/", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(response.status).toBe(200);
		}
	});
});

describe("recent-tabs route contracts", () => {
	it("returns a mutation delta instead of the full tab collection", async () => {
		seedPreferences([]);
		const { status, body } = await requestJson("/recent-tabs", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(tab("n-1")),
		});

		expect(status).toBe(200);
		expect(Array.isArray(body)).toBe(false);
		expect(body).toMatchObject({
			changed: true,
			baseRevision: 0,
			revision: 1,
		});
		const result = body as RecentTabsMutationResult;
		expect(result.operations).toHaveLength(1);
		expect(result.operations[0]?.type).toBe("upsert");
		expect("tabs" in (body as Record<string, unknown>)).toBe(false);
	});

	it("batch-upserts tabs in one revision but never creates folders", async () => {
		seedPreferences([]);
		const { status, body } = await requestJson("/recent-tabs/batch", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				tabs: [tab("child-1", { folderId: "folder-1" }), tab("folder-1", { type: "folder" })],
			}),
		});

		expect(status).toBe(200);
		expect(body).toMatchObject({ changed: true, baseRevision: 0, revision: 1 });
		expect(
			db
				.select({ key: userRecentTabs.tabKey, folderId: userRecentTabs.folderId })
				.from(userRecentTabs)
				.orderBy(userRecentTabs.sortOrder)
				.all(),
		).toEqual([{ key: "narrator:child-1", folderId: null }]);
	});

	it("creates, edits and dissolves a folder through its routes", async () => {
		seedPreferences([tab("a"), tab("b"), tab("c")]);
		const created = await requestJson("/recent-tabs/folders", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ targetKey: "narrator:a", sourceKey: "narrator:c", title: "Work" }),
		});
		expect(created.status).toBe(200);
		const folderId = (created.body as { folderId: string }).folderId;
		expect(folderId).toBeString();

		const edited = await requestJson(`/recent-tabs/folders/${folderId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ icon: "rocket", color: "teal", previewCount: 1 }),
		});
		expect(edited.status).toBe(200);
		const moved = await requestJson("/recent-tabs/move", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "narrator:b", folderId }),
		});
		expect(moved.status).toBe(200);
		expect(
			db
				.select({ key: userRecentTabs.tabKey, folderId: userRecentTabs.folderId })
				.from(userRecentTabs)
				.orderBy(userRecentTabs.sortOrder)
				.all(),
		).toEqual([
			{ key: `folder:${folderId}`, folderId: null },
			{ key: "narrator:a", folderId },
			{ key: "narrator:c", folderId },
			{ key: "narrator:b", folderId },
		]);

		const dissolved = await requestJson(`/recent-tabs/folders/${folderId}/dissolve`, {
			method: "POST",
		});
		expect(dissolved.status).toBe(200);
		expect(
			db
				.select({ key: userRecentTabs.tabKey })
				.from(userRecentTabs)
				.orderBy(userRecentTabs.sortOrder)
				.all()
				.map((row) => row.key),
		).toEqual(["narrator:a", "narrator:c", "narrator:b"]);
	});

	it("supports section pagination and key-relative moves", async () => {
		seedPreferences([tab("n-1"), tab("n-2"), tab("p-1", { type: "project" })]);

		const first = await requestJson("/recent-tabs?section=work&limit=1");
		expect(first.status).toBe(200);
		expect(first.body).toMatchObject({ hasMore: true, revision: 0 });
		const firstPage = first.body as {
			items: PersistedRecentTab[];
			nextCursor: string | null;
		};
		expect(firstPage.items.map((item) => item.id)).toEqual(["n-1"]);

		const second = await requestJson(
			`/recent-tabs?section=work&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
		);
		expect((second.body as { items: PersistedRecentTab[] }).items.map((item) => item.id)).toEqual([
			"n-2",
		]);

		const moved = await requestJson("/recent-tabs/move", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: "narrator:n-2", beforeKey: "narrator:n-1" }),
		});
		expect(moved.status).toBe(200);
		expect(moved.body).toMatchObject({ changed: true, revision: 1 });
		const stored = db
			.select({ key: userRecentTabs.tabKey })
			.from(userRecentTabs)
			.orderBy(userRecentTabs.sortOrder)
			.all();
		expect(stored.map((row) => row.key)).toEqual(["narrator:n-2", "narrator:n-1", "project:p-1"]);
	});

	it("keeps GET /user-preferences compatible with at most 20 enriched legacy tabs", async () => {
		seedPreferences(Array.from({ length: 30 }, (_, index) => tab(`n-${index}`)));

		const { status, body } = await requestJson("/");
		expect(status).toBe(200);
		const preferences = body as { recentTabs: PersistedRecentTab[] };
		expect(preferences.recentTabs).toHaveLength(20);
		expect(preferences.recentTabs[0]?.id).toBe("n-0");

		const shadow = db.select().from(userPreferences).get();
		expect(JSON.parse(shadow?.recentTabs ?? "[]")).toHaveLength(20);
		expect(db.select().from(userRecentTabs).all()).toHaveLength(30);
	});

	it("accepts restore by undo token", async () => {
		seedPreferences([tab("n-1"), tab("n-2")]);
		const cleared = await requestJson("/recent-tabs/clear", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ scope: "all" }),
		});
		const token = (cleared.body as RecentTabsMutationResult).undoToken;
		expect(token).toBeString();

		const restored = await requestJson("/recent-tabs/restore", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
		});
		expect(restored.status).toBe(200);
		expect(restored.body).toMatchObject({ changed: true, revision: 2 });
		expect(db.select().from(userRecentTabs).all()).toHaveLength(2);
	});

	it("mints an undo token for a user-initiated single-tab DELETE and restores it", async () => {
		seedPreferences([tab("n-1"), tab("n-2")]);
		const removed = await requestJson("/recent-tabs/narrator/n-1", { method: "DELETE" });
		expect(removed.status).toBe(200);
		const token = (removed.body as RecentTabsMutationResult).undoToken;
		expect(token).toBeString();
		expect(db.select().from(userRecentTabs).all()).toHaveLength(1);

		const restored = await requestJson("/recent-tabs/restore", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
		});
		expect(restored.status).toBe(200);
		expect(db.select().from(userRecentTabs).all()).toHaveLength(2);
	});

	it("mints no undo token for a cascade DELETE", async () => {
		seedPreferences([tab("n-1"), tab("n-2")]);
		const removed = await requestJson("/recent-tabs/narrator/n-1?cascade=1", { method: "DELETE" });
		expect(removed.status).toBe(200);
		expect((removed.body as RecentTabsMutationResult).undoToken).toBeUndefined();
		expect(db.select().from(userRecentTabs).all()).toHaveLength(1);
	});
});
