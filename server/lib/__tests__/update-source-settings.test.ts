import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { DEFAULTS, SETTING_DOCS } from "../settings/defaults";
import {
	deepMerge,
	getDefaults,
	narraforkDir,
	normalizeSettingsProxyUrls,
	reloadSettings,
	saveSettings,
} from "../settings/index";
import type { NarraForkSettings } from "../settings/types";
import {
	DEFAULT_GITHUB_REPOSITORY,
	DEFAULT_UPDATE_SETTINGS,
	isValidGitHubRepository,
	LEGACY_UPDATE_SERVER_URL,
	normalizeUpdateSourceSettings,
	updateSourceSettingsSchema,
} from "../settings/update-source";

// Use the route's actual update schema without importing its database-backed graph.
const updateSettingsSchema = z.object({ update: updateSourceSettingsSchema });

function normalize(raw: Record<string, unknown>) {
	return normalizeUpdateSourceSettings(deepMerge(getDefaults(), raw), raw);
}

const validRepositories = [
	"NarraFork/NarraFork",
	"a/b",
	"an-owner/a_repo-name.v2",
	`${"a".repeat(39)}/${"b".repeat(100)}`,
];
const invalidRepositories = [
	"",
	"https://github.com/NarraFork/NarraFork",
	"github.com/NarraFork",
	"github.com/NarraFork/NarraFork",
	"owner/repo/extra",
	"owner/..",
	"owner/repo..name",
	"../repo",
	"owner/.",
	"owner/repo?ref=main",
	"owner/repo#fragment",
	"owner/repo%2fextra",
	"owner/repo\\extra",
	"owner:443/repo",
	"owner/repo ",
	" owner/repo",
	"owner/仓库",
	"-owner/repo",
	"owner-/repo",
	"two--hyphens/repo",
	"owner_/repo",
	"/repo",
	"owner/",
	`${"a".repeat(40)}/b`,
	`a/${"b".repeat(101)}`,
];

describe("GitHub update repository validation", () => {
	for (const repository of validRepositories) {
		test(`accepts ${repository}`, () => {
			expect(isValidGitHubRepository(repository)).toBe(true);
			const result = updateSettingsSchema.safeParse({
				update: { githubRepository: repository },
			});
			expect(result.success).toBe(true);
			if (result.success) expect(result.data.update?.githubRepository).toBe(repository);
		});
	}

	for (const repository of invalidRepositories) {
		test(`rejects ${JSON.stringify(repository)}`, () => {
			expect(isValidGitHubRepository(repository)).toBe(false);
			expect(
				updateSettingsSchema.safeParse({ update: { githubRepository: repository } }).success,
			).toBe(false);
		});
	}

	test("rejects non-string repository values", () => {
		for (const repository of [null, 42, {}, ["owner", "repo"]]) {
			expect(isValidGitHubRepository(repository)).toBe(false);
			expect(
				updateSettingsSchema.safeParse({ update: { githubRepository: repository } }).success,
			).toBe(false);
		}
	});
});

