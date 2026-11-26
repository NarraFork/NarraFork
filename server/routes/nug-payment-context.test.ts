import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { isNugPaymentContext, type NugPaymentIntent } from "@shared/nug-payment";
import { Hono } from "hono";
import { seedUnifiedCredentials } from "../../tests/unified-credentials";
import { sqlite } from "../db";
import { agentLoop } from "../lib/agent/loop";
import { PooledProvider, resetProviderKeyRuntimeForTests } from "../lib/agent/pooled-provider";
import { resolveProviderAndModel } from "../lib/agent/provider";
import type { AgentEvent } from "../lib/agent/types";
import { AppError } from "../lib/errors";
import { getNarraforkHome } from "../lib/narrafork-home";
import { deleteNugCachedModels, setNugCachedModels } from "../lib/nug-model-cache";
import {
	captureNugPaymentRequest,
	NUG_PAYMENT_CONTEXT_TTL_MS,
	resolveNugPaymentContext,
} from "../lib/nug-payment-context";
import { purgeNugQuotaCache } from "../lib/nug-quota-cache";
import { streamQuotaIdentityForRequest } from "../lib/provider-key-subjects";
import { getProviderKeyStore, nugKeyOwner, type ProviderKey } from "../lib/provider-keys";
import { saveSettings, settings } from "../lib/settings";
import { nugRoutes } from "./nug";

seedUnifiedCredentials();
const SOURCE = "payment-context-nug";
const PREFIX = "payment-context";
const NARRATOR = "payment-context-narrator";
const SECOND_NARRATOR = "payment-context-another-narrator";
const OWNER = "payment-context-owner";
const A = "failed-inference-account-A-secret";
const B = "failed-inference-account-B-secret";
const MODEL = `${PREFIX}:openai:m`;
const saved = structuredClone(settings);
const store = getProviderKeyStore();
let first: ProviderKey;
let second: ProviderKey;
let calls: Array<{ path: string; auth: string }>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let gate: ((request: Request) => Response | Promise<Response>) | undefined;

function responseFor(request: Request): Response {
	const path = new URL(request.url).pathname;
	if (path.endsWith("/chat/completions")) {
		return request.headers.get("Authorization") === `Bearer ${A}`
			? Response.json({ error: { message: "forbidden" } }, { status: 403 })
			: Response.json(
					{ error: { message: "insufficient_quota", balance: 0, required: 5 } },
					{ status: 402 },
				);
	}
	if (path.endsWith("/billing/config"))
		return Response.json({
			enabled: true,
			providers: [{ name: "mockpay", displayName: "Mock" }],
			unitName: "credits",
			quotaRate: 1,
			orderMinAmount: 1,
			orderMaxAmount: 100,
			balance: 0,
			totalGranted: 10,
		});
	if (path.endsWith("/quota")) return Response.json({ balance: 20, totalGranted: 30 });
	if (path.includes("/billing/orders"))
		return Response.json({
			order: {
				id: "context-order",
				amount: "10",
				quota_amount: "10",
				provider: "mockpay",
				status: "pending",
				pay_url: "https://pay.example/qr",
				created_at: "2026-11-25",
			},
		});
	throw new Error(`意外请求：${path}`);
}
function app(owner = OWNER) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		const user = { sub: owner, role: "user" as const, iat: 0, exp: Number.MAX_SAFE_INTEGER };
		c.set("auth", { type: "session", user });
		c.set("user", user);
		await next();
	});
	app.onError((error) =>
		Response.json(
			{ error: error.message, ...(error instanceof AppError ? { code: error.code } : {}) },
			{ status: error instanceof AppError ? error.statusCode : 500 },
		),
	);
	return app.route("/api/nug", nugRoutes);
}
function config(intent: NugPaymentIntent, owner = OWNER, source = SOURCE) {
	const query = new URLSearchParams(
		intent.mode === "request"
			? { mode: intent.mode, narratorId: intent.narratorId, paymentContext: intent.paymentContext }
			: { mode: intent.mode },
	);
	return app(owner).request(`/api/nug/providers/${source}/billing/config?${query}`);
}
function create(intent: unknown, owner = OWNER, source = SOURCE) {
	return app(owner).request(`/api/nug/providers/${source}/billing/orders`, {
		method: "POST",
		body: JSON.stringify({ amount: 10, provider: "mockpay", intent }),
	});
}
function captureContext(): string {
	const issue = captureNugPaymentRequest(
		NARRATOR,
		PREFIX,
		streamQuotaIdentityForRequest(PREFIX, { credentialId: second.id }),
	);
	if (!issue) throw new Error("无法捕获真实 B 主体");
	const context = issue();
	if (!context) throw new Error("签名密钥不可用");
	return context;
}
function requestIntent(paymentContext = captureContext()): NugPaymentIntent {
	return { mode: "request", narratorId: NARRATOR, paymentContext };
}
function billingCalls() {
	return calls.filter((call) => call.path.includes("/billing/") || call.path.endsWith("/quota"));
}

