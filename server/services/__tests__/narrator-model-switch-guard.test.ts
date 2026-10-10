import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import type { ActiveNarrator } from "../narrator-session-state";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));

const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const { settings } = await import("../../lib/settings");
const { getModelContextWindow, DEFAULT_CONTEXT_WINDOW } = await import(
	"../../lib/settings/provider"
);
const { activeNarrators } = await import("../narrator-session-state");
const { updateNarratorModel } = await import("../narrator-session");
const { MODEL_SWITCH_CONTEXT_WARN_RATIO, buildModelSwitchContextWarning } = await import(
	"../narrator-model-switch-guard"
);
const websocket = await import("../../websocket/narrator-ws");

const PROVIDER = "switchfixture";
const TIGHT_MODEL = `${PROVIDER}:tight`;
const ROOMY_MODEL = `${PROVIDER}:roomy`;
/** 两个模型都挂同一个小窗口：本用例只关心"占用 vs 窗口"的判定。 */
const FIXTURE_WINDOW = 50_000;
/**
 * 会话 cwd 指向仓库的 `.tmp`（存在、且没有任何 AGENTS.md / CLAUDE.md），
 * 这样系统提示不会把仓库指令算进来，占用完全由替身 provider 返回的历史决定。
 */
const FIXTURE_CWD = join(import.meta.dir, "..", "..", "..", ".tmp");

/**
 * 这份历史由替身 provider 直接返回，因此测试可以精确控制"重建后的历史有多大"，
 * 不必构造真实的工具输出。
 */
let historyPayload = "";
const adapter: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async () => ({
		history: [{ protocol: "switchfixture", text: historyPayload }],
		trailingToolResults: [],
	}),
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("This guard test must not contact a provider");
	},
	formatToolResult: () => ({}),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => {
		throw new Error("This guard test must not generate titles");
	},
	generateWithMeta: async () => {
		throw new Error("This guard test must not generate summaries");
	},
	generateWithHistory: async () => {
		throw new Error("This guard test must not generate history");
	},
};
const unregister = registerExternalProviderResolver((name) => (name === PROVIDER ? adapter : null));

let broadcasts: Array<Record<string, unknown>> = [];
let narratorSeq = 0;
const createdNarratorIds: string[] = [];

