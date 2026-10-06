import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "nf-search-route-"));
process.env.NARRAFORK_HOME = testHome;
const { settings } = await import("../../lib/settings");
const { settingsRoutes } = await import("../settings");
const probe = await import("../../lib/search/subagent-probe");
const { AppError } = await import("../../lib/errors");
const snapshot = structuredClone(settings);
const oldFetch = globalThis.fetch;

function app(role: "admin" | "user" = "admin") {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: "verified-admin", role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.onError((error) =>
		error instanceof AppError
			? Response.json({ error: error.message }, { status: error.statusCode })
			: Response.json({ error: error.message }, { status: 500 }),
	);
	instance.route("/settings", settingsRoutes);
	return instance;
}
function post(body: unknown, role: "admin" | "user" = "admin") {
	return app(role).request("/settings/search/test", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}
const channel = {
	id: "subagent",
	kind: "subagent",
	enabled: false,
	model: "route_probe:claude-opus-5",
	maxTurns: 3,
	timeoutMs: 2000,
};
const body = {
	channelId: "subagent",
	channel,
	query: "current release",
	purpose: "verify release",
};

beforeEach(() => {
	Object.assign(settings, structuredClone(snapshot));
	settings.anthropicProviders = [
		{
			id: "route-probe",
			prefix: "route_probe",
			name: "Probe",
			apiKey: "fake-key",
			baseUrl: "https://probe.invalid/v1",
			defaultModel: "claude-opus-5",
			officialApi: true,
		},
	];
	settings.search = {
		...settings.search,
		channels: [{ ...channel, kind: "subagent", model: "invalid:saved", enabled: false }],
		customProviders: [],
	};
});
afterEach(() => {
	globalThis.fetch = oldFetch;
	Object.assign(settings, structuredClone(snapshot));
});
afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

describe("settings search test route", () => {
	test("uses a validated draft and authenticated user, without mutating saved configuration", async () => {
		const saved = JSON.stringify(settings.search);
		const run = spyOn(probe, "runSearchProbe").mockResolvedValue("Verified results");
		try {
			const response = await post({ ...body, userId: "spoofed" });
			expect(response.status).toBe(200);
			expect((await response.json()).text).toBe("Verified results");
			expect(run).toHaveBeenCalledTimes(1);
			expect(run.mock.calls[0][0]).toMatchObject(channel);
			expect(run.mock.calls[0][1]).toMatchObject({ userId: "verified-admin", testMode: true });
			expect(run.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
			expect(run.mock.calls[0][1].parentNarratorId).toBeUndefined();
			expect(JSON.stringify(settings.search)).toBe(saved);
		} finally {
			run.mockRestore();
		}
	});
	test("rejects invalid budgets and non-admin users before running a probe", async () => {
		const run = spyOn(probe, "runSearchProbe").mockResolvedValue("unexpected");
		try {
			for (const maxTurns of [0, 11, 1.5])
				expect((await post({ ...body, channel: { ...channel, maxTurns } })).status).toBe(400);
			expect((await post(body, "user")).status).toBe(403);
			expect(run).not.toHaveBeenCalled();
		} finally {
			run.mockRestore();
		}
	});
	test("restores masked credentials while testing unsaved custom provider fields", async () => {
		if (!settings.search) throw new Error("Missing search settings");
		settings.search.customProviders = [
			{
				id: "draft",
				name: "Saved",
				protocol: "zhipu-web-search-v1",
				baseUrl: "https://saved.invalid/search",
				apiKey: "real-secret",
				headers: { Authorization: "Bearer saved-secret" },
			},
		];
		const saved = JSON.stringify(settings.search);
		let url = "";
		let headers: Headers | undefined;
		globalThis.fetch = (async (input, init) => {
			url = String(input);
			headers = new Headers(init?.headers);
			return Response.json({
				search_result: [
					{ title: "Draft result", link: "https://source.example", content: "current release" },
				],
			});
		}) as typeof fetch;
		const response = await post({
			query: "current release",
			channelId: "custom:draft",
			channel: { id: "custom:draft", kind: "custom-api", enabled: false, providerId: "draft" },
			customProvider: {
				...settings.search.customProviders[0],
				name: "Unsaved",
				baseUrl: "https://draft.invalid/search",
				apiKey: "********cret",
				headers: { Authorization: "********cret" },
			},
		});
		expect(response.status).toBe(200);
		expect(url).toBe("https://draft.invalid/search/web_search");
		expect(headers?.get("Authorization")).toContain("saved-secret");
		expect((await response.json()).channelLabel).toBe("Custom: Unsaved");
		expect(JSON.stringify(settings.search)).toBe(saved);
	});
});
