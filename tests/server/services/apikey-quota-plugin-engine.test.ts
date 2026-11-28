import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import {
	archivedQuotaFixture,
	closeQuotaTestPackage,
	legacyQuotaFixture,
	quotaConfig,
	required,
	walletQuota,
} from "../../../server/lib/__tests__/provider-quota-legacy-fixture";
import { toProviderBalanceSnapshot } from "../../../server/lib/provider-balance-cache";
import { ProviderQuotaError } from "../../../server/lib/provider-quota-async";
import { quotaQueryParamsSchema } from "../../../shared/provider-quota";

let archive: Awaited<ReturnType<typeof archivedQuotaFixture>>;
let fixture: ReturnType<typeof legacyQuotaFixture> | undefined;
let balance = 12.5;
beforeAll(async () => {
	archive = await archivedQuotaFixture({
		fetch: async () => Response.json({ isValid: true, mode: "unrestricted", unit: "USD", balance }),
	});
}, 60000);
afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
	mock.restore();
});
afterAll(async () => {
	await archive?.close();
	await closeQuotaTestPackage();
});
const config = () =>
	quotaConfig({
		id: `engine-${crypto.randomUUID()}`,
		extraHeaders: { "X-Tenant": "t1" },
		userAgentMode: "custom",
		customUserAgent: "engine-agent",
		proxy: { mode: "direct" },
		tlsRejectUnauthorized: false,
	});

