import { rm } from "node:fs/promises";
import { type CDPSession, CDPSessionEvent, type Frame } from "puppeteer-core";
import { logger } from "../logger";
import { reserveDiagnostic } from "./diagnostic-admission";
import {
	HEAP_SNAPSHOT_DEFAULT_TIMEOUT_MS,
	HEAP_SNAPSHOT_MAX_TIMEOUT_MS,
	MEMORY_CLEANUP_TIMEOUT_MS,
	MEMORY_METRICS_DEFAULT_TIMEOUT_MS,
	MEMORY_METRICS_MAX_TIMEOUT_MS,
} from "./memory-constants";
import { runMemoryJob, waitForMemory } from "./memory-job";
import { exportHeapSnapshot } from "./memory-snapshot";
import { SnapshotError } from "./memory-snapshot-stream";
import { type BrowserSession, touchSession } from "./session";

// Puppeteer's bundled public declarations omit this real runtime symbol; a string
// "Disconnected" is silently ineffective. Keep the narrow typing bridge local.
const CDP_DISCONNECTED = (CDPSessionEvent as typeof CDPSessionEvent & { Disconnected: symbol })
	.Disconnected;

export interface MemoryOptions {
	collectGarbage?: boolean;
	timeout?: number;
	signal?: AbortSignal;
}

export interface MemoryMetrics {
	timestamp: string;
	url: string;
	JSHeapUsedSize: number | null;
	JSHeapTotalSize: number | null;
	Documents: number | null;
	Frames: number | null;
	Nodes: number | null;
	JSEventListeners: number | null;
	collectGarbage: boolean;
	durationMs: number;
}

function budget(value: number | undefined, fallback: number, max: number): number {
	return Number.isFinite(value) && value !== undefined && value > 0
		? Math.min(max, Math.max(1, Math.floor(value)))
		: fallback;
}

