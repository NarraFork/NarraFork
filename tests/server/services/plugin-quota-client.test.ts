import { describe, expect, test } from "bun:test";
import { ProviderQuotaError } from "@server/lib/provider-quota-async";
import { PluginQuotaClient, type PluginQuotaRuntime } from "@server/services/plugin-quota-client";
import {
	QUOTA_MAX_SNAPSHOT_BYTES,
	type QuotaQueryParams,
	type QuotaQueryResult,
} from "@shared/provider-quota";

const params: QuotaQueryParams = {
	protocolVersion: "1.0",
	contributionId: "quota",
	mode: "probe",
	reference: "host-ref",
	deadlineAt: Date.now() + 30_000,
	target: {
		kind: "custom-api",
		id: "custom-api/provider",
		providerId: "provider",
		generation: "target-v1",
		baseUrl: "https://example.test/v1",
	},
};
const supported: QuotaQueryResult = {
	status: "supported",
	data: { amounts: [{ id: "credit", unit: "USD", remaining: 2 }], windows: [] },
	error: null,
};

function client(response: () => Promise<unknown>) {
	const methods: string[] = [];
	const runtime: PluginQuotaRuntime = {
		state: "active",
		getDiagnostics: () => ({ runtimeId: "runtime", generation: 1 }),
		request: async <T>(method: string) => {
			methods.push(method);
			return (await response()) as T;
		},
	};
	return { client: new PluginQuotaClient(runtime), methods };
}
const options = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });

describe("PluginQuotaClient", () => {
	test("uses only quota.query and accepts supported/unsupported/fixed error results", async () => {
		for (const result of [
			supported,
			{ status: "unsupported", data: null, error: null },
			{ status: "error", data: null, error: "request_failed" },
		] as QuotaQueryResult[]) {
			const fixture = client(async () => result);
			expect(await fixture.client.query(params, options())).toEqual(result);
			expect(fixture.methods).toEqual(["quota.query"]);
		}
	});

	for (const [name, invalid] of [
		["unknown fields", { ...supported, upstream: "secret" }],
		[
			"HTML labels",
			{
				...supported,
				data: {
					amounts: [{ id: "credit", unit: "USD", remaining: 2, label: "<script>" }],
					windows: [],
				},
			},
		],
		[
			"NaN",
			{
				...supported,
				data: { amounts: [{ id: "credit", unit: "USD", remaining: NaN }], windows: [] },
			},
		],
		[
			"Infinity",
			{
				...supported,
				data: { amounts: [{ id: "credit", unit: "USD", remaining: Infinity }], windows: [] },
			},
		],
		["missing supported data", { ...supported, data: null }],
		["unbounded response", { ...supported, extra: "文".repeat(QUOTA_MAX_SNAPSHOT_BYTES) }],
		["invalid JSON", undefined],
	] as const) {
		test(`rejects ${name} with a fixed invalid_response`, async () => {
			const fixture = client(async () => invalid);
			await expect(fixture.client.query(params, options())).rejects.toMatchObject({
				code: "invalid_response",
				message: "invalid_response",
			});
		});
	}

	test("rejects the 16 KiB aggregate response even when each nested field is individually valid", async () => {
		const large = {
			...supported,
			data: {
				amounts: Array.from({ length: 32 }, (_, index) => ({
					id: `amount-${index}`,
					unit: "USD",
					remaining: 2,
					label: "文".repeat(256),
				})),
				windows: [],
			},
		};
		await expect(client(async () => large).client.query(params, options())).rejects.toMatchObject({
			code: "invalid_response",
		});
	});

	test("maps transport timeout and per-call byte errors without exposing upstream text", async () => {
		for (const [code, expected] of [
			["RPC_TIMEOUT", "timeout"],
			["RESPONSE_FRAME_LIMIT", "invalid_response"],
			["socket-failed", "request_failed"],
		]) {
			const transportError = Object.assign(new Error("apiKey=secret upstream response"), { code });
			const fixture = client(async () => {
				throw new Error("runtime wrapper", { cause: transportError });
			});
			await expect(fixture.client.query(params, options())).rejects.toMatchObject({
				code: expected,
				message: expected,
			});
		}
	});

	test("cancellation settles even if the runtime ignores AbortSignal and later returns success", async () => {
		let finish!: (value: QuotaQueryResult) => void;
		const fixture = client(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const controller = new AbortController();
		const pending = fixture.client.query(params, { signal: controller.signal, timeoutMs: 1000 });
		controller.abort(new ProviderQuotaError("unavailable"));
		await expect(pending).rejects.toMatchObject({ code: "unavailable" });
		finish(supported);
		await Promise.resolve();
		expect(fixture.methods).toEqual(["quota.query"]);
	});

	test("rejects invalid targets and pre-aborted requests without dispatch", async () => {
		const fixture = client(async () => supported);
		const controller = new AbortController();
		controller.abort();
		await expect(
			fixture.client.query(params, { signal: controller.signal, timeoutMs: 1000 }),
		).rejects.toMatchObject({ code: "timeout" });
		await expect(
			fixture.client.query(
				{ ...params, target: { ...params.target, kind: "nug" } } as never,
				options(),
			),
		).rejects.toMatchObject({ code: "invalid_configuration" });
		expect(fixture.methods).toHaveLength(0);
	});
});
