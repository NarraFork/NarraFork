import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import type { Page } from "puppeteer-core";
import { createPluginSourceFeed } from "../server/lib/plugins/source-feed";
import { publishPluginSource } from "./publish-plugin-source";
import {
	parseQuotaSmokeArgs,
	QuotaBrowserSmoke,
	type QuotaSmokeContext,
	smokeProviderQuota,
} from "./smoke-provider-quota";

const ID = "com.example.provider";
const REFERENCE_ROOT = resolve(
	import.meta.dir,
	"../tests/fixtures/plugins/e2e/reference-provider-rpc",
);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "manual_required"]);
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected object");
	return value as Record<string, unknown>;
}
async function fixtureArchive(root: string, version: string): Promise<string> {
	const manifest = JSON.parse(await readFile(join(REFERENCE_ROOT, "manifest.json"), "utf8"));
	manifest.version = version;
	const source = (await readFile(join(REFERENCE_ROOT, "server/index.js"), "utf8")).replace(
		'const PLUGIN_VERSION = "1.0.1";',
		`const PLUGIN_VERSION = "${version}";`,
	);
	const archive = join(root, `provider-${version}.nfplugin`);
	const zip = archiver("zip", { zlib: { level: 9 } });
	const done = pipeline(zip, createWriteStream(archive, { flags: "wx", mode: 0o600 }));
	zip.append(JSON.stringify(manifest), {
		name: "manifest.json",
		date: new Date("2000-01-01T00:00:00Z"),
	});
	zip.append(source, { name: "server/index.js", date: new Date("2000-01-01T00:00:00Z") });
	for (const name of ["ui/provider-settings.iife.js", "ui/provider-settings.css"])
		zip.append(await readFile(join(REFERENCE_ROOT, name)), {
			name,
			date: new Date("2000-01-01T00:00:00Z"),
		});
	await zip.finalize();
	await done;
	return archive;
}
async function json(context: QuotaSmokeContext, path: string, method = "GET", value?: unknown) {
	return object(
		await context.require(path, {
			method,
			...(value === undefined
				? {}
				: { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }),
		}),
	);
}
async function job(context: QuotaSmokeContext, id: unknown) {
	if (typeof id !== "string") throw new Error("Missing update job ID");
	return context.wait(
		"plugin source job",
		async () => {
			const current = await json(context, `/api/plugins/update-jobs/${id}`);
			return TERMINAL.has(String(current.status)) ? current : undefined;
		},
		60000,
	);
}
async function clickText(page: Page, text: string) {
	await page.waitForFunction(
		(text) =>
			[...document.querySelectorAll("button")].some(
				(button) => button.textContent?.trim() === text && !button.disabled,
			),
		{ polling: 100 },
		text,
	);
	await page.evaluate((text) => {
		const button = [...document.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === text && !button.disabled,
		);
		if (!button) throw new Error("Expected enabled button");
		button.click();
	}, text);
}

