import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UpdateSourceIdentity } from "@shared/update-identity";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApiError, api } from "../lib/api";
import { sameUpdateSource, updateCheckErrorKey, updateSettingsKey } from "../lib/update-source";
import commonEn from "../locales/en/common.json";
import commonZh from "../locales/zh-CN/common.json";
import { useInstanceSettings } from "./useInstanceSettings";
import {
	extractUpdateFailureDiagnostic,
	useUpdateApply,
	useUpdateCheck,
	useUpdateDownload,
} from "./useUpdateCheck";
import { OFFICIAL_UPDATE_SERVER_URL, useUpdateSourcePrompt } from "./useUpdateSourcePrompt";

describe("extractUpdateFailureDiagnostic", () => {
	test("prefers reason, then message, error, code, and fallback", () => {
		expect(
			extractUpdateFailureDiagnostic({
				code: "DOWNLOAD_FAILED",
				reason: "Download failed from upstream",
				message: "Download failed",
				error: "generic",
			}),
		).toEqual({
			error: "Download failed from upstream",
			code: "DOWNLOAD_FAILED",
			reason: "Download failed from upstream",
			message: "Download failed",
		});

		expect(extractUpdateFailureDiagnostic({ message: "Message first" })).toEqual({
			error: "Message first",
			code: undefined,
			reason: undefined,
			message: "Message first",
		});

		expect(extractUpdateFailureDiagnostic({ error: "Error first" })).toEqual({
			error: "Error first",
			code: undefined,
			reason: undefined,
			message: undefined,
		});

		expect(extractUpdateFailureDiagnostic({ code: "CODE_ONLY" })).toEqual({
			error: "CODE_ONLY",
			code: "CODE_ONLY",
			reason: undefined,
			message: undefined,
		});

		expect(extractUpdateFailureDiagnostic({}, "Fallback message")).toEqual({
			error: "Fallback message",
			code: undefined,
			reason: undefined,
			message: undefined,
		});
	});
});

/**
 * The admin gate on the update check.
 *
 * `GET /api/update/check` is admin-only, and `UpdateBadge` mounts for EVERY signed-in user through
 * the app shell. Without the gate inside `useUpdateCheck`, each non-admin session issued a
 * guaranteed 403 per refetch interval (plus the query default's retry) while the badge stayed
 * hidden anyway. Eyeballing the `enabled` expression is not enough here: the failure mode is a
 * request that should never leave, so these tests count actual `queryFn` invocations.
 */