function insertNarrator(id: string, model: string) {
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({
			id,
			type: "primary",
			variant: "primary",
			model,
			cwd: FIXTURE_CWD,
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

function fixture(model: string) {
	narratorSeq += 1;
	const narratorId = `switch-guard-${narratorSeq}`;
	createdNarratorIds.push(narratorId);
	insertNarrator(narratorId, model);
	const active: ActiveNarrator = {
		narratorId,
		conversationId: `switch-guard-conversation-${narratorSeq}`,
		cwd: FIXTURE_CWD,
		model,
		provider: PROVIDER,
		systemPrompt: null,
		events: new EventEmitter(),
		alive: true,
		locale: "en",
		abortController: new AbortController(),
		_enabledOptionalTools: new Set(),
		_disabledTools: new Set(),
		_blockedSkills: { all: false, names: new Set() },
		_substatus: new Set(),
	};
	activeNarrators.set(narratorId, active);
	return { narratorId, active };
}

/**
 * 让替身返回一份"估算后达到窗口 ratio 倍"的历史。
 * estimateTokens 对 ASCII 记 0.5 token/字符，反推字符数并留出余量。
 */
function payloadForRatio(ratio: number) {
	const window = getModelContextWindow(TIGHT_MODEL, PROVIDER) ?? DEFAULT_CONTEXT_WINDOW;
	return "x".repeat(Math.ceil((window * ratio) / 0.5) + 1_000);
}

beforeEach(() => {
	mkdirSync(FIXTURE_CWD, { recursive: true });
	cleanDb(sqlite);
	historyPayload = "";
	broadcasts = [];
	narratorSeq = 0;
	createdNarratorIds.length = 0;
	// 小窗口只是"尽力而为"：一旦本机装了模型目录（modelCatalog），目录分支会排在
	// 逐模型覆盖之前，未知模型落到 DEFAULT_CONTEXT_WINDOW（272k）。所以下面所有
	// 尺寸都从 getModelContextWindow 的实际返回值反推，两种环境都能过。
	settings.agent.modelContextWindows = {
		...(settings.agent.modelContextWindows ?? {}),
		[TIGHT_MODEL]: FIXTURE_WINDOW,
		[ROOMY_MODEL]: FIXTURE_WINDOW,
	};
	spyOn(websocket, "broadcastToNarrator").mockImplementation((_id, event) => {
		broadcasts.push(event as unknown as Record<string, unknown>);
	});
});

afterEach(() => {
	for (const id of createdNarratorIds) activeNarrators.delete(id);
	mock.restore();
});

afterAll(() => {
	unregister();
	mock.module("../../db", () => realDb);
});

describe("buildModelSwitchContextWarning", () => {
	const base = {
		narratorId: "guard-unit",
		model: TIGHT_MODEL,
		provider: PROVIDER,
		contextWindow: 100_000,
	};

	test("低于阈值不告警（防误报）", () => {
		expect(buildModelSwitchContextWarning({ ...base, promptTokens: 1 })).toBeNull();
		expect(buildModelSwitchContextWarning({ ...base, promptTokens: 89_999 })).toBeNull();
	});

	test("达到阈值即告警，并带上可操作的数字", () => {
		const warning = buildModelSwitchContextWarning({ ...base, promptTokens: 90_000 });
		expect(warning).not.toBeNull();
		expect(warning?.percent).toBe(90);
		expect(warning?.promptTokens).toBe(90_000);
		expect(warning?.contextWindow).toBe(100_000);
		expect(warning?.message).toContain("90000");
		expect(warning?.message).toContain("100000");
	});

	test("已经超窗口时照样告警，占用率可以大于 100", () => {
		expect(buildModelSwitchContextWarning({ ...base, promptTokens: 150_000 })?.percent).toBe(150);
	});

	test("窗口未知或占用为 0 时不猜、不告警", () => {
		expect(
			buildModelSwitchContextWarning({ ...base, contextWindow: 0, promptTokens: 10 }),
		).toBeNull();
		expect(buildModelSwitchContextWarning({ ...base, promptTokens: 0 })).toBeNull();
		expect(
			buildModelSwitchContextWarning({ ...base, contextWindow: Number.NaN, promptTokens: 10 }),
		).toBeNull();
	});

	test("阈值常量本身就是判定线", () => {
		expect(MODEL_SWITCH_CONTEXT_WARN_RATIO).toBe(0.9);
	});
});

describe("updateNarratorModel context reassessment", () => {
	test("切到窗口更紧的模型：广播告警，且切换本身照常成功", async () => {
		const { narratorId, active } = fixture(ROOMY_MODEL);
		historyPayload = payloadForRatio(1.2);

		updateNarratorModel(narratorId, TIGHT_MODEL);

		// 同步路径已经完成切换并照常广播模型变更：重估是旁路，不阻塞也不改写结果。
		expect(active.model).toBe(TIGHT_MODEL);
		expect(active.provider).toBe(PROVIDER);
		expect(broadcasts.some((event) => event.type === "model_changed")).toBe(true);
		expect(broadcasts.some((event) => event.type === "model_settings_changed")).toBe(true);
		// 告警此刻还没发（异步旁路），但切换已经成功了——这正是"不阻断"的含义。
		expect(broadcasts.some((event) => event.type === "context_window_warning")).toBe(false);

		const pending = active._contextSwitchGuardPending;
		expect(pending).toBeDefined();
		await pending;

		const warning = broadcasts.find((event) => event.type === "context_window_warning");
		expect(warning).toBeDefined();
		expect(warning?.narratorId).toBe(narratorId);
		expect(warning?.model).toBe(TIGHT_MODEL);
		expect(warning?.provider).toBe(PROVIDER);
		expect(warning?.contextWindow).toBe(getModelContextWindow(TIGHT_MODEL, PROVIDER));
		expect(warning?.promptTokens as number).toBeGreaterThan(warning?.contextWindow as number);
		expect(warning?.percent as number).toBeGreaterThanOrEqual(90);
		// 切换后的模型没有被回退。
		expect(active.model).toBe(TIGHT_MODEL);
	});

	test("占用很小：切换成功但不告警（防误报）", async () => {
		const { narratorId, active } = fixture(ROOMY_MODEL);
		historyPayload = "small history";

		updateNarratorModel(narratorId, TIGHT_MODEL);
		await active._contextSwitchGuardPending;

		expect(active.model).toBe(TIGHT_MODEL);
		expect(broadcasts.some((event) => event.type === "model_changed")).toBe(true);
		expect(broadcasts.some((event) => event.type === "context_window_warning")).toBe(false);
	});

	test("重估失败不会影响切换本身", async () => {
		const { narratorId, active } = fixture(ROOMY_MODEL);
		// 库里的行被删掉：重估会在 getById 处失败，但模型已经切过去了。
		db.delete(narrators).run();

		updateNarratorModel(narratorId, TIGHT_MODEL);
		await active._contextSwitchGuardPending;

		expect(active.model).toBe(TIGHT_MODEL);
		expect(broadcasts.some((event) => event.type === "model_changed")).toBe(true);
		expect(broadcasts.some((event) => event.type === "context_window_warning")).toBe(false);
	});
});
