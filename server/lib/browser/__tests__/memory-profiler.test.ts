import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "puppeteer-core";
import { settings } from "../../settings";
import { createShare, getShare, revokeShareRegistry } from "../../shares";
import { reserveDiagnostic } from "../diagnostic-admission";
import { cancelMemoryJob } from "../memory-job";
import type {
	MemoryProfileFailureDiagnostic,
	MemoryProfileRequest,
	MemoryProfileSummary,
	MemoryProfileWorkerCommand,
	MemoryProfileWorkerReply,
} from "../memory-profile-types";
import {
	cancelMemoryProfile,
	createMemoryProfiler,
	memoryProfileView,
	PROFILE_SUPERVISOR_PHASE_BUDGETS,
	profileWorkerEntryPoint,
	profileWorkerSpecifiers,
	statusMemoryProfile,
	stopMemoryProfile,
} from "../memory-profiler";
import type { BrowserSession } from "../session";
import type { TraceLease } from "../tracing-lease";

function required<T>(value: T | undefined | null): T {
	if (value === undefined || value === null) throw new Error("Missing expected test value");
	return value;
}

class FakeWorker extends EventEmitter {
	request?: MemoryProfileRequest;
	commands: MemoryProfileWorkerCommand[] = [];
	terminated = false;
	record = true;
	ack = true;
	traceStopped = true;
	postMessage(command: MemoryProfileWorkerCommand) {
		this.commands.push(command);
		if (command.kind === "start") {
			this.request = command.request;
			if (this.record)
				queueMicrotask(() =>
					this.reply({
						kind: "recording",
						profileId: command.request.profileId,
						startedAt: new Date().toISOString(),
						browserVersion: "Chrome/123.0",
						warnings: [],
					}),
				);
		}
		if (command.kind === "cancel" && this.ack)
			queueMicrotask(() =>
				this.reply({
					kind: "cancelled",
					profileId: command.profileId,
					stage: "cancelled",
					traceStopped: this.traceStopped,
				}),
			);
	}
	reply(reply: MemoryProfileWorkerReply) {
		this.emit("message", reply);
	}
	async terminate() {
		this.terminated = true;
		return 0;
	}
}
async function fixture(
	options: {
		worker?: FakeWorker;
		spawn?: (specifier: string) => FakeWorker;
		setup?: NonNullable<Parameters<typeof createMemoryProfiler>[0]>["setup"];
		register?: typeof createShare;
		shareMaxBytes?: () => number;
		moveArtifact?: typeof rename;
		cleanupMs?: number;
		stopMs?: number;
		workerCleanupMs?: number;
		replyGraceMs?: number;
		lease?: (browser: Browser, owner: string) => TraceLease;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "nf-profile-supervisor-"));
	const browser = Object.assign(new EventEmitter(), {
		connected: true,
		wsEndpoint: () => "ws://SECRET-ENDPOINT-CANARY",
	});
	const page = Object.assign(new EventEmitter(), { isClosed: () => false, browser: () => browser });
	const session = {
		id: "session",
		narratorId: "owner",
		page,
		context: {},
	} as unknown as BrowserSession;
	const worker = options.worker ?? new FakeWorker();
	const registered = new Map<string, Parameters<typeof createShare>[0]>();
	const revoked: string[] = [];
	let detached = 0;
	let confirmed = 0;
	let uncertain = 0;
	let leases = 0;
	const api = createMemoryProfiler({
		root: join(root, "private"),
		sharesRoot: join(root, "shares"),
		shareMaxBytes: options.shareMaxBytes,
		moveArtifact: options.moveArtifact,
		spawn:
			options.spawn ??
			(() => {
				queueMicrotask(() => worker.reply({ kind: "ready" }));
				return worker;
			}),
		specifiers: () => ["file:///worker-a", "file:///worker-b"],
		setup:
			options.setup ??
			(async () => ({
				targetId: "exact-target-id",
				detach: async () => {
					detached++;
				},
			})),
		lease:
			options.lease ??
			(() => {
				leases++;
				let current = true;
				return {
					isCurrent: () => current,
					confirmStopped: () => {
						current = false;
						confirmed++;
					},
					markUncertain: () => {
						uncertain++;
					},
				};
			}),
		registerShare:
			options.register ??
			((opts) => {
				registered.set(opts.id, opts);
				return {
					...opts,
					createdBy: opts.createdBy,
					expiresAt: new Date(),
					originalName: opts.originalName,
				};
			}),
		revokeShare: (id) => {
			revoked.push(id);
			registered.delete(id);
			return null;
		},
		limits: {
			startTimeoutMs: 50,
			stopTimeoutMs: options.stopMs ?? 50,
			workerCleanupTimeoutMs: options.workerCleanupMs ?? 30,
			replyGraceMs: options.replyGraceMs ?? 20,
			cleanupTimeoutMs: options.cleanupMs ?? 30,
		},
	});
	return {
		root,
		session,
		worker,
		page,
		browser,
		api,
		registered,
		revoked,
		counts: () => ({ detached, confirmed, uncertain, leases }),
		async dispose() {
			if (session.memoryJob)
				await cancelMemoryProfile(session, session.memoryProfile?.view.profileId as string);
			await rm(root, { recursive: true, force: true });
		},
	};
}
function summary(request: MemoryProfileRequest, partial = false): MemoryProfileSummary {
	return {
		status: partial ? "partial" : "complete",
		browserVersion: "Chrome/123.0",
		mode: request.config.mode,
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
		durationMs: 10,
		stopReason: "manual",
		heapTrend: [],
		warnings: [],
	};
}
async function complete(worker: FakeWorker, partial = false, traceStopped = true) {
	const request = worker.request as MemoryProfileRequest;
	const result = summary(request, partial);
	const data = JSON.stringify(result);
	await writeFile(join(request.dir, "summary.json"), data);
	await writeFile(join(request.dir, "private.raw"), "SECRET-ENDPOINT-CANARY");
	worker.reply({
		kind: "result",
		profileId: request.profileId,
		summary: result,
		artifacts: [{ kind: "summary", filename: "summary.json", size: Buffer.byteLength(data) }],
		traceStopped,
	});
}
async function until(predicate: () => boolean) {
	for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(1);
	expect(predicate()).toBe(true);
}