const DOM_GLOBAL_KEYS = [
	"window",
	"document",
	"navigator",
	"localStorage",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

function installDom(): () => void {
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of DOM_GLOBAL_KEYS) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const store = new Map<string, string>([["narrafork_token", "test-admin"]]);
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		// `useCurrentUser` reads the token through `getToken()` during render, which touches
		// localStorage directly.
		localStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
			clear: () => store.clear(),
		},
		requestAnimationFrame: (callback: FrameRequestCallback) =>
			setTimeout(() => callback(Date.now()), 0) as unknown as number,
		cancelAnimationFrame: (handle: number) => clearTimeout(handle),
		IS_REACT_ACT_ENVIRONMENT: false,
	};
	for (const key of DOM_GLOBAL_KEYS) {
		Object.defineProperty(globalThis, key, {
			configurable: true,
			enumerable: previous.get(key)?.enumerable ?? true,
			writable: true,
			value: values[key],
		});
	}
	return () => {
		// Restore in full so this file cannot leak DOM globals into sibling test files.
		for (const key of [...DOM_GLOBAL_KEYS].reverse()) {
			const descriptor = previous.get(key);
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
}

async function settle() {
	for (let turn = 0; turn < 4; turn++) {
		for (let i = 0; i < 6; i++) await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

type CheckUpdateResult = Awaited<ReturnType<typeof api.checkUpdate>>;
type UpdateCheckResult = ReturnType<typeof useUpdateCheck>;

let restoreDom: (() => void) | null = null;
let queryClient: QueryClient | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let renders: UpdateCheckResult[] = [];
let checkUpdateCalls = 0;
const originalCheckUpdate = api.checkUpdate;
const originalGetSettings = api.getSettings;
const originalGetRuntimeSettings = api.getRuntimeSettings;

import { setToken } from "../lib/api/client";
import { runtimeSettingsQueryOptions } from "./useRuntimeSettings";

const originalUpdateSettings = api.updateSettings;
const originalUpdateRuntimeSettings = api.updateRuntimeSettings;
const originalFetch = globalThis.fetch;
const originalApplyUpdate = api.applyUpdate;
let applyState: ReturnType<typeof useUpdateApply> | undefined;
let downloadState: ReturnType<typeof useUpdateDownload> | undefined;
let settingsState: ReturnType<typeof useInstanceSettings> | undefined;

function DownloadHarness() {
	downloadState = useUpdateDownload();
	return null;
}

function ApplyHarness() {
	applyState = useUpdateApply();
	return null;
}

function SettingsHarness() {
	settingsState = useInstanceSettings();
	return null;
}

async function mountHarness(
	component: typeof DownloadHarness | typeof SettingsHarness | typeof ApplyHarness,
) {
	if (!queryClient || !root) throw new Error("harness is not initialized");
	root.render(
		createElement(QueryClientProvider, { client: queryClient }, createElement(component)),
	);
	await settle();
}

let promptLanguage = "zh-CN";
let promptState: ReturnType<typeof useUpdateSourcePrompt> | undefined;

function Harness() {
	const check = useUpdateCheck();
	renders.push(check);
	promptState = useUpdateSourcePrompt(check, promptLanguage);
	return null;
}

/** Seed `["auth", "me"]` so `useCurrentUser` resolves from cache without a request. */
async function mountAs(role: "admin" | "user") {
	if (!queryClient || !root) throw new Error("harness is not initialized");
	queryClient.setQueryData(["auth", "me"], { id: "u1", username: "tester", role });
	root.render(
		createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, {})),
	);
	await settle();
}

function latest(): UpdateCheckResult {
	const last = renders.at(-1);
	if (!last) throw new Error("hook never rendered");
	return last;
}

beforeEach(() => {
	restoreDom = installDom();
	promptLanguage = "zh-CN";
	promptState = undefined;
	renders = [];
	checkUpdateCalls = 0;
	api.updateRuntimeSettings = async (input) =>
		(await api.updateSettings(input)) as unknown as Awaited<
			ReturnType<typeof originalUpdateRuntimeSettings>
		>;
	api.getSettings = async () => ({
		update: { source: "github", githubRepository: "fork/project" },
	});
	api.getRuntimeSettings = async () =>
		(await api.getSettings()) as unknown as Awaited<ReturnType<typeof originalGetRuntimeSettings>>;
	api.checkUpdate = async () => {
		checkUpdateCalls++;
		return {
			updateAvailable: true,
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
		} as CheckUpdateResult;
	};
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	root?.unmount();
	root = null;
	queryClient?.clear();
	queryClient = null;
	await settle();
	container?.remove();
	container = null;
	// Restore the patched API method and the DOM globals even if an expectation threw.
	api.checkUpdate = originalCheckUpdate;
	api.getSettings = originalGetSettings;
	api.getRuntimeSettings = originalGetRuntimeSettings;
	api.updateSettings = originalUpdateSettings;
	api.updateRuntimeSettings = originalUpdateRuntimeSettings;
	api.applyUpdate = originalApplyUpdate;
	applyState = undefined;
	globalThis.fetch = originalFetch;
	downloadState = undefined;
	settingsState = undefined;
	restoreDom?.();
	restoreDom = null;
});

describe("update source behavior", () => {
	test("a saved custom server product matches the unchanged draft fingerprint", () => {
		const savedUpdateSettings = {
			source: "update-server" as const,
			serverUrl: "https://updates.example",
			githubRepository: "fork/project",
			product: "custom-product",
			channel: "stable" as const,
		};
		const draftKey = updateSettingsKey({
			source: savedUpdateSettings.source,
			serverUrl: savedUpdateSettings.serverUrl,
			githubRepository: savedUpdateSettings.githubRepository,
			product: savedUpdateSettings.product,
			channel: savedUpdateSettings.channel,
		});
		expect(draftKey).toBe(updateSettingsKey(savedUpdateSettings));
		expect(draftKey).not.toBe(updateSettingsKey({ ...savedUpdateSettings, product: "narrafork" }));
		expect(draftKey).not.toBe(
			updateSettingsKey({ ...savedUpdateSettings, githubRepository: "another/project" }),
		);
	});
	test("every backend check failure has a bilingual classification", () => {
		for (const code of [
			"RATE_LIMITED",
			"CANONICAL_MIRROR_REQUIRED",
			"REPOSITORY_UNAVAILABLE",
			"PLATFORM_UNAVAILABLE",
			"INVALID_CONFIGURATION",
			"INVALID_METADATA",
			"NETWORK_ERROR",
			"TIMEOUT",
			"NO_RELEASE",
			"SCAN_LIMIT_REACHED",
			"UPDATE_SOURCE_CHANGED",
			"UPDATE_ARTIFACT_CHANGED",
		]) {
			const key = updateCheckErrorKey(code) as keyof typeof commonEn;
			expect(key).not.toBe("updateCheckFailed");
			expect(commonEn[key]).toBeTruthy();
			expect(commonZh[key]).toBeTruthy();
		}
	});
	test("a structured check failure cannot advertise an update or masquerade as latest", async () => {
		api.checkUpdate = async () => ({
			updateAvailable: true,
			currentVersion: "1.0.0",
			error: "rate limited",
			errorCode: "GITHUB_RATE_LIMIT",
			retryAfter: 60,
		});
		await mountAs("admin");
		expect(latest().checkFailed).toBe(true);
		expect(latest().updateAvailable).toBe(false);
		expect(latest().errorKey).toBe("updateCheckRateLimited");
		expect(latest().retryAfter).toBe(60);
	});

	test("a failed refresh suppresses even a previously successful recommendation", async () => {
		await mountAs("admin");
		api.checkUpdate = async () => {
			throw new Error("offline");
		};
		await latest().refetch();
		await settle();
		expect(latest().checkFailed).toBe(true);
		expect(latest().updateAvailable).toBe(false);
		expect(latest().error).toBe("offline");
	});

	test("settings default to GitHub and preserve unselected endpoints when saving", async () => {
		api.getSettings = async () => ({
			update: { serverUrl: "https://old.example", channel: "beta", autoDownload: true },
		});
		let saved: Record<string, unknown> | undefined;
		api.updateSettings = async (data) => {
			saved = data;
			return data;
		};
		queryClient?.setQueryData(["update-check"], { updateAvailable: true, latestVersion: "1.1.0" });
		const prepared = { ready: true, version: "1.1.0", canAutoRestart: true };
		queryClient?.setQueryData<typeof prepared>(["update-status", "1.1.0"], prepared);
		await mountHarness(SettingsHarness);
		expect(settingsState?.updateSource).toBe("github");
		expect(settingsState?.updateGithubRepository).toBe("NarraFork/NarraFork");
		settingsState?.setUpdateSource("update-server");
		await settle();
		expect(settingsState?.updateGithubRepository).toBe("NarraFork/NarraFork");
		settingsState?.setUpdateSource("github");
		settingsState?.setUpdateGithubRepository("fork/project");
		await settle();
		settingsState?.save();
		await settle();
		expect(saved?.update).toEqual({
			source: "github",
			githubRepository: "fork/project",
			serverUrl: "https://old.example",
			channel: "beta",
			autoDownload: true,
		});
		expect(queryClient?.getQueryData(["update-check"])).toBeUndefined();
		expect(queryClient?.getQueryData<typeof prepared>(["update-status", "1.1.0"])).toEqual(
			prepared,
		);
	});

	const releaseInfo: NonNullable<CheckUpdateResult["releaseInfo"]> = {
		version: "1.1.0",
		source: "github",
		repository: "fork/project",
		releaseDate: "2026-01-01",
		path: "untrusted",
		sha512: "hash",
		files: [{ url: "untrusted", size: 1, sha512: "hash" }],
	};

	test("download sends the release hash beside the legacy source/version payload", async () => {
		let body: unknown;
		globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response('data: {"success":true,"ready":true}\n\n');
		}) as unknown as typeof fetch;
		await mountHarness(DownloadHarness);
		await downloadState?.download(releaseInfo);
		await settle();
		expect(body).toEqual({
			releaseInfo: { version: releaseInfo.version, sha512: releaseInfo.sha512 },
			source: "github",
			repository: "fork/project",
			retry: false,
		});
		expect(downloadState?.result?.success).toBe(true);
	});

	test.each([
		{ source: "github" as const, repository: "another/project" },
		{ source: "update-server" as const, repository: undefined },
	])("409 re-check never retries against a different source/repository: %j", async (next) => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return Response.json({ code: "VERSION_CHANGED", error: "stale" }, { status: 409 });
		}) as unknown as typeof fetch;
		api.checkUpdate = async () => ({
			updateAvailable: true,
			currentVersion: "1.0.0",
			releaseInfo: { ...releaseInfo, ...next },
		});
		await mountHarness(DownloadHarness);
		await downloadState?.download(releaseInfo);
		await settle();
		expect(calls).toBe(1);
		expect(downloadState?.result?.success).toBe(false);
	});

	test.each([
		{ source: "github", repository: "fork/project", channel: "beta", platform: "linux-x64" },
		{ source: "github", repository: "fork/project", channel: "stable", platform: "linux-arm64" },
		{
			source: "update-server",
			repository: "fork/project",
			serverUrl: "https://updates.example",
			product: "other",
			channel: "stable",
			platform: "linux-x64",
		},
	] satisfies UpdateSourceIdentity[])("full source identity prevents cross-configuration retry: %j", async (next) => {
		const initial: UpdateSourceIdentity =
			next.source === "github"
				? { ...next, channel: "stable", platform: "linux-x64" }
				: { ...next, product: "narrafork" };
		const original = { ...releaseInfo, source: initial.source, sourceIdentity: initial };
		expect(sameUpdateSource(original, { ...original, sourceIdentity: next })).toBe(false);
		expect(sameUpdateSource(original, releaseInfo)).toBe(false);
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return Response.json({ code: "VERSION_CHANGED", error: "stale" }, { status: 409 });
		}) as unknown as typeof fetch;
		api.checkUpdate = async () => ({
			updateAvailable: true,
			currentVersion: "1.0.0",
			releaseInfo: { ...original, version: "1.2.0", sourceIdentity: next },
		});
		await mountHarness(DownloadHarness);
		await downloadState?.download(original);
		await settle();
		expect(calls).toBe(1);
		expect(downloadState?.result?.success).toBe(false);
	});

	test("legacy retry is also blocked when saved configuration changes during the request", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			queryClient?.setQueryData(runtimeSettingsQueryOptions().queryKey, {
				update: { source: "github", githubRepository: "fork/project", channel: "beta" },
			});
			return Response.json({ code: "VERSION_CHANGED", error: "stale" }, { status: 409 });
		}) as unknown as typeof fetch;
		api.checkUpdate = async () => ({
			updateAvailable: true,
			currentVersion: "1.0.0",
			releaseInfo: { ...releaseInfo, version: "1.2.0" },
		});
		await mountHarness(DownloadHarness);
		await downloadState?.download(releaseInfo);
		expect(calls).toBe(1);
	});

	test("download sends full identity and retains the SSE verified selector", async () => {
		const sourceIdentity: UpdateSourceIdentity = {
			source: "github",
			repository: "fork/project",
			channel: "stable",
			platform: "linux-x64",
		};
		const preparedIdentity = {
			id: "verified",
			sourceIdentity,
			version: "1.1.0",
			sha512: "hash",
			sizeBytes: 1,
		};
		let body: unknown;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(
				`data: ${JSON.stringify({ success: true, ready: true, preparedIdentity })}\n\n`,
			);
		}) as unknown as typeof fetch;
		await mountHarness(DownloadHarness);
		await downloadState?.download({ ...releaseInfo, sourceIdentity });
		await settle();
		expect(body).toMatchObject({ releaseInfo: { sourceIdentity, sha512: "hash" } });
		expect(downloadState?.result?.preparedIdentity).toEqual(preparedIdentity);
	});

	test.each([
		["PREPARED_UPDATE_IDENTITY_REQUIRED", "updateApplyIdentityRequired"],
		["PREPARED_UPDATE_CHANGED", "updatePreparedChanged"],
	] as const)("apply sends the chosen selector and localizes HTTP 409 %s", async (code, key) => {
		await i18n.init({
			lng: "en",
			resources: { en: { common: commonEn }, "zh-CN": { common: commonZh } },
		});
		let selected: unknown;
		api.applyUpdate = async (version, preparedId) => {
			selected = { version, preparedId };
			throw new ApiError("conflict", 409, { code });
		};
		await mountHarness(ApplyHarness);
		await applyState?.apply("1.1.0", "artifact-a");
		await settle();
		expect(selected).toEqual({ version: "1.1.0", preparedId: "artifact-a" });
		expect(applyState?.applyResult?.error).toBe(commonEn[key]);
		await i18n.changeLanguage("zh-CN");
		await applyState?.apply("1.1.0", "artifact-a");
		await settle();
		expect(applyState?.applyResult?.error).toBe(commonZh[key]);
		await i18n.changeLanguage("en");
	});

	test("the update API serializes version and preparedId in the apply body", async () => {
		let body: unknown;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return Response.json({ success: false, code: "PREPARED_UPDATE_CHANGED" });
		}) as unknown as typeof fetch;
		await originalApplyUpdate("1.1.0", "artifact-a");
		expect(body).toEqual({ version: "1.1.0", preparedId: "artifact-a" });
	});

	test.each([
		{ code: "UPDATE_SOURCE_CHANGED", field: "errorCode" },
		{ code: "UPDATE_ARTIFACT_CHANGED", field: "errorCode" },
		{ code: "UPDATE_ARTIFACT_CHANGED", field: "code" },
	])("identity conflict never rechecks or automatically downloads: %j", async ({ code, field }) => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return Response.json({ [field]: code, error: "identity changed" }, { status: 409 });
		}) as unknown as typeof fetch;
		await mountHarness(DownloadHarness);
		await downloadState?.download(releaseInfo);
		await settle();
		expect(calls).toBe(1);
		expect(checkUpdateCalls).toBe(0);
		expect(downloadState?.result?.code).toBe(code);
	});

	test("unmount during a 409 re-check prevents a detached download retry and cache overwrite", async () => {
		const previousCheck = {
			updateAvailable: true,
			currentVersion: "1.0.0",
			releaseInfo,
			settingsKey: updateSettingsKey({ source: "github", githubRepository: "fork/project" }),
		};
		queryClient?.setQueryData(["update-check"], previousCheck);
		let resolveCheck!: (value: CheckUpdateResult) => void;
		let signal: AbortSignal | undefined;
		let calls = 0;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			calls++;
			signal = init?.signal ?? undefined;
			return Response.json({ code: "VERSION_CHANGED", error: "stale" }, { status: 409 });
		}) as unknown as typeof fetch;
		api.checkUpdate = () =>
			new Promise((resolve) => {
				resolveCheck = resolve;
			});
		await mountHarness(DownloadHarness);
		const downloading = downloadState?.download(releaseInfo);
		await settle();
		expect(resolveCheck).toBeDefined();
		root?.render(null);
		await settle();
		expect(signal?.aborted).toBe(true);
		resolveCheck({
			updateAvailable: true,
			currentVersion: "1.0.0",
			releaseInfo: { ...releaseInfo, version: "1.2.0" },
		});
		await downloading;
		expect(calls).toBe(1);
		expect(queryClient?.getQueryData<typeof previousCheck>(["update-check"])).toEqual(
			previousCheck,
		);
	});

	test("an old aborted download cannot clear the new retry's controller or progress", async () => {
		let rejectOld!: (reason: Error) => void;
		const signals: AbortSignal[] = [];
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			const signal = init?.signal;
			if (!signal) throw new Error("missing signal");
			signals.push(signal);
			if (signals.length === 1) {
				return new Promise<Response>((_resolve, reject) => {
					rejectOld = reject;
				});
			}
			return new Response(
				new ReadableStream({
					start(controller) {
						signal.addEventListener("abort", () =>
							controller.error(new DOMException("cancelled", "AbortError")),
						);
					},
				}),
			);
		}) as unknown as typeof fetch;
		await mountHarness(DownloadHarness);
		const first = downloadState?.download(releaseInfo);
		await settle();
		const second = downloadState?.download(releaseInfo, { retry: true });
		await settle();
		expect(signals[0].aborted).toBe(true);
		rejectOld(new DOMException("cancelled", "AbortError"));
		await first;
		await settle();
		expect(downloadState?.isDownloading).toBe(true);
		expect(signals[1].aborted).toBe(false);
		downloadState?.cancel();
		await second;
		expect(signals[1].aborted).toBe(true);
	});

	test("same-source version conflicts retain the existing single re-check retry", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return calls === 1
				? Response.json({ code: "VERSION_CHANGED", error: "stale" }, { status: 409 })
				: new Response('data: {"success":true,"ready":true}\n\n');
		}) as unknown as typeof fetch;
		api.checkUpdate = async () => ({
			updateAvailable: true,
			currentVersion: "1.0.0",
			releaseInfo: { ...releaseInfo, version: "1.2.0" },
		});
		await mountHarness(DownloadHarness);
		await downloadState?.download(releaseInfo);
		await settle();
		expect(calls).toBe(2);
		expect(downloadState?.result?.version).toBe("1.2.0");
		expect(queryClient?.getQueryData<{ settingsKey: string }>(["update-check"])?.settingsKey).toBe(
			updateSettingsKey({ source: "github", githubRepository: "fork/project" }),
		);
	});
});

