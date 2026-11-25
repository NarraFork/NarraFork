import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { seedUnifiedCredentials } from "../../tests/unified-credentials";
import { autoSourceFacts } from "../lib/agent/auto-route-signals";
import { AppError } from "../lib/errors";
import {
	getNugCachedQuota,
	getNugQuotaSnapshot,
	nugQuotaIdentity,
	purgeNugQuotaCache,
	setNugCachedQuota,
} from "../lib/nug-quota-cache";
import {
	getProviderKeyStore,
	nugKeyOwner,
	type ProviderKey,
	withProviderKey,
} from "../lib/provider-keys";
import { saveSettings, settings } from "../lib/settings";
import { nugRoutes } from "./nug";

seedUnifiedCredentials();
const ID = "nug-billing-bound";
const OTHER = "nug-billing-other";
const A = "gateway-account-A-secret";
const B = "gateway-account-B-secret";
const ROOT = `/api/nug/providers/${ID}/billing/orders`;
const store = getProviderKeyStore();
interface GatewayCall {
	url: string;
	method: string;
	authorization: string;
}
interface BoundOrder {
	id: string;
	binding: string;
	pay_url?: string;
}
let calls: GatewayCall[];
let gateway: (call: GatewayCall) => Response | Promise<Response>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let first: ProviderKey;
let second: ProviderKey;
let owner: string;
let ownerIndex = 0;

function order(id = "same-upstream-order", status = "pending") {
	return Response.json({
		order: {
			id,
			amount: "10",
			quota_amount: "10",
			provider: "mockpay",
			status,
			pay_url: "https://pay.example/qr",
			created_at: "2026-11-25T00:00:00Z",
		},
		pollIntervalMs: 3000,
	});
}
function app(userId: string | null = owner, external = false) {
	const instance = new Hono();
	instance.onError(
		(error) =>
			new Response(JSON.stringify({ error: error.message }), {
				status: error instanceof AppError ? error.statusCode : 500,
				headers: { "Content-Type": "application/json" },
			}),
	);
	if (userId)
		instance.use("*", async (c, next) => {
			const user = { sub: userId, role: "user" as const, iat: 0, exp: 9_999_999_999 };
			c.set("user", user);
			if (external) {
				const oauth = {
					tokenId: "external",
					clientId: "external",
					oauthClientId: "external",
					grantId: null,
					refreshFamilyId: null,
					expiresAt: "2099-01-01",
					scopes: [],
				};
				c.set("auth", { type: "oauth", user, oauth });
				c.set("oauth", oauth);
			} else c.set("auth", { type: "session", user });
			await next();
		});
	return instance.route("/api/nug", nugRoutes);
}
function create(userId = owner) {
	return app(userId).request(ROOT, {
		method: "POST",
		body: JSON.stringify({ amount: 10, provider: "mockpay", channel: "alipay" }),
	});
}
function query(
	bound: BoundOrder,
	repay = false,
	userId = owner,
	providerId = ID,
	orderId = bound.id,
) {
	return app(userId).request(
		`/api/nug/providers/${providerId}/billing/orders/${encodeURIComponent(orderId)}${repay ? "/repay" : ""}?binding=${encodeURIComponent(bound.binding)}`,
		{ method: repay ? "POST" : "GET" },
	);
}
function paymentQuota(bound: BoundOrder, userId = owner) {
	return app(userId).request(
		`/api/nug/providers/${ID}/quota?orderId=${encodeURIComponent(bound.id)}&binding=${encodeURIComponent(bound.binding)}`,
	);
}
async function created() {
	const response = await create();
	expect(response.status).toBe(201);
	return (await response.json()).order as BoundOrder;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(() => {
	owner = `nug-billing-owner-${++ownerIndex}`;
	calls = [];
	gateway = () => order();
	saveSettings({
		...settings,
		proxy: { mode: "direct" },
		nugProviders: [
			{
				id: ID,
				prefix: ID,
				name: "Billing",
				baseUrl: "https://gateway.example",
				apiKey: A,
				defaultModel: "",
			},
		],
	});
	const initial = store.list(nugKeyOwner(ID))[0];
	if (!initial) throw new Error("Missing real first credential");
	first = initial;
	second = store.addGroupCredential(ID, "nug", { apiKey: B, label: "Another account" });
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				const request = new Request(input, init);
				const call = {
					url: request.url,
					method: request.method,
					authorization: request.headers.get("Authorization") ?? "",
				};
				calls.push(call);
				return gateway(call);
			},
			{ preconnect: () => {} },
		),
	);
});
afterEach(() => {
	fetchSpy.mockRestore();
	setSystemTime();
	purgeNugQuotaCache([ID]);
	store.removeProvider(nugKeyOwner(ID));
	store.removeProvider(nugKeyOwner(OTHER));
});