beforeEach(() => {
	setSystemTime();
	resetProviderKeyRuntimeForTests();
	calls = [];
	gate = undefined;
	for (const user of [OWNER, "payment-context-outsider"])
		sqlite.run(
			"INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', '2026-11-25')",
			[user, user],
		);
	for (const id of [NARRATOR, SECOND_NARRATOR])
		sqlite.run(
			"INSERT INTO narrators (id, type, owner_user_id, visibility, write_audience, model, created_at, updated_at) VALUES (?, 'primary', ?, 'private', 'owner', ?, '2026-11-25', '2026-11-25')",
			[id, OWNER, MODEL],
		);
	saveSettings({
		...settings,
		proxy: { mode: "direct" },
		nugProviders: [
			{
				id: SOURCE,
				prefix: PREFIX,
				name: "请求钱包",
				apiKey: A,
				baseUrl: "https://payment-gateway.example",
				defaultModel: "openai:m",
			},
		],
	});
	const key = store.list(nugKeyOwner(SOURCE))[0];
	if (!key) throw new Error("缺少 A");
	first = key;
	second = store.addGroupCredential(SOURCE, "nug", { apiKey: B });
	setNugCachedModels(SOURCE, [
		{ id: "openai:m", channel: "openai", channelType: "openai", model: "m", contextLength: 128000 },
	]);
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				const request = new Request(input, init);
				calls.push({
					path: new URL(request.url).pathname,
					auth: request.headers.get("Authorization") ?? "",
				});
				return gate ? gate(request) : responseFor(request);
			},
			{ preconnect: () => {} },
		),
	);
});
afterEach(() => {
	fetchSpy.mockRestore();
	setSystemTime();
	purgeNugQuotaCache([SOURCE, "payment-context-other-source"]);
	store.removeGroup(SOURCE);
	store.removeGroup("payment-context-other-source");
	deleteNugCachedModels(SOURCE);
	resetProviderKeyRuntimeForTests();
	saveSettings(structuredClone(saved));
	sqlite.run("DELETE FROM narrators WHERE id IN (?, ?)", [NARRATOR, SECOND_NARRATOR]);
});