describe("memory profile supervisor", () => {
	test("startup returns only a small recording view; tool abort is no longer bound after start", async () => {
		const f = await fixture();
		try {
			const signal = new AbortController();
			const view = await f.api.startMemoryProfile(f.session, {
				mode: "allocation",
				signal: signal.signal,
			});
			expect(view.state).toBe("recording");
			expect(f.worker.request?.targetId).toBe("exact-target-id");
			expect(f.worker.request?.wsEndpoint).toContain("SECRET-ENDPOINT-CANARY");
			expect(JSON.stringify(view)).not.toContain("SECRET-ENDPOINT-CANARY");
			signal.abort();
			expect(f.session.memoryJob?.controller.signal.aborted).toBe(false);
			required(view.config).mode = "gc";
			expect(memoryProfileView(f.session).config?.mode).toBe("allocation");
			expect(f.counts().leases).toBe(0);
		} finally {
			await f.dispose();
		}
	});
	test("same-session and global admission remain exclusive until cleanup is done", async () => {
		const worker = new FakeWorker();
		worker.ack = false;
		const f = await fixture({ worker, cleanupMs: 40 });
		const other = await fixture();
		try {
			const view = await f.api.startMemoryProfile(f.session);
			await expect(f.api.startMemoryProfile(f.session)).rejects.toThrow("(busy)");
			await expect(other.api.startMemoryProfile(other.session)).rejects.toThrow("(busy)");
			const cancellation = cancelMemoryProfile(f.session, required(view.profileId));
			expect(f.session.memoryJob).toBeDefined();
			expect(() => reserveDiagnostic("snapshot")).toThrow();
			await cancellation;
			expect(f.session.memoryJob).toBeUndefined();
			expect(worker.terminated).toBe(true);
			const release = reserveDiagnostic("snapshot");
			release();
		} finally {
			await f.dispose();
			await other.dispose();
		}
	});
	test("rejects closing, pre-aborted and invalid options without acquiring job", async () => {
		const f = await fixture();
		try {
			f.session.memoryDiagnosticsClosed = true;
			await expect(f.api.startMemoryProfile(f.session)).rejects.toThrow("(closing)");
			f.session.memoryDiagnosticsClosed = false;
			await expect(
				f.api.startMemoryProfile(f.session, {
					signal: AbortSignal.abort(new Error("SECRET-ENDPOINT-CANARY")),
				}),
			).rejects.toThrow("(cancelled)");
			await expect(f.api.startMemoryProfile(f.session, { durationMs: 120001 })).rejects.toThrow(
				"(input)",
			);
			await expect(
				f.api.startMemoryProfile(f.session, { samplingIntervalBytes: 1 }),
			).rejects.toThrow("(input)");
			expect(f.session.memoryJob).toBeUndefined();
		} finally {
			await f.dispose();
		}
	});
	test("startup timeout cancels worker and keeps endpoint out of thrown errors", async () => {
		const worker = new FakeWorker();
		worker.record = false;
		const f = await fixture({ worker });
		try {
			await expect(f.api.startMemoryProfile(f.session)).rejects.toThrow(
				"Memory profile failed (timeout)",
			);
			expect(statusMemoryProfile(f.session).state).toBe("failed");
			expect(f.session.memoryJob).toBeUndefined();
			expect(f.counts().confirmed).toBe(1);
			expect(JSON.stringify(statusMemoryProfile(f.session))).not.toContain(
				"SECRET-ENDPOINT-CANARY",
			);
		} finally {
			await f.dispose();
		}
	});
	test("stop is idempotent and completed cancel retains independent 24h shares", async () => {
		const f = await fixture();
		try {
			const view = await f.api.startMemoryProfile(f.session);
			const stop1 = stopMemoryProfile(f.session, required(view.profileId));
			const stop2 = stopMemoryProfile(f.session, required(view.profileId));
			expect(f.worker.commands.filter((command) => command.kind === "stop")).toHaveLength(1);
			await complete(f.worker);
			const [a, b] = await Promise.all([stop1, stop2]);
			expect(a).toEqual(b);
			expect(a.state).toBe("completed");
			expect(a.artifacts).toHaveLength(1);
			const artifact = required(a.artifacts?.[0]);
			expect(artifact.shareUrl).toBe(`/api/shares/${artifact.shareId}`);
			expect(f.registered.get(artifact.shareId)?.expiryHours).toBe(24);
			expect(await readFile(artifact.path, "utf8")).toBe(JSON.stringify(a.summary));
			expect(await readdir(join(f.root, "private"))).toEqual([]);
			expect(await cancelMemoryProfile(f.session, required(view.profileId))).toEqual(a);
			expect(f.registered.size).toBe(1);
			expect(f.revoked).toEqual([]);
			expect(f.counts()).toMatchObject({ confirmed: 1, uncertain: 0, detached: 1 });
		} finally {
			await f.dispose();
		}
	});
	test("partial summaries are preserved, not silently promoted to complete", async () => {
		const f = await fixture();
		try {
			const view = await f.api.startMemoryProfile(f.session, { mode: "allocation" });
			await complete(f.worker, true);
			expect((await stopMemoryProfile(f.session, required(view.profileId))).summary?.status).toBe(
				"partial",
			);
		} finally {
			await f.dispose();
		}
	});
	test("old profile IDs cannot stop a new recording and late replies cannot mutate it", async () => {
		const first = new FakeWorker(),
			second = new FakeWorker();
		let launches = 0;
		const f = await fixture({
			spawn: () => {
				const worker = launches++ === 0 ? first : second;
				queueMicrotask(() => worker.reply({ kind: "ready" }));
				return worker;
			},
		});
		try {
			const a = await f.api.startMemoryProfile(f.session, { mode: "allocation" });
			await cancelMemoryProfile(f.session, required(a.profileId));
			const b = await f.api.startMemoryProfile(f.session, { mode: "allocation" });
			await expect(stopMemoryProfile(f.session, required(a.profileId))).rejects.toThrow("(input)");
			second.reply({
				kind: "cancelled",
				profileId: required(a.profileId),
				stage: "cancelled",
				traceStopped: true,
			});
			first.reply({
				kind: "failed",
				profileId: required(a.profileId),
				stage: "worker",
				traceStopped: true,
			});
			expect(statusMemoryProfile(f.session, required(b.profileId)).state).toBe("recording");
			expect(second.commands.filter((command) => command.kind === "stop")).toHaveLength(0);
		} finally {
			await f.dispose();
		}
	});
	test("close, browser disconnect and existing cancelMemoryJob abort live recordings", async () => {
		for (const kind of ["page", "browser", "job"]) {
			const f = await fixture();
			try {
				await f.api.startMemoryProfile(f.session);
				const done = required(f.session.memoryJob).done;
				if (kind === "page") f.page.emit("close");
				else if (kind === "browser") f.browser.emit("disconnected");
				else await cancelMemoryJob(f.session);
				await done;
				expect(statusMemoryProfile(f.session).state).toBe("cancelled");
				expect(f.session.memoryJob).toBeUndefined();
				expect(f.page.listenerCount("close")).toBe(0);
				expect(f.browser.listenerCount("disconnected")).toBe(0);
			} finally {
				await f.dispose();
			}
		}
	});
	test("late setup detaches after caller cancels without blocking cleanup", async () => {
		let resolve!: (target: { targetId: string; detach(): Promise<void> }) => void;
		let detached = false;
		const f = await fixture({
			setup: () =>
				new Promise((done) => {
					resolve = done;
				}),
		});
		try {
			const controller = new AbortController();
			const pending = f.api.startMemoryProfile(f.session, { signal: controller.signal });
			controller.abort(new Error("SECRET-ENDPOINT-CANARY"));
			await expect(pending).rejects.toThrow("(cancelled)");
			resolve({
				targetId: "late",
				detach: async () => {
					detached = true;
				},
			});
			await until(() => detached);
			expect(f.session.memoryJob).toBeUndefined();
		} finally {
			await f.dispose();
		}
	});
	test("trace capability startup retains its diagnostic stage instead of generic worker", async () => {
		const worker = new FakeWorker();
		worker.record = false;
		const post = worker.postMessage.bind(worker);
		worker.postMessage = (command) => {
			post(command);
			if (command.kind === "start")
				queueMicrotask(() =>
					worker.reply({
						kind: "failed",
						profileId: command.request.profileId,
						stage: "trace_capability",
						traceStopped: true,
						diagnostic: {
							diagnosticStage: "trace_capability",
							browserVersion: "Chrome/154.0.8037.97",
							missingCategories: ["disabled-by-default-v8.gc"],
						},
					}),
				);
		};
		const f = await fixture({ worker });
		try {
			const pending = f.api.startMemoryProfile(f.session);
			await expect(pending).rejects.toThrow("(trace_capability)");
			const diagnostic = {
				diagnosticStage: "trace_capability",
				browserVersion: "Chrome/154.0.8037.97",
				missingCategories: ["disabled-by-default-v8.gc"],
			};
			await expect(pending).rejects.toMatchObject({ cause: diagnostic });
			expect(statusMemoryProfile(f.session)).toMatchObject({
				state: "failed",
				stage: "trace_capability",
				diagnostic,
			});
			expect(f.counts().confirmed).toBe(1);
			expect(f.counts().uncertain).toBe(0);
		} finally {
			await f.dispose();
		}
	});

	for (const scenario of [
		{
			name: "filters private version, categories and extra fields",
			stage: "trace_capability",
			diagnostic: {
				diagnosticStage: "trace_capability",
				browserVersion: "ws://PRIVATE-CANARY/target?token=PRIVATE-CANARY",
				missingCategories: ["blink.user_timing", "PRIVATE-CANARY", "blink.user_timing"],
				targetId: "PRIVATE-CANARY",
				path: "/private/PRIVATE-CANARY",
			},
			expected: {
				diagnosticStage: "trace_capability",
				browserVersion: "unavailable",
				missingCategories: ["blink.user_timing"],
			} satisfies MemoryProfileFailureDiagnostic,
		},
		{
			name: "retains explicit empty categories for an actual tracing startup failure",
			stage: "trace_capability",
			diagnostic: {
				diagnosticStage: "trace_capability",
				browserVersion: "Chrome/154.0.8037.97",
				missingCategories: [],
			},
			expected: {
				diagnosticStage: "trace_capability",
				browserVersion: "Chrome/154.0.8037.97",
				missingCategories: [],
			} satisfies MemoryProfileFailureDiagnostic,
		},
		{
			name: "drops unknown-only category lists rather than turning them into trusted empty lists",
			stage: "trace_capability",
			diagnostic: {
				diagnosticStage: "trace_capability",
				browserVersion: "Chrome/154.0.8037.97",
				missingCategories: ["PRIVATE-CANARY"],
			},
			expected: undefined,
		},
		{
			name: "drops diagnostic for an untrusted stage",
			stage: "ws://PRIVATE-CANARY",
			diagnostic: {
				diagnosticStage: "trace_capability",
				browserVersion: "Chrome/154.0.8037.97",
				missingCategories: ["v8"],
			},
			expected: undefined,
		},
		{
			name: "drops diagnostic with an untrusted discriminator",
			stage: "trace_capability",
			diagnostic: {
				diagnosticStage: "PRIVATE-CANARY",
				browserVersion: "Chrome/154.0.8037.97",
				missingCategories: ["v8"],
			},
			expected: undefined,
		},
		{
			name: "rejects category lists beyond the four-item budget",
			stage: "trace_capability",
			diagnostic: {
				diagnosticStage: "trace_capability",
				browserVersion: "Chrome/154.0.8037.97",
				missingCategories: ["v8", "v8", "v8", "v8", "v8"],
			},
			expected: undefined,
		},
	]) {
		test(`failure diagnostic ${scenario.name}`, async () => {
			const worker = new FakeWorker();
			worker.record = false;
			const post = worker.postMessage.bind(worker);
			worker.postMessage = (command) => {
				post(command);
				if (command.kind === "start")
					queueMicrotask(() =>
						worker.reply({
							kind: "failed",
							profileId: command.request.profileId,
							stage: scenario.stage,
							traceStopped: true,
							diagnostic: scenario.diagnostic,
						} as unknown as MemoryProfileWorkerReply),
					);
			};
			const f = await fixture({ worker });
			try {
				const error = await f.api.startMemoryProfile(f.session).catch((error: unknown) => error);
				const view = statusMemoryProfile(f.session);
				expect(view.state).toBe("failed");
				expect(view.stage).toBe(
					scenario.stage === "trace_capability" ? "trace_capability" : "worker",
				);
				expect(view.diagnostic).toEqual(scenario.expected);
				expect((error as Error).cause).toEqual(scenario.expected);
				expect(JSON.stringify({ view, errorCause: (error as Error).cause })).not.toContain(
					"PRIVATE-CANARY",
				);
				expect(f.counts().confirmed).toBe(1);
			} finally {
				await f.dispose();
			}
		});
	}

	test("worker error and malicious stage become generic failure, never raw endpoint text", async () => {
		for (const error of [true, false]) {
			const f = await fixture();
			try {
				await f.api.startMemoryProfile(f.session);
				const done = required(f.session.memoryJob).done;
				if (error) f.worker.emit("error", new Error("ws://SECRET-ENDPOINT-CANARY"));
				else
					f.worker.reply({
						kind: "failed",
						profileId: required(f.worker.request).profileId,
						stage: "ws://SECRET-ENDPOINT-CANARY",
						traceStopped: true,
					});
				await done;
				expect(statusMemoryProfile(f.session).stage).toBe("worker");
				expect(JSON.stringify(statusMemoryProfile(f.session))).not.toContain(
					"SECRET-ENDPOINT-CANARY",
				);
			} finally {
				await f.dispose();
			}
		}
	});
	test("failed registry transaction revokes every staged share and asynchronously removes dirs", async () => {
		let registrations = 0;
		const f = await fixture({
			register: () => {
				registrations++;
				throw new Error("ws://SECRET-ENDPOINT-CANARY");
			},
		});
		try {
			const view = await f.api.startMemoryProfile(f.session);
			await complete(f.worker);
			const result = await stopMemoryProfile(f.session, required(view.profileId));
			expect(result.state).toBe("failed");
			expect(result.stage).toBe("share");
			expect(registrations).toBe(1);
			expect(f.revoked).toHaveLength(1);
			expect(await readdir(join(f.root, "shares"))).toEqual([]);
			expect(await readdir(join(f.root, "private"))).toEqual([]);
		} finally {
			await f.dispose();
		}
	});
	test("close during registry creation rolls artifacts back instead of publishing stale links", async () => {
		let close!: () => void;
		const f = await fixture({
			register: (opts) => {
				close();
				return { ...opts, expiresAt: new Date() };
			},
		});
		close = () => f.page.emit("close");
		try {
			const view = await f.api.startMemoryProfile(f.session);
			await complete(f.worker);
			const result = await stopMemoryProfile(f.session, required(view.profileId));
			expect(result.state).toBe("cancelled");
			expect(result.artifacts).toBeUndefined();
			expect(f.revoked).toHaveLength(1);
			expect(await readdir(join(f.root, "shares"))).toEqual([]);
		} finally {
			await f.dispose();
		}
	});
	test("trace stopped false poisons the lease, while explicit stop confirmation releases it", async () => {
		for (const confirmed of [true, false]) {
			const worker = new FakeWorker();
			worker.traceStopped = confirmed;
			const f = await fixture({ worker });
			try {
				const view = await f.api.startMemoryProfile(f.session);
				await complete(worker, false, confirmed);
				await stopMemoryProfile(f.session, required(view.profileId));
				expect(f.counts().confirmed).toBe(confirmed ? 1 : 0);
				expect(f.counts().uncertain).toBe(confirmed ? 0 : 1);
			} finally {
				await f.dispose();
			}
		}
	});
	test("ignores mismatched terminal IDs including false trace stop confirmations", async () => {
		const worker = new FakeWorker();
		worker.traceStopped = false;
		const f = await fixture({ worker });
		try {
			const view = await f.api.startMemoryProfile(f.session);
			worker.reply({
				kind: "cancelled",
				profileId: "wrong-id",
				stage: "cancelled",
				traceStopped: true,
			});
			expect(statusMemoryProfile(f.session).state).toBe("recording");
			await cancelMemoryProfile(f.session, required(view.profileId));
			expect(f.counts().uncertain).toBe(1);
			expect(f.counts().confirmed).toBe(0);
		} finally {
			await f.dispose();
		}
	});
	test("summary replies larger than 32KiB are rejected without registering shares", async () => {
		const f = await fixture();
		try {
			const view = await f.api.startMemoryProfile(f.session);
			f.worker.reply({
				kind: "result",
				profileId: required(view.profileId),
				summary: { ...summary(required(f.worker.request)), warnings: ["x".repeat(32769)] },
				artifacts: [],
				traceStopped: true,
			});
			const result = await stopMemoryProfile(f.session, required(view.profileId));
			expect(result.state).toBe("failed");
			expect(result.stage).toBe("bytes");
			expect(f.registered.size).toBe(0);
		} finally {
			await f.dispose();
		}
	});
	test("fixed artifact names, exact sizes and no symlinks are enforced", async () => {
		for (const variant of ["name", "size", "symlink"]) {
			const f = await fixture();
			try {
				const view = await f.api.startMemoryProfile(f.session);
				const request = required(f.worker.request);
				const data = JSON.stringify(summary(request));
				if (variant === "symlink") {
					await writeFile(join(f.root, "outside"), data);
					await symlink(join(f.root, "outside"), join(request.dir, "summary.json"));
				} else await writeFile(join(request.dir, "summary.json"), data);
				f.worker.reply({
					kind: "result",
					profileId: required(view.profileId),
					summary: summary(request),
					artifacts: [
						{
							kind: "summary",
							filename: (variant === "name" ? "../outside" : "summary.json") as "summary.json",
							size: Buffer.byteLength(data) + (variant === "size" ? 1 : 0),
						},
					],
					traceStopped: true,
				});
				const result = await stopMemoryProfile(f.session, required(view.profileId));
				expect(result.stage).toBe("bytes");
				expect(f.registered.size).toBe(0);
			} finally {
				await f.dispose();
			}
		}
	});
	test("finalizing watchdog is bounded and main-thread timers keep advancing", async () => {
		const worker = new FakeWorker();
		worker.ack = false;
		const f = await fixture({ worker });
		try {
			const view = await f.api.startMemoryProfile(f.session);
			let ticks = 0;
			const timer = setInterval(() => {
				ticks++;
			}, 1);
			const began = Date.now();
			const result = await stopMemoryProfile(f.session, required(view.profileId));
			clearInterval(timer);
			expect(result.state).toBe("failed");
			expect(result.stage).toBe("timeout");
			expect(Date.now() - began).toBeLessThan(200);
			expect(ticks).toBeGreaterThan(10);
			expect(f.counts().uncertain).toBe(1);
		} finally {
			await f.dispose();
		}
	});
	test("phase budgets preserve worker 15s work plus 5s cleanup before waiting for its reply", () => {
		expect(PROFILE_SUPERVISOR_PHASE_BUDGETS).toEqual({
			workerFinalizeMs: 15_000,
			workerCleanupMs: 5_000,
			replyGraceMs: 1_000,
			mainCleanupMs: 5_000,
		});
	});
	test("valid terminal reply after worker cleanup is not discarded at the worker work deadline", async () => {
		const f = await fixture({ stopMs: 30, workerCleanupMs: 100, replyGraceMs: 40 });
		try {
			const started = await f.api.startMemoryProfile(f.session);
			const stopping = stopMemoryProfile(f.session, required(started.profileId));
			await Bun.sleep(70);
			expect(statusMemoryProfile(f.session).state).toBe("finalizing");
			expect(f.session.memoryJob?.controller.signal.aborted).toBe(false);
			expect(f.counts().uncertain).toBe(0);
			await complete(f.worker);
			const result = await stopping;
			expect(result.state).toBe("completed");
			expect(result.artifacts).toHaveLength(1);
			expect(f.registered.size).toBe(1);
			expect(f.revoked).toEqual([]);
			expect(f.counts().confirmed).toBe(1);
			expect(f.counts().uncertain).toBe(0);
		} finally {
			await f.dispose();
		}
	});
	test("done wait reserves own cleanup after a worker reply arrives in its cleanup allowance", async () => {
		let detached = false;
		const f = await fixture({
			stopMs: 30,
			workerCleanupMs: 100,
			replyGraceMs: 70,
			cleanupMs: 140,
			setup: async () => ({
				targetId: "exact-target-id",
				detach: async () => {
					await Bun.sleep(100);
					detached = true;
				},
			}),
		});
		try {
			const started = await f.api.startMemoryProfile(f.session);
			const began = Date.now();
			const stopping = stopMemoryProfile(f.session, required(started.profileId));
			await Bun.sleep(140);
			expect(f.session.memoryJob?.controller.signal.aborted).toBe(false);
			await complete(f.worker);
			const result = await stopping;
			expect(Date.now() - began).toBeGreaterThan(200);
			expect(Date.now() - began).toBeLessThan(450);
			expect(result.state).toBe("completed");
			expect(detached).toBe(true);
			expect(f.session.memoryJob).toBeUndefined();
			expect(f.counts().confirmed).toBe(1);
			expect(f.counts().uncertain).toBe(0);
		} finally {
			await f.dispose();
		}
	});
	test("late worker reply gives publication its own budget rather than the expired worker clock", async () => {
		const f = await fixture({
			stopMs: 30,
			workerCleanupMs: 100,
			replyGraceMs: 70,
			cleanupMs: 150,
			moveArtifact: async (source, target) => {
				await Bun.sleep(100);
				await rename(source, target);
			},
		});
		try {
			const started = await f.api.startMemoryProfile(f.session);
			const began = Date.now();
			const stopping = stopMemoryProfile(f.session, required(started.profileId));
			await Bun.sleep(140);
			await complete(f.worker);
			const result = await stopping;
			expect(Date.now() - began).toBeGreaterThan(200);
			expect(result.state).toBe("completed");
			expect(result.artifacts).toHaveLength(1);
			expect(f.counts().confirmed).toBe(1);
			expect(f.counts().uncertain).toBe(0);
		} finally {
			await f.dispose();
		}
	});
	test("non-settling publication remains bounded by main cleanup and rolls registry back", async () => {
		const f = await fixture({ moveArtifact: () => new Promise<void>(() => {}) });
		try {
			const started = await f.api.startMemoryProfile(f.session);
			await complete(f.worker);
			const began = Date.now();
			const result = await stopMemoryProfile(f.session, required(started.profileId));
			expect(Date.now() - began).toBeLessThan(120);
			expect(result.state).toBe("failed");
			expect(result.stage).toBe("timeout");
			expect(f.registered.size).toBe(0);
			expect(f.revoked).toHaveLength(1);
			expect(f.session.memoryJob).toBeUndefined();
		} finally {
			await f.dispose();
		}
	});
	test("a non-settling handle done cannot leave stop waiting forever", async () => {
		const f = await fixture();
		try {
			const started = await f.api.startMemoryProfile(f.session);
			required(f.session.memoryProfile).done = new Promise<void>(() => {});
			const began = Date.now();
			await expect(stopMemoryProfile(f.session, required(started.profileId))).rejects.toThrow(
				"Memory profile failed (timeout)",
			);
			expect(Date.now() - began).toBeLessThan(300);
			expect(f.session.memoryJob).toBeUndefined();
			expect(statusMemoryProfile(f.session).state).toBe("failed");
		} finally {
			await f.dispose();
		}
	});
	test("duration independently enters finalizing and completes worker autostop without manual stop", async () => {
		const f = await fixture();
		try {
			const view = await f.api.startMemoryProfile(f.session, { durationMs: 1000 });
			await Bun.sleep(1002);
			expect(statusMemoryProfile(f.session).state).toBe("finalizing");
			expect(f.worker.commands.filter((command) => command.kind === "stop")).toHaveLength(0);
			await complete(f.worker);
			expect((await stopMemoryProfile(f.session, required(view.profileId))).state).toBe(
				"completed",
			);
		} finally {
			await f.dispose();
		}
	});
	test("startup fallback accepts the next compiled candidate without changing requests", async () => {
		const failed = new FakeWorker(),
			good = new FakeWorker();
		let launches = 0;
		const f = await fixture({
			spawn: () => {
				const worker = launches++ === 0 ? failed : good;
				queueMicrotask(() => {
					if (worker === failed) worker.emit("error", new Error("SECRET-ENDPOINT-CANARY"));
					else worker.reply({ kind: "ready" });
				});
				return worker;
			},
		});
		try {
			const view = await f.api.startMemoryProfile(f.session);
			expect(view.state).toBe("recording");
			expect(launches).toBe(2);
			expect(failed.terminated).toBe(true);
		} finally {
			await f.dispose();
		}
	});
	test("worker source budget honors the configured share limit and retains the fixed safety ceiling", async () => {
		const shareSettings = required(settings.shares);
		const previousLimit = shareSettings.maxFileSizeMb;
		const f = await fixture();
		try {
			shareSettings.maxFileSizeMb = 1;
			const started = await f.api.startMemoryProfile(f.session);
			expect(f.worker.request?.maxArtifactsBytes).toBe(1024 * 1024);
			await complete(f.worker);
			expect((await stopMemoryProfile(f.session, required(started.profileId))).state).toBe(
				"completed",
			);
		} finally {
			shareSettings.maxFileSizeMb = previousLimit;
			await f.dispose();
		}
		const large = await fixture({ shareMaxBytes: () => 200 * 1024 * 1024 });
		try {
			await large.api.startMemoryProfile(large.session);
			expect(large.worker.request?.maxArtifactsBytes).toBe(96 * 1024 * 1024);
		} finally {
			await large.dispose();
		}
	});
	test("publish rechecks a reduced share limit for each file and aggregate bytes", async () => {
		for (const variant of ["file", "total"]) {
			let limit = 64 * 1024;
			const f = await fixture({ shareMaxBytes: () => limit });
			try {
				const started = await f.api.startMemoryProfile(f.session);
				const request = required(f.worker.request);
				expect(request.maxArtifactsBytes).toBe(limit);
				const result = summary(request);
				const data = JSON.stringify(result);
				const allocationSize = 500;
				await writeFile(join(request.dir, "allocation.heapprofile"), Buffer.alloc(allocationSize));
				await writeFile(join(request.dir, "summary.json"), data);
				const summarySize = Buffer.byteLength(data);
				limit = variant === "file" ? allocationSize - 1 : allocationSize + summarySize - 1;
				if (variant === "total") {
					expect(allocationSize).toBeLessThan(limit);
					expect(summarySize).toBeLessThan(limit);
				}
				f.worker.reply({
					kind: "result",
					profileId: request.profileId,
					summary: result,
					artifacts: [
						{ kind: "allocation", filename: "allocation.heapprofile", size: allocationSize },
						{ kind: "summary", filename: "summary.json", size: summarySize },
					],
					traceStopped: true,
				});
				const failed = await stopMemoryProfile(f.session, required(started.profileId));
				expect(failed.state).toBe("failed");
				expect(failed.stage).toBe("bytes");
				expect(f.registered.size).toBe(0);
				expect(f.session.memoryJob).toBeUndefined();
				expect(await readdir(join(f.root, "private"))).toEqual([]);
				const release = reserveDiagnostic("profile");
				release();
			} finally {
				await f.dispose();
			}
		}
	});
	test("share budget reduction during publication revokes previously registered artifacts", async () => {
		let limit = 64 * 1024;
		const registered: string[] = [];
		const f = await fixture({
			shareMaxBytes: () => limit,
			register: (opts) => {
				registered.push(opts.id);
				limit = 1;
				return { ...opts, expiresAt: new Date() };
			},
		});
		try {
			const started = await f.api.startMemoryProfile(f.session);
			const request = required(f.worker.request);
			const result = summary(request);
			const data = JSON.stringify(result);
			await writeFile(join(request.dir, "allocation.heapprofile"), "{}");
			await writeFile(join(request.dir, "summary.json"), data);
			f.worker.reply({
				kind: "result",
				profileId: request.profileId,
				summary: result,
				artifacts: [
					{ kind: "allocation", filename: "allocation.heapprofile", size: 2 },
					{ kind: "summary", filename: "summary.json", size: Buffer.byteLength(data) },
				],
				traceStopped: true,
			});
			const failed = await stopMemoryProfile(f.session, required(started.profileId));
			expect(failed.state).toBe("failed");
			expect(failed.stage).toBe("bytes");
			expect(registered).toHaveLength(1);
			expect(f.revoked).toEqual(registered);
			expect(await readdir(join(f.root, "shares"))).toEqual([]);
			expect(await readdir(join(f.root, "private"))).toEqual([]);
			expect(f.session.memoryJob).toBeUndefined();
		} finally {
			await f.dispose();
		}
	});
	test("lease rejection releases diagnostic admission and does not create a session job", async () => {
		const f = await fixture({
			lease: () => {
				throw new Error("ws://SECRET-ENDPOINT-CANARY");
			},
		});
		try {
			await expect(f.api.startMemoryProfile(f.session)).rejects.toThrow("(busy)");
			expect(f.session.memoryJob).toBeUndefined();
			expect(statusMemoryProfile(f.session)).toEqual({ state: "idle" });
			const release = reserveDiagnostic("profile");
			release();
		} finally {
			await f.dispose();
		}
	});
	test("second registration failure revokes the already registered first artifact", async () => {
		const registrations: string[] = [];
		const f = await fixture({
			register: (opts) => {
				registrations.push(opts.id);
				if (registrations.length === 2) throw new Error("ws://SECRET-ENDPOINT-CANARY");
				return { ...opts, expiresAt: new Date() };
			},
		});
		try {
			const started = await f.api.startMemoryProfile(f.session);
			const request = required(f.worker.request);
			const result = summary(request, true);
			const data = JSON.stringify(result);
			await writeFile(join(request.dir, "allocation.heapprofile"), "{}");
			await writeFile(join(request.dir, "summary.json"), data);
			f.worker.reply({
				kind: "result",
				profileId: request.profileId,
				summary: result,
				artifacts: [
					{ kind: "allocation", filename: "allocation.heapprofile", size: 2 },
					{ kind: "summary", filename: "summary.json", size: Buffer.byteLength(data) },
				],
				traceStopped: true,
			});
			const failed = await stopMemoryProfile(f.session, required(started.profileId));
			expect(failed.state).toBe("failed");
			expect(failed.stage).toBe("share");
			expect(f.revoked).toEqual(registrations);
			expect(registrations[0]).not.toBe(registrations[1]);
			expect(await readdir(join(f.root, "shares"))).toEqual([]);
		} finally {
			await f.dispose();
		}
	});
	test("stop signal aborts finalizing and completion retains its own profile ID", async () => {
		const f = await fixture();
		try {
			const started = await f.api.startMemoryProfile(f.session);
			const controller = new AbortController();
			const stopping = stopMemoryProfile(f.session, required(started.profileId), controller.signal);
			controller.abort(new Error("ws://SECRET-ENDPOINT-CANARY"));
			const cancelled = await stopping;
			expect(cancelled.state).toBe("cancelled");
			expect(cancelled.profileId).toBe(started.profileId);
			expect(f.session.memoryJob).toBeUndefined();
		} finally {
			await f.dispose();
		}
	});
	test("compiled worker candidates retain Bun virtual filesystem Windows entrypoint", () => {
		expect(
			profileWorkerSpecifiers(false, "file:///repo/server/lib/browser/memory-profiler.ts"),
		).toEqual(["file:///repo/server/lib/browser/memory-profile-worker.ts"]);
		expect(profileWorkerSpecifiers(true, "file:///$bunfs/root/index.js")).toHaveLength(3);
		expect(
			profileWorkerEntryPoint("file:///C:/~BUN/root/lib/browser/memory-profile-worker.js"),
		).toBe("C:/~BUN/root/lib/browser/memory-profile-worker.js");
	});
	test("pure registry revocation cancels access but leaves file ownership to async caller", async () => {
		const root = await mkdtemp(join(tmpdir(), "nf-profile-registry-"));
		const path = join(root, "artifact.json");
		const id = `profile-test-${Date.now()}`;
		try {
			await writeFile(path, "retained");
			createShare({
				id,
				originalName: "artifact.json",
				storagePath: path,
				size: 8,
				createdBy: "owner",
				expiryHours: 24,
			});
			expect(getShare(id)).not.toBeNull();
			expect(revokeShareRegistry(id)?.storagePath).toBe(path);
			expect(getShare(id)).toBeNull();
			expect(revokeShareRegistry(id)).toBeNull();
			expect(await readFile(path, "utf8")).toBe("retained");
		} finally {
			revokeShareRegistry(id);
			await rm(root, { recursive: true, force: true });
		}
	});
});
