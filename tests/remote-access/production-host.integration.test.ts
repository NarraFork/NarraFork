import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { createRemoteHost } from "../../remote-host";
import { importRemoteFrontend, setRemoteFrontendDisabled } from "../../remote-host/store";
import { buildRemoteFrontendArtifact } from "../../scripts/lib/remote-frontend-artifact";
import { db } from "../../server/db";
import { users } from "../../server/db/schema";
import { generateId } from "../../server/lib/id";
import {
	REMOTE_CAPABILITY_NAMES,
	REMOTE_FRONTEND_CAPABILITY,
	type RemoteBackendIdentity,
} from "../../shared/remote-access/application";
import type { Invitation } from "../../shared/remote-access/browser-client";
import type { RemoteBusinessTransport } from "../../shared/remote-access/business-transport";
import {
	type RemoteFrontendCatalog,
	remoteFrontendManifestPath,
} from "../../shared/remote-access/frontend-catalog";
import {
	type RemoteFrontendManifest,
	remoteFrontendArtifactNames,
} from "../../shared/remote-access/frontend-manifest";
import {
	productionTestBrowserExecutable,
	startProductionRemoteTestRuntime,
	waitForProductionTest,
} from "./production-test-runtime";

/** These two identities exercise the selection ABI, NOT unmodified historical NF backends. */
const ROOT = resolve(import.meta.dirname, "../..");
const ADMIN = generateId();
const PASSWORD = "isolated-versioned-host-password";
const identities: RemoteBackendIdentity[] = ["0.1.0", "0.2.0"].map((nfVersion, index) => ({
	nfVersion,
	repository: "fixture/narrafork",
	sourceCommit: (index ? "b" : "a").repeat(40),
	bootstrapAbi: 1,
	apiEpoch: 1,
	wireVersion: 2,
	capabilities: [...REMOTE_CAPABILITY_NAMES],
}));
type Runtime = Awaited<ReturnType<typeof startProductionRemoteTestRuntime>>;
type Fault = "none" | "missing" | "hash";
interface MountRecord {
	version: string;
	identity: RemoteBackendIdentity;
	assetBase: string;
	userId: string;
	role: string;
	meStatus: number;
	healthStatus: number;
	peerUnchanged: boolean;
	rtcCount: number;
	signalingCount: number;
	pairingHelloCount: number;
	documentNonce: string;
}
interface BrowserState {
	nativePeers: RTCPeerConnection[];
	signalingCount: number;
	pairingHelloCount: number;
	documentNonce: string;
	mounts: MountRecord[];
	credentials?: { username: string; password: string };
	transport?: RemoteBusinessTransport;
	dispose?: () => void;
}
let directory: string | undefined;
let storePath: string;
let browser: Browser | undefined;
let host: Awaited<ReturnType<typeof createRemoteHost>>;
const runtimes: Runtime[] = [];
const manifests: RemoteFrontendManifest[] = [];
const beforeMountContexts = new Map<number, string[]>();
let fault: Fault = "none";

function mountSource(version: string): string {
	return `export async function mount({ root, transport, backendIdentity, assetBase }) {
  const state = window.hostSelectionState;
  const peer = state.nativePeers[0];
  if (!peer || state.nativePeers.length !== 1) throw new Error('EXPECTED_EXISTING_RTC');
  if (backendIdentity.nfVersion !== ${JSON.stringify(version)}) throw new Error('WRONG_VERSION_MOUNTED');
  const credentials = state.credentials;
  delete state.credentials;
  const login = await transport.request('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  });
  if (!login.ok) throw new Error('REAL_LOGIN_FAILED');
  const session = await login.json();
  await transport.authenticate(session.token);
  const meResponse = await transport.request('/api/auth/me');
  const me = await meResponse.json();
  const health = await transport.request('/api/health');
  await health.json();
  if (!meResponse.ok || !health.ok || me.role !== 'admin') throw new Error('REAL_AUTHENTICATED_ROUTES_FAILED');
  state.transport = transport;
  state.mounts.push({ version: ${JSON.stringify(version)}, identity: backendIdentity, assetBase,
    userId: me.id, role: me.role, meStatus: meResponse.status, healthStatus: health.status,
    peerUnchanged: state.nativePeers.length === 1 && state.nativePeers[0] === peer,
    rtcCount: state.nativePeers.length, signalingCount: state.signalingCount, pairingHelloCount: state.pairingHelloCount, documentNonce: state.documentNonce });
  root.dataset.mountedVersion = ${JSON.stringify(version)};
  root.textContent = 'Mounted ' + ${JSON.stringify(version)};
  return () => { delete state.transport; root.replaceChildren(); };
}`;
}