test("真实 A403→池切B402→付款事件→重排后配置与下单仍使用B，不公开CID或私有identity", async () => {
	expect(resolveProviderAndModel(MODEL).adapter).toBeInstanceOf(PooledProvider);
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(
		{
			narratorId: NARRATOR,
			conversationId: NARRATOR,
			userId: OWNER,
			provider: PREFIX,
			model: MODEL,
			cwd: getNarraforkHome(),
			signal: AbortSignal.timeout(10000),
			maxTurns: 1,
			permissionHandler: async () => ({ behavior: "deny", message: "不运行工具" }),
		},
		"hello",
		{ rows: [] },
	))
		events.push(event);
	const payment = events.find(
		(event): event is Extract<AgentEvent, { type: "payment_required" }> =>
			event.type === "payment_required",
	);
	expect(events.filter((event) => event.type === "error")).toEqual([]);
	expect(payment).toBeDefined();
	if (!payment?.paymentContext) throw new Error("真实失败事件未携带付款上下文");
	expect(
		calls.filter((call) => call.path.endsWith("/chat/completions")).map((call) => call.auth),
	).toEqual([`Bearer ${A}`, `Bearer ${B}`]);
	expect(store.get(first.id)?.disabled).not.toBe(true);
	expect(isNugPaymentContext(payment.paymentContext)).toBe(true);
	for (const hidden of [
		second.id,
		A,
		B,
		streamQuotaIdentityForRequest(PREFIX, { credentialId: second.id }),
	])
		if (hidden) expect(JSON.stringify(payment)).not.toContain(hidden);
	expect(payment).not.toHaveProperty("credentialId");
	expect(payment).not.toHaveProperty("providerIdentity");
	const intent = requestIntent(payment.paymentContext);
	// A 仍是首个 enabled：配置和首次下单都必须绕过它，使用实际 402 的 B。
	expect(store.list(nugKeyOwner(SOURCE))[0]?.id).toBe(first.id);
	expect((await config(intent)).status).toBe(200);
	const created = await create(intent);
	expect(created.status).toBe(201);
	const bound = (await created.json()).order;
	store.reorder(nugKeyOwner(SOURCE), [second.id, first.id]);
	expect((await config(intent)).status).toBe(200);
	store.reorder(nugKeyOwner(SOURCE), [first.id, second.id]);
	expect((await create(intent)).status).toBe(201);
	const url = `/api/nug/providers/${SOURCE}/billing/orders/${bound.id}?binding=${bound.binding}`;
	expect((await app().request(url)).status).toBe(200);
	expect(
		(
			await app().request(
				`/api/nug/providers/${SOURCE}/billing/orders/${bound.id}/repay?binding=${bound.binding}`,
				{ method: "POST" },
			)
		).status,
	).toBe(200);
	expect(billingCalls().map((call) => call.auth)).toEqual(Array(6).fill(`Bearer ${B}`));
});

test("请求边界证明不会在402签发时采纳已旋转的新钱包，也不为未知attempt制造上下文", async () => {
	expect(captureNugPaymentRequest(NARRATOR, PREFIX, undefined)).toBeUndefined();
	const issue = captureNugPaymentRequest(
		NARRATOR,
		PREFIX,
		streamQuotaIdentityForRequest(PREFIX, { credentialId: second.id }),
	);
	if (!issue) throw new Error("缺少B证明");
	store.update(second.id, { apiKey: "B-changed-before-402" });
	const intent = requestIntent(issue());
	expect((await config(intent)).status).toBe(409);
	expect((await create(intent)).status).toBe(409);
	expect(billingCalls()).toEqual([]);
});

test.each([
	"",
	"   \t",
])("签名secret为空或空白时不可签发且拒绝旧context，不回退首钱包 (%j)", async (blank) => {
	const privateIdentity = streamQuotaIdentityForRequest(PREFIX, { credentialId: second.id });
	const issue = captureNugPaymentRequest(NARRATOR, PREFIX, privateIdentity);
	const valid = captureContext();
	if (!issue) throw new Error("缺少签发闭包");
	const originalSecret = settings.auth.jwtSecret;
	try {
		settings.auth.jwtSecret = blank;
		expect(captureNugPaymentRequest(NARRATOR, PREFIX, privateIdentity)).toBeUndefined();
		expect(issue()).toBeUndefined();
		expect(() => resolveNugPaymentContext(SOURCE, NARRATOR, valid)).toThrow();
		expect((await config(requestIntent(valid))).status).toBe(409);
		expect((await create(requestIntent(valid))).status).toBe(409);
		expect(billingCalls()).toEqual([]);
	} finally {
		settings.auth.jwtSecret = originalSecret;
	}
});

test("只有明确 standalone 才选择当前首个启用钱包，缺少失败context绝不回退", async () => {
	expect((await config({ mode: "standalone" })).status).toBe(200);
	expect((await create({ mode: "standalone" })).status).toBe(201);
	expect(billingCalls().map((call) => call.auth)).toEqual([`Bearer ${A}`, `Bearer ${A}`]);
	const before = calls.length;
	for (const intent of [
		undefined,
		{ mode: "request", narratorId: NARRATOR },
		{ mode: "standalone", paymentContext: captureContext() },
		{ mode: "request", narratorId: NARRATOR, paymentContext: "", credentialId: second.id },
	])
		expect((await create(intent)).status).toBe(409);
	expect((await app().request(`/api/nug/providers/${SOURCE}/billing/config`)).status).toBe(409);
	expect(calls).toHaveLength(before);
});