describe("update source settings", () => {
	test("settings route consumes the isolated update schema", () => {
		const source = readFileSync(resolve(import.meta.dir, "../../routes/settings.ts"), "utf-8");
		expect(source).toContain(
			'import { updateSourceSettingsSchema } from "../lib/settings/update-source"',
		);
		expect(source).toContain("update: updateSourceSettingsSchema,");
	});

	test("retains the legacy TLS gate even when GitHub is selected", () => {
		for (const serverUrl of ["", "https://updates.example.com", "http://127.0.0.1:17780"]) {
			expect(
				updateSettingsSchema.safeParse({ update: { source: "github", serverUrl } }).success,
			).toBe(true);
		}
		for (const serverUrl of [
			"http://updates.example.com",
			"ftp://updates.example.com",
			"not a url",
		]) {
			expect(
				updateSettingsSchema.safeParse({ update: { source: "github", serverUrl } }).success,
			).toBe(false);
		}
	});

	test("defaults and field documentation include both new settings", () => {
		expect(DEFAULTS.update?.source).toBe("github");
		expect(DEFAULTS.update?.githubRepository).toBe(DEFAULT_GITHUB_REPOSITORY);
		expect(SETTING_DOCS["update.source"]).toBeDefined();
		expect(SETTING_DOCS["update.githubRepository"]).toBeDefined();
	});

	test("validates the source enum and keeps source-only patches partial", () => {
		for (const source of ["github", "update-server"] as const) {
			const result = updateSettingsSchema.safeParse({ update: { source } });
			expect(result.success).toBe(true);
			if (result.success) expect(result.data.update).toEqual({ source });
		}
		for (const source of ["GitHub", "server", "", null, 1]) {
			expect(updateSettingsSchema.safeParse({ update: { source } }).success).toBe(false);
		}
		expect(updateSettingsSchema.safeParse({ update: {} }).success).toBe(true);
	});

	test("keeps legacy update settings patchable", () => {
		const update = {
			serverUrl: "https://updates.example.com",
			product: "private-product",
			channel: "beta" as const,
			checkIntervalMinutes: 0,
			autoDownload: true,
		};
		const result = updateSettingsSchema.safeParse({ update });
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.update).toEqual(update);
	});

	test("source-only changes retain settings for both sources", () => {
		const update: NonNullable<NarraForkSettings["update"]> = {
			...DEFAULT_UPDATE_SETTINGS,
			serverUrl: "https://private.example.com/update",
			product: "private-product",
			githubRepository: "private-owner/releases",
			channel: "beta" as const,
			autoDownload: true,
		};
		for (const source of ["github", "update-server"] as const) {
			const parsed = updateSettingsSchema.parse({ update: { source } });
			const next = deepMerge({ update }, parsed);
			expect(next.update).toEqual({ ...update, source });
			const normalized = normalize(next);
			expect(normalized.update).toEqual(next.update);
			expect(normalized.needsSave).toBe(false);
		}
	});
});