test("create A then reorder B keeps poll and repay on A; two accounts' colliding order ids remain isolated", async () => {
	const boundA = await created();
	expect(boundA.binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
	const connection = settings.nugProviders?.find((p) => p.id === ID);
	if (!connection) throw new Error("Missing connection");
	const identity = nugQuotaIdentity(withProviderKey(connection, first));
	for (const secret of [A, B, identity, createHash("sha256").update(identity).digest("hex")])
		expect(JSON.stringify(boundA)).not.toContain(secret);
	store.reorder(nugKeyOwner(ID), [second.id, first.id]);
	expect(settings.nugProviders?.[0]?.apiKey).toBe(B);
	const polled = await query(boundA);
	expect(polled.status).toBe(200);
	expect((await polled.json()).order.binding).toBe(boundA.binding);
	expect((await query(boundA, true)).status).toBe(200);
	const boundB = await created();
	expect(boundB.id).toBe(boundA.id);
	expect(boundB.binding).not.toBe(boundA.binding);
	expect((await query(boundA)).status).toBe(200);
	expect((await query(boundB, true)).status).toBe(200);
	expect(calls.map((call) => call.authorization)).toEqual(
		[A, A, A, B, A, B].map((key) => `Bearer ${key}`),
	);
});

test.each([
	"deleted",
	"replaced",
	"reassigned",
	"disabled",
	"endpoint",
	"connection-deleted",
	"network",
	"global-proxy",
])("%s invalidates the captured subject without calling B", async (change) => {
	const bound = await created();
	store.reorder(nugKeyOwner(ID), [second.id, first.id]);
	if (change === "deleted" || change === "reassigned") store.remove(first.id);
	if (change === "reassigned") store.add(nugKeyOwner(OTHER), { id: first.id, apiKey: A });
	if (change === "replaced") store.update(first.id, { apiKey: "new-account-secret" });
	if (change === "disabled") store.update(first.id, { disabled: true });
	if (change === "network") store.update(first.id, { network: { userAgentMode: "codex" } });
	if (change === "endpoint")
		settings.nugProviders = settings.nugProviders?.map((p) => ({
			...p,
			baseUrl: "https://another-gateway.example",
		}));
	if (change === "connection-deleted") settings.nugProviders = [];
	if (change === "global-proxy")
		settings.proxy = { mode: "custom", url: "http://new-proxy.example:8080" };
	const poll = await query(bound);
	expect(poll.status).toBe(409);
	expect(await poll.text()).not.toContain(A);
	expect((await query(bound, true)).status).toBe(404);
	expect(calls.map((call) => call.authorization)).toEqual([`Bearer ${A}`]);
});

test("binding ownership, provider/order scope and missing pre-upgrade contexts fail without new-primary fallback", async () => {
	const bound = await created();
	store.reorder(nugKeyOwner(ID), [second.id, first.id]);
	for (const repay of [false, true]) {
		expect((await query(bound, repay, "another-local-user")).status).toBe(404);
		expect((await query(bound, repay, owner, OTHER)).status).toBe(404);
		expect((await query(bound, repay, owner, ID, "another-order")).status).toBe(404);
		expect((await query({ ...bound, binding: "x".repeat(43) }, repay)).status).toBe(404);
		expect(
			(
				await app().request(`${ROOT}/${bound.id}${repay ? "/repay" : ""}`, {
					method: repay ? "POST" : "GET",
				})
			).status,
		).toBe(409);
	}
	expect((await app(null).request(`${ROOT}/${bound.id}?binding=${bound.binding}`)).status).toBe(
		401,
	);
	expect(
		(await app(owner, true).request(`${ROOT}/${bound.id}?binding=${bound.binding}`)).status,
	).toBe(401);
	expect(calls).toHaveLength(1);
});

test.each([
	"create",
	"poll",
	"repay",
	"quota",
])("%s verifies identity again after a controlled late gateway answer", async (stage) => {
	const bound = stage === "create" ? undefined : await created();
	const entered = deferred<void>();
	const answer = deferred<Response>();
	gateway = () => {
		entered.resolve();
		return answer.promise;
	};
	const task = bound
		? stage === "quota"
			? paymentQuota(bound)
			: query(bound, stage === "repay")
		: create();
	await entered.promise;
	store.update(first.id, { apiKey: "replaced-during-gateway-call" });
	answer.resolve(order());
	const response = await task;
	expect(response.status).toBe(409);
	const text = await response.text();
	expect(text).not.toContain("pay_url");
	expect(text).not.toContain(A);
	expect(text).not.toContain('binding":');
	expect(calls.every((call) => call.authorization === `Bearer ${A}`)).toBe(true);
});

test("opaque bindings expire and per-user capacity is reserved before a create RPC", async () => {
	const entered = deferred<void>();
	const answer = deferred<void>();
	gateway = async () => {
		if (calls.length === 50) entered.resolve();
		await answer.promise;
		return order();
	};
	const pending = Array.from({ length: 50 }, () => create());
	await entered.promise;
	expect((await create()).status).toBe(429);
	expect(calls).toHaveLength(50);
	answer.resolve();
	const orders: BoundOrder[] = [];
	for (const response of await Promise.all(pending)) {
		expect(response.status).toBe(201);
		orders.push((await response.json()).order);
	}
	setSystemTime(Date.now() + 24 * 60 * 60_000 + 1);
	const expired = orders[0];
	if (!expired) throw new Error("Missing expiring order");
	expect((await query(expired)).status).toBe(404);
	expect((await create()).status).toBe(201);
	expect(calls).toHaveLength(51);
});

test.each([
	false,
	true,
])("post-payment balance uses A and cannot overwrite B's provider view (reordered: %s)", async (reordered) => {
	setNugCachedQuota(ID, {
		balance: 0,
		totalGranted: 0,
		detailedQuotaBalance: null,
		fetchedAt: Date.now(),
	});
	const bound = await created();
	if (reordered) store.reorder(nugKeyOwner(ID), [second.id, first.id]);
	setNugCachedQuota(ID, {
		balance: 77,
		totalGranted: 88,
		detailedQuotaBalance: null,
		fetchedAt: Date.now(),
	});
	if (reordered) {
		store.update(second.id, { disabled: true });
		expect(autoSourceFacts(ID).available).toBe(false);
		store.update(second.id, { disabled: false });
	}
	gateway = (call) =>
		call.url.endsWith("/v1/quota")
			? Response.json({ balance: 11, totalGranted: 22 })
			: order(bound.id, "paid");
	expect((await (await query(bound)).json()).order.status).toBe("paid");
	const response = await paymentQuota(bound);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		balance: 11,
		totalGranted: 22,
		paymentCredentialIsPrimary: !reordered,
	});
	expect(getNugCachedQuota(ID)?.balance).toBe(reordered ? 77 : 11);
	expect(getNugQuotaSnapshot(ID, first.id)?.snapshot?.balances[0]?.remaining).toBe(11);
	if (reordered) {
		expect(getNugQuotaSnapshot(ID, second.id)?.snapshot?.balances[0]?.remaining).toBe(77);
		store.update(second.id, { disabled: true });
		expect(autoSourceFacts(ID).available).toBe(true);
	}
	expect(calls.map((call) => call.authorization)).toEqual(Array(3).fill(`Bearer ${A}`));
	expect((await paymentQuota(bound, "another-local-user")).status).toBe(404);
	store.update(first.id, { apiKey: "replaced-after-payment" });
	expect((await paymentQuota(bound)).status).toBe(409);
	expect(calls).toHaveLength(3);
});

test("payment quota stores raw missing numbers as unknown before legacy response normalization", async () => {
	const bound = await created();
	gateway = () => Response.json({ detailedQuotaBalance: "Only details are available" });
	const response = await paymentQuota(bound);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ balance: 0, totalGranted: 0 });
	expect(getNugCachedQuota(ID)).toMatchObject({
		balance: null,
		totalGranted: null,
		detailedQuotaBalance: "Only details are available",
	});
});

test("gateway failures and mismatched orders never expose credentials or substitute a new order", async () => {
	gateway = () => new Response(`upstream echoed ${A}`, { status: 502 });
	const failed = await create();
	expect(failed.status).toBe(502);
	expect(await failed.text()).not.toContain(A);
	gateway = () => order();
	const bound = await created();
	gateway = () => order("wrong-upstream-order");
	const poll = await query(bound);
	expect(poll.status).toBe(502);
	expect(await poll.text()).not.toContain("pay_url");
});