describe("useUpdateCheck saved settings", () => {
	test("a check started before a channel change never gets labeled with the new configuration", async () => {
		let finish!: (value: CheckUpdateResult) => void;
		api.checkUpdate = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		await mountAs("admin");
		queryClient?.setQueryData(runtimeSettingsQueryOptions().queryKey, {
			update: { source: "github", githubRepository: "fork/project", channel: "beta" },
		});
		finish({ updateAvailable: true, currentVersion: "1.0.0", latestVersion: "1.1.0" });
		await settle();
		expect(latest().checkFailed).toBe(true);
		expect(latest().updateAvailable).toBe(false);
		expect(latest().errorCode).toBe("UPDATE_SOURCE_CHANGED");
	});

	test("waits for the deduplicated settings request before checking", async () => {
		let resolveSettings!: (value: Awaited<ReturnType<typeof api.getSettings>>) => void;
		let settingsCalls = 0;
		api.getSettings = () => {
			settingsCalls++;
			return new Promise((resolve) => {
				resolveSettings = resolve;
			});
		};
		const pendingSettings = queryClient?.fetchQuery({
			queryKey: runtimeSettingsQueryOptions().queryKey,
			queryFn: api.getSettings,
		});
		await mountAs("admin");
		expect(settingsCalls).toBe(1);
		expect(checkUpdateCalls).toBe(0);
		expect(latest().isLoading).toBe(true);
		const settings = {
			update: {
				source: "github" as const,
				githubRepository: "fork/project",
				serverUrl: "https://narrafork-update.b.domexie.cn",
			},
		};
		resolveSettings(settings);
		await pendingSettings;
		await settle();
		expect(checkUpdateCalls).toBe(1);
		expect(latest().updateAvailable).toBe(true);
		expect(latest().settingsKey).toBe(updateSettingsKey(settings.update));
	});

	test("a settings failure never starts a check and uses the existing error mapping", async () => {
		api.getSettings = async () => {
			throw new Error("settings unavailable");
		};
		await mountAs("admin");
		expect(checkUpdateCalls).toBe(0);
		expect(latest().updateAvailable).toBe(false);
		expect(latest().checkFailed).toBe(true);
		expect(latest().error).toBe("settings unavailable");
		expect(latest().errorKey).toBe("updateCheckFailed");
	});
});

