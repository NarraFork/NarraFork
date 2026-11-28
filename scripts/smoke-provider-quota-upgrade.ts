import { randomUUID } from "node:crypto";
import { chmod, lstat, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { copyReleaseFile, hashReleaseFile, readReleaseText } from "./lib/ci-release-io";
import {
	assertQuotaSnapshot,
	assertSiteCredentialIsolation,
	createQuotaFixture,
	createSiteQuotaFixture,
	parseQuotaSmokeArgs,
	QuotaBrowserSmoke,
	type QuotaSmokeContext,
	readBoundedQuotaBody,
	smokeProviderQuota,
} from "./smoke-provider-quota";

const LEGACY = "com.narrafork.apikey-quota";
const QUOTA = "io.narrafork.provider-quota";
const RELAY = "quota-smoke-relay";
const SITE = "upgrade-site-account";
const MODEL = "quota-smoke:quota-smoke-model";
const MAX_EXE = 1024 ** 3;
const CHOICES = ["enabled", "disabled", "revoked", "removed"] as const;
type Choice = (typeof CHOICES)[number];
type Row = Record<string, unknown>;
function insist(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
function row(value: unknown): Row {
	insist(value && typeof value === "object" && !Array.isArray(value), "Expected API object");
	return value as Row;
}
function rows(value: unknown): Row[] {
	insist(Array.isArray(value), "Expected API array");
	return value.map(row);
}
function text(value: unknown): string {
	insist(typeof value === "string" && value.length > 0, "Missing fixture identity");
	return value;
}
const json = (c: QuotaSmokeContext, path: string, method = "GET", body?: unknown) =>
	c
		.require(path, {
			method,
			...(body === undefined
				? {}
				: { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		})
		.then(row);

export function upgradeOptions(args: readonly string[]) {
	const upgradeArgs = args.filter((arg) => arg.startsWith("--candidate="));
	insist(
		upgradeArgs.length === 1 && upgradeArgs[0]?.slice(12),
		"Pass exactly one --candidate=<executable>",
	);
	const options = parseQuotaSmokeArgs(args.filter((arg) => !arg.startsWith("--candidate=")));
	const candidate = resolve(upgradeArgs[0].slice(12));
	insist(
		!options.baseline && candidate !== options.binary,
		"Upgrade needs two distinct builds and full acceptance",
	);
	return { ...options, candidate };
}

async function artifact(binary: string) {
	const metadata = row(JSON.parse(await readReleaseText(`${binary}.metadata.json`, 64 * 1024)));
	const digest = await hashReleaseFile(binary, MAX_EXE, AbortSignal.timeout(30_000));
	insist(
		metadata.sha256 === digest.sha256 &&
			metadata.size === digest.size &&
			metadata.sha512 === digest.sha512,
		"Executable differs from its release sidecar",
	);
	const commit = text(metadata.commit);
	insist(/^[0-9a-f]{7,40}$/.test(commit), "Executable has no source identity");
	return { ...digest, commit, version: text(metadata.version) };
}
export function upgradeBuildReady(h: Row, build: { version: string; commit: string }): boolean {
	if (h.status === "starting" && h.commit === undefined) return false;
	insist(
		h.commit === build.commit && h.version === `${build.version}+${build.commit}`,
		"Unexpected build answering on the smoke port",
	);
	if (h.status === "recovering" || h.status === "starting") return false;
	insist(
		h.status === "ok" && (!h.readiness || h.readiness === "ready"),
		"Owned build did not recover successfully",
	);
	return true;
}
async function buildIdentity(c: QuotaSmokeContext, build: Awaited<ReturnType<typeof artifact>>) {
	await c.wait("expected build is ready", async () =>
		upgradeBuildReady(await json(c, "/api/health"), build) ? true : undefined,
	);
}

// Windows may spell an owned temp file with its short name. Compare actual regular-file identities, not basenames or directory prefixes.
export async function sameSmokeFile(recorded: string, owned: string): Promise<boolean> {
	if (
		!isAbsolute(recorded) ||
		!isAbsolute(owned) ||
		parse(recorded).root.toLowerCase() !== parse(owned).root.toLowerCase()
	)
		return false;
	const [a, b] = await Promise.all([
		lstat(recorded, { bigint: true }),
		lstat(owned, { bigint: true }),
	]);
	return a.isFile() && b.isFile() && a.ino > 0n && a.dev === b.dev && a.ino === b.ino;
}
/** The candidate may replace only the first executable copied by smokeProviderQuota, after a clean exit. */
async function stopOwned(c: QuotaSmokeContext) {
	const run = c.server;
	insist(run && run.child.status === undefined && !run.child.closed, "No live owned server");
	const origin = new URL(c.origin);
	const lock = row(
		JSON.parse(await readReleaseText(join(c.env.NARRAFORK_HOME, "narrafork.lock"), 16 * 1024)),
	);
	insist(
		origin.protocol === "http:" &&
			origin.hostname === "127.0.0.1" &&
			Number(origin.port) > 0 &&
			![7778, 7779, 41221].includes(Number(origin.port)),
		"Refusing non-test origin",
	);
	insist(
		lock.pid === run.child.process.pid,
		"Smoke server PID differs from the process we spawned",
	);
	insist(
		await sameSmokeFile(text(lock.dbPath), join(c.env.NARRAFORK_HOME, "narrafork.db")),
		"Instance lock points at a different database",
	);
	insist(
		await sameSmokeFile(text(lock.execPath), c.executable),
		"Instance lock points at a different executable",
	);
	const res = await c.http("/api/system/lifecycle/signal", { method: "POST" });
	insist(
		res.status === 202 && row(res.body).success === true,
		"Owned instance did not accept graceful shutdown",
	);
	await run.scope.until(
		"owned server exit and closed handles",
		() => (run.child.closed ? true : undefined),
		60_000,
	);
	insist(run.child.status === 0, "Owned server did not shut down cleanly");
	await run.scope.close();
	c.server = undefined;
}

export function verifyReplacementGrants(oldSet: Row, nextSet: Row) {
	insist(
		text(oldSet.installationId) !== text(nextSet.installationId),
		"Replacement reused legacy authorization identity",
	);
	const old = new Set(rows(oldSet.grants).map((v) => text(v.grantId)));
	const current = rows(nextSet.grants);
	insist(
		current
			.map((g) => g.capability)
			.sort()
			.join(",") === "provider.connection.request,quota.provide" &&
			current.every((g) => g.grantedBy === "system" && !old.has(text(g.grantId))),
		"Replacement copied or widened legacy grants",
	);
}

export function verifyRetainedGrants(oldSet: Row, nextSet: Row) {
	insist(
		oldSet.installationId === nextSet.installationId,
		"Existing installation identity changed",
	);
	insist(oldSet.revision === nextSet.revision, "Existing grant revision changed");
	const normalize = (value: Row) =>
		rows(value.grants)
			.map((grant) => ({
				grantId: grant.grantId,
				capability: grant.capability,
				scope: grant.scope,
				constraints: grant.constraints,
				grantedBy: grant.grantedBy,
				revision: grant.revision,
			}))
			.sort((a, b) => String(a.grantId).localeCompare(String(b.grantId)));
	insist(
		JSON.stringify(normalize(oldSet)) === JSON.stringify(normalize(nextSet)),
		"Existing grants were replaced or widened",
	);
}

// Read the public shell outside the browser; the evidence tab keeps its original cache and session untouched.
async function servedEntry(c: QuotaSmokeContext): Promise<string> {
	const signal = AbortSignal.any([c.signal, AbortSignal.timeout(15_000)]);
	const response = await fetch(`${c.origin}/`, { signal, redirect: "error" });
	insist(response.ok, "Could not identify the currently served application shell");
	const html = await readBoundedQuotaBody(response, 128 * 1024, signal);
	const entries = [...html.matchAll(/<script\b[^>]{0,512}>/gi)]
		.map((m) => m[0])
		.filter((tag) => /\btype=["']module["']/i.test(tag))
		.map((tag) => /\bsrc=["']\.\/(assets\/[\w.-]+\.js)["']/i.exec(tag)?.[1])
		.filter((path): path is string => !!path);
	insist(
		entries.length === 1,
		"Expected one versioned main module in the served application shell",
	);
	return `/${entries[0]}`;
}
async function screenshot(
	page: Page,
	c: QuotaSmokeContext,
	name: string,
	path: string | null,
	expected: readonly string[],
) {
	const entry = await servedEntry(c);
	const target = new URL(path ?? page.url(), c.origin);
	insist(target.origin === c.origin, "Unexpected browser evidence target");
	await page.bringToFront();
	try {
		// Visibility may trigger the original application's version-monitor reload.
		// Observe its result before navigating; do not race a document replacement.
		await page.waitForFunction(
			(asset: string) =>
				[...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].some(
					(s) => new URL(s.src).pathname === asset,
				) && document.readyState === "complete",
			{ timeout: 30_000, polling: 100 },
			entry,
		);
		if (path) {
			const response = await page.goto(target.href, {
				waitUntil: "domcontentloaded",
				timeout: 30_000,
			});
			// A client-side navigation can return null. In either case require the new document's route, main bundle and live UI below.
			if (response && !response.ok())
				throw new Error(`Could not open ${name}: HTTP ${response.status()}`);
		}
		await page.waitForFunction(
			(url: string, asset: string, terms: string[]) => {
				const current = new URL(location.href),
					wanted = new URL(url);
				// The original application's own version monitor can append this nonce on upgrade.
				if (!wanted.searchParams.has("_nf_reload") && current.searchParams.has("_nf_reload")) {
					const values = current.searchParams.getAll("_nf_reload");
					if (values.length !== 1 || !/^\d{13}-[a-f0-9]+$/i.test(values[0] ?? "")) return false;
					current.searchParams.delete("_nf_reload");
				}
				return (
					current.href === wanted.href &&
					[...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].some(
						(s) => new URL(s.src).origin === wanted.origin && new URL(s.src).pathname === asset,
					) &&
					terms.every((s) => document.body.innerText.includes(s))
				);
			},
			{ timeout: 30_000, polling: 100 },
			target.href,
			entry,
			[...expected],
		);
	} catch (error) {
		await c.artifact(`${name}-diagnostic.json`, {
			route: new URL(page.url()).pathname,
			expectedRoute: target.pathname,
			expectedAsset: entry,
			actualAssets: await page.evaluate(() =>
				[...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
					.slice(0, 8)
					.map((s) => new URL(s.src).pathname),
			),
			text: await page.evaluate(() => document.body.innerText.slice(0, 4096)),
		});
		throw error;
	}
	const visible = await page.evaluate(() =>
		[
			document.body.innerText,
			...Array.from(
				document.querySelectorAll('input:not([type="password"]),textarea'),
				(el) => (el as HTMLInputElement).value,
			),
		]
			.join("\n")
			.slice(0, 256 * 1024),
	);
	insist(
		!c.secrets.some((s) => s && visible.includes(s)),
		"A test credential is visible; screenshot withheld",
	);
	const bytes = await page.screenshot({ type: "png", fullPage: false });
	insist(bytes.byteLength <= 4 * 1024 ** 2, "Screenshot exceeds budget");
	await writeFile(join(c.options.out, `${name}.png`), bytes, { flag: "wx", mode: 0o600 });
	c.check(`browser ${name}`, {
		route: target.pathname,
		entry,
		appReloadNonce: new URL(page.url()).searchParams.has("_nf_reload"),
	});
}

async function legacyBalance(c: QuotaSmokeContext, provider: string, remaining: number) {
	const result = await c.http(`/api/provider-balances/${provider}/probe`, { method: "POST" });
	insist(result.ok || result.status === 429, "Legacy quota probe rejected saved provider");
	await c.wait("old saved account quota", async () => {
		const snapshot = (await json(c, `/api/provider-balances?providerId=${provider}`))[provider];
		if (!snapshot || row(snapshot).status !== "supported") return undefined;
		return rows(row(row(snapshot).balance).amounts).some(
			(a) => a.unit === "USD" && a.remaining === remaining,
		)
			? true
			: undefined;
	});
}
async function snapshot(c: QuotaSmokeContext, provider: string) {
	return rows(
		(await json(c, `/api/provider-quotas?providerId=${provider}&limit=10`)).snapshots,
	).find((v) => v.providerId === provider);
}

async function verifyReinstallAndEdits(
	c: QuotaSmokeContext,
	site: ReturnType<typeof createSiteQuotaFixture>,
	siteRoot: string,
	account: string,
	page?: Page,
) {
	const restartReady = async () => {
		await stopOwned(c);
		await c.start();
		await c.wait("restarted candidate ready", async () => {
			const health = await json(c, "/api/health");
			return health.status === "ok" && (!health.readiness || health.readiness === "ready")
				? true
				: undefined;
		});
	};
	c.stage = "explicit reinstall requires new permissions and preserved binding";
	const previous = await c.plugin();
	if (previous) await json(c, `/api/plugins/${QUOTA}/uninstall`, "POST");
	insist((await c.upload("explicit latest quota reinstall")).ok, "Explicit reinstall failed");
	const plugin = await json(c, `/api/plugins/${QUOTA}`);
	insist(row(plugin.current).version === "1.0.4", "Reinstall archive is not 1.0.4");
	let grants = await json(c, `/api/plugins/${QUOTA}/grants`);
	insist(
		rows(grants.grants).every((g) => !String(g.capability).startsWith("provider.settings.")),
		"Install granted a new settings capability",
	);
	const query = `kind=custom-api&id=${SITE}`;
	const endpoint = `/api/provider-settings/${QUOTA}/site-account?${query}`;
	const readView = async () =>
		c.wait("saved extension after plugin initialization", async () => {
			const extension = rows((await json(c, `/api/provider-settings?${query}`)).extensions).find(
				(v) => v.pluginId === QUOTA && v.contributionId === "site-account",
			);
			return extension?.config ? row(extension.config) : undefined;
		});
	let view = await readView();
	const confirmation = () => ({
		expectedRevision: view.revision,
		schemaFingerprint: view.schemaFingerprint,
		expectedBindingRevision: view.bindingRevision,
	});
	if (view.status === "dormant") {
		await json(
			c,
			`/api/provider-settings/${QUOTA}/site-account/rebind?${query}`,
			"POST",
			confirmation(),
		);
		view = await readView();
	}
	insist(
		row(row(view.secrets).token).isSet === true &&
			row(view.values).siteUrl === siteRoot &&
			row(view.values).userId === "424242",
		"Reinstall lost site credentials or account identity",
	);
	verifyRetainedGrants(grants, await json(c, `/api/plugins/${QUOTA}/grants`));
	await json(c, `/api/plugins/${QUOTA}/enable`, "POST");
	await json(c, `/api/plugins/${QUOTA}/activate`, "POST");
	verifyRetainedGrants(grants, await json(c, `/api/plugins/${QUOTA}/grants`));
	const blocked = await snapshot(c, SITE);
	insist(!blocked?.data, "Unapproved new settings capability exposed quota");
	const requests = site.evidence().requests;
	await json(c, `/api/plugins/${QUOTA}/grants`, "PUT", {
		expectedRevision: grants.revision,
		grants: [
			...rows(grants.grants).map((g) => ({
				capability: g.capability,
				scope: g.scope,
				constraints: g.constraints,
				expiresAt: g.expiresAt,
				grantId: g.grantId,
			})),
			...["provider.settings.read_self", "provider.settings.connection.use"].map((capability) => ({
				capability,
				scope: { type: "global" },
			})),
		],
	});
	grants = await json(c, `/api/plugins/${QUOTA}/grants`);
	await json(c, `/api/plugins/${QUOTA}/activate`, "POST");
	const refresh = async (balance: number) => {
		const result = await c.http(`/api/provider-quotas/${SITE}/refresh`, { method: "POST" });
		insist(result.ok || result.status === 429, "Explicit account refresh rejected");
		await c.wait("fresh site quota after explicit reinstall or edit", async () => {
			const value = await snapshot(c, SITE);
			return value?.status === "supported" &&
				value.stale === false &&
				value.data &&
				rows(row(value.data).amounts).some((a) => a.remaining === balance)
				? true
				: undefined;
		});
	};
	await refresh(42.56);
	insist(site.evidence().requests > requests, "Reinstall only returned old cached data");
	assertSiteCredentialIsolation(site.evidence().records);
	c.check(c.stage, { explicitNewGrants: true, preservedCredentialWithoutReentry: true });
	if (page) {
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForSelector('[data-testid="provider-settings-site-account"]');
		await page.$eval('[data-testid="provider-settings-site-account"]', (element) =>
			element.scrollIntoView({ block: "center" }),
		);
		await screenshot(page, c, "05-reinstalled-extension", null, [
			"供应商扩展",
			QUOTA.toUpperCase(),
		]);
	}
	c.stage = "post-migration edits preserve explicit secret intent";
	view = await readView();
	const save = async (values: Row, operation: "keep" | "clear") => {
		view = await json(c, endpoint, "PUT", {
			schemaVersion: 1,
			...confirmation(),
			values,
			secrets: { token: { operation } },
		});
	};
	const changedAccount = await c.http(endpoint, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			schemaVersion: 1,
			...confirmation(),
			values: { ...row(view.values), userId: "different-account" },
			secrets: { token: { operation: "keep" } },
		}),
	});
	insist(
		changedAccount.status === 409,
		"Account change retained an old secret without confirmation",
	);
	const originalValues = row(view.values);
	site.setRemaining(43.21);
	await save({ ...originalValues, useSiteAccount: false }, "keep");
	await save(originalValues, "keep");
	await refresh(43.21);
	await restartReady();
	insist(
		(await json(c, "/api/auth/me")).id === account,
		"Original login no longer works after edits",
	);
	verifyRetainedGrants(grants, await json(c, `/api/plugins/${QUOTA}/grants`));
	view = await readView();
	insist(row(row(view.secrets).token).isSet === true, "Edited secret disappeared after restart");
	await refresh(43.21);
	c.check(c.stage);
	c.stage = "explicit clear and deletion survive restart without legacy resurrection";
	await save(row(view.values), "clear");
	insist(row(row(view.secrets).token).isSet === false, "Secret clear was not persisted");
	const clearedRequests = site.evidence().requests;
	await json(c, endpoint, "DELETE", { expectedRevision: view.revision });
	await restartReady();
	view = await readView();
	insist(
		row(row(view.secrets).token).isSet === false,
		"Deleted secret resurrected from legacy files",
	);
	insist(
		site.evidence().requests === clearedRequests,
		"Deleted site credentials produced requests after restart",
	);
	insist((await json(c, "/api/auth/me")).id === account, "Original login lost after deletion");
	c.check(c.stage);
}

async function exercise(
	c: QuotaSmokeContext,
	choice: Choice,
	candidate: string,
	old: Awaited<ReturnType<typeof artifact>>,
	next: Awaited<ReturnType<typeof artifact>>,
) {
	c.report.artifacts.original = old;
	c.report.artifacts.candidate = next;
	c.report.artifacts.choice = choice;
	c.report.expectedVersion = "1.0.4";
	const legacyBaseline = old.commit.startsWith("7a77c8306");
	const baselineId = legacyBaseline ? LEGACY : QUOTA;
	c.report.artifacts.baselinePlugin = baselineId;
	c.stage = "original binary and original bundled plugin";
	await buildIdentity(c, old);
	const p = await c.wait(
		"original bundled plugin initialized",
		async () => {
			const response = await c.http(`/api/plugins/${baselineId}`);
			if (response.status === 404) return undefined;
			insist(response.ok, "Original plugin status failed");
			const plugin = row(response.body);
			return plugin.desiredState === "enabled" &&
				(legacyBaseline ? plugin.builtin === true : plugin.runtimeState === "active")
				? plugin
				: undefined;
		},
		90000,
	);
	insist(
		p.desiredState === "enabled" &&
			(p.version === (legacyBaseline ? "1.0.0" : "1.0.3") ||
				(p.current && row(p.current).version === (legacyBaseline ? "1.0.0" : "1.0.3"))),
		"Missing baseline bundled plugin",
	);
	if (legacyBaseline)
		insist(
			(await c.http(`/api/plugins/${QUOTA}`)).status === 404,
			"Baseline already contains replacement",
		);
	const oldGrants = await json(c, `/api/plugins/${baselineId}/grants`);
	insist(
		rows(oldGrants.grants)
			.map((g) => g.capability)
			.sort()
			.join(",") ===
			(legacyBaseline ? "provider.use" : "provider.connection.request,quota.provide"),
		"Unexpected original grant set",
	);
	c.check(c.stage);
	c.stage = "data created by original host";
	const account = text((await json(c, "/api/auth/me")).id);
	await json(c, "/api/user-preferences", "PATCH", {
		language: "zh-CN",
		setupWizardCompleted: true,
	});
	const key = `upgrade_key_${randomUUID()}`,
		reserveKey = `upgrade_spare_${randomUUID()}`,
		siteToken = `upgrade_wallet_${randomUUID()}`;
	c.secrets.push(key, reserveKey, siteToken);
	const fail = (error: Error) => c.controller.abort(error);
	const relay = createQuotaFixture(key, c.signal, fail);
	c.fixture = relay;
	const site = createSiteQuotaFixture(
		{ accessToken: siteToken, userId: "424242", inferenceSecrets: [key, reserveKey] },
		c.signal,
		fail,
	);
	c.siteFixture = site;
	const config = {
		id: RELAY,
		name: "Quota smoke relay",
		prefix: "quota-smoke",
		baseUrl: `${relay.origin}/v1`,
		apiKey: "",
		protocol: "completions-compatible",
		defaultModel: "quota-smoke-model",
		proxy: { mode: "direct" },
	};
	await json(c, "/api/settings", "PATCH", {
		customApiProviders: [
			config,
			{
				...config,
				id: SITE,
				name: "Upgrade wallet",
				prefix: "upgrade-site",
				apiKey: key,
				quotaSiteUrl: site.origin,
				quotaUserId: "424242",
				quotaAccessToken: siteToken,
			},
		],
		agent: { defaultModel: MODEL },
	});
	const keyPath = `/api/provider-keys/${RELAY}`;
	const first = text(
		row((await json(c, keyPath, "POST", { apiKey: key, label: "Upgrade primary" })).key).id,
	);
	const spare = text(
		row((await json(c, keyPath, "POST", { apiKey: reserveKey, label: "Upgrade spare" })).key).id,
	);
	await json(c, `/api/provider-keys/key/${spare}`, "PATCH", { disabled: true });
	await json(c, `/api/openai/providers/${RELAY}/models/refresh`, "POST");
	const title = "额度升级验收会话";
	const narrator = text(
		(await json(c, "/api/narrators", "POST", { title, cwd: c.cwd, model: MODEL })).id,
	);
	const draftPrefs = async () => {
		const me = await json(c, "/api/auth/me"),
			prefs = await json(c, "/api/user-preferences"),
			n = await json(c, `/api/narrators/${narrator}`);
		insist(
			me.id === account &&
				prefs.language === "zh-CN" &&
				prefs.setupWizardCompleted === true &&
				n.id === narrator &&
				n.title === title &&
				n.model === MODEL,
			"Original account, preferences or saved narrator changed",
		);
		const s = await json(c, "/api/settings"),
			providers = rows(s.customApiProviders),
			wallet = providers.find((v) => v.id === SITE);
		insist(
			row(s.agent).defaultModel === MODEL &&
				providers.find((v) => v.id === RELAY)?.prefix === config.prefix &&
				wallet?.quotaSiteUrl === site.origin &&
				wallet.quotaUserId === "424242" &&
				/^\*/.test(text(wallet.quotaAccessToken)) &&
				![key, reserveKey, siteToken].some((v) => JSON.stringify(s).includes(v)),
			"Migrated settings lost identities or disclosed secrets",
		);
		const keys = rows((await json(c, keyPath)).keys);
		insist(
			keys.length === 2 &&
				keys[0]?.id === first &&
				keys[0].disabled === false &&
				keys[1]?.id === spare &&
				keys[1].disabled === true &&
				keys.every((k) => k.apiKey === undefined),
			"Key order, identity or disabled choice changed",
		);
	};
	await draftPrefs();
	await legacyBalance(c, RELAY, 12.34);
	await legacyBalance(c, SITE, 31.27);
	assertSiteCredentialIsolation(site.evidence().records);
	c.check(c.stage);
	if (choice === "disabled") {
		await json(c, `/api/plugins/${baselineId}/disable`, "POST");
		insist(
			(await json(c, `/api/plugins/${baselineId}`)).desiredState === "disabled",
			"Legacy disable was not persisted",
		);
	}
	if (choice === "revoked") {
		await json(c, `/api/plugins/${baselineId}/grants/revoke`, "POST", {
			expectedRevision: oldGrants.revision,
			grantIds: rows(oldGrants.grants).map((g) => g.grantId),
		});
		insist(
			rows((await json(c, `/api/plugins/${baselineId}/grants`)).grants).length === 0,
			"Legacy grant not revoked",
		);
	}
	if (choice === "removed") {
		await json(c, `/api/plugins/${baselineId}/uninstall`, "POST");
		const state = row(
			JSON.parse(
				await readReleaseText(join(c.env.NARRAFORK_HOME, "plugins", "state.json"), 4 * 1024 ** 2),
			),
		);
		insist(
			row(state.plugins)[baselineId] === undefined,
			"Original uninstall left installed state behind",
		);
	}
	const handoffGrants =
		choice === "removed" ? undefined : await json(c, `/api/plugins/${baselineId}/grants`);
	let page: Page | undefined;
	if (choice === "enabled") {
		c.stage = "original browser session";
		const browser = new QuotaBrowserSmoke(c, narrator);
		await browser.start();
		// The old host serves the detail view via client navigation; a direct URL with a dotted ID is not an old SPA entry point.
		const seed = await browser.newPage("zh-CN");
		await seed.goto(`${c.origin}/settings/plugins`, { waitUntil: "domcontentloaded" });
		await seed.waitForFunction(
			(id) => document.body.innerText.includes(id),
			{ polling: 100 },
			baselineId,
		);
		page = await browser.newPage("zh-CN", { seedSession: false });
		await seed.close();
		await page.bringToFront();
		await page.goto(`${c.origin}/settings/plugins`, { waitUntil: "domcontentloaded" });
		const legacyRow = await page.waitForFunction(
			(id) =>
				[...document.querySelectorAll("tr")].find((tr) =>
					tr.querySelector("td")?.innerText.includes(id),
				),
			{ polling: 100 },
			baselineId,
		);
		const element = legacyRow.asElement();
		insist(element, "Legacy plugin row was not rendered for the signed-in session");
		await element.click();
		await page.waitForFunction(
			(id) => location.pathname === `/settings/plugins/${id}`,
			{ polling: 100 },
			baselineId,
		);
		await screenshot(page, c, "01-original-plugin", null, [
			baselineId,
			legacyBaseline ? "1.0.0" : "1.0.3",
		]);
		await screenshot(page, c, "01-original-wallet", `/settings/providers?provider=${SITE}`, [
			"Upgrade wallet",
			"USD 31.27",
		]);
		c.check(c.stage);
	}
	c.stage = "graceful handoff in the same data directory";
	const db = join(c.env.NARRAFORK_HOME, "narrafork.db");
	const before = await lstat(db, { bigint: true });
	insist(before.isFile() && before.ino > 0n, "No identifiable original database");
	const staging = join(c.cwd, "candidate.next");
	await copyReleaseFile(candidate, staging, MAX_EXE, c.signal);
	insist(
		(await hashReleaseFile(staging, MAX_EXE, c.signal)).sha256 === next.sha256,
		"Staged candidate hash mismatch",
	);
	if (process.platform !== "win32") await chmod(staging, 0o700);
	await stopOwned(c);
	await rename(c.executable, join(c.cwd, "original.previous"));
	await rename(staging, c.executable);
	relay.setRemaining(23.45);
	site.setRemaining(42.56);
	const oldCounts = {
		key: relay.evidence().counts["/api/usage/token/"] ?? 0,
		wallet: site.evidence().requests,
	};
	const verify = async () => {
		await buildIdentity(c, next);
		const after = await lstat(db, { bigint: true });
		insist(
			after.dev === before.dev && after.ino === before.ino,
			"Replaced database instead of migrating in place",
		);
		await draftPrefs();
		if (choice === "enabled") {
			await c.wait("new quota runtime active", async () => {
				const v = await c.plugin();
				return v?.runtimeState === "active" &&
					v.desiredState === "enabled" &&
					row(v.current).version === "1.0.3"
					? true
					: undefined;
			});
			const g = await json(c, `/api/plugins/${QUOTA}/grants`);
			if (legacyBaseline) verifyReplacementGrants(oldGrants, g);
			else verifyRetainedGrants(oldGrants, g);
			for (const [pid, value] of [
				[RELAY, 23.45],
				[SITE, 42.56],
			] as const) {
				const admitted = await c.http(`/api/provider-quotas/${pid}/refresh`, { method: "POST" });
				insist(admitted.ok || admitted.status === 429, "Refresh rejected migrated provider");
				await c.wait("fresh post-upgrade quota", async () => {
					const v = await snapshot(c, pid);
					if (
						!v ||
						v.status !== "supported" ||
						!v.data ||
						!rows(row(v.data).amounts).some((a) => a.unit === "USD" && a.remaining === value)
					)
						return undefined;
					insist(
						v.stale === false && v.error === null && text(v.sourceId).startsWith(`${QUOTA}/`),
						"Not a live replacement-plugin result",
					);
					if (pid === RELAY) {
						assertQuotaSnapshot(v, value);
						insist(v.keyId === first, "Wrong key subject");
					} else
						insist(
							v.keyId === undefined &&
								v.pushCompatible === false &&
								row(v.data).format === "new-api-user",
							"Wrong site subject",
						);
					return true;
				});
			}
			insist(
				(relay.evidence().counts["/api/usage/token/"] ?? 0) > oldCounts.key &&
					site.evidence().requests > oldCounts.wallet,
				"Old cached balance mistaken for post-upgrade traffic",
			);
			assertSiteCredentialIsolation(site.evidence().records);
			return text(g.installationId);
		}
		if (!legacyBaseline && choice !== "removed") {
			const retained = await json(c, `/api/plugins/${QUOTA}`);
			insist(
				retained.desiredState === (choice === "disabled" ? "disabled" : "enabled"),
				"Saved lifecycle choice changed",
			);
			insist(handoffGrants, "Missing handoff authority");
			verifyRetainedGrants(handoffGrants, await json(c, `/api/plugins/${QUOTA}/grants`));
		} else {
			// A missing runtime alone is not evidence: wait for the new host to have completed and recorded its migration.
			await c.wait("persisted refusal decision", async () => {
				const path = join(c.env.NARRAFORK_HOME, "plugins", "state.json");
				const state = row(JSON.parse(await readReleaseText(path, 4 * 1024 ** 2)));
				// Original uninstall predates the new tombstone: its revoked installation authority preserves the refusal.
				const mark = state.bundledBootstrap && row(state.bundledBootstrap)[QUOTA];
				if (!mark) return undefined;
				const m = row(mark);
				insist(
					m.status === "removed" &&
						(!legacyBaseline ||
							(m.inheritedFrom === LEGACY &&
								m.defaultChoice === (choice === "removed" ? "revoked" : choice))),
					"Incorrect inherited refusal",
				);
				return true;
			});
			insist((await c.plugin()) === null, "Suppressed plugin was installed");
			const catalog = rows((await json(c, "/api/plugins/builtins")).builtins).find(
				(v) => v.pluginId === QUOTA,
			);
			insist(
				catalog?.installed === false && catalog.canInstall === true,
				"Operator cannot explicitly reinstall",
			);
		}
		for (const id of [RELAY, SITE]) {
			await c.wait("refused quota scheduler initialized", async () => {
				const value = await snapshot(c, id);
				if (!value) return undefined;
				insist(
					value.data === null && value.sourceId === null,
					"A refused source exposed old quota values",
				);
				insist(
					(relay.evidence().counts["/api/usage/token/"] ?? 0) === oldCounts.key &&
						site.evidence().requests === oldCounts.wallet,
					"A refused source performed quota requests during startup",
				);
				return value.status === "unavailable" ? true : undefined;
			});
		}
		insist(
			(relay.evidence().counts["/api/usage/token/"] ?? 0) === oldCounts.key &&
				site.evidence().requests === oldCounts.wallet,
			"A refused source still performed quota requests",
		);
		return undefined;
	};
	await c.start();
	const installed = await verify();
	c.check(c.stage, { sameDatabase: true, originalSessionAccepted: true, choice });
	if (page) {
		c.stage = "upgraded browser without logging in again";
		if (old.commit === next.commit) {
			await page.evaluate(async () => {
				for (const registration of await navigator.serviceWorker.getRegistrations()) {
					await registration.update();
					const worker = registration.installing ?? registration.waiting;
					if (worker && worker.state !== "activated")
						await new Promise<void>((resolve, reject) => {
							const timer = setTimeout(() => {
								worker.removeEventListener("statechange", check);
								reject(Error("Updated service worker activation timed out"));
							}, 20000);
							const check = () => {
								if (worker.state === "activated" || worker.state === "redundant") {
									clearTimeout(timer);
									worker.removeEventListener("statechange", check);
									worker.state === "activated"
										? resolve()
										: reject(Error("Updated service worker became redundant"));
								}
							};
							worker.addEventListener("statechange", check);
							check();
						});
				}
			});
			await page.reload({ waitUntil: "domcontentloaded" });
			c.check("same-commit frontend refreshed through normal service worker update", {
				sessionStorageUnchanged: true,
			});
		}
		await screenshot(page, c, "02-upgraded-plugin", `/settings/plugins/${QUOTA}`, [QUOTA, "1.0.3"]);
		await screenshot(page, c, "03-upgraded-wallet", `/settings/providers?provider=${SITE}`, [
			"USD 42.56",
		]);
		await page.waitForSelector('[data-testid="provider-settings-site-account"]');
		await page.$eval('[data-testid="provider-settings-site-account"]', (element) =>
			element.scrollIntoView({ block: "center" }),
		);
		await screenshot(page, c, "04-upgraded-extension", null, ["供应商扩展", QUOTA.toUpperCase()]);
		c.check(c.stage);
	}
	c.stage = "second candidate boot is idempotent";
	await stopOwned(c);
	await c.start();
	insist((await verify()) === installed, "Fresh boot created a different installation identity");
	c.check(c.stage, { choice });
	await verifyReinstallAndEdits(c, site, site.origin, account, page);
	await page?.close();
	await stopOwned(c);
	insist(
		(await hashReleaseFile(c.executable, MAX_EXE, c.signal)).sha256 === next.sha256 &&
			(await hashReleaseFile(candidate, MAX_EXE, c.signal)).sha256 === next.sha256,
		"Candidate changed after boot",
	);
	c.check("all owned server processes closed cleanly");
}

export async function smokeQuotaUpgrade(args: readonly string[]) {
	const { candidate, ...options } = upgradeOptions(args);
	const old = await artifact(options.binary),
		next = await artifact(candidate);
	insist(
		old.sha256 !== next.sha256 &&
			(old.commit.startsWith("7a77c8306") || old.commit.startsWith("cfd067361")),
		"Expected one of the two unmodified baseline builds and a distinct candidate binary",
	);
	const { mkdir } = await import("node:fs/promises");
	await mkdir(options.out, { mode: 0o700 });
	for (const choice of CHOICES) {
		const report = await smokeProviderQuota(
			{ ...options, out: join(options.out, choice) },
			undefined,
			(c) => exercise(c, choice, candidate, old, next),
		);
		insist(
			report.finalAcceptance && report.checks.every((v) => v.status === "passed"),
			"Incomplete native upgrade scenario",
		);
	}
	return { status: "passed", choices: CHOICES, original: old, candidate: next };
}
if (import.meta.main) {
	try {
		console.log(JSON.stringify(await smokeQuotaUpgrade(process.argv.slice(2))));
	} catch (error) {
		console.error(String(error));
		process.exitCode = 1;
	}
}