beforeAll(async () => {
	if (process.env.NARRAFORK_TEST !== "1") throw new Error("Isolated test HOME required");
	directory = await mkdtemp(join(ROOT, ".webrtc-production-host-"));
	storePath = join(directory, "host");
	const bootstrapBuild = await Bun.build({
		entrypoints: [join(ROOT, "frontend/remote/bootstrap.ts")],
		target: "browser",
		format: "esm",
	});
	if (!bootstrapBuild.success)
		throw new Error(`Actual bootstrap build failed: ${bootstrapBuild.logs.join("\n")}`);
	const bootstrap = bootstrapBuild.outputs.find((output) => output.path.endsWith(".js"));
	if (!bootstrap || bootstrap.size > 1024 * 1024)
		throw new Error("Bootstrap fixture missing or oversized");
	for (const identity of identities) {
		const inputDir = join(directory, `input-${identity.nfVersion}`);
		const outputDir = join(directory, `artifact-${identity.nfVersion}`);
		await mkdir(join(inputDir, ".vite"), { recursive: true });
		await writeFile(join(inputDir, "bootstrap.js"), await bootstrap.text());
		await writeFile(join(inputDir, "mount.js"), mountSource(identity.nfVersion));
		await writeFile(join(inputDir, "mount.css"), ":root { color-scheme: light dark; }\n");
		await writeFile(
			join(inputDir, ".vite/manifest.json"),
			JSON.stringify({
				bootstrap: { name: "bootstrap", file: "bootstrap.js", isEntry: true },
				mount: { name: "mount", file: "mount.js", isEntry: true, css: ["mount.css"] },
			}),
		);
		const manifest = await buildRemoteFrontendArtifact({
			root: ROOT,
			inputDir,
			outputDir,
			target: {
				repository: identity.repository,
				version: identity.nfVersion,
				commit: identity.sourceCommit,
				capability: REMOTE_FRONTEND_CAPABILITY,
			},
			signal: AbortSignal.timeout(30_000),
		});
		const imported = await importRemoteFrontend({
			storePath,
			manifestPath: join(outputDir, remoteFrontendArtifactNames(identity.nfVersion).manifest),
			signal: AbortSignal.timeout(30_000),
		});
		expect(imported.buildId).toBe(manifest.buildId);
		manifests.push(manifest);
	}
	host = await createRemoteHost({
		storePath,
		bootstrapBuildId: manifests[1].buildId,
		allowLocalhost: true,
		signal: AbortSignal.timeout(30_000),
	});
	await db.insert(users).values({
		id: ADMIN,
		username: ADMIN,
		passwordHash: await Bun.password.hash(PASSWORD),
		role: "admin",
		createdAt: new Date().toISOString(),
	});
	for (const [index, identity] of identities.entries()) {
		const runtime = await startProductionRemoteTestRuntime({
			identity,
			async assetHandler(request) {
				const pathname = new URL(request.url).pathname;
				// Deliberately not #root: import the actual bootstrap without auto-starting it,
				// then explicitly provide localhost pins (production per-instance origins stay unchanged).
				if (pathname === "/")
					return new Response(
						'<!doctype html><html><body><main id="selection-root"></main></body></html>',
						{ headers: { "Content-Type": "text/html; charset=utf-8" } },
					);
				const response = await host.assetHandler(request);
				if (pathname !== "/remote/catalog.json" || !response) return response;
				beforeMountContexts.set(index, [...runtimes[index].backend.registry.contexts.keys()]);
				if (fault === "none") return response;
				const catalog = (await response.json()) as RemoteFrontendCatalog;
				if (fault === "missing")
					catalog.entries = catalog.entries.filter(
						(entry) => entry.nfVersion !== identities[0].nfVersion,
					);
				if (fault === "hash")
					catalog.entries = catalog.entries.map((entry) =>
						entry.buildId === manifests[0].buildId
							? { ...entry, manifestSha256: "0".repeat(64) }
							: entry,
					);
				return Response.json(catalog, { headers: { "Cache-Control": "no-store" } });
			},
		});
		runtimes.push(runtime);
	}
	browser = await puppeteer.launch({
		executablePath: productionTestBrowserExecutable(),
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});
}, 180_000);