describe("update proxy settings", () => {
	test("supports four independent modes and requires valid custom HTTP(S) URLs", () => {
		for (const mode of ["default", "direct", "system"] as const) {
			const patch = { update: { proxy: { mode } } };
			expect(updateSettingsSchema.parse(patch)).toEqual(patch);
		}
		for (const url of ["proxy.example:8080", " https://user:secret@proxy.example:8443 "]) {
			const parsed = updateSettingsSchema.parse({ update: { proxy: { mode: "custom", url } } });
			expect(parsed.update?.proxy?.url).toBe(
				url.trim().startsWith("https:") ? url.trim() : `http://${url}`,
			);
		}
		for (const url of [
			undefined,
			null,
			"",
			"http://",
			"http://host:invalid",
			"https://[bad",
			"http://a\nb",
			"not a proxy",
			"socks5://host:1080",
			"a".repeat(501),
		]) {
			expect(
				updateSettingsSchema.safeParse({ update: { proxy: { mode: "custom", url } } }).success,
			).toBe(false);
		}
	});

	test("proxy-only patches preserve update identity, global proxy and TokenDance configuration", () => {
		const current = deepMerge(getDefaults(), {
			proxy: { mode: "custom", url: "http://global.example:8080" },
			tokendance: { apiKey: "keep-token", baseUrl: "https://gateway.example" },
			update: {
				...DEFAULT_UPDATE_SETTINGS,
				githubRepository: "fork/releases",
				product: "private",
				channel: "beta",
				proxy: { mode: "custom", url: "http://old.example:8080" },
			},
		});
		const patch = updateSettingsSchema.parse(
			JSON.parse(JSON.stringify({ update: { proxy: { mode: "default" } } })),
		);
		const next = deepMerge(current, patch);
		if (!current.update) throw new Error("Expected update settings");
		expect(normalizeSettingsProxyUrls(next)).toBe(true);
		expect(next.update).toEqual({ ...current.update, proxy: { mode: "default" } });
		expect(next.proxy).toEqual(current.proxy);
		expect(next.tokendance).toEqual(current.tokendance);
		expect(SETTING_DOCS["update.proxy.mode"]).toBeDefined();
		expect(SETTING_DOCS["update.proxy.url"]).toBeDefined();
	});

	test("loading normalizes update proxy without deleting unsupported persisted URLs", () => {
		for (const url of [
			" proxy.example:8080 ",
			"socks5://proxy.example:1080",
			"http://host:invalid",
		]) {
			const current = deepMerge(getDefaults(), { update: { proxy: { mode: "custom", url } } });
			normalizeSettingsProxyUrls(current);
			expect(current.update?.proxy).toEqual({
				mode: "custom",
				url: url.startsWith(" ") ? "http://proxy.example:8080" : url,
			});
		}
	});

	test("isolated save/reload retains explicit inheritance without disturbing other fields", () => {
		expect(process.env.NARRAFORK_TEST).toBe("1");
		expect(narraforkDir).toBe(resolve(process.env.NARRAFORK_HOME ?? ""));
		const settingsPath = resolve(narraforkDir, "settings.json");
		const original = readFileSync(settingsPath, "utf-8");
		try {
			const current = getDefaults();
			if (!current.update) throw new Error("Expected update defaults");
			current.update.proxy = { mode: "custom", url: "proxy.example:8080" };
			saveSettings(current);
			expect(reloadSettings().update?.proxy).toEqual({
				mode: "custom",
				url: "http://proxy.example:8080",
			});
			const next = deepMerge(
				reloadSettings(),
				updateSettingsSchema.parse({ update: { proxy: { mode: "default" } } }),
			);
			saveSettings(next);
			expect(reloadSettings().update).toEqual({ ...current.update, proxy: { mode: "default" } });
		} finally {
			writeFileSync(settingsPath, original);
			reloadSettings();
		}
	});
});

