import { afterEach, describe, expect, test } from "bun:test";
import { delimiter, join, resolve } from "node:path";
import {
	assertQuotaSnapshot,
	assertSiteCredentialIsolation,
	assertSiteQuotaFailure,
	assertSiteQuotaSnapshot,
	createQuotaFixture,
	createSiteQuotaFixture,
	finishQuotaSmokeCleanup,
	parseQuotaSmokeArgs,
	QuotaSmokeContext,
	quotaSmokeEnvironment,
	quotaUiHasUnavailable,
	readBoundedQuotaBody,
	redactQuotaEvidence,
} from "../../scripts/smoke-provider-quota";

const fixtures: ReturnType<typeof createQuotaFixture>[] = [];
const siteFixtures: ReturnType<typeof createSiteQuotaFixture>[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.stop();
	for (const fixture of siteFixtures.splice(0)) fixture.stop();
});
const args = ["--binary=native.exe", "--archive=quota.nfplugin", "--out=evidence"];

function snapshot(remaining: number): Record<string, unknown> {
	return {
		providerId: "quota-smoke-relay",
		status: "supported",
		error: null,
		stale: false,
		sourceId: "io.narrafork.provider-quota/relay",
		data: { amounts: [{ unit: "USD", remaining }] },
	};
}

function siteSnapshot(remaining: number): Record<string, unknown> {
	return {
		...snapshot(remaining),
		targetId: "custom-api/quota-smoke-relay",
		pushCompatible: false,
		data: {
			format: "new-api-user",
			scope: "wallet",
			planName: "quota-smoke-site-group",
			amounts: [{ unit: "USD", remaining }],
		},
	};
}

function siteFailure(code: string): Record<string, unknown> {
	return { ...siteSnapshot(0), status: "error", error: code, stale: true, data: null };
}

function siteFixture(onFailure?: (error: Error) => void) {
	const fixture = createSiteQuotaFixture(
		{
			accessToken: "unit-site-token",
			userId: "424242",
			inferenceSecrets: ["unit-inference-key", "unit-inference-header", "unit-inference-cookie"],
		},
		new AbortController().signal,
		onFailure,
	);
	siteFixtures.push(fixture);
	return fixture;
}

const siteHeaders = { Authorization: "Bearer unit-site-token", "New-Api-User": "424242" };