function metric(value: number | undefined): number | null {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

async function detach(client: CDPSession): Promise<void> {
	const signal = AbortSignal.timeout(MEMORY_CLEANUP_TIMEOUT_MS);
	await waitForMemory(client.detach(), signal).catch(() => {});
}

/** Single deadline covers setup, GC and collection, not one full timeout per command. */
async function withMemorySession<T>(
	session: BrowserSession,
	timeoutMs: number,
	externalSignal: AbortSignal | undefined,
	run: (
		client: CDPSession,
		signal: AbortSignal,
		remainingMs: () => number,
		setStage: (stage: string) => void,
	) => Promise<T>,
): Promise<T> {
	return runMemoryJob(session, timeoutMs, externalSignal, async (jobSignal, remainingMs) => {
		touchSession(session);
		const started = Date.now();
		const changed = new AbortController();
		const signal = AbortSignal.any([jobSignal, changed.signal]);
		const page = session.page;
		const close = () => changed.abort(new Error("Browser memory target closed"));
		const navigate = (frame: Frame) => {
			if (frame === page.mainFrame()) {
				changed.abort(new Error("Browser memory target navigated during diagnostic"));
			}
		};
		page.on("close", close);
		page.on("error", close);
		page.on("framenavigated", navigate);
		let client: CDPSession | undefined;
		let stage = "setup";
		try {
			signal.throwIfAborted();
			if (page.isClosed()) close();
			signal.throwIfAborted();
			const pending = page.createCDPSession();
			// Setup may finish after our deadline; release that late resource too.
			void pending.then(
				(late) => {
					if (signal.aborted) void detach(late);
				},
				() => {},
			);
			client = await waitForMemory(pending, signal);
			const disconnected = () => changed.abort(new Error("Browser memory target disconnected"));
			client.on(CDP_DISCONNECTED, disconnected);
			try {
				const result = await run(client, signal, remainingMs, (value) => {
					stage = value;
				});
				signal.throwIfAborted();
				if (Date.now() - started >= 5_000) {
					logger.info("Slow browser memory diagnostic", {
						sessionId: session.id,
						stage,
						durationMs: Date.now() - started,
					});
				}
				return result;
			} finally {
				client.off(CDP_DISCONNECTED, disconnected);
			}
		} catch (error) {
			// Protocol errors can contain endpoint credentials. Only our typed stages are safe.
			logger.warn("Browser memory diagnostic failed", {
				sessionId: session.id,
				stage: error instanceof SnapshotError ? error.stage : stage,
				durationMs: Date.now() - started,
			});
			if (signal.aborted) throw signal.reason;
			if (error instanceof SnapshotError) throw error;
			throw new Error(`Browser memory diagnostic failed during ${stage}`);
		} finally {
			page.off("close", close);
			page.off("error", close);
			page.off("framenavigated", navigate);
			if (client) await detach(client);
		}
	});
}

export async function memoryMetrics(
	session: BrowserSession,
	opts: MemoryOptions = {},
): Promise<MemoryMetrics> {
	const started = Date.now();
	const url = session.page.url().slice(0, 2048);
	const release = opts.collectGarbage ? reserveDiagnostic("gc") : () => {};
	try {
		return await withMemorySession(
			session,
			budget(opts.timeout, MEMORY_METRICS_DEFAULT_TIMEOUT_MS, MEMORY_METRICS_MAX_TIMEOUT_MS),
			opts.signal,
			async (client, signal, remainingMs, stage) => {
				if (opts.collectGarbage) {
					stage("garbage collection");
					await waitForMemory(
						client.send("HeapProfiler.collectGarbage", undefined, { timeout: remainingMs() }),
						signal,
					);
				}
				stage("metrics");
				await waitForMemory(
					client.send("Performance.enable", undefined, { timeout: remainingMs() }),
					signal,
				);
				const heap = await waitForMemory(
					client.send("Runtime.getHeapUsage", undefined, { timeout: remainingMs() }),
					signal,
				);
				const performance = await waitForMemory(
					client.send("Performance.getMetrics", undefined, { timeout: remainingMs() }),
					signal,
				);
				const values = new Map(performance.metrics.map(({ name, value }) => [name, value]));
				return {
					timestamp: new Date().toISOString(),
					url,
					JSHeapUsedSize: metric(heap.usedSize),
					JSHeapTotalSize: metric(heap.totalSize),
					Documents: metric(values.get("Documents")),
					Frames: metric(values.get("Frames")),
					Nodes: metric(values.get("Nodes")),
					JSEventListeners: metric(values.get("JSEventListeners")),
					collectGarbage: opts.collectGarbage ?? false,
					durationMs: Date.now() - started,
				};
			},
		);
	} finally {
		release();
	}
}

export async function heapSnapshot(
	session: BrowserSession,
	savePath: string,
	maxBytes: number,
	opts: MemoryOptions = {},
): Promise<{ timestamp: string; url: string; fileSize: number; durationMs: number }> {
	const started = Date.now();
	const url = session.page.url().slice(0, 2048);
	const release = reserveDiagnostic("snapshot");
	try {
		return await withMemorySession(
			session,
			budget(opts.timeout, HEAP_SNAPSHOT_DEFAULT_TIMEOUT_MS, HEAP_SNAPSHOT_MAX_TIMEOUT_MS),
			opts.signal,
			async (client, signal, remainingMs, stage) => {
				stage("target lookup");
				const { targetInfo } = await waitForMemory(
					client.send("Target.getTargetInfo", undefined, { timeout: remainingMs() }),
					signal,
				);
				stage("heap snapshot export");
				const result = await exportHeapSnapshot({
					wsEndpoint: session.page.browser().wsEndpoint(),
					targetId: targetInfo.targetId,
					savePath,
					maxBytes,
					timeoutMs: remainingMs(),
					collectGarbage: opts.collectGarbage ?? false,
					signal,
				});
				logger.info("Browser heap snapshot exported", {
					sessionId: session.id,
					fileSize: result.fileSize,
					durationMs: Date.now() - started,
				});
				return {
					...result,
					timestamp: new Date().toISOString(),
					url,
					durationMs: Date.now() - started,
				};
			},
		);
	} catch (error) {
		await waitForMemory(
			Promise.all([rm(savePath, { force: true }), rm(`${savePath}.partial`, { force: true })]),
			AbortSignal.timeout(MEMORY_CLEANUP_TIMEOUT_MS),
		).catch(() => {});
		throw error;
	} finally {
		release();
	}
}