describe("legacy update source migration", () => {
	test("new or missing configuration selects GitHub and requests persistence", () => {
		for (const raw of [{}, { update: {} }, { update: null }]) {
			const result = normalize(raw);
			expect(result.update.source).toBe("github");
			expect(result.update.githubRepository).toBe(DEFAULT_GITHUB_REPOSITORY);
			expect(result.needsSave).toBe(true);
		}
	});

	for (const serverUrl of [
		"",
		"  ",
		LEGACY_UPDATE_SERVER_URL,
		`${LEGACY_UPDATE_SERVER_URL}/`,
		"https://NARRAFORK-UPDATE.B.DOMEXIE.CN/",
		"HTTPS://NARRAFORK-UPDATE.B.DOMEXIE.CN:443/",
	]) {
		test(`migrates default product with ${JSON.stringify(serverUrl)} to GitHub`, () => {
			const result = normalize({ update: { serverUrl, product: "narrafork" } });
			expect(result.update.source).toBe("github");
			expect(result.update.serverUrl).toBe(serverUrl);
			expect(result.needsSave).toBe(true);
		});
	}

	for (const serverUrl of [
		"https://updates.example.com",
		"http://127.0.0.1:17780",
		`${LEGACY_UPDATE_SERVER_URL}/private`,
		`${LEGACY_UPDATE_SERVER_URL}?product=custom`,
		`${LEGACY_UPDATE_SERVER_URL}#custom`,
		"https://narrafork-update.b.domexie.cn:8443/",
		"https://private@narrafork-update.b.domexie.cn/",
	]) {
		test(`preserves legacy private server ${serverUrl}`, () => {
			const result = normalize({ update: { serverUrl } });
			expect(result.update.source).toBe("update-server");
			expect(result.update.serverUrl).toBe(serverUrl);
		});
	}

	test("a non-default product keeps the update-server source even without a custom URL", () => {
		for (const serverUrl of [undefined, "", LEGACY_UPDATE_SERVER_URL]) {
			const result = normalize({ update: { serverUrl, product: "private-product" } });
			expect(result.update.source).toBe("update-server");
			expect(result.update.product).toBe("private-product");
		}
	});

	test("respects the pre-merge explicit source rather than inferring from server fields", () => {
		for (const source of ["github", "update-server"] as const) {
			for (const serverUrl of [LEGACY_UPDATE_SERVER_URL, "https://private.example.com"]) {
				const raw = { update: { source, serverUrl, product: "private-product" } };
				const result = normalize(raw);
				expect(result.update.source).toBe(source);
				expect(result.update.serverUrl).toBe(serverUrl);
			}
		}
	});

	test("does not mutate merged settings, raw settings, or defaults", () => {
		const raw = { update: { serverUrl: "https://private.example.com", channel: "beta" } };
		const merged = deepMerge(getDefaults(), raw);
		const beforeRaw = structuredClone(raw);
		const beforeMerged = structuredClone(merged);
		const beforeDefaults = structuredClone(DEFAULTS);
		const result = normalizeUpdateSourceSettings(merged, raw);
		expect(result.update.source).toBe("update-server");
		expect(raw).toEqual(beforeRaw);
		expect(merged).toEqual(beforeMerged);
		expect(DEFAULTS).toEqual(beforeDefaults);
	});

	test("fills a missing repository, retains valid custom repository, repairs unsafe slugs", () => {
		for (const githubRepository of [undefined, "owner/custom-repo", "../repo"]) {
			const result = normalize({ update: { source: "github", githubRepository } });
			expect(result.update.githubRepository).toBe(
				githubRepository === "owner/custom-repo" ? githubRepository : DEFAULT_GITHUB_REPOSITORY,
			);
			expect(result.needsSave).toBe(githubRepository !== "owner/custom-repo");
		}
	});

	test("persisted migration is idempotent even when server or product changes later", () => {
		const first = normalize({ update: { serverUrl: "https://private.example.com" } });
		expect(first.needsSave).toBe(true);
		const persisted = JSON.parse(JSON.stringify({ update: first.update }));
		expect(normalize(persisted).needsSave).toBe(false);
		persisted.update.serverUrl = LEGACY_UPDATE_SERVER_URL;
		expect(normalize(persisted).update.source).toBe("update-server");
	});

	test("disk loading persists inferred source and default repository only in the isolated home", () => {
		expect(process.env.NARRAFORK_TEST).toBe("1");
		expect(narraforkDir).toBe(resolve(process.env.NARRAFORK_HOME ?? ""));
		const settingsPath = resolve(narraforkDir, "settings.json");
		const original = readFileSync(settingsPath, "utf-8");
		try {
			for (const serverUrl of [LEGACY_UPDATE_SERVER_URL, "https://private.example.com"]) {
				const legacy = getDefaults();
				if (!legacy.update) throw new Error("Expected update defaults");
				delete legacy.update.source;
				delete legacy.update.githubRepository;
				legacy.update.serverUrl = serverUrl;
				writeFileSync(settingsPath, JSON.stringify(legacy));
				const loaded = reloadSettings();
				const persisted = JSON.parse(readFileSync(settingsPath, "utf-8"));
				const source = serverUrl === LEGACY_UPDATE_SERVER_URL ? "github" : "update-server";
				expect(loaded.update?.source).toBe(source);
				expect(persisted.update.source).toBe(source);
				expect(persisted.update.githubRepository).toBe(DEFAULT_GITHUB_REPOSITORY);
				expect(persisted.update.serverUrl).toBe(serverUrl);
			}
		} finally {
			writeFileSync(settingsPath, original);
			reloadSettings();
		}
	});
});
