import { afterAll, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryMetrics } from "../../../browser/memory";
import { MAX_HEAP_SNAPSHOT_BYTES } from "../../../browser/memory-constants";
import type { BrowserSession } from "../../../browser/session";
import type { CreateShareOpts, ShareRecord } from "../../../shares";
import type { ToolContext } from "../../types";

const isolatedHome = await mkdtemp(join(tmpdir(), "nf-memory-tool-home-"));
const previousHome = process.env.NARRAFORK_HOME;
process.env.NARRAFORK_HOME = isolatedHome;
const { browserTool } = await import("../browser");
const { formatMemoryMetrics, handleBrowserMemory } = await import("../browser-memory");
const { createShare, getShareDir } = await import("../../../shares");
const { shareRoutes } = await import("../../../../routes/shares");
const { Hono } = await import("hono");
const shareApp = new Hono().route("/api/shares", shareRoutes);
afterAll(async () => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	await rm(isolatedHome, { recursive: true, force: true });
});

const metrics: MemoryMetrics = {
	timestamp: "2026-10-02T00:00:00.000Z",
	url: "https://example.test/",
	JSHeapUsedSize: 1024 * 1024,
	JSHeapTotalSize: null,
	Documents: 0,
	Frames: 1,
	Nodes: null,
	JSEventListeners: 10,
	collectGarbage: false,
	durationMs: 5,
};
const session = { id: "memory-tool-test" } as BrowserSession;