describe("useUpdateCheck admin gate", () => {
	test("a non-admin never calls the admin-only settings or check endpoints", async () => {
		let settingsCalls = 0;
		api.getSettings = async () => {
			settingsCalls++;
			return {};
		};
		await mountAs("user");

		expect(settingsCalls).toBe(0);
		expect(checkUpdateCalls).toBe(0);
		const state = queryClient?.getQueryState(["update-check"]);
		expect(state?.fetchStatus).toBe("idle");
		expect(state?.status).toBe("pending");
		expect(latest().updateAvailable).toBe(false);
		// A disabled v5 query is `pending` but not `fetching`, so `isLoading` is false: a caller
		// gating a skeleton on it will not spin forever for regular users.
		expect(latest().isLoading).toBe(false);
	});

	test("a non-admin's manual refetch stays blocked by the gate", async () => {
		await mountAs("user");
		await latest().refetch();
		await settle();

		expect(checkUpdateCalls).toBe(0);
		expect(latest().updateAvailable).toBe(false);
	});

	test("an admin still performs the check", async () => {
		await mountAs("admin");

		expect(checkUpdateCalls).toBe(1);
		expect(latest().updateAvailable).toBe(true);
		expect(latest().latestVersion).toBe("1.1.0");
		expect(latest().isLoading).toBe(false);
	});
});

