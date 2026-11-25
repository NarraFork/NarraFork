import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import type * as Auth from "./api/client";
import type * as Submission from "./narrator-submission";
import type * as Scopes from "./recent-tabs-owner";

type FixtureGlobal = typeof globalThis & {
	submissionFixture: { auth: typeof Auth; submission: typeof Submission; scopes: typeof Scopes };
};
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";

test("native insecure Chromium supports local ownership and SHA-256 submission receipt recovery without secure API polyfills", async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [
			fileURLToPath(new URL("./narrator-submission.browser-fixture.ts", import.meta.url)),
		],
		target: "browser",
		format: "iife",
		define: { "import.meta.env.DEV": "false", "import.meta.env.MODE": '"test"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const script = bundle.outputs.find((output) => output.path.endsWith(".js"));
	if (!script) throw new Error("Missing insecure-context fixture bundle");
	const browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox"],
		timeout: 15_000,
	});
	try {
		const page = await browser.newPage();
		// Opaque origin is genuinely insecure, without a LAN port, hosts changes, or API replacement.
		await page.goto("data:text/html,<html><body>Insecure submission fixture</body></html>");
		const features = await page.evaluate(() => ({
			secure: isSecureContext,
			randomUUID: typeof crypto.randomUUID,
			subtle: typeof crypto.subtle,
			entropy: typeof crypto.getRandomValues,
		}));
		expect(features).toEqual({
			secure: false,
			randomUUID: "undefined",
			subtle: "undefined",
			entropy: "function",
		});
		const pageErrors: unknown[] = [];
		page.on("pageerror", (error) => pageErrors.push(error));
		await page.addScriptTag({ content: await script.text() });
		expect(pageErrors.map(String)).toEqual([]);
		const body = { message: "private HTTP metadata 中文", narratorId: "stable-target" };
		const result = await page.evaluate(async (body) => {
			const { auth, scopes, submission } = (globalThis as FixtureGlobal).submissionFixture;
			// Opaque origins also block Web Storage; the storage stub is unrelated to the
			// secure APIs this test intentionally leaves unavailable.
			const authStorage = new Map<string, string>();
			Object.defineProperty(globalThis, "localStorage", {
				configurable: true,
				value: {
					getItem: (key: string) => authStorage.get(key) ?? null,
					setItem: (key: string, value: string) => authStorage.set(key, value),
					removeItem: (key: string) => authStorage.delete(key),
				},
			});
			auth.confirmAuthUser(auth.setToken("insecure-origin-credential"), "http-user");
			const scope = scopes.getRecentTabsScope();
			if (!scope) throw Error("Missing HTTP scope");
			const local = scopes.isRecentTabsScopeCurrent(scope);
			const key = scopes.recentTabsSectionQueryKey(scope, "work");
			const rows = new Map<string, string>();
			const storage = {
				getItem: (key: string) => rows.get(key) ?? null,
				setItem: (key: string, value: string) => {
					rows.set(key, value);
				},
				removeItem: (key: string) => {
					rows.delete(key);
				},
			};
			const fingerprint = await submission.submissionFingerprint(body);
			const reconciler = new submission.NarratorSubmissionReconciler(storage);
			const sent: string[] = [];
			const receipts: string[] = [];
			let loseResponse = false;
			const options = {
				scope: "user/source",
				fingerprint,
				send: async (id: string) => {
					sent.push(id);
					if (loseResponse) {
						loseResponse = false;
						throw new Error("Response lost");
					}
					return "sent";
				},
				receipt: async (id: string) => {
					receipts.push(id);
					throw Object.assign(new Error("Absent"), {
						status: 404,
						data: { status: "not_found", dedupeWindowMs: submission.SUBMISSION_DEDUPE_WINDOW_MS },
					});
				},
				accepted: () => "accepted",
				canRetry: () => true,
			};
			const first = await reconciler.submit(options);
			loseResponse = true;
			let reason = "";
			try {
				await reconciler.submit(options);
			} catch (error) {
				reason = error instanceof submission.SubmissionOutcomeUnknown ? error.reason : "unexpected";
			}
			const pending = [...rows.values()][0];
			const retried = await new submission.NarratorSubmissionReconciler(storage).submit(options);
			return {
				local,
				key,
				first,
				fingerprint,
				reason,
				pending,
				retried,
				sent,
				receipts,
				pendingCount: rows.size,
			};
		}, body);
		expect(result.local).toBe(true);
		expect(result.key).toEqual([
			"user-preferences",
			"recent-tabs",
			"http-user",
			expect.any(Number),
			expect.any(Number),
			"work",
		]);
		expect(result.first).toBe("sent");
		expect(result.fingerprint).toBe(
			createHash("sha256").update(JSON.stringify(body)).digest("hex"),
		);
		expect(result.reason).toBe("unknown");
		expect(result.pending).toContain(result.fingerprint);
		expect(result.pending).not.toContain(body.message);
		expect(result.retried).toBe("sent");
		expect(result.sent).toHaveLength(3);
		expect(result.sent[0]).toMatch(/^submission-[a-f0-9]{32}$/u);
		expect(result.sent[1]).not.toBe(result.sent[0]);
		expect(result.sent[2]).toBe(result.sent[1]);
		expect(result.receipts).toEqual([result.sent[1], result.sent[1]]);
		expect(result.pendingCount).toBe(0);
	} finally {
		await browser.close();
	}
}, 30_000);