export async function runPluginSourceAcceptance(context: QuotaSmokeContext): Promise<void> {
	const packages = join(context.root, "source-fixture");
	await mkdir(packages, { mode: 0o700 });
	const oldArchive = await fixtureArchive(packages, "1.0.1");
	const newArchive = await fixtureArchive(packages, "1.0.2");
	const publicRoot = join(packages, "public");
	const feedHolder: { fetch?: (request: Request) => Response | Promise<Response> } = {};
	const feed = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: 1024,
		idleTimeout: 30,
		fetch: (request) => feedHolder.fetch?.(request) ?? new Response("Not ready", { status: 503 }),
	});
	const origin = `http://127.0.0.1:${feed.port}`;
	const browser = new QuotaBrowserSmoke(context, "source-validation");
	let page: Page | undefined;
	try {
		await publishPluginSource({
			archive: newArchive,
			root: publicRoot,
			pluginId: ID,
			publicOrigin: origin,
			signal: context.signal,
		});
		const app = await createPluginSourceFeed({ root: publicRoot, publicOrigin: origin });
		feedHolder.fetch = app.fetch;
		context.stage = "legacy source-free provider installation";
		const form = new FormData();
		form.set(
			"archive",
			new File([new Uint8Array(await readFile(oldArchive))], "legacy.nfplugin", {
				type: "application/zip",
			}),
		);
		await context.require("/api/plugins/install", { method: "POST", body: form });
		await json(context, `/api/plugins/${ID}/enable`, "POST");
		await json(context, `/api/plugins/${ID}/activate`, "POST");
		let status = await json(context, `/api/plugins/${ID}`);
		const permissionsBefore = await json(context, `/api/plugins/${ID}/grants`);
		let source = await json(context, `/api/plugins/${ID}/source`);
		if (
			object(status.current).version !== "1.0.1" ||
			status.runtimeState !== "active" ||
			object(source.binding).source !== null
		)
			throw new Error("Legacy source-free provider lost its normal install/activation behavior");
		context.check(context.stage, {
			version: object(status.current).version,
			runtimeState: status.runtimeState,
			source: object(source.binding).source,
		});
		context.stage = "bind explicit website source with no guessed homepage";
		source = await json(context, `/api/plugins/${ID}/source`, "PUT", {
			source: {
				type: "website",
				allowInsecureHttp: true,
				updateApi: `${origin}/v1/plugins/${ID}/latest`,
			},
			expectedRevision: object(source.binding).revision,
		});
		if (
			object(source.binding).autoUpdate !== false ||
			object(object(source.binding).source).homepage !== undefined
		)
			throw new Error("Source binding invented automatic update or a homepage");
		await json(context, "/api/user-preferences", "PATCH", {
			setupWizardCompleted: true,
			language: "en",
		});
		await browser.start();
		page = await browser.newPage("en");
		await page.goto(`${context.origin}/settings/plugins/${ID}`, { waitUntil: "domcontentloaded" });
		await clickText(page, "Source & updates");
		await page.waitForSelector(`[data-plugin-update-panel="${ID}"]`);
		context.check(context.stage);
		context.stage = "real browser check and apply website release";
		const checked = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === `/api/plugins/${ID}/updates/check` &&
				response.request().method() === "POST",
			{ timeout: 15000 },
		);
		void checked.catch(() => {});
		await clickText(page, "Check release updates");
		const checkResponse = await checked;
		if (checkResponse.status() !== 202) throw new Error("Release check UI did not create a job");
		const checkJob = await job(context, object(await checkResponse.json()).jobId);
		if (checkJob.status !== "succeeded")
			throw new Error(`Release check failed: ${String(checkJob.error)}`);
		const applying = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === `/api/plugins/${ID}/updates/apply` &&
				response.request().method() === "POST",
			{ timeout: 15000 },
		);
		void applying.catch(() => {});
		await clickText(page, "Update plugin");
		const applyResponse = await applying;
		if (applyResponse.status() !== 202) throw new Error("Release apply UI did not create a job");
		const applyJob = await job(context, object(await applyResponse.json()).jobId);
		if (applyJob.status !== "succeeded")
			throw new Error(`Release update failed: ${String(applyJob.error)}`);
		status = await json(context, `/api/plugins/${ID}`);
		const permissionsAfter = await json(context, `/api/plugins/${ID}/grants`);
		if (
			object(status.current).version !== "1.0.2" ||
			status.runtimeState !== "active" ||
			status.desiredState !== "enabled"
		)
			throw new Error("Source update lost enabled runtime state");
		if (JSON.stringify(permissionsBefore.grants) !== JSON.stringify(permissionsAfter.grants))
			throw new Error("Source update changed previously approved grants");
		context.check(context.stage, {
			from: "1.0.1",
			to: "1.0.2",
			job: applyJob.status,
			runtimeState: status.runtimeState,
			grantsPreserved: true,
		});
		await page.screenshot({ path: join(context.options.out, "website-update-en.png") });
		await page.close();
		page = undefined;
		context.stage = "disabled source update remains disabled";
		await json(context, `/api/plugins/${ID}/disable`, "POST");
		const thirdArchive = await fixtureArchive(packages, "1.0.3");
		await publishPluginSource({
			archive: thirdArchive,
			root: publicRoot,
			pluginId: ID,
			publicOrigin: origin,
			signal: context.signal,
		});
		source = await json(context, `/api/plugins/${ID}/source`);
		source = await json(context, `/api/plugins/${ID}/source`, "PUT", {
			source: {
				type: "website",
				allowInsecureHttp: true,
				updateApi: `${origin}/v1/plugins/${ID}/latest?revision=3`,
				homepage: "https://example.com/plugin",
			},
			expectedRevision: object(source.binding).revision,
		});
		const thirdCheck = await json(context, `/api/plugins/${ID}/updates/check`, "POST", {});
		if ((await job(context, thirdCheck.jobId)).status !== "succeeded")
			throw new Error("Third release check failed");
		const candidate = await json(context, `/api/plugins/${ID}/updates`);
		const thirdApply = await json(context, `/api/plugins/${ID}/updates/apply`, "POST", {
			candidateId: candidate.candidateId,
			expectedRevision: object(source.binding).revision,
		});
		if ((await job(context, thirdApply.jobId)).status !== "succeeded")
			throw new Error("Disabled update failed");
		status = await json(context, `/api/plugins/${ID}`);
		if (
			object(status.current).version !== "1.0.3" ||
			status.desiredState !== "disabled" ||
			status.runtimeState === "active"
		)
			throw new Error("Update reactivated a disabled plugin");
		context.check(context.stage, {
			version: object(status.current).version,
			desiredState: status.desiredState,
		});
		context.stage = "corrupt archive checksum preserves installed package";
		const badArchive = await fixtureArchive(packages, "1.0.4");
		const fourth = await publishPluginSource({
			archive: badArchive,
			root: publicRoot,
			pluginId: ID,
			publicOrigin: origin,
			signal: context.signal,
		});
		if (!fourth.latest) throw new Error("Fourth release missing");
		const bytes = await readFile(
			join(publicRoot, "assets", `${fourth.latest.artifact.sha256}.nfplugin`),
		);
		bytes[0] ^= 1;
		await writeFile(join(publicRoot, "assets", `${fourth.latest.artifact.sha256}.nfplugin`), bytes);
		source = await json(context, `/api/plugins/${ID}/source`, "PUT", {
			source: {
				type: "website",
				allowInsecureHttp: true,
				updateApi: `${origin}/v1/plugins/${ID}/latest?revision=4`,
			},
			expectedRevision: object(source.binding).revision,
		});
		const badCheck = await json(context, `/api/plugins/${ID}/updates/check`, "POST", {});
		if ((await job(context, badCheck.jobId)).status !== "succeeded")
			throw new Error("Checksum test metadata check failed");
		const badCandidate = await json(context, `/api/plugins/${ID}/updates`);
		const badApply = await json(context, `/api/plugins/${ID}/updates/apply`, "POST", {
			candidateId: badCandidate.candidateId,
			expectedRevision: object(source.binding).revision,
		});
		const badJob = await job(context, badApply.jobId);
		if (badJob.status !== "failed" || badJob.error !== "hash_mismatch")
			throw new Error("Corrupt archive was not rejected at the checksum boundary");
		status = await json(context, `/api/plugins/${ID}`);
		if (object(status.current).version !== "1.0.3" || status.desiredState !== "disabled")
			throw new Error("Checksum failure changed current version or operator choice");
		context.check(context.stage, { error: badJob.error, version: object(status.current).version });
		context.stage = "source preference and failure summary survive native restart";
		await context.restart();
		const restored = await json(context, `/api/plugins/${ID}/source`);
		if (JSON.stringify(restored.binding) !== JSON.stringify(source.binding))
			throw new Error("Source binding did not persist across restart");
		const restoredSummary = await json(context, `/api/plugins/${ID}/updates`);
		if (restoredSummary.error !== "hash_mismatch" || restoredSummary.candidateId !== undefined)
			throw new Error("Restart lost bounded update summary or revived an executable candidate");
		context.check(context.stage, {
			revision: object(restored.binding).revision,
			error: restoredSummary.error,
		});
		await json(context, `/api/plugins/${ID}/uninstall`, "POST");
		const removed = await context.http(`/api/plugins/${ID}`);
		if (removed.status !== 404) throw new Error("Reference plugin uninstall failed");
		context.check(
			"old source-free provider install, website update, failure and uninstall completed",
		);
	} catch (error) {
		if (page && !page.isClosed()) {
			await page
				.screenshot({ path: join(context.options.out, "source-failure.png") })
				.catch(() => {});
			await context
				.artifact("source-failure.json", {
					stage: context.stage,
					url: page.url(),
					text: (await page.evaluate(() => document.body.innerText)).slice(0, 20000),
				})
				.catch(() => {});
		}
		throw error;
	} finally {
		await page?.close().catch(() => {});
		await feed.stop(true);
		context.report.browser = browser.evidence();
	}
}

if (import.meta.main) {
	try {
		const options = parseQuotaSmokeArgs(process.argv.slice(2));
		if (options.baseline) throw new Error("Source acceptance requires a new compiled binary");
		const report = await smokeProviderQuota(options, undefined, runPluginSourceAcceptance);
		console.info(
			JSON.stringify({
				status: report.status,
				finalAcceptance: report.finalAcceptance,
				checks: report.checks.length,
			}),
		);
	} catch (error) {
		console.error(String(error));
		process.exitCode = 1;
	}
}