describe("provider quota native smoke contract", () => {
	test("requires explicit artifacts, defaults to full acceptance and bounds the whole run", () => {
		const options = parseQuotaSmokeArgs(args);
		expect(options).toEqual({
			binary: resolve("native.exe"),
			archive: resolve("quota.nfplugin"),
			out: resolve("evidence"),
			baseline: false,
			timeoutMs: 480_000,
		});
		expect(
			parseQuotaSmokeArgs([
				"--binary",
				"native.exe",
				"--archive",
				"quota.nfplugin",
				"--out",
				"evidence",
				"--baseline",
			]).baseline,
		).toBe(true);
		for (const invalid of [
			args.slice(1),
			[...args, "--binary=other.exe"],
			[...args, "--port=7778"],
			[...args, "--skip-browser"],
			[...args, "--baseline=maybe"],
			[...args, "--timeout-ms=480001"],
			[...args, "--timeout-ms=999"],
			[...args, "--timeout-ms=NaN"],
			["--binary", "--archive=a", "--out=b"],
		])
			expect(() => parseQuotaSmokeArgs(invalid)).toThrow();
	});

	test("isolates all home/data paths and strips account, module and Bun environment", () => {
		const root = resolve("quota-private-test");
		const windows = process.platform === "win32";
		const system = windows ? "C:\\Windows\\System32" : "/usr/bin";
		const git = windows ? "C:\\Program Files\\Git\\cmd" : "/bin";
		const ambient = {
			PATH: [
				system,
				git,
				resolve(".narrafork/toolchains/bun-1.4.3/package/bin"),
				resolve("node_modules/.bin"),
			].join(delimiter),
			SystemRoot: "C:\\Windows",
			PATHEXT: ".EXE;.CMD",
			HOME: "real-home",
			USERPROFILE: "real-profile",
			NARRAFORK_HOME: "production-data",
			DATABASE_URL: "production-db",
			ANTHROPIC_API_KEY: "real-key",
			OPENAI_API_KEY: "real-key",
			HTTP_PROXY: "http://credential:secret@proxy",
			NODE_PATH: "modules",
			NODE_OPTIONS: "--require secrets",
		};
		const env = quotaSmokeEnvironment(root, ambient);
		expect(env.HOME).toBe(join(root, "home"));
		expect(env.NARRAFORK_HOME).toBe(join(root, "data"));
		expect(env.TMP).toBe(join(root, "tmp"));
		expect(env.USERPROFILE).toBe(env.HOME);
		expect(env.PATH).not.toMatch(/toolchains|node_modules|\.bun/);
		for (const name of [
			"DATABASE_URL",
			"ANTHROPIC_API_KEY",
			"OPENAI_API_KEY",
			"HTTP_PROXY",
			"NODE_PATH",
			"NODE_OPTIONS",
		])
			expect(env[name]).toBeUndefined();
		if (windows) expect(env.PATH.split(delimiter)).toContain(system);
		expect(env.NODE_ENV).toBe("production");
	});

	test("accepts actual zero but rejects stale, unsupported and non-plugin snapshots", () => {
		expect(() => assertQuotaSnapshot(snapshot(0), 0)).not.toThrow();
		expect(() => assertQuotaSnapshot(snapshot(12.34), 12.34)).not.toThrow();
		for (const invalid of [
			{ ...snapshot(0), status: "unavailable" },
			{ ...snapshot(0), stale: true },
			{ ...snapshot(0), error: "request_failed" },
			{ ...snapshot(0), providerId: "different" },
			{ ...snapshot(0), sourceId: "core/legacy" },
			{ ...snapshot(0), data: null },
			snapshot(1),
		])
			expect(() => assertQuotaSnapshot(invalid, 0)).toThrow();
	});

	test("detects unavailable plugin text in both languages without hiding an account status", () => {
		for (const text of [
			"Quota source plugin unavailable",
			"Quota source is unavailable",
			"额度来源插件不可用",
			"providerQuota.errors.unavailable",
		])
			expect(quotaUiHasUnavailable(text)).toBe(true);
		for (const text of [
			"USD 0",
			"额度可用",
			"Provider quota: USD 12.34",
			"Account unavailable",
			"账号不可用",
		])
			expect(quotaUiHasUnavailable(text)).toBe(false);
	});

	test.each([
		false,
		true,
	])("cleanup preserves its redacted cause and the primary stage (primary=%s)", (withPrimary) => {
		const context = new QuotaSmokeContext(parseQuotaSmokeArgs(args), resolve("unused-test-home"));
		context.stage = "source restart";
		context.report.status = "passed";
		context.report.finalAcceptance = true;
		context.secrets.push("fixture-private");
		const primary = withPrimary ? new Error("source validation failed") : undefined;
		const busy = Object.assign(new Error("resource busy"), {
			code: "EBUSY",
			syscall: "unlink",
			path: "fixture-private/file",
		});
		const result = finishQuotaSmokeCleanup(context, primary, [
			new AggregateError([busy], "directory cleanup"),
		]);
		expect(result).toBeInstanceOf(Error);
		expect(context.stage).toBe(withPrimary ? "source restart" : "owned process and home cleanup");
		expect(context.report).toMatchObject({
			status: "failed",
			finalAcceptance: false,
			checks: [{ name: "owned process and home cleanup", status: "failed" }],
		});
		expect(context.report.error).toContain("EBUSY; unlink; [redacted]/file");
		expect(context.report.error).not.toContain("fixture-private");
		if (withPrimary) expect(context.report.error).toContain("source validation failed");
	});

	test("successful cleanup cannot turn a failed acceptance into a pass", () => {
		const context = new QuotaSmokeContext(parseQuotaSmokeArgs(args), resolve("unused-test-home"));
		const primary = new Error("validation failed");
		expect(finishQuotaSmokeCleanup(context, primary, [])).toBe(primary);
		expect(context.report).toMatchObject({
			status: "failed",
			finalAcceptance: false,
			checks: [{ name: "owned process and home cleanup", status: "passed" }],
		});
	});
	test("redacts test secrets, bearer sessions and query credentials before evidence", () => {
		const value = redactQuotaEvidence(
			{
				password: "private-password",
				apiKey: "test-key",
				token: "nfs_secretSession",
				quotaAccessToken: "private-site-access-token",
				masked: "partial-private-key",
				message:
					"Bearer nfs_secretSession test-key https://fixture.invalid/?token=private-token&x=1",
				data: { remaining: 0 },
			},
			["test-key", "private-password"],
		);
		const text = JSON.stringify(value);
		expect(text).not.toMatch(
			/private-password|test-key|nfs_secretSession|private-token|private-site-access-token|partial-private-key/,
		);
		expect(text).toContain('"remaining":0');
		expect(text).toContain("[redacted]");
	});
});