test.each([
	"rotate",
	"delete",
	"same-secret-new-cid",
	"disabled",
	"network",
	"endpoint",
	"global-proxy",
	"expiry",
	"tamper",
])("B主体%s后拒绝请求充值，不查询或下单A", async (change) => {
	const intent = requestIntent();
	if (change === "rotate") store.update(second.id, { apiKey: "B-new-account-secret" });
	if (change === "delete" || change === "same-secret-new-cid") store.remove(second.id);
	if (change === "same-secret-new-cid") store.addGroupCredential(SOURCE, "nug", { apiKey: B });
	if (change === "disabled") store.update(second.id, { disabled: true });
	if (change === "network") store.update(second.id, { network: { userAgentMode: "codex" } });
	if (change === "endpoint")
		settings.nugProviders = settings.nugProviders?.map((p) => ({
			...p,
			baseUrl: "https://changed.example",
		}));
	if (change === "global-proxy")
		settings.proxy = { mode: "custom", url: "http://changed-proxy.example:8080" };
	if (change === "expiry") setSystemTime(Date.now() + NUG_PAYMENT_CONTEXT_TTL_MS + 1);
	if (change === "tamper" && intent.mode === "request")
		intent.paymentContext = `${intent.paymentContext.slice(0, -1)}${intent.paymentContext.endsWith("a") ? "b" : "a"}`;
	expect((await config(intent)).status).toBe(409);
	expect((await create(intent)).status).toBe(409);
	expect(billingCalls()).toEqual([]);
});

test("narrator/source/写权限及用途不能错配，私有STREAM identity不能充当公开token", async () => {
	const intent = requestIntent();
	expect((await config(intent, "payment-context-outsider")).status).toBe(404);
	expect((await create(intent, "payment-context-outsider")).status).toBe(404);
	if (intent.mode !== "request") throw new Error("需要请求意图");
	expect((await create({ ...intent, narratorId: SECOND_NARRATOR })).status).toBe(409);
	const source = settings.nugProviders?.[0];
	if (!source) throw new Error("缺少测试连接");
	settings.nugProviders?.push({
		...source,
		id: "payment-context-other-source",
		prefix: "other-source",
	});
	store.addGroupCredential("payment-context-other-source", "nug", { apiKey: B });
	expect((await create(intent, OWNER, "payment-context-other-source")).status).toBe(409);
	expect(
		(
			await create({
				...intent,
				paymentContext: streamQuotaIdentityForRequest(PREFIX, { credentialId: second.id }),
			})
		).status,
	).toBe(409);
	expect((await create({ ...intent, paymentContext: "a".repeat(43) })).status).toBe(409);
	expect(billingCalls()).toEqual([]);
});

test("新建与既有订单在权限撤销后都明确拒绝；受控上游等待期间撤权不发布QR", async () => {
	const intent = requestIntent();
	const firstOrder = await create(intent);
	expect(firstOrder.status).toBe(201);
	const bound = (await firstOrder.json()).order;
	let entered!: () => void;
	let release!: (response: Response) => void;
	const reached = new Promise<void>((resolve) => {
		entered = resolve;
	});
	gate = (request) => {
		if (request.method === "POST" && request.url.endsWith("/billing/orders")) {
			entered();
			return new Promise<Response>((resolve) => {
				release = resolve;
			});
		}
		return responseFor(request);
	};
	const pending = create(intent);
	await reached;
	sqlite.run("UPDATE narrators SET owner_user_id = 'payment-context-outsider' WHERE id = ?", [
		NARRATOR,
	]);
	release(
		Response.json({
			order: {
				id: "late",
				amount: "10",
				quota_amount: "10",
				provider: "mockpay",
				status: "pending",
				pay_url: "https://pay.example/late",
				created_at: "2026-11-25",
			},
		}),
	);
	const late = await pending;
	expect(late.status).toBe(404);
	expect(await late.text()).not.toContain("pay_url");
	const before = calls.length;
	expect(
		(
			await app().request(
				`/api/nug/providers/${SOURCE}/billing/orders/${bound.id}?binding=${bound.binding}`,
			)
		).status,
	).toBe(404);
	expect((await config(intent)).status).toBe(404);
	expect((await create(intent)).status).toBe(404);
	expect(calls).toHaveLength(before);
});