afterAll(async () => {
	try {
		await browser?.close();
	} finally {
		try {
			for (const runtime of runtimes) await runtime.stop();
		} finally {
			if (directory) await rm(directory, { recursive: true, force: true });
		}
	}
});

async function runSelection(index: number) {
	if (!browser) throw new Error("Chromium not started");
	const runtime = runtimes[index];
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	const requests: string[] = [];
	const pageErrors: string[] = [];
	let navigations = 0;
	try {
		await page.setCacheEnabled(false);
		page.on("request", (request) => requests.push(new URL(request.url()).pathname));
		page.on("pageerror", (error) => pageErrors.push(String(error)));
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) navigations++;
		});
		await page.evaluateOnNewDocument(() => {
			const state: BrowserState = {
				nativePeers: [],
				signalingCount: 0,
				pairingHelloCount: 0,
				documentNonce: crypto.randomUUID(),
				mounts: [],
			};
			Reflect.set(window, "hostSelectionState", state);
			const NativeRTC = window.RTCPeerConnection;
			window.RTCPeerConnection = new Proxy(NativeRTC, {
				construct(target, args, newTarget) {
					const peer = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
					state.nativePeers.push(peer);
					return peer;
				},
			});
			const nativeSend = RTCDataChannel.prototype.send;
			RTCDataChannel.prototype.send = new Proxy(nativeSend, {
				apply(target, receiver, args) {
					if (typeof args[0] === "string") {
						try {
							if (JSON.parse(args[0]).type === "hello") state.pairingHelloCount++;
						} catch {
							/* Other frames are not JSON control messages. */
						}
					}
					return Reflect.apply(target, receiver, args);
				},
			});
			const NativeSocket = window.WebSocket;
			window.WebSocket = new Proxy(NativeSocket, {
				construct(target, args, newTarget) {
					if (String(args[0]).includes("/signal/browser")) state.signalingCount++;
					return Reflect.construct(target, args, newTarget);
				},
			});
		});
		await page.goto(runtime.coordinator.origin, { waitUntil: "domcontentloaded" });
		const discoveries = runtime.coordinator.stats().discoveries;
		const created = await runtime.peer.command("pair.create");
		const invitation = created.invitation as Invitation;
		await waitForProductionTest(
			() => runtime.coordinator.stats().discoveries > discoveries,
			"fresh invitation discovery",
		);
		const beforeDocument = await page.evaluate(
			() => (Reflect.get(window, "hostSelectionState") as BrowserState).documentNonce,
		);
		const result = await page.evaluate(
			async ({ invitation, bootstrapPath, username, password }) => {
				const state = Reflect.get(window, "hostSelectionState") as BrowserState;
				state.credentials = { username, password };
				const module = (await import(
					bootstrapPath
				)) as typeof import("../../frontend/remote/bootstrap");
				const root = document.getElementById("selection-root");
				if (!root) throw new Error("Selection root missing");
				let failure = "";
				try {
					state.dispose = await module.bootstrapRemote(root, {
						invitation,
						connect: { allowLocalhost: true, expectedInstanceId: invitation.instanceId },
					});
				} catch (error) {
					module.showRemoteBootstrapError(root, error, "en");
					failure =
						error instanceof Error &&
						[
							"REMOTE_FRONTEND_NOT_AVAILABLE",
							"REMOTE_FRONTEND_DISABLED",
							"REMOTE_MANIFEST_HASH_MISMATCH",
						].includes(error.message)
							? error.message
							: "UNEXPECTED_BOOTSTRAP_FAILURE";
				}
				let afterMountStatus: number | null = null;
				if (state.transport) {
					const response = await state.transport.request("/api/auth/me");
					afterMountStatus = response.status;
					await response.json();
				}
				return {
					failure,
					mounts: state.mounts,
					rtcCount: state.nativePeers.length,
					signalingCount: state.signalingCount,
					pairingHelloCount: state.pairingHelloCount,
					documentNonce: state.documentNonce,
					afterMountStatus,
					state: root.dataset.remoteState,
					text: root.textContent,
					stylesheets: [
						...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
					].map((link) => new URL(link.href).pathname),
				};
			},
			{
				invitation,
				bootstrapPath: `/remote/frontends/${manifests[1].buildId}/bootstrap.js`,
				username: ADMIN,
				password: PASSWORD,
			},
		);
		return {
			...result,
			beforeDocument,
			requests,
			pageErrors,
			navigations,
			contextsBeforeMount: beforeMountContexts.get(index) ?? [],
			contextsAfterMount: [...runtime.backend.registry.contexts.keys()],
		};
	} finally {
		await page
			.evaluate(() =>
				(Reflect.get(window, "hostSelectionState") as BrowserState | undefined)?.dispose?.(),
			)
			.catch(() => {});
		await context.close();
		await waitForProductionTest(
			() => runtime.backend.registry.contexts.size === 0,
			"RTC context cleanup",
		);
	}
}