async function withDependencies(
	run: (deps: Parameters<typeof handleBrowserMemory>[3], dir: string) => Promise<void>,
) {
	const dir = await mkdtemp(join(tmpdir(), "nf-memory-tool-"));
	const deps = {
		memoryMetrics: async () => metrics,
		heapSnapshot: async (_session: BrowserSession, path: string, _max: number) => {
			await writeFile(path, "sensitive-heap-body");
			return { fileSize: 19, timestamp: metrics.timestamp, url: metrics.url, durationMs: 10 };
		},
		getShareDir: () => dir,
		getMaxShareSizeBytes: () => 500 * 1024 * 1024,
		createShare: (opts: CreateShareOpts): ShareRecord => ({
			id: opts.id,
			originalName: opts.originalName,
			storagePath: opts.storagePath,
			size: opts.size,
			createdBy: opts.createdBy,
			expiresAt: new Date(),
		}),
	};
	try {
		await run(deps, dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("Browser memory tool contract", () => {
	test("raw JSON schema and Zod agree on both actions and optional explicit GC", () => {
		const raw = browserTool.rawJsonSchema as {
			properties: Record<string, { enum?: string[]; type?: string }>;
		};
		for (const action of ["memory_metrics", "heap_snapshot"]) {
			expect(raw.properties.action?.enum).toContain(action);
			expect(browserTool.parameters.safeParse({ action, session_id: "id" }).success).toBe(true);
			expect(browserTool.parameters.safeParse({ action, collect_garbage: true }).success).toBe(
				true,
			);
			expect(browserTool.parameters.safeParse({ action, collect_garbage: "true" }).success).toBe(
				false,
			);
		}
		expect(raw.properties.collect_garbage?.type).toBe("boolean");
		expect(browserTool.description).toContain("NOT redacted");
		expect(browserTool.description).toContain("Chrome is never killed");
	});

	test("requires session ID and refuses unknown/other narrator session IDs", async () => {
		const ctx = {
			narratorId: "not-the-owner",
			signal: new AbortController().signal,
		} as ToolContext;
		for (const action of ["memory_metrics", "heap_snapshot"]) {
			const missing = await browserTool.execute({ action }, ctx);
			expect(missing.isError).toBe(true);
			expect(missing.output).toContain("session_id is required");
			const foreign = await browserTool.execute({ action, session_id: "foreign" }, ctx);
			expect(foreign.isError).toBe(true);
			expect(foreign.output).toContain("Session not found");
		}
	});

	test("unavailable remains distinct from zero; displays raw bytes and MB", () => {
		const output = formatMemoryMetrics(metrics);
		expect(output).toContain("1048576 bytes (1.00 MB)");
		expect(output).toContain("JSHeapTotalSize: unavailable");
		expect(output).toContain("Documents: 0");
		expect(output).toContain("Nodes: unavailable");
	});

	test("metrics output includes bounded structured data", async () => {
		await withDependencies(async (deps) => {
			const result = await handleBrowserMemory(session, "memory_metrics", {}, deps);
			expect(result.metadata?.memoryMetrics).toEqual(metrics);
			expect(result.output).toContain("Forced GC: false");
		});
	});

	test("snapshot returns artifact metadata and privacy warning, never heap body", async () => {
		await withDependencies(async (deps) => {
			let registered: CreateShareOpts | undefined;
			if (!deps) throw new Error("Missing dependencies");
			const original = deps.createShare;
			deps.createShare = (opts) => {
				registered = opts;
				return original(opts);
			};
			const result = await handleBrowserMemory(session, "heap_snapshot", {}, deps);
			expect(result.output).toContain("NOT redacted");
			expect(result.output).toContain("24h");
			expect(JSON.stringify(result)).not.toContain("sensitive-heap-body");
			expect(registered?.expiryHours).toBe(24);
			expect(registered?.originalName).toEndWith(".heapsnapshot");
			expect(await readFile(registered?.storagePath ?? "", "utf8")).toBe("sensitive-heap-body");
		});
	});

	test("heap snapshot URL downloads exact bytes through real createShare and Hono shareRoutes", async () => {
		await withDependencies(async (deps) => {
			if (!deps) throw new Error("Missing dependencies");
			deps.createShare = createShare;
			deps.getShareDir = getShareDir;
			const result = await handleBrowserMemory(session, "heap_snapshot", {}, deps);
			const url = result.metadata?.shareUrl as string;
			expect(url).toBe(`/api/shares/${result.metadata?.shareId}`);
			expect(result.output).toContain(`Share URL: ${url}`);
			const response = await shareApp.request(url);
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Disposition")).toContain("attachment;");
			expect(await response.text()).toBe("sensitive-heap-body");
			expect((await shareApp.request(`${url}/download`)).status).toBe(404);
		});
	});

	test("share size setting constrains snapshot bytes below hard maximum", async () => {
		await withDependencies(async (deps) => {
			if (!deps) throw new Error("Missing dependencies");
			const original = deps.heapSnapshot;
			const limits: number[] = [];
			deps.heapSnapshot = async (s, path, max, options) => {
				limits.push(max);
				return original(s, path, max, options);
			};
			await handleBrowserMemory(session, "heap_snapshot", {}, deps);
			deps.getMaxShareSizeBytes = () => 1024;
			await handleBrowserMemory(session, "heap_snapshot", {}, deps);
			expect(limits).toEqual([MAX_HEAP_SNAPSHOT_BYTES, 1024]);
		});
	});

	test("share registration failure removes sensitive final artifact", async () => {
		await withDependencies(async (deps, dir) => {
			if (!deps) throw new Error("Missing dependencies");
			deps.createShare = () => {
				throw new Error("share failed");
			};
			await expect(handleBrowserMemory(session, "heap_snapshot", {}, deps)).rejects.toThrow(
				"share failed",
			);
			await expect(access(dir)).rejects.toThrow();
		});
	});

	test("cancel after export removes artifact without registering a share", async () => {
		await withDependencies(async (deps, dir) => {
			if (!deps) throw new Error("Missing dependencies");
			const controller = new AbortController();
			const original = deps.heapSnapshot;
			deps.heapSnapshot = async (s, path, max, options) => {
				const result = await original(s, path, max, options);
				controller.abort(new Error("cancelled"));
				return result;
			};
			deps.createShare = () => {
				throw new Error("must not register");
			};
			await expect(
				handleBrowserMemory(session, "heap_snapshot", { signal: controller.signal }, deps),
			).rejects.toThrow("cancelled");
			await expect(access(dir)).rejects.toThrow();
		});
	});
});