/** Old engine failures now fail closed through the source service, never a native fallback. */
describe("apikey engine migration to actual quota contribution", () => {
	test("a probe executes archived quota.query without Agent tool or command dispatch", async () => {
		const runtime = required(archive.supervisor.get(archive.pluginId));
		const rpc = spyOn(runtime, "request");
		const result = await archive.rpc(config());
		expect(result).toMatchObject({
			status: "supported",
			data: { format: "sub2api", amounts: [{ remaining: 12.5 }] },
		});
		expect(rpc.mock.calls.some(([method]) => method === "quota.query")).toBe(true);
		expect(rpc.mock.calls.some(([method]) => method === "tools.invoke")).toBe(false);
		expect(rpc.mock.calls.some(([method]) => method === "commands.invoke")).toBe(false);
		expect(runtime.pid).toBeGreaterThan(0);
	});
	test("an already cancelled query never activates, leases a connection or invokes RPC", async () => {
		const activation = spyOn(archive.manager, "activate");
		const issue = spyOn(archive.connection, "issue");
		const rpc = spyOn(required(archive.supervisor.get(archive.pluginId)), "request");
		const controller = new AbortController();
		controller.abort();
		await expect(
			archive.rpc(config(), "probe", undefined, controller.signal),
		).rejects.toMatchObject({ code: "timeout" });
		expect(activation).not.toHaveBeenCalled();
		expect(issue).not.toHaveBeenCalled();
		expect(rpc).not.toHaveBeenCalled();
		expect(archive.connection.activeReferences).toBe(0);
	});
	test("connection facts stay host-private; only target identity/reference cross RPC", async () => {
		const runtime = required(archive.supervisor.get(archive.pluginId));
		const rpc = spyOn(runtime, "request");
		const cfg = config();
		await archive.rpc(cfg);
		const input = rpc.mock.calls.find(([method]) => method === "quota.query")?.[1];
		expect(quotaQueryParamsSchema.safeParse(input).success).toBe(true);
		expect(input).toMatchObject({
			mode: "probe",
			target: { providerId: cfg.id, baseUrl: cfg.baseUrl },
		});
		expect(JSON.stringify(input)).not.toMatch(
			/test-secret-key|apiKey|X-Tenant|tlsRejectUnauthorized|proxy/,
		);
	});
	test("unsupported is authoritative and never invokes another native engine", async () => {
		fixture = legacyQuotaFixture();
		fixture.query.mockResolvedValue({ status: "unsupported", data: null, error: null });
		expect(await fixture.service.refresh("relay-test")).toMatchObject({
			status: "unsupported",
			data: null,
		});
		expect(fixture.query).toHaveBeenCalledTimes(1);
	});
	for (const code of ["request_failed", "invalid_response", "invalid_configuration"] as const) {
		test(`typed ${code} failures have safe fixed codes, no inline fallback`, async () => {
			fixture = legacyQuotaFixture();
			fixture.query.mockRejectedValue(new ProviderQuotaError(code));
			expect(await fixture.service.refresh("relay-test")).toMatchObject({
				status: "error",
				error: code,
				data: null,
			});
			expect(fixture.query).toHaveBeenCalledTimes(1);
		});
	}
	for (const output of [
		{ status: "ok", balance: walletQuota },
		{ status: "nonsense" },
		"boom",
		JSON.stringify({ status: "supported", data: walletQuota, error: null }),
		{ status: "supported", error: null, data: null },
	]) {
		test(`invalid former tool/partial output ${JSON.stringify(output)} is deterministic invalid_response`, async () => {
			fixture = legacyQuotaFixture();
			fixture.query.mockResolvedValue(output as never);
			expect(await fixture.service.refresh("relay-test")).toMatchObject({
				status: "error",
				error: "invalid_response",
				data: null,
			});
			expect(fixture.query).toHaveBeenCalledTimes(1);
		});
	}
	test("a disabled source fails before invoking it; no native adapter answers instead", async () => {
		fixture = legacyQuotaFixture();
		fixture.revoke();
		expect(await fixture.service.refresh("relay-test")).toMatchObject({
			status: "unavailable",
			data: null,
		});
		expect(fixture.query).not.toHaveBeenCalled();
	});
	test("source disabled between scheduling and reply discards its result", async () => {
		fixture = legacyQuotaFixture();
		let finish!: (value: never) => void;
		fixture.query.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const pending = fixture.service.refresh("relay-test");
		fixture.revoke();
		finish({ status: "supported", data: walletQuota, error: null } as never);
		expect(await pending).toBeNull();
		expect(fixture.service.peek("relay-test")?.data).toBeNull();
	});
	test("refresh reports unavailable in the same way as probe", async () => {
		fixture = legacyQuotaFixture();
		fixture.revoke();
		expect(await fixture.service.refresh("relay-test", { mode: "refresh" })).toMatchObject({
			status: "unavailable",
			data: null,
		});
	});
	test("activation/source errors do not silently reinstate builtin fetching", async () => {
		fixture = legacyQuotaFixture();
		fixture.query.mockRejectedValue(new ProviderQuotaError("unavailable"));
		expect(await fixture.service.refresh("relay-test")).toMatchObject({
			status: "unavailable",
			data: null,
		});
		expect(fixture.query).toHaveBeenCalledTimes(1);
	});
	test("refresh returns the archived plugin balance through its bounded cursor", async () => {
		balance = 3;
		const cfg = config();
		const found = await archive.rpc(cfg);
		const refreshed = await archive.rpc(cfg, "refresh", found.cursor);
		expect(refreshed).toMatchObject({ status: "supported", data: { amounts: [{ remaining: 3 }] } });
		balance = 12.5;
	});
	test("refresh failures preserve the normalized error contract, not raw upstream strings", async () => {
		fixture = legacyQuotaFixture();
		fixture.query.mockRejectedValue(new ProviderQuotaError("request_failed"));
		const result = await fixture.service.refresh("relay-test", { mode: "refresh" });
		expect(result).toMatchObject({ status: "error", error: "request_failed" });
		expect(result && toProviderBalanceSnapshot(result).error).toBe("request_failed");
	});
	test("injecting test HTTP still executes the real archived RPC instead of an in-process fallback", async () => {
		const rpc = spyOn(required(archive.supervisor.get(archive.pluginId)), "request");
		await archive.rpc(config());
		expect(rpc.mock.calls.some(([method]) => method === "quota.query")).toBe(true);
	});
	test("no installed source/activator remains unavailable rather than native success", async () => {
		fixture = legacyQuotaFixture();
		fixture.service.configureDriver({ listSources: () => [], query: fixture.query });
		expect(await fixture.service.refresh("relay-test")).toMatchObject({
			status: "unavailable",
			data: null,
		});
		expect(fixture.query).not.toHaveBeenCalled();
	});
});
