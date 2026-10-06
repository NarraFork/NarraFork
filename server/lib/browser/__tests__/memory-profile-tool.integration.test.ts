import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../agent/types";
import type { MemoryProfileView } from "../memory-profile-types";

const home = await mkdtemp(join(tmpdir(), "nf-profile-tool-integration-"));
const previous = process.env.NARRAFORK_HOME;
process.env.NARRAFORK_HOME = home;
const { getBrowser, closeBrowser } = await import("../pool");
const {
	createSession,
	closeSession,
	closeAllSessions,
	listSessions,
	snapshotSessionsForHandoff,
	restoreSessionFromHandoff,
	getSession,
} = await import("../session");
const { browserTool } = await import("../../agent/tools/browser");
const { shareRoutes } = await import("../../../routes/shares");
const { Hono } = await import("hono");
const shareApp = new Hono().route("/api/shares", shareRoutes);
async function assertDownload(url: string, path: string) {
	const response = await shareApp.request(url);
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Disposition")).toContain("attachment;");
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(
		new Uint8Array(await readFile(path)),
	);
	expect((await shareApp.request(`${url}/download`)).status).toBe(404);
}
let chrome = false;
try {
	await getBrowser();
	chrome = true;
} catch (error) {
	if (!(error instanceof Error) || !error.message.startsWith("Could not find Chrome/Chromium."))
		throw error;
	console.warn("SKIP memory profile tool integration: Chrome missing");
}
const chromeTest = chrome ? test : test.skip;
afterAll(async () => {
	try {
		await closeAllSessions();
		await closeBrowser();
	} finally {
		if (previous === undefined) delete process.env.NARRAFORK_HOME;
		else process.env.NARRAFORK_HOME = previous;
		await rm(home, { recursive: true, force: true });
	}
});