describe("authoritative site-account quota smoke", () => {
	test("accepts a real zero wallet/group only for the explicit account subject", () => {
		expect(() => assertSiteQuotaSnapshot(siteSnapshot(0), 0)).not.toThrow();
		expect(() => assertSiteQuotaSnapshot(siteSnapshot(31.27), 31.27)).not.toThrow();
		for (const invalid of [
			snapshot(0),
			{ ...siteSnapshot(0), pushCompatible: true },
			{ ...siteSnapshot(0), keyId: "inference-key-id" },
			{ ...siteSnapshot(0), targetId: "custom-api/quota-smoke-relay/keys/inference" },
			{
				...siteSnapshot(0),
				data: { ...(siteSnapshot(0).data as Record<string, unknown>), format: "new-api" },
			},
			{
				...siteSnapshot(0),
				data: { ...(siteSnapshot(0).data as Record<string, unknown>), scope: "key" },
			},
			{
				...siteSnapshot(0),
				data: { ...(siteSnapshot(0).data as Record<string, unknown>), planName: "wrong-group" },
			},
		])
			expect(() => assertSiteQuotaSnapshot(invalid, 0)).toThrow();
	});

	test("requires auth/network failures to clear good data instead of retaining or reviving it", () => {
		for (const code of ["auth_failed", "request_failed"] as const) {
			expect(() => assertSiteQuotaFailure(siteFailure(code), code)).not.toThrow();
			for (const invalid of [
				{ ...siteFailure(code), data: siteSnapshot(42.56).data },
				{ ...siteFailure(code), status: "supported" },
				{ ...siteFailure(code), status: "unsupported" },
				{ ...siteFailure(code), pushCompatible: true },
				{ ...siteFailure(code), keyId: "inference" },
				{ ...siteFailure(code), error: null },
				{ ...siteFailure(code), stale: false },
			])
				expect(() => assertSiteQuotaFailure(invalid, code)).toThrow();
		}
	});

	test("serves /api/user/self on its own origin using only site authentication and returns USD-zero/group inputs", async () => {
		const site = siteFixture();
		const inference = createQuotaFixture("unit-inference-key", new AbortController().signal);
		fixtures.push(inference);
		expect(site.origin).not.toBe(inference.origin);
		site.setRemaining(0);
		const response = await fetch(`${site.origin}/api/user/self`, {
			headers: siteHeaders,
			signal: AbortSignal.timeout(5000),
		});
		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(payload.success).toBe(true);
		expect(payload.data.quota).toBe(0);
		expect(payload.data.used_quota / 500_000).toBe(7.5);
		expect(payload.data.group).toBe("quota-smoke-site-group");
		expect(() => assertSiteCredentialIsolation(site.evidence().records)).not.toThrow();
		expect(JSON.stringify(site.evidence())).not.toMatch(
			/unit-site-token|unit-inference-key|unit-inference-header|unit-inference-cookie/,
		);
	});

	test("rejects inference keys, missing UserId and every inference-only custom header", async () => {
		const failures: Error[] = [];
		const site = siteFixture((error) => failures.push(error));
		const signal = AbortSignal.timeout(5000);
		const invalid: Record<string, string>[] = [
			{ Authorization: "Bearer unit-inference-key", "New-Api-User": "424242" },
			{ Authorization: "Bearer unit-site-token" },
			...Object.entries({
				"X-Smoke-Inference": "unit-inference-header",
				"X-API-Key": "unit-inference-key",
				"API-Key": "unit-inference-key",
				Cookie: "unit-inference-cookie",
			}).map(([name, value]) => ({ ...siteHeaders, [name]: value })),
		];
		for (const headers of invalid) {
			const response = await fetch(`${site.origin}/api/user/self`, { headers, signal });
			expect(response.status).toBe(400);
			await response.body?.cancel();
		}
		expect(failures.length).toBe(invalid.length);
		expect(() => assertSiteCredentialIsolation(site.evidence().records)).toThrow();
		expect(() => assertSiteCredentialIsolation([])).toThrow();
		expect(JSON.stringify(site.evidence())).not.toMatch(
			/unit-site-token|unit-inference-key|unit-inference-header|unit-inference-cookie/,
		);
	});

	test("exercises a real site 401 followed by a refused socket without stopping inference", async () => {
		const site = siteFixture();
		const inference = createQuotaFixture("unit-inference-key", new AbortController().signal);
		fixtures.push(inference);
		const signal = AbortSignal.timeout(5000);
		const good = await fetch(`${site.origin}/api/user/self`, { headers: siteHeaders, signal });
		expect(good.status).toBe(200);
		await good.body?.cancel();
		site.setMode("unauthorized");
		const revoked = await fetch(`${site.origin}/api/user/self`, { headers: siteHeaders, signal });
		expect(revoked.status).toBe(401);
		expect((await revoked.json()).success).toBe(false);
		expect(() => assertSiteCredentialIsolation(site.evidence().records)).not.toThrow();
		site.disconnect();
		await expect(
			fetch(`${site.origin}/api/user/self`, { headers: siteHeaders, signal }),
		).rejects.toThrow();
		expect(site.evidence().disconnected).toBe(true);
		const available = await fetch(`${inference.origin}/v1/models`, {
			headers: { Authorization: "Bearer unit-inference-key" },
			signal,
		});
		expect(available.status).toBe(200);
		await available.body?.cancel();
		expect(inference.evidence().counts["/api/usage/token/"]).toBeUndefined();
		expect(() => site.setRemaining(0)).toThrow();
		expect(() => site.setMode("supported")).toThrow();
	});
});

