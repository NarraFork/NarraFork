import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	legacyQuotaFixture,
	quotaConfig,
	walletQuota,
} from "../../../server/lib/__tests__/provider-quota-legacy-fixture";
import { toProviderBalanceSnapshot } from "../../../server/lib/provider-balance-cache";
import { ProviderQuotaError } from "../../../server/lib/provider-quota-async";

let fixture: ReturnType<typeof legacyQuotaFixture> | undefined;
afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
	mock.restore();
});

describe("provider balance engine replaced by one quota-source registry", () => {
	test("the default is explicitly unavailable without a source, never an inline bundled engine", async () => {
		fixture = legacyQuotaFixture();
		fixture.revoke();
		expect(await fixture.service.refresh("relay-test")).toMatchObject({
			status: "unavailable",
			data: null,
		});
		expect(fixture.query).not.toHaveBeenCalled();
	});
	test("a source can be restored only explicitly, then returns its unlimited/unknown semantics", async () => {
		fixture = legacyQuotaFixture();
		fixture.revoke();
		fixture.query.mockResolvedValue({
			status: "supported",
			error: null,
			data: { ...walletQuota, scope: "key", unlimited: true, amounts: [] },
		});
		fixture.setEnabled(true);
		const snapshot = await fixture.service.refresh("relay-test");
		expect(snapshot && toProviderBalanceSnapshot(snapshot).balance).toEqual({
			scope: "key",
			unlimited: true,
			amounts: [],
		});
	});
	test("removing a source is unavailable, not restore-builtin", async () => {
		fixture = legacyQuotaFixture();
		await fixture.service.refresh("relay-test");
		fixture.revoke();
		expect(fixture.service.peek("relay-test")).toMatchObject({ status: "unavailable", data: null });
		const source = await readFile(
			new URL("../../../server/lib/provider-balance-cache.ts", import.meta.url),
			"utf8",
		);
		expect(source).not.toMatch(
			/builtinProviderBalanceEngine|setProviderBalanceEngine|inlineFallback|outboundFetch/,
		);
	});
	test("invalid URL is an explicit safe configuration failure before any source I/O", async () => {
		fixture = legacyQuotaFixture([quotaConfig({ baseUrl: "https://relay.invalid/v1?secret=1" })]);
		expect(await fixture.service.refresh("relay-test")).toMatchObject({
			status: "error",
			data: null,
			error: "invalid_configuration",
		});
		expect(fixture.query).not.toHaveBeenCalled();
		expect(new ProviderQuotaError("invalid_configuration").message).toBe("invalid_configuration");
	});
});
