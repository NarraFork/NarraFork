import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalBackend } from "@server/lib/agent/execution/local-backend";
import { createIntelligentUiRoutes } from "@server/routes/intelligent-ui";
import type { WorkspaceContext } from "@shared/workspace-context";
import { hasKitApproval, requestKitBuild, resetKitRequestsForTest } from "./kit-requests";
import { createKitService } from "./kit-service";

const roots: string[] = [];
beforeEach(() => resetKitRequestsForTest());
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string> = {}) {
	const root = await mkdtemp(join(tmpdir(), "nf-ui-kit-service-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
	const backend = new LocalBackend();
	const workspace: WorkspaceContext = {
		revision: 1,
		deviceId: "local",
		cwd: root,
		pathFlavor: backend.pathFlavor === "windows" ? "windows" : "posix",
		contextKey: "workspace",
		capabilities: { switchDirectory: true },
	};
	const notified: Array<{ narratorId: string; userId: string; text: string }> = [];
	const authorized: string[] = [];
	const service = createKitService({
		workspace: async () => workspace,
		backend: () => backend,
		authorize: async (_narrator, _user, _device, path) => {
			authorized.push(path);
			return path;
		},
		notifyApproved: async (narratorId, userId, text) => {
			notified.push({ narratorId, userId, text });
		},
	});
	return { root, service, notified, authorized };
}
const signal = () => new AbortController().signal;

describe("kit confirmation (the user's side)", () => {
	test("approving tells the agent exactly once and unlocks the build", async () => {
		const { service, notified } = await fixture();
		const request = requestKitBuild("n", "workspace", "build", "no kit");
		const overview = await service.overview("n", "actor", signal());
		expect(overview).toEqual({ status: { state: "builtin", components: [] }, request });
		expect(hasKitApproval("n", "workspace")).toBe(false);

		const approved = await service.approve("n", "actor", request?.id as string);
		expect(approved.request?.state).toBe("approved");
		expect(hasKitApproval("n", "workspace")).toBe(true);
		expect(notified).toHaveLength(1);
		expect(notified[0]).toMatchObject({ narratorId: "n", userId: "actor" });
		// The agent is told what was approved, to finish its current step first, and how.
		expect(notified[0]?.text).toContain("approved building");
		expect(notified[0]?.text).toContain("Finish the step you are on");
		expect(notified[0]?.text).toContain('{action:"kit_build"}');
		expect(notified[0]?.text).toContain("kit.json");

		// A second click on the same button changes nothing and queues nothing.
		await service.approve("n", "actor", request?.id as string);
		expect(notified).toHaveLength(1);
	});

	test("an update approval asks the agent to re-check the manifest, not to write a new one", async () => {
		const { service, notified } = await fixture();
		const request = requestKitBuild("n", "workspace", "update", "stale");
		await service.approve("n", "actor", request?.id as string);
		expect(notified[0]?.text).toContain("approved updating");
		expect(notified[0]?.text).toContain("against the project's current component library");
	});

	test("a request that is gone, or another narrator's, cannot be approved", async () => {
		const { service, notified } = await fixture();
		const request = requestKitBuild("n", "workspace", "build", "no kit");
		await expect(service.approve("other", "actor", request?.id as string)).rejects.toThrow(
			"no longer open",
		);
		await expect(service.approve("n", "actor", "missing")).rejects.toThrow("no longer open");
		expect(notified).toEqual([]);
		expect(hasKitApproval("n", "workspace")).toBe(false);
	});

	test("declining closes the prompt without telling the agent anything", async () => {
		const { service, notified } = await fixture();
		const request = requestKitBuild("n", "workspace", "build", "no kit");
		expect(await service.dismiss("n", request?.id as string)).toEqual({ dismissed: true });
		expect((await service.overview("n", "actor", signal())).request).toBeNull();
		expect(notified).toEqual([]);
	});

	test("the bundle is served only through the caller's file authorization", async () => {
		const kit = ".narrafork/intelligent_ui/kit";
		const { service, authorized } = await fixture({
			[`${kit}/kit.json`]: JSON.stringify({ version: 1, components: [{ name: "A", from: "./a" }] }),
			[`${kit}/dist/kit.js`]: "globalThis.__nfKit = {};",
			[`${kit}/dist/kit.meta.json`]: JSON.stringify({
				version: 1,
				fingerprint: "old",
				hash: "h1",
				builtAt: "2026-01-01T00:00:00.000Z",
				components: ["A"],
				hasSetup: false,
				css: null,
			}),
		});
		const bundle = await service.bundle("n", "actor", signal());
		expect(bundle).toEqual({
			js: "globalThis.__nfKit = {};",
			css: "",
			hash: "h1",
			components: ["A"],
			hasSetup: false,
		});
		// Exactly the two files it serves from, each authorized before it is read. (A
		// bundle recorded before bundles were named after their inputs is still served.)
		const read = authorized.map((path) => path.replaceAll("\\", "/").split("/").pop());
		expect(read).toEqual(["kit.meta.json", "kit.js"]);
	});
});

describe("kit routes", () => {
	function routes(principal: string | null = "actor") {
		const calls: string[] = [];
		const app = createIntelligentUiRoutes({
			authorize: async () => {
				calls.push("authorize");
				if (!principal) throw Object.assign(new Error("forbidden"), { statusCode: 403 });
				return principal;
			},
			kit: {
				overview: async () => {
					calls.push("overview");
					return { status: { state: "builtin", components: [] }, request: null };
				},
				bundle: async () => {
					calls.push("bundle");
					return { js: "1", css: "", hash: "h", components: [], hasSetup: false };
				},
				approve: async (_narrator, user, requestId) => {
					calls.push(`approve:${user}:${requestId}`);
					return { status: { state: "builtin", components: [] }, request: null };
				},
				dismiss: async (_narrator, requestId) => {
					calls.push(`dismiss:${requestId}`);
					return { dismissed: true };
				},
			},
		});
		return { app, calls };
	}
	const json = (body: unknown) => ({
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	test("every kit route checks narrator access before doing anything", async () => {
		for (const [path, init] of [
			["/n/intelligent-ui/kit", undefined],
			["/n/intelligent-ui/kit/bundle", undefined],
			["/n/intelligent-ui/kit/approve", json({ requestId: "r" })],
			["/n/intelligent-ui/kit/dismiss", json({ requestId: "r" })],
		] as const) {
			const denied = routes(null);
			expect((await denied.app.request(path, init)).status).not.toBe(200);
			expect(denied.calls).toEqual(["authorize"]);
		}
	});

	test("approval carries the authenticated user and a validated request id", async () => {
		const { app, calls } = routes();
		expect(
			(await app.request("/n/intelligent-ui/kit/approve", json({ requestId: "r1" }))).status,
		).toBe(200);
		expect(calls).toEqual(["authorize", "approve:actor:r1"]);
		for (const body of [{}, { requestId: "" }, { requestId: 5 }, { requestId: "x".repeat(65) }]) {
			const bad = routes();
			const response = await bad.app.request("/n/intelligent-ui/kit/approve", json(body));
			expect(response.status).toBe(400);
			expect(bad.calls).toEqual(["authorize"]);
		}
	});

	test("status and bundle are never cached", async () => {
		const { app } = routes();
		for (const path of ["/n/intelligent-ui/kit", "/n/intelligent-ui/kit/bundle"]) {
			const response = await app.request(path);
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		}
	});
});