describe("provider quota smoke body and upstream fixture", () => {
	test("streams bounded response bytes even when Content-Length is absent or false", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(new Uint8Array(20));
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ headers: { "Content-Length": "1" } },
		);
		await expect(readBoundedQuotaBody(response, 32)).rejects.toThrow("budget");
		expect(cancelled).toBe(true);
		expect(await readBoundedQuotaBody(new Response("small"), 16)).toBe("small");
	});

	test("cancels a stalled body on the shared network deadline", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				cancel() {
					cancelled = true;
				},
			}),
		);
		await expect(readBoundedQuotaBody(response, 32, AbortSignal.timeout(25))).rejects.toThrow();
		expect(cancelled).toBe(true);
	});

	test("bounds upstream path diagnostics and reports budget exhaustion", async () => {
		let failure: Error | undefined;
		const fixture = createQuotaFixture(
			"quota-budget-key",
			new AbortController().signal,
			(error) => {
				failure = error;
			},
		);
		fixtures.push(fixture);
		const signal = AbortSignal.timeout(5_000);
		for (let index = 0; index < 32; index++) {
			const response = await fetch(`${fixture.origin}/fixture-${index}`, {
				headers: { Authorization: "Bearer quota-budget-key" },
				signal,
			});
			expect(response.status).toBe(404);
			await response.body?.cancel();
		}
		const overflow = await fetch(`${fixture.origin}/one-too-many`, { signal });
		expect(overflow.status).toBe(503);
		await overflow.body?.cancel();
		expect(Object.keys(fixture.evidence().counts).length).toBe(32);
		expect(failure?.message).toContain("budget");
	});

	test("requires the throwaway key only on models/usage and converts a real zero fixture", async () => {
		const key = "quota-unit-fixture-key";
		const fixture = createQuotaFixture(key, new AbortController().signal);
		fixtures.push(fixture);
		const signal = AbortSignal.timeout(5_000);
		const headers = { Authorization: `Bearer ${key}` };
		const models = await fetch(`${fixture.origin}/v1/models`, { headers, signal });
		expect(models.status).toBe(200);
		expect((await models.json()).data[0].id).toBe("quota-smoke-model");
		expect((await fetch(`${fixture.origin}/v1/models`, { signal })).status).toBe(401);
		expect((await fetch(`${fixture.origin}/api/status`, { headers, signal })).status).toBe(400);
		const status = await (await fetch(`${fixture.origin}/api/status`, { signal })).json();
		expect(status.data.quota_display_type).toBe("USD");
		fixture.setRemaining(0);
		const usage = await (
			await fetch(`${fixture.origin}/api/usage/token/`, { headers, signal })
		).json();
		expect(usage.data.total_available).toBe(0);
		expect(usage.data.total_granted / status.data.quota_per_unit).toBe(50);
		expect(fixture.evidence().counts["/api/usage/token/"]).toBe(1);
		expect(fixture.evidence().requests).toBe(5);
		expect(() => fixture.setRemaining(-1)).toThrow();
		expect(() => fixture.setRemaining(Number.POSITIVE_INFINITY)).toThrow();
	});
});
