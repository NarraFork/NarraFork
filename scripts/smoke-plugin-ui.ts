import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, Page } from "puppeteer-core";

const ROOT = resolve(import.meta.dir, "..");
const FIXTURE_ROOT = join(ROOT, "tests/fixtures/plugins/e2e/reference-ui-hostile");
const MAX_LOG_TAIL_BYTES = 4 * 1024;
const MAX_SERVER_LOG_BYTES = 2 * 1024 * 1024;
const WATCHDOG_MS = 120_000;
const strict = process.argv.includes("--strict");
const requestedIterations = Number(
	process.argv
		.find((argument) => argument.startsWith("--iterations="))
		?.slice("--iterations=".length) ?? 10,
);
const iterations = Number.isSafeInteger(requestedIterations)
	? Math.max(1, Math.min(requestedIterations, 50))
	: 10;

interface CheckResult {
	name: string;
	status: "pass" | "fail" | "blocker";
	detail?: string;
}

const results: CheckResult[] = [];
let activeSmokeRuntime: Awaited<ReturnType<typeof createSmokeRuntime>> | undefined;

function record(status: CheckResult["status"], name: string, detail?: string): void {
	results.push({ status, name, detail });
	console.log(`  [${status.toUpperCase()}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function check(name: string, ok: boolean, detail?: string): void {
	record(ok ? "pass" : "fail", name, detail);
}

function blocker(name: string, detail: string): void {
	record("blocker", name, detail);
}

// Shared by the two real-browser acceptance scripts. Importing this module does not run smoke.
export function assertSmokeInputs(paths: readonly string[]): void {
	for (const path of paths) {
		if (!existsSync(join(ROOT, path))) throw new Error(`Missing smoke input: ${path}`);
	}
}

export function isolatedSmokeEnvironment(home: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of [
		"PATH",
		"SystemRoot",
		"WINDIR",
		"TEMP",
		"TMP",
		"TMPDIR",
		"LANG",
		"PUPPETEER_EXECUTABLE_PATH",
		"PUPPETEER_CACHE_DIR",
	]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return {
		...env,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, "config"),
		XDG_CACHE_HOME: join(home, "cache"),
		XDG_DATA_HOME: join(home, "data"),
		NARRAFORK_HOME: home,
		NF_DATABASE_BACKEND: "sqlite",
		NARRAFORK_ALLOW_MULTIPLE: "1",
		NF_PLUGINS_ENABLED: "1",
		NODE_ENV: "production",
		LOG_LEVEL: "warn",
	};
}

export async function createSmokeRuntime() {
	mkdirSync(join(ROOT, ".narrafork"), { recursive: true });
	const evidenceDir = mkdtempSync(join(ROOT, ".narrafork", "browser-smoke-"));
	console.log(`Smoke evidence: ${evidenceDir}`);
	const home = mkdtempSync(join(tmpdir(), "narrafork-browser-smoke-"));
	const env = isolatedSmokeEnvironment(home);
	// Dynamic application imports in this process must use the same isolated settings/DB.
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, env);
	let server: ChildProcess | undefined;
	let serverClosed: Promise<void> | undefined;
	let ownedBrowser: Browser | undefined;
	let cleanupPromise: Promise<void> | undefined;
	let failure: Error | undefined;
	let logTail = Buffer.alloc(0);
	let logBytes = 0;
	const controller = new AbortController();
	const events: Array<{ at: number; label: string; detail: string }> = [];
	let outcome: unknown;
	function evidence(label: string, detail: string): void {
		if (events.length < 100) events.push({ at: Date.now(), label, detail: detail.slice(0, 500) });
	}
	function persistEvidence(): void {
		writeFileSync(join(evidenceDir, "server-tail.log"), logTail, { mode: 0o600 });
		writeFileSync(
			join(evidenceDir, "summary.json"),
			JSON.stringify(
				{
					failure: failure?.message.slice(0, 500),
					serverLogBytes: logBytes,
					events,
					outcome,
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
	}

	async function awaitClose(closed: Promise<unknown>): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				closed,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(
								new Error(
									"Owned process did not close within 8s; leaving its temporary HOME intact",
								),
							),
						8_000,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	async function cleanup(): Promise<void> {
		if (cleanupPromise) return cleanupPromise;
		cleanupPromise = (async () => {
			const errors: unknown[] = [];
			let processesClosed = true;
			try {
				persistEvidence();
			} catch (error) {
				errors.push(error);
			} finally {
				// Evidence failure must never bypass cancellation, shutdown or HOME cleanup.
				controller.abort();
				clearTimeout(watchdog);
				process.off("SIGINT", onInterrupt);
				process.off("SIGTERM", onTerminate);
				try {
					if (server && serverClosed) {
						server.kill("SIGTERM");
						const force = setTimeout(() => server?.kill("SIGKILL"), 3_000);
						try {
							await awaitClose(serverClosed);
						} finally {
							clearTimeout(force);
						}
					}
				} catch (error) {
					processesClosed = false;
					errors.push(error);
				}
				try {
					if (ownedBrowser) {
						const child = ownedBrowser.process();
						const closed =
							child && child.exitCode === null && child.signalCode === null
								? new Promise<void>((done) => child.once("close", () => done()))
								: Promise.resolve();
						const force = setTimeout(() => child?.kill("SIGKILL"), 3_000);
						try {
							await awaitClose(Promise.all([ownedBrowser.close().catch(() => undefined), closed]));
						} finally {
							clearTimeout(force);
						}
					}
				} catch (error) {
					processesClosed = false;
					errors.push(error);
				}
				try {
					persistEvidence();
				} catch (error) {
					errors.push(error);
				} finally {
					if (processesClosed) {
						try {
							rmSync(home, { recursive: true, force: true });
						} catch (error) {
							errors.push(error);
						}
					}
				}
			}
			if (errors.length)
				throw new AggregateError(
					errors,
					"Smoke cleanup failed; owned processes were still shut down where possible",
				);
		})();
		return cleanupPromise;
	}
	function stop(reason: string, code: number): void {
		failure ??= new Error(reason);
		console.error(reason);
		void cleanup().then(
			() => process.exit(code),
			(error) => {
				console.error("Smoke cleanup failed:", error);
				process.exit(2);
			},
		);
	}
	const onInterrupt = () => stop("Smoke cancelled (SIGINT)", 130);
	const onTerminate = () => stop("Smoke cancelled (SIGTERM)", 143);
	process.once("SIGINT", onInterrupt);
	process.once("SIGTERM", onTerminate);
	const watchdog = setTimeout(
		() => stop(`WATCHDOG: smoke exceeded ${WATCHDOG_MS}ms`, 2),
		WATCHDOG_MS,
	);
	try {
		const port = await reservePort();
		const base = `http://127.0.0.1:${port}`;
		return {
			home,
			base,
			cleanup,
			evidenceDir,
			serverPid: () => server?.pid,
			report(checks: Array<{ name: string; detail?: string; status?: string; ok?: boolean }>) {
				outcome = checks.slice(0, 40).map((check) => ({
					name: check.name.slice(0, 200),
					status: check.status?.slice(0, 20),
					ok: check.ok,
					detail: check.detail?.slice(0, 500),
				}));
			},
			async snapshotPage(page: Page, label: string) {
				try {
					const snapshot = await page.evaluate(() => ({
						url: location.href.split("?")[0],
						text: document.body.innerText.slice(0, 2_000),
						controls: Array.from(
							document.querySelectorAll<HTMLElement>("button, [role=menu], [role=menuitem]"),
						)
							.filter((element) => {
								const rect = element.getBoundingClientRect();
								return rect.width > 0 && rect.height > 0;
							})
							.slice(0, 40)
							.map((element) => ({
								tag: element.tagName,
								role: element.getAttribute("role"),
								label: element.getAttribute("aria-label"),
								text: element.textContent?.slice(0, 120),
								html: element.outerHTML.slice(0, 400),
							})),
					}));
					writeFileSync(
						join(evidenceDir, `${label.replace(/[^\w-]/g, "_")}.json`),
						JSON.stringify(snapshot, null, 2),
						{ mode: 0o600 },
					);
				} catch (error) {
					evidence(label, `snapshot failed: ${String(error)}`);
				}
			},
			watchPage(page: Page, label: string) {
				page.on("framenavigated", (frame) => {
					if (frame === page.mainFrame())
						evidence(label, `navigation ${frame.url().split("?")[0]}`);
				});
				page.on("console", (message) => evidence(label, `${message.type()}: ${message.text()}`));
				page.on("pageerror", (error) => evidence(label, `pageerror: ${String(error)}`));
				page.on("response", (response) => {
					if (/\/api\/(health|plugins\/ui\/contributions)(?:\?|$)/.test(response.url())) {
						evidence(label, `${response.status()} ${response.url().split("?")[0]}`);
					}
				});
			},
			ownBrowser(browser: Browser) {
				ownedBrowser = browser;
			},
			logTail: () => logTail.toString("utf8"),
			assertHealthyProcess() {
				if (failure) throw failure;
				if (!server || server.exitCode !== null || server.signalCode !== null) {
					throw new Error(`Isolated server exited: ${logTail.toString("utf8")}`);
				}
			},
			start() {
				if (server || controller.signal.aborted) throw new Error("Smoke runtime is not startable");
				server = spawn(
					process.execPath,
					["server/index.ts", `--port=${port}`, "--host=127.0.0.1", "--no-auto-resume"],
					{ cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
				);
				serverClosed = new Promise<void>((done) => server?.once("close", () => done()));
				server.once("error", (error) => {
					failure = error;
				});
				const collect = (chunk: Buffer) => {
					logBytes += chunk.length;
					logTail = Buffer.concat([logTail, chunk.subarray(-MAX_LOG_TAIL_BYTES)]).subarray(
						-MAX_LOG_TAIL_BYTES,
					);
					if (logBytes > MAX_SERVER_LOG_BYTES && !failure) {
						stop("Isolated server exceeded the 2MiB output budget", 2);
					}
				};
				server.stdout?.on("data", collect);
				server.stderr?.on("data", collect);
			},
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}

function reservePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const probe = createServer();
		probe.unref();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") {
				probe.close();
				reject(new Error("Unable to reserve an isolated TCP port"));
				return;
			}
			probe.close((error) => {
				if (error) reject(error);
				else resolvePort(address.port);
			});
		});
	});
}