describe("Browser recording actions with owned Chrome", () => {
	chromeTest(
		"real tracingComplete followed by IO.read failure permits perf and GC on another page",
		async () => {
			const target = await createSession(`test-perf-fault-${crypto.randomUUID()}`, "about:blank");
			const other = await createSession(`test-perf-next-${crypto.randomUUID()}`, "about:blank");
			const attach = target.page.createCDPSession.bind(target.page);
			let completed = false,
				readFailures = 0;
			target.page.createCDPSession = async () => {
				const client = await attach();
				client.on("Tracing.tracingComplete", () => {
					completed = true;
				});
				const send = client.send;
				client.send = ((method: string, ...params: unknown[]) => {
					if (method === "IO.read") {
						expect(completed).toBe(true);
						expect(target.tracing?.active).toBe(false);
						expect(target.tracing?.lease.isCurrent()).toBe(false);
						readFailures++;
						return Promise.reject(new Error("owned-Chrome injected IO.read failure"));
					}
					return Reflect.apply(send, client, [method, ...params]);
				}) as typeof client.send;
				return client;
			};
			try {
				const ctx = { narratorId: target.narratorId } as ToolContext;
				expect(
					(await browserTool.execute({ action: "perf_start", session_id: target.id }, ctx)).isError,
				).not.toBe(true);
				const failed = await browserTool.execute(
					{ action: "perf_stop", session_id: target.id },
					ctx,
				);
				expect(failed.isError).toBe(true);
				expect(failed.output).toContain("injected IO.read failure");
				expect(readFailures).toBe(1);
				const nextCtx = { narratorId: other.narratorId } as ToolContext;
				expect(
					(await browserTool.execute({ action: "perf_start", session_id: other.id }, nextCtx))
						.isError,
				).not.toBe(true);
				const trace = await browserTool.execute(
					{ action: "perf_stop", session_id: other.id },
					nextCtx,
				);
				expect(trace.isError).not.toBe(true);
				const url = trace.metadata?.shareUrl as string;
				expect(url).toBe(`/api/shares/${trace.metadata?.shareId}`);
				expect(trace.output).toContain(`Share URL: ${url}`);
				await assertDownload(url, trace.metadata?.tracePath as string);
				const gc = await browserTool.execute(
					{ action: "memory_profile_start", session_id: other.id, mode: "gc" },
					nextCtx,
				);
				expect(gc.isError).not.toBe(true);
				const gcStop = await browserTool.execute(
					{
						action: "memory_profile_stop",
						session_id: other.id,
						profile_id: (gc.metadata?.memoryProfile as MemoryProfileView).profileId,
					},
					nextCtx,
				);
				expect(gcStop.isError).not.toBe(true);
				const view = gcStop.metadata?.memoryProfile as MemoryProfileView;
				expect(view.state).toBe("completed");
				for (const artifact of view.artifacts ?? [])
					await assertDownload(artifact.shareUrl, artifact.path);
			} finally {
				target.page.createCDPSession = attach;
				await closeSession(target.narratorId, target.id);
				await closeSession(other.narratorId, other.id);
			}
		},
		30000,
	);

	chromeTest(
		"a foreign owned-Chrome trace is not ended by rejected perf startup or session close",
		async () => {
			const target = await createSession(`test-perf-foreign-${crypto.randomUUID()}`, "about:blank");
			const foreignPage = await (await getBrowser()).newPage();
			const client = await foreignPage.createCDPSession();
			let completions = 0;
			client.on("Tracing.tracingComplete", () => {
				completions++;
			});
			try {
				await client.send("Tracing.start", {
					transferMode: "ReturnAsStream",
					categories: "devtools.timeline",
				});
				const failed = await browserTool.execute({ action: "perf_start", session_id: target.id }, {
					narratorId: target.narratorId,
				} as ToolContext);
				expect(failed.isError).toBe(true);
				await closeSession(target.narratorId, target.id);
				expect(completions).toBe(0);
				// A second independent client must still be refused: foreign recording remains active.
				const probe = await foreignPage.createCDPSession();
				try {
					await expect(probe.send("Tracing.start")).rejects.toThrow("already");
				} finally {
					await probe.detach();
				}
				const done = new Promise<{ stream?: string }>((resolve) =>
					client.once("Tracing.tracingComplete", resolve),
				);
				await client.send("Tracing.end");
				const event = await done;
				expect(completions).toBe(1);
				if (event.stream) await client.send("IO.close", { handle: event.stream });
			} finally {
				await client.detach().catch(() => {});
				await foreignPage.close();
				await closeSession(target.narratorId, target.id);
			}
		},
		20000,
	);
	chromeTest(
		"preserved handoff reports interruption without restoring recorder handles",
		async () => {
			const target = await createSession(
				`test-profile-handoff-${crypto.randomUUID()}`,
				"data:text/html,<title>profile-handoff</title>",
			);
			const ctx = { narratorId: target.narratorId } as ToolContext;
			try {
				const started = await browserTool.execute(
					{ action: "memory_profile_start", session_id: target.id, mode: "allocation" },
					ctx,
				);
				expect(started.isError).not.toBe(true);
				const profileId = (started.metadata?.memoryProfile as MemoryProfileView).profileId;
				const snap = snapshotSessionsForHandoff().find((s) => s.sessionId === target.id);
				expect(snap?.interruptedProfileId).toBe(profileId);
				expect(JSON.stringify(snap)).not.toContain("controller");
				expect(JSON.stringify(snap)).not.toContain("ws://");
				if (!snap) throw new Error("Missing test handoff");
				await closeAllSessions({ preserve: true });
				expect(await restoreSessionFromHandoff(await getBrowser(), snap)).toEqual({ ok: true });
				const status = await browserTool.execute(
					{ action: "memory_profile_status", session_id: target.id, profile_id: profileId },
					ctx,
				);
				const view = status.metadata?.memoryProfile as MemoryProfileView;
				expect(view.state).toBe("cancelled");
				expect(view.stage).toBe("restart_interrupted");
				expect(view.warnings?.join(" ")).toContain("not resumed");
				expect(getSession(target.narratorId, target.id)?.memoryJob).toBeUndefined();
			} finally {
				await closeSession(target.narratorId, target.id);
				await target.context.close().catch(() => {});
			}
		},
		30000,
	);
	chromeTest(
		"start/actions/automatic completion/status/stop produce GC and allocation artifacts",
		async () => {
			const target = await createSession(
				`test-profile-tool-${crypto.randomUUID()}`,
				"data:text/html,<title>profile-tool-fixture</title>",
			);
			const controller = new AbortController();
			const ctx = { narratorId: target.narratorId, signal: controller.signal } as ToolContext;
			try {
				const start = await browserTool.execute(
					{
						action: "memory_profile_start",
						session_id: target.id,
						mode: "both",
						duration_ms: "1000",
						sampling_interval_bytes: "16384",
					},
					ctx,
				);
				expect(start.isError).not.toBe(true);
				const initial = start.metadata?.memoryProfile as MemoryProfileView;
				expect(initial.state).toBe("recording");
				expect(initial.profileId).toBeTruthy();
				expect(initial.config?.durationMs).toBe(1000);
				// Interrupting the finished start tool must not own the long-lived recording signal.
				controller.abort();
				const fresh = { narratorId: target.narratorId } as ToolContext;
				expect(JSON.stringify(listSessions(target.narratorId))).not.toContain("ws://");
				expect(JSON.stringify(listSessions(target.narratorId))).not.toContain("controller");
				const denied = await browserTool.execute(
					{ action: "memory_profile_status", session_id: target.id },
					{ narratorId: "foreign" } as ToolContext,
				);
				expect(denied.isError).toBe(true);
				const forced = await browserTool.execute(
					{ action: "memory_metrics", session_id: target.id, collect_garbage: true },
					fresh,
				);
				expect(forced.isError).toBe(true);
				const action = await browserTool.execute(
					{
						action: "evaluate",
						session_id: target.id,
						value:
							"(() => { function profile_churn() { for (let i=0; i<120; i++) { const tmp=Array.from({length:8000},(_,j)=>({j,text:'x'.repeat(64)})); if(tmp.length!==8000) throw new Error(); } } profile_churn(); return 'ok'; })()",
						timeout: 10000,
					},
					fresh,
				);
				expect(action.isError).not.toBe(true);
				let view: MemoryProfileView | undefined;
				const deadline = Date.now() + 20000;
				while (Date.now() < deadline) {
					const status = await browserTool.execute(
						{ action: "memory_profile_status", session_id: target.id },
						fresh,
					);
					view = status.metadata?.memoryProfile as MemoryProfileView;
					if (["completed", "failed", "cancelled"].includes(view.state)) break;
					await Bun.sleep(50);
				}
				expect(view?.state).toBe("completed");
				expect(view?.summary?.stopReason).toBe("duration_limit");
				expect(view?.summary?.allocation?.hotspots.length).toBeGreaterThan(0);
				expect(view?.summary?.gc?.scope?.threadName).toBe("CrRendererMain");
				expect(view?.summary?.gc?.minorCount).toBeGreaterThan(0);
				expect(view?.artifacts?.map((a) => a.kind).sort()).toEqual(["allocation", "gc", "summary"]);
				for (const artifact of view?.artifacts ?? []) {
					const text = await readFile(artifact.path, "utf8");
					expect(() => JSON.parse(text)).not.toThrow();
					expect(artifact.shareUrl).toContain("/api/shares/");
					await assertDownload(artifact.shareUrl, artifact.path);
					expect(artifact.filename).not.toContain("raw");
				}
				const stop = await browserTool.execute(
					{ action: "memory_profile_stop", session_id: target.id, profile_id: initial.profileId },
					fresh,
				);
				expect(stop.isError).not.toBe(true);
				expect(stop.metadata?.memoryProfile).toEqual(view);
			} finally {
				await closeSession(target.narratorId, target.id);
			}
		},
		40000,
	);
});