describe("first GitHub check mirror prompt", () => {
	function configure(errorCode?: string) {
		api.getSettings = async () => ({
			update: {
				source: "github",
				githubRepository: "NarraFork/NarraFork",
				channel: "beta",
				autoDownload: false,
				proxy: { mode: "direct" },
			},
		});
		api.checkUpdate = async () => ({
			updateAvailable: false,
			currentVersion: "1.0.0",
			source: "github",
			repository: "NarraFork/NarraFork",
			errorCode,
		});
	}

	for (const code of ["NETWORK_ERROR", "TIMEOUT", "GITHUB_RATE_LIMIT", "RATE_LIMITED"]) {
		test(`Chinese admin is prompted on first ${code}`, async () => {
			configure(code);
			await mountAs("admin");
			expect(promptState?.opened).toBe(true);
		});
	}

	for (const code of [
		undefined,
		"NO_RELEASE",
		"INVALID_METADATA",
		"REPOSITORY_NOT_FOUND",
		"PLATFORM_UNAVAILABLE",
		"UPDATE_SOURCE_CHANGED",
	]) {
		test(`does not mistake ${code ?? "success"} for connectivity trouble`, async () => {
			configure(code);
			await mountAs("admin");
			expect(promptState?.opened).toBe(false);
		});
	}

	test("a later failed poll does not prompt after a successful first check", async () => {
		configure();
		await mountAs("admin");
		configure("NETWORK_ERROR");
		await latest().refetch();
		await settle();
		expect(promptState?.opened).toBe(false);
	});

	test("English first check is consumed without prompting after a language change", async () => {
		configure("TIMEOUT");
		promptLanguage = "en";
		await mountAs("admin");
		expect(promptState?.opened).toBe(false);
		promptLanguage = "zh-CN";
		await mountAs("admin");
		expect(promptState?.opened).toBe(false);
	});

	test("non-admin, custom repository and server sources do not prompt", async () => {
		configure("TIMEOUT");
		await mountAs("user");
		expect(promptState?.opened).toBe(false);
		api.getSettings = async () => ({
			update: { source: "github", githubRepository: "fork/project" },
		});
		await mountAs("admin");
		expect(promptState?.opened).toBe(false);
		queryClient?.setQueryData(runtimeSettingsQueryOptions().queryKey, {
			update: { source: "update-server" },
		});
		await latest().refetch();
		await settle();
		expect(promptState?.opened).toBe(false);
	});

	test("a browser-to-NarraFork failure does not prompt or consume the check", async () => {
		configure("TIMEOUT");
		const check = api.checkUpdate;
		api.checkUpdate = async () => {
			throw new Error("API offline");
		};
		await mountAs("admin");
		expect(promptState?.opened).toBe(false);
		expect(localStorage.getItem("narrafork:first-github-update-check:u1")).toBeNull();
		api.checkUpdate = check;
		await latest().refetch();
		await settle();
		expect(promptState?.opened).toBe(true);
	});

	test("dismissal writes no settings and survives a remount", async () => {
		configure("NETWORK_ERROR");
		let writes = 0;
		api.updateSettings = async () => {
			writes++;
			return {};
		};
		await mountAs("admin");
		promptState?.dismiss();
		await settle();
		await latest().refetch();
		await settle();
		expect(promptState?.opened).toBe(false);
		root?.unmount();
		if (!container) throw new Error("harness container is missing");
		root = createRoot(container);
		await mountAs("admin");
		expect(promptState?.opened).toBe(false);
		expect(writes).toBe(0);
	});

	test("an administrator PATCH finishing after token replacement cannot seed the new user's runtime cache", async () => {
		configure("TIMEOUT");
		await mountAs("admin");
		expect(promptState?.opened).toBe(true);
		const complete = { managementOnly: true };
		queryClient?.setQueryData(["settings"], complete);
		let finish!: (value: Awaited<ReturnType<typeof api.updateRuntimeSettings>>) => void;
		let signal: AbortSignal | undefined;
		api.updateRuntimeSettings = async (_input, options) => {
			signal = (options as { signal?: AbortSignal } | undefined)?.signal;
			return new Promise((resolve) => {
				finish = resolve;
			});
		};
		const pending = promptState?.confirm();
		await settle();
		setToken("replacement-user");
		finish({
			revision: 2,
			agent: { defaultModel: "x", summaryModel: "x" },
			outline: { enabled: false },
			requestEvidence: { autoPin: "off" },
			summaryModelAvailable: true,
			update: { source: "update-server", serverUrl: "https://admin-private.example" },
		});
		await pending;
		await settle();
		expect(signal?.aborted).toBe(true);
		expect(queryClient?.getQueryData(runtimeSettingsQueryOptions().queryKey)).toBeUndefined();
		expect(queryClient?.getQueryData(["settings"])).toEqual(complete);
		expect(promptState?.opened).toBe(false);
	});
	test("confirmation patches only mirror fields, refreshes checks and preserves prepared state", async () => {
		configure("TIMEOUT");
		let payload: Record<string, unknown> | undefined;
		let saved = false;
		const settings = await api.getSettings();
		api.getSettings = async () =>
			saved
				? {
						update: {
							...settings.update,
							source: "update-server",
							serverUrl: OFFICIAL_UPDATE_SERVER_URL,
						},
					}
				: settings;
		api.updateSettings = async (data) => {
			payload = data;
			saved = true;
			return api.getSettings();
		};
		let checks = 0;
		api.checkUpdate = async () => {
			checks++;
			return {
				updateAvailable: false,
				currentVersion: "1.0.0",
				source: saved ? "update-server" : "github",
				errorCode: "TIMEOUT",
			};
		};
		const prepared = { ready: true, preparedIdentity: { id: "keep" } };
		queryClient?.setQueryData(["update-status", "1.1.0"], prepared);
		await mountAs("admin");
		expect(promptState?.opened).toBe(true);
		await promptState?.confirm();
		await settle();
		expect(payload).toEqual({
			expectedUpdateSettingsKey: updateSettingsKey(settings.update),
			update: {
				source: "update-server",
				serverUrl: OFFICIAL_UPDATE_SERVER_URL,
				product: "narrafork",
			},
		});
		expect(promptState?.opened).toBe(false);
		expect(checks).toBe(2);
		expect(queryClient?.getQueryData(runtimeSettingsQueryOptions().queryKey)).toEqual(
			await api.getSettings(),
		);
		expect(queryClient?.getQueryData(["update-status", "1.1.0"])).toEqual(prepared);
	});

	test("failed save keeps the dialog open and can be retried", async () => {
		configure("TIMEOUT");
		api.updateSettings = async () => {
			throw new Error("save failed");
		};
		await mountAs("admin");
		await promptState?.confirm();
		await settle();
		expect(promptState?.opened).toBe(true);
		expect(promptState?.error).toBe("updateMirrorSwitchFailed");
		expect(promptState?.saving).toBe(false);
		api.updateSettings = async () => ({ update: { source: "update-server" } });
		await promptState?.confirm();
		await settle();
		expect(promptState?.opened).toBe(false);
	});

	test("duplicate confirmation and dismissal cannot interrupt an in-flight save", async () => {
		configure("TIMEOUT");
		let writes = 0;
		let finish: ((value: Awaited<ReturnType<typeof api.updateSettings>>) => void) | undefined;
		api.updateSettings = () => {
			writes++;
			return new Promise((resolve) => {
				finish = resolve;
			});
		};
		await mountAs("admin");
		const first = promptState?.confirm();
		const second = promptState?.confirm();
		promptState?.dismiss();
		await settle();
		expect(writes).toBe(1);
		expect(promptState?.opened).toBe(true);
		expect(promptState?.saving).toBe(true);
		finish?.({ update: { source: "update-server" } });
		await Promise.all([first, second]);
		await settle();
		expect(promptState?.opened).toBe(false);
	});

	test("restricted localStorage does not break checks or repeat prompts within the mount", async () => {
		configure("TIMEOUT");
		const getItem = localStorage.getItem;
		localStorage.getItem = (key) => {
			if (key.startsWith("narrafork:first-github-update-check:")) throw new Error("storage denied");
			return getItem(key);
		};
		await mountAs("admin");
		expect(promptState?.opened).toBe(true);
		promptState?.dismiss();
		await settle();
		await latest().refetch();
		await settle();
		expect(promptState?.opened).toBe(false);
		localStorage.getItem = getItem;
	});

	test("a source changed between GET and PATCH is not overwritten and refreshes the cached settings", async () => {
		configure("TIMEOUT");
		let writes = 0;
		const concurrent = {
			update: { source: "update-server", serverUrl: "https://private.example" },
		};
		api.updateSettings = async (payload) => {
			writes++;
			expect(payload.expectedUpdateSettingsKey).toBe(latest().settingsKey);
			api.getSettings = async () => concurrent;
			throw new ApiError("Update settings changed", 409, { code: "UPDATE_SOURCE_CHANGED" });
		};
		await mountAs("admin");
		await promptState?.confirm();
		await settle();
		expect(writes).toBe(1);
		expect(promptState?.opened).toBe(true);
		expect(promptState?.error).toBe("updateSourceChanged");
		expect(queryClient?.getQueryData(runtimeSettingsQueryOptions().queryKey)).toEqual(concurrent);
	});

	test("rechecks settings before saving and refuses changed sources", async () => {
		configure("TIMEOUT");
		let writes = 0;
		api.updateSettings = async () => {
			writes++;
			return {};
		};
		await mountAs("admin");
		api.getSettings = async () => ({
			update: { source: "update-server", serverUrl: "https://private.example" },
		});
		await promptState?.confirm();
		await settle();
		expect(writes).toBe(0);
		expect(promptState?.error).toBe("updateSourceChanged");
	});
});