function assertNoNativeBusinessOrRemount(result: Awaited<ReturnType<typeof runSelection>>) {
	expect(result.rtcCount).toBe(1);
	expect(result.signalingCount).toBe(1);
	expect(result.pairingHelloCount).toBe(1);
	expect(result.navigations).toBe(1);
	expect(result.documentNonce).toBe(result.beforeDocument);
	expect(result.requests.filter((path) => /^\/(api|ws)(\/|$)/.test(path))).toEqual([]);
	expect(result.pageErrors).toEqual([]);
}

test("two verified NF identities select exact installed modules and keep the existing real RTC across mount", async () => {
	fault = "none";
	for (const index of [0, 1]) {
		const result = await runSelection(index);
		assertNoNativeBusinessOrRemount(result);
		expect(result.failure).toBe("");
		expect(result.mounts).toHaveLength(1);
		expect(result.mounts[0]).toMatchObject({
			version: identities[index].nfVersion,
			identity: identities[index],
			userId: ADMIN,
			role: "admin",
			meStatus: 200,
			healthStatus: 200,
			peerUnchanged: true,
			rtcCount: 1,
			signalingCount: 1,
			pairingHelloCount: 1,
			documentNonce: result.beforeDocument,
		});
		expect(result.afterMountStatus).toBe(200);
		expect(result.contextsBeforeMount).toHaveLength(1);
		expect(result.contextsAfterMount).toEqual(result.contextsBeforeMount);
		expect(result.requests).toContain(`/remote/frontends/${manifests[index].buildId}/mount.js`);
		expect(result.requests).not.toContain(
			`/remote/frontends/${manifests[1 - index].buildId}/mount.js`,
		);
		expect(result.stylesheets).toEqual([`/remote/frontends/${manifests[index].buildId}/mount.css`]);
		expect(runtimes[index].errors).toEqual([]);
	}
}, 60_000);

test("unknown compatibility key never mounts the other available version", async () => {
	fault = "missing";
	try {
		const result = await runSelection(0);
		assertNoNativeBusinessOrRemount(result);
		expect(result.failure).toBe("REMOTE_FRONTEND_NOT_AVAILABLE");
		expect(result.mounts).toEqual([]);
		expect(result.requests.some((path) => path.endsWith("/mount.js"))).toBe(false);
		expect(result.text).toContain("No compatible remote frontend");
		expect(result.state).toBe("failed");
	} finally {
		fault = "none";
	}
}, 30_000);

test("an explicitly disabled matching build is not replaced by the newer version", async () => {
	await setRemoteFrontendDisabled(
		storePath,
		manifests[0].buildId,
		true,
		AbortSignal.timeout(10_000),
	);
	try {
		const result = await runSelection(0);
		assertNoNativeBusinessOrRemount(result);
		expect(result.failure).toBe("REMOTE_FRONTEND_DISABLED");
		expect(result.mounts).toEqual([]);
		expect(result.requests.some((path) => path.endsWith("/mount.js"))).toBe(false);
		expect(result.text).toContain("is disabled");
	} finally {
		await setRemoteFrontendDisabled(
			storePath,
			manifests[0].buildId,
			false,
			AbortSignal.timeout(10_000),
		);
	}
}, 30_000);

test("a catalog/manifest digest mismatch fails before either business module is loaded", async () => {
	fault = "hash";
	try {
		const result = await runSelection(0);
		assertNoNativeBusinessOrRemount(result);
		expect(result.failure).toBe("REMOTE_MANIFEST_HASH_MISMATCH");
		expect(result.requests).toContain(remoteFrontendManifestPath(manifests[0].buildId));
		expect(result.mounts).toEqual([]);
		expect(result.requests.some((path) => path.endsWith("/mount.js"))).toBe(false);
		expect(result.state).toBe("failed");
	} finally {
		fault = "none";
	}
}, 30_000);