async function waitForHealth(base: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${base}/api/health`, {
				signal: AbortSignal.timeout(1_000),
			});
			if (response.ok) return true;
		} catch {
			// The isolated server is still starting.
		}
		await Bun.sleep(150);
	}
	return false;
}

async function jsonRequest<T>(
	base: string,
	path: string,
	options: RequestInit = {},
): Promise<{ response: Response; body: T }> {
	const response = await fetch(`${base}${path}`, {
		...options,
		signal: options.signal ?? AbortSignal.timeout(10_000),
	});
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// Keep bounded plain text for the caller's diagnostic.
	}
	return { response, body: body as T };
}

async function preinstallReferencePlugin(home: string): Promise<void> {
	process.env.NARRAFORK_HOME = home;
	process.env.NARRAFORK_ALLOW_MULTIPLE = "1";
	process.env.NF_PLUGINS_ENABLED = "1";
	const { PluginManager } = await import("../server/services/plugin-manager");
	const manager = new PluginManager({
		root: join(home, "plugins"),
		disabled: false,
		restorePluginLifecycle: () => undefined,
	});
	try {
		const installed = await manager.install(FIXTURE_ROOT);
		await manager.enable(installed.pluginId);
	} finally {
		await manager.shutdown();
	}
}

interface ContributionItem {
	pluginId: string;
	version: string;
	hash: string;
	contributionId: string;
	title: string;
	entryPath?: string;
	stylePath?: string;
	status: string;
}

interface CreatedUiSession {
	session: {
		sessionId: string;
		connectNonce: string;
		pluginId: string;
		version: string;
		hash: string;
		contributionId: string;
		panelInstanceId: string;
	};
	sessionToken: string;
	assetToken: string;
}

async function runHostileIframeCycles(
	page: Page,
	shell: string,
	bootstrap: {
		nonce: string;
		pluginId: string;
		contributionId: string;
		panelInstanceId: string;
	},
	count: number,
): Promise<{
	probes: Array<Record<string, unknown>>;
	residualIframes: number;
}> {
	return page.evaluate(
		async (input) => {
			const context = {
				contextVersion: 1,
				host: {
					appVersion: "smoke",
					locale: "en",
					colorScheme: "dark",
					platform: "linux",
				},
				plugin: {
					id: input.bootstrap.pluginId,
					version: "1.0.0",
					contributionId: input.bootstrap.contributionId,
					panelInstanceId: input.bootstrap.panelInstanceId,
				},
				surface: { kind: "workspace", active: true, visible: true },
				route: { routeId: "plugin-ui-smoke" },
			};
			const probes: Array<Record<string, unknown>> = [];

			const runOne = (index: number) =>
				new Promise<Record<string, unknown>>((resolveProbe, rejectProbe) => {
					const iframe = document.createElement("iframe");
					iframe.dataset.pluginSmoke = String(index);
					iframe.sandbox.add("allow-scripts");
					iframe.setAttribute("allow", "");
					iframe.referrerPolicy = "no-referrer";
					iframe.srcdoc = input.shell;
					iframe.style.cssText = "position:fixed;width:320px;height:200px;left:-10000px;top:0";
					const channel = new MessageChannel();
					let settled = false;
					const finish = (result?: Record<string, unknown>, error?: Error) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						channel.port1.close();
						iframe.remove();
						if (error) rejectProbe(error);
						else resolveProbe(result ?? {});
					};
					const timer = setTimeout(
						() => finish(undefined, new Error(`hostile iframe cycle ${index} timed out`)),
						5_000,
					);
					channel.port1.onmessage = (event) => {
						const message = event.data as Record<string, unknown>;
						if (message.kind === "request" && typeof message.id === "string") {
							const method = message.method;
							channel.port1.postMessage({
								protocol: "narrafork.ui/1",
								kind: "response",
								id: message.id,
								result:
									method === "handshake"
										? { protocolVersion: 1, context }
										: method === "context.get"
											? context
											: null,
							});
							return;
						}
						if (message.kind === "notification" && message.method === "hostile.probe") {
							finish((message.params ?? {}) as Record<string, unknown>);
						}
					};
					channel.port1.start();
					iframe.onload = () => {
						iframe.contentWindow?.postMessage(
							{
								type: "narrafork:ui-connect",
								protocol: "narrafork.ui/1",
								hostProtocolRange: { min: 1, max: 1 },
								...input.bootstrap,
							},
							"*",
							[channel.port2],
						);
					};
					document.body.appendChild(iframe);
				});

			for (let index = 0; index < input.count; index += 1) {
				probes.push(await runOne(index));
			}
			return {
				probes,
				residualIframes: document.querySelectorAll("iframe[data-plugin-smoke]").length,
			};
		},
		{ shell, bootstrap, count },
	);
}

async function runBrowserChecks(
	base: string,
	token: string,
	contribution: ContributionItem,
	session: CreatedUiSession,
): Promise<void> {
	let browser: Browser | undefined;
	try {
		const { getBrowser } = await import("../server/lib/browser/pool");
		browser = await getBrowser(true);
		activeSmokeRuntime?.ownBrowser(browser);
		const page = await browser.newPage();
		activeSmokeRuntime?.watchPage(page, "hostile-admin");
		await page.setViewport({ width: 1280, height: 800 });
		const consoleErrors: string[] = [];
		page.on("console", (message) => {
			if (message.type() === "error" && consoleErrors.length < 100) {
				consoleErrors.push(message.text().slice(0, 500));
			}
		});
		page.on("pageerror", (error) => {
			if (consoleErrors.length < 100) {
				const message = error instanceof Error ? error.message : String(error);
				consoleErrors.push(`pageerror: ${message.slice(0, 500)}`);
			}
		});
		await page.evaluateOnNewDocument((value: string) => {
			localStorage.setItem("narrafork_token", value);
			localStorage.setItem("narrafork_lang", "en");
		}, token);
		await page.goto(`${base}/settings/plugins`, {
			waitUntil: "domcontentloaded",
			timeout: 20_000,
		});
		const adminVisible = await page
			.waitForFunction(
				() =>
					document.body.textContent?.includes("Reference Hostile UI Fixture") === true ||
					document.body.textContent?.includes("com.example.hostile-ui") === true,
				{ timeout: 15_000 },
			)
			.then(() => true)
			.catch(() => false);
		if (adminVisible) {
			record("pass", "admin plugin page discovers the installed reference plugin");
		} else {
			const diagnostic = await page.evaluate(() => document.body.innerText.slice(0, 1_500));
			blocker(
				"admin plugin page discovers the installed reference plugin",
				`${page.url()} did not render the fixture (${diagnostic.replaceAll(/\s+/g, " ")})`,
			);
		}

		const encodeAssetPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
		const assetPrefix = `${base}/api/plugins/ui/${encodeURIComponent(contribution.pluginId)}/${encodeURIComponent(
			contribution.version,
		)}/${encodeURIComponent(contribution.hash)}/asset/${encodeURIComponent(
			session.session.sessionId,
		)}/${encodeURIComponent(session.assetToken)}`;
		const entryUrl = `${assetPrefix}/${encodeAssetPath(contribution.entryPath ?? "")}`;
		const styleUrl = contribution.stylePath
			? `${assetPrefix}/${encodeAssetPath(contribution.stylePath)}`
			: undefined;
		const { createPluginAssetShell } = await import("../frontend/components/plugins/asset-shell");
		const locationHost = globalThis as typeof globalThis & { location?: Location };
		const previousLocation = Object.getOwnPropertyDescriptor(locationHost, "location");
		Object.defineProperty(locationHost, "location", {
			configurable: true,
			value: new URL(base) as unknown as Location,
		});
		let shell: string;
		try {
			shell = createPluginAssetShell({
				nonce: session.session.connectNonce,
				pluginId: contribution.pluginId,
				contributionId: contribution.contributionId,
				panelInstanceId: session.session.panelInstanceId,
				entryUrl,
				styleUrl,
				defaultTimeoutMs: 2_000,
			});
		} finally {
			if (previousLocation) Object.defineProperty(locationHost, "location", previousLocation);
			else Reflect.deleteProperty(locationHost, "location");
		}
		if (shell.includes("sessionToken=") || shell.includes("?sessionToken")) {
			blocker(
				"plugin asset capability is not embedded in a long-lived URL",
				"sessionToken query credentials must never appear in plugin shell URLs",
			);
		} else {
			check("plugin asset URLs omit the RPC session token", true);
		}

		const hostile = await runHostileIframeCycles(
			page,
			shell,
			{
				nonce: session.session.connectNonce,
				pluginId: contribution.pluginId,
				contributionId: contribution.contributionId,
				panelInstanceId: session.session.panelInstanceId,
			},
			iterations,
		);
		check("hostile iframe cycles leave no DOM iframe residue", hostile.residualIframes === 0);
		check("hostile iframe cycles leave only the host page frame", page.frames().length === 1);
		check(
			"hostile iframe emitted one bounded probe per cycle",
			hostile.probes.length === iterations,
		);
		const sandboxPassed = hostile.probes.every(
			(probe) =>
				probe.parentDocumentBlocked === true &&
				probe.parentStorageBlocked === true &&
				probe.opaqueStorageBlocked === true &&
				probe.networkBlocked === true &&
				probe.topNavigationBlocked === true &&
				probe.evalBlocked === true &&
				probe.contextPluginId === contribution.pluginId &&
				probe.contextContributionId === contribution.contributionId,
		);
		check(
			"hostile iframe cannot reach parent DOM/storage/network/navigation/eval",
			sandboxPassed,
			`cycles=${hostile.probes.length}`,
		);

		const unexpectedConsoleErrors = consoleErrors.filter(
			(message) =>
				!/Content Security Policy|Refused to connect|Blocked script execution|navigation.*sandbox|sandboxed and lacks the 'allow-same-origin' flag|favicon|WebSocket/i.test(
					message,
				),
		);
		check(
			"browser run has no unexpected console errors",
			unexpectedConsoleErrors.length === 0,
			unexpectedConsoleErrors.slice(0, 3).join(" | ") || undefined,
		);
		await page.close();
	} catch (error) {
		blocker(
			"real Chrome hostile-iframe smoke",
			error instanceof Error ? error.message : String(error),
		);
	} finally {
		try {
			const { closeBrowser } = await import("../server/lib/browser/pool");
			await closeBrowser();
		} catch {
			// Browser was never started or already closed.
		}
		void browser;
	}
}

async function runWorkspacePluginPanelCheck(
	base: string,
	token: string,
	contribution: ContributionItem,
): Promise<void> {
	let browser: Browser | undefined;
	let page: import("puppeteer-core").Page | undefined;
	try {
		const narrator = await jsonRequest<{ id?: string }>(base, "/api/narrators", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({}),
		});
		if (!narrator.response.ok || !narrator.body.id) {
			throw new Error(`narrator create failed: ${narrator.response.status}`);
		}
		const workspace = await jsonRequest<{ id?: string }>(base, "/api/workspaces", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ title: "Plugin acceptance workspace", tree: "{}" }),
		});
		if (!workspace.response.ok || !workspace.body.id)
			throw new Error(`workspace create failed: ${workspace.response.status}`);
		const member = await jsonRequest(base, `/api/workspaces/${workspace.body.id}/panels`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ kind: "narrator", narratorId: narrator.body.id }),
		});
		if (!member.response.ok)
			throw new Error(`workspace membership failed: ${member.response.status}`);
		const { getBrowser } = await import("../server/lib/browser/pool");
		browser = await getBrowser(true);
		activeSmokeRuntime?.ownBrowser(browser);
		page = await browser.newPage();
		activeSmokeRuntime?.watchPage(page, "workspace-picker");
		await page.setViewport({ width: 1_400, height: 900 });
		const sessionResponses: number[] = [];
		page.on("response", (response) => {
			if (response.url().includes("/api/plugins/ui/sessions") && sessionResponses.length < 100)
				sessionResponses.push(response.status());
		});
		await page.evaluateOnNewDocument((value: string) => {
			localStorage.setItem("narrafork_token", value);
			localStorage.setItem("narrafork_lang", "en");
		}, token);
		await page.goto(`${base}/narrators/workspace/${encodeURIComponent(workspace.body.id)}`, {
			waitUntil: "domcontentloaded",
			timeout: 20_000,
		});
		const dockMounted = await page
			.waitForSelector(".dv-dockview", { timeout: 15_000 })
			.then(() => true)
			.catch(() => false);
		if (!dockMounted) throw new Error("workspace narrator dock did not mount");
		await page
			.waitForFunction(() => document.querySelector("svg.tabler-icon-puzzle") !== null, {
				timeout: 15_000,
			})
			.catch(() => undefined);
		await activeSmokeRuntime?.snapshotPage(page, "picker-before-click");
		const tabsBefore = await page.$$eval(".dv-tab", (tabs) => tabs.length);
		const pickerClicked = await page.evaluate(() => {
			const icons = Array.from(document.querySelectorAll<SVGElement>("svg.tabler-icon-puzzle"));
			const button = icons
				.map((icon) => icon.closest("button"))
				.find((candidate) => {
					if (!candidate) return false;
					const rect = candidate.getBoundingClientRect();
					return rect.width > 0 && rect.height > 0;
				});
			if (!button) return false;
			(button as HTMLButtonElement).click();
			return true;
		});
		if (!pickerClicked) throw new Error("plugin contribution picker trigger was not found");
		const pickerItemVisible = await page
			.waitForFunction(
				(title: string) =>
					Array.from(
						document.querySelectorAll<HTMLElement>(
							'[role="menuitem"], [data-menu-item], [role="menu"] button',
						),
					).some((candidate) => {
						const rect = candidate.getBoundingClientRect();
						return (
							rect.width > 0 && rect.height > 0 && (candidate.textContent ?? "").includes(title)
						);
					}),
				{ timeout: 15_000 },
				contribution.title,
			)
			.then(() => true)
			.catch(() => false);
		const itemClicked = pickerItemVisible
			? await page.evaluate((title: string) => {
					const item = Array.from(
						document.querySelectorAll<HTMLElement>(
							'[role="menuitem"], [data-menu-item], [role="menu"] button',
						),
					).find((candidate) => {
						const rect = candidate.getBoundingClientRect();
						return (
							rect.width > 0 && rect.height > 0 && (candidate.textContent ?? "").includes(title)
						);
					});
					if (!item) return false;
					item.click();
					return true;
				}, contribution.title)
			: false;
		if (!itemClicked) {
			await activeSmokeRuntime?.snapshotPage(page, "picker-missing-item");
			const visibleMenuText = await page.evaluate(() =>
				Array.from(
					document.querySelectorAll<HTMLElement>(
						'[role="menuitem"], [data-menu-item], [role="menu"] button',
					),
				)
					.filter((candidate) => {
						const rect = candidate.getBoundingClientRect();
						return rect.width > 0 && rect.height > 0;
					})
					.map((candidate) => (candidate.textContent ?? "").trim())
					.filter(Boolean)
					.join(" | "),
			);
			throw new Error(
				`picker item was not rendered: ${contribution.title}; visible items: ${visibleMenuText || "none"}`,
			);
		}
		const iframeReady = await page
			.waitForSelector(`iframe[title=${JSON.stringify(contribution.title)}]`, { timeout: 15_000 })
			.then(() => true)
			.catch(() => false);
		// Workspace resources open as non-durable previews. Pin the real panel before
		// asserting its saved identity; temporary floats intentionally do not persist.
		const pinned = await page.evaluate(() => {
			const pin = document.querySelector<HTMLButtonElement>("button[data-workspace-resource-pin]");
			if (!pin || pin.disabled) return false;
			pin.click();
			return true;
		});
		await Bun.sleep(800);
		const tabsAfter = await page.$$eval(".dv-tab", (tabs) => tabs.length);
		const persistedWorkspace = await jsonRequest<{ tree?: string }>(
			base,
			`/api/workspaces/${workspace.body.id}`,
			{ headers: { authorization: `Bearer ${token}` } },
		);
		const layout = persistedWorkspace.body.tree ?? "";
		if (!persistedWorkspace.response.ok)
			throw new Error(`workspace layout read failed: ${persistedWorkspace.response.status}`);
		const hasIdentity = [
			contribution.pluginId,
			contribution.contributionId,
			contribution.version,
			contribution.hash,
		].every((value) => layout.includes(value));
		check(
			"workspace contribution picker opens the newly installed panel",
			pickerClicked &&
				itemClicked &&
				pinned &&
				tabsAfter > tabsBefore &&
				iframeReady &&
				hasIdentity,
			`tabs ${tabsBefore}→${tabsAfter}, iframe=${iframeReady}, pinned=${pinned}, identity=${hasIdentity}, session=${sessionResponses.join(",") || "none"}`,
		);
	} catch (error) {
		blocker(
			"workspace contribution picker opens the newly installed panel",
			error instanceof Error ? error.message : String(error),
		);
	} finally {
		await page?.close().catch(() => {});
		try {
			const { closeBrowser } = await import("../server/lib/browser/pool");
			await closeBrowser();
		} catch {
			// Browser was never started or already closed.
		}
		void browser;
	}
}

async function runCrossWindowDisableCheck(
	base: string,
	token: string,
	pluginId: string,
): Promise<{
	disabled: { response: Response; body: Record<string, unknown> };
	disableLatencyMs: number;
	windowsRefetched: boolean;
}> {
	let browser: Browser | undefined;
	try {
		const { getBrowser } = await import("../server/lib/browser/pool");
		browser = await getBrowser(true);
		activeSmokeRuntime?.ownBrowser(browser);
		const pages = await Promise.all([browser.newPage(), browser.newPage()]);
		const requestCounts = pages.map(() => 0);
		for (const [index, page] of pages.entries()) {
			activeSmokeRuntime?.watchPage(page, `disable-window-${index}`);
			page.on("request", (request) => {
				if (request.url().includes("/api/plugins/ui/contributions")) requestCounts[index] += 1;
			});
			await page.evaluateOnNewDocument((value: string) => {
				localStorage.setItem("narrafork_token", value);
				localStorage.setItem("narrafork_lang", "en");
			}, token);
			await page.goto(`${base}/settings/plugins`, {
				waitUntil: "domcontentloaded",
				timeout: 20_000,
			});
			await page
				.waitForFunction(
					() =>
						document.body.textContent?.includes("Reference Hostile UI Fixture") === true ||
						document.body.textContent?.includes("com.example.hostile-ui") === true,
					{ timeout: 15_000 },
				)
				.catch(() => undefined);
		}
		await Bun.sleep(250);
		const baselines = [...requestCounts];
		const disableStarted = performance.now();
		const disabled = await jsonRequest<Record<string, unknown>>(
			base,
			`/api/plugins/${encodeURIComponent(pluginId)}/disable`,
			{ method: "POST", headers: { authorization: `Bearer ${token}` } },
		);
		const deadline = Date.now() + 1_000;
		while (
			Date.now() < deadline &&
			requestCounts.some((count, index) => count <= baselines[index])
		) {
			await Bun.sleep(25);
		}
		return {
			disabled,
			disableLatencyMs: performance.now() - disableStarted,
			windowsRefetched: requestCounts.every((count, index) => count > baselines[index]),
		};
	} catch (error) {
		blocker(
			"two browser windows receive lifecycle invalidation within one second",
			error instanceof Error ? error.message : String(error),
		);
		return {
			disabled: {
				response: new Response(null, { status: 599 }),
				body: {},
			},
			disableLatencyMs: Number.POSITIVE_INFINITY,
			windowsRefetched: false,
		};
	} finally {
		try {
			const { closeBrowser } = await import("../server/lib/browser/pool");
			await closeBrowser();
		} catch {
			// Browser was never started or already closed.
		}
		void browser;
	}
}

async function main(): Promise<void> {
	assertSmokeInputs([
		"server/index.ts",
		"server/services/plugin-manager.ts",
		"server/routes/workspaces.ts",
		"frontend/routes/narrators/workspace/$workspaceId.tsx",
		"server/lib/browser/pool.ts",
		"frontend/components/plugins/asset-shell.ts",
		"tests/fixtures/plugins/e2e/reference-ui-hostile/manifest.json",
		"tests/fixtures/plugins/e2e/reference-ui-hostile/ui/hostile.iife.js",
		"tests/fixtures/plugins/e2e/reference-ui-hostile/ui/hostile.css",
		"tests/fixtures/plugins/e2e/reference-ui-hostile/ui/quiet.iife.js",
		"tests/fixtures/plugins/e2e/reference-ui-hostile/ui/quiet.css",
		"dist/frontend/index.html",
	]);
	const runtime = await createSmokeRuntime();
	activeSmokeRuntime = runtime;
	const { home, base } = runtime;

	console.log(`Isolated NARRAFORK_HOME: ${home}`);
	console.log(`Isolated server: ${base}`);
	try {
		await preinstallReferencePlugin(home);
		runtime.start();
		const healthy = await waitForHealth(base, 30_000);
		runtime.assertHealthyProcess();
		if (!healthy) throw new Error(`isolated server did not become healthy:\n${runtime.logTail()}`);
		check("isolated backend becomes healthy", true);

		const registered = await jsonRequest<{ token?: string }>(base, "/api/auth/register", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				username: "plugin_smoke_admin",
				password: "plugin-smoke-password-123",
			}),
		});
		if (!registered.response.ok || !registered.body.token) {
			throw new Error(
				`admin registration failed: ${registered.response.status} ${JSON.stringify(registered.body)}`,
			);
		}
		const token = registered.body.token;
		const authHeaders = { authorization: `Bearer ${token}` };

		const discovered = await jsonRequest<ContributionItem[]>(
			base,
			"/api/plugins/ui/contributions",
			{
				headers: authHeaders,
			},
		);
		check("UI contribution snapshot request succeeds", discovered.response.ok);
		const contributions = Array.isArray(discovered.body) ? discovered.body : [];
		check("UI contribution snapshot contains both reference views", contributions.length === 2);
		const hostile = contributions.find((item) => item.contributionId === "hostile-panel");
		const quiet = contributions.find((item) => item.contributionId === "quiet-panel");
		if (!hostile) throw new Error("hostile-panel contribution was not discovered");
		check("discovered contribution is available", hostile.status === "available");
		if (quiet?.entryPath !== "ui/quiet.iife.js" || quiet.stylePath !== "ui/quiet.css") {
			blocker(
				"per-view entryPath/stylePath survive Catalog → UI snapshot",
				`quiet-panel resolved ${quiet?.entryPath ?? "missing"} / ${quiet?.stylePath ?? "missing"}`,
			);
		}

		const created = await jsonRequest<CreatedUiSession>(base, "/api/plugins/ui/sessions", {
			method: "POST",
			headers: { ...authHeaders, "content-type": "application/json" },
			body: JSON.stringify({
				pluginId: hostile.pluginId,
				version: hostile.version,
				hash: hostile.hash,
				contributionId: hostile.contributionId,
				panelInstanceId: "plugin-ui-smoke-panel",
				surface: "workspace",
				surfaceScope: "global",
			}),
		});
		if (!created.response.ok || !created.body.sessionToken || !created.body.assetToken) {
			throw new Error(
				`UI session creation failed: ${created.response.status} ${JSON.stringify(created.body)}`,
			);
		}
		check("backend creates a principal-bound UI session", true);

		await runBrowserChecks(base, token, hostile, created.body);
		await runWorkspacePluginPanelCheck(base, token, hostile);

		const crossWindow = await runCrossWindowDisableCheck(base, token, hostile.pluginId);
		const disabled = crossWindow.disabled;
		check("administrator disable succeeds", disabled.response.ok);
		const disabledSnapshot = await jsonRequest<ContributionItem[]>(
			base,
			"/api/plugins/ui/contributions",
			{ headers: authHeaders },
		);
		check(
			"disable changes the authoritative contribution snapshot within one second",
			disabledSnapshot.body.every((item) => item.status === "disabled") &&
				crossWindow.disableLatencyMs < 1_000,
			`${Math.round(crossWindow.disableLatencyMs)}ms`,
		);
		check(
			"two browser windows receive lifecycle invalidation within one second",
			crossWindow.windowsRefetched,
			crossWindow.windowsRefetched
				? undefined
				: "one or more pages did not refetch the contribution snapshot",
		);

		const staleRequest = await jsonRequest<{ code?: string }>(
			base,
			`/api/plugins/ui/sessions/${encodeURIComponent(created.body.session.sessionId)}/request`,
			{
				method: "POST",
				headers: {
					...authHeaders,
					"content-type": "application/json",
					"X-NarraFork-Plugin-Session": created.body.sessionToken,
				},
				body: JSON.stringify({
					protocol: "narrafork.ui/1",
					kind: "request",
					id: "stale-session",
					method: "context.get",
				}),
			},
		);
		check(
			"disable rejects the old UI session",
			!staleRequest.response.ok &&
				["PLUGIN_UI_SESSION_INVALID", "PLUGIN_UI_DISABLED"].includes(staleRequest.body.code ?? ""),
			`${staleRequest.response.status}/${staleRequest.body.code ?? "unknown"}`,
		);

		const enabled = await jsonRequest<Record<string, unknown>>(
			base,
			`/api/plugins/${encodeURIComponent(hostile.pluginId)}/enable`,
			{ method: "POST", headers: authHeaders },
		);
		check("administrator re-enable succeeds", enabled.response.ok);
		const stillStale = await jsonRequest<{ code?: string }>(
			base,
			`/api/plugins/ui/sessions/${encodeURIComponent(created.body.session.sessionId)}/bootstrap`,
			{
				headers: {
					...authHeaders,
					"X-NarraFork-Plugin-Session": created.body.sessionToken,
				},
			},
		);
		check(
			"re-enable does not resurrect the revoked session",
			!stillStale.response.ok && stillStale.body.code === "PLUGIN_UI_SESSION_INVALID",
			`${stillStale.response.status}/${stillStale.body.code ?? "unknown"}`,
		);

		const grantsBefore = await jsonRequest<{
			revision?: number;
			grants?: Array<{ grantId?: string }>;
		}>(base, `/api/plugins/${encodeURIComponent(hostile.pluginId)}/grants`, {
			headers: authHeaders,
		});
		const beforeRevision = grantsBefore.body.revision ?? 0;
		const smokeGrantId = "smoke-ui-panel-grant";
		const granted = await jsonRequest<{ permissions?: { revision?: number } }>(
			base,
			`/api/plugins/${encodeURIComponent(hostile.pluginId)}/grants`,
			{
				method: "PUT",
				headers: { ...authHeaders, "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: beforeRevision,
					grants: [
						{
							grantId: smokeGrantId,
							capability: "ui.panel",
							scope: { type: "global" },
						},
					],
				}),
			},
		);
		const grantedRevision = granted.body.permissions?.revision ?? beforeRevision;
		check(
			"grant API advances the permission revision",
			granted.response.ok && grantedRevision > beforeRevision,
			`${beforeRevision}→${grantedRevision}`,
		);
		const revoked = await jsonRequest<{ permissions?: { revision?: number } }>(
			base,
			`/api/plugins/${encodeURIComponent(hostile.pluginId)}/grants/revoke`,
			{
				method: "POST",
				headers: { ...authHeaders, "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: grantedRevision, grantIds: [smokeGrantId] }),
			},
		);
		const revokedRevision = revoked.body.permissions?.revision ?? grantedRevision;
		check(
			"grant revoke advances the permission revision",
			revoked.response.ok && revokedRevision > grantedRevision,
			`${grantedRevision}→${revokedRevision}`,
		);
		runtime.assertHealthyProcess();
	} catch (error) {
		record(
			"fail",
			"plugin UI smoke execution",
			error instanceof Error ? error.message : String(error),
		);
		console.error(runtime.logTail());
	} finally {
		runtime.report(results);
		await runtime.cleanup();
	}

	const passed = results.filter((result) => result.status === "pass").length;
	const failures = results.filter((result) => result.status === "fail");
	const blockers = results.filter((result) => result.status === "blocker");
	console.log(
		`\nPlugin UI smoke foundation: ${passed} passed, ${failures.length} failed, ${blockers.length} blocker(s).`,
	);
	if (blockers.length > 0) {
		console.log(
			`Blockers:\n${blockers.map((item) => `  - ${item.name}: ${item.detail}`).join("\n")}`,
		);
	}
	if (failures.length > 0) process.exit(1);
	if (strict && blockers.length > 0) process.exit(2);
	// Preinstallation imports application timers; all owned processes are already closed.
	process.exit(0);
}

if (import.meta.main) {
	void main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
