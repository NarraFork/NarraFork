import type {
	TokenProtocolResolution,
	TokenRecalculationJob,
	TokenRecalculationRange,
} from "../../shared/token-recalculation";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { tokenRecalculationRangeSchema } from "../lib/validators/token-recalculation";
import {
	runTokenRecalculation,
	type TokenRecalculationRow,
	type TokenRecalculationStore,
} from "./token-recalculation";

interface RecalculationDependencies {
	createStore(signal: AbortSignal): Promise<TokenRecalculationStore>;
	createResolver(): Promise<(row: TokenRecalculationRow) => TokenProtocolResolution>;
}

export class TokenRecalculationService {
	private job: TokenRecalculationJob | null = null;
	private controller: AbortController | null = null;
	private done: Promise<void> = Promise.resolve();
	constructor(private readonly dependencies: RecalculationDependencies) {}

	get(): TokenRecalculationJob | null {
		return this.job ? { ...this.job } : null;
	}
	start(range: TokenRecalculationRange): TokenRecalculationJob {
		const parsed = tokenRecalculationRangeSchema.parse(range);
		if (this.job?.status === "running")
			throw new AppError(
				"A token recalculation is already running",
				409,
				"TOKEN_RECALCULATION_BUSY",
			);
		const job: TokenRecalculationJob = {
			...parsed,
			id: generateId(),
			status: "running",
			startedAt: new Date().toISOString(),
			finishedAt: null,
			scanned: 0,
			processed: 0,
			changed: 0,
			skipped: 0,
			fallback: 0,
			error: null,
		};
		const controller = new AbortController();
		this.job = job;
		this.controller = controller;
		this.done = Promise.resolve().then(() => this.execute(job, controller.signal));
		return { ...job };
	}
	cancel(id: string): TokenRecalculationJob {
		if (!this.job || this.job.id !== id)
			throw new AppError("Token recalculation not found", 404, "NOT_FOUND");
		this.controller?.abort();
		return { ...this.job };
	}
	/** Useful for graceful callers and isolated tests; never waited on by the start HTTP route. */
	async wait(): Promise<void> {
		await this.done;
	}

	private async execute(job: TokenRecalculationJob, signal: AbortSignal): Promise<void> {
		let store: TokenRecalculationStore | undefined;
		let failed = false;
		try {
			if (signal.aborted) return;
			store = await this.dependencies.createStore(signal);
			await runTokenRecalculation(
				job,
				store,
				await this.dependencies.createResolver(),
				signal,
				(milliseconds, rows) => {
					logger.warn("Slow token recalculation batch", {
						jobId: job.id,
						milliseconds: Math.round(milliseconds),
						rows,
					});
				},
			);
		} catch (error) {
			failed = !signal.aborted;
			if (failed) {
				job.error =
					"Token recalculation failed. Completed batches are retained; running it again will skip them.";
				// Do not put database driver messages/connection credentials into the API response or logs.
				logger.warn("Token recalculation failed", {
					jobId: job.id,
					errorType: error instanceof Error ? error.name : "unknown",
				});
			}
		} finally {
			try {
				await store?.close();
			} catch {
				failed = true;
				job.error = "Token recalculation worker failed to close. Completed batches are retained.";
			}
			job.status = failed ? "failed" : signal.aborted ? "cancelled" : "completed";
			job.finishedAt = new Date().toISOString();
			this.controller = null;
		}
	}
}

export function getTokenRecalculationService(): TokenRecalculationService {
	return hotSafe(
		"token-recalculation-service",
		() =>
			new TokenRecalculationService({
				async createStore(signal) {
					const { activeDatabaseBackend, postgresRuntime } = await import("../db");
					if (activeDatabaseBackend === "postgres") {
						if (!postgresRuntime) throw new Error("PostgreSQL runtime is unavailable");
						const { createPostgresTokenRecalculationStore } = await import(
							"./token-recalculation-postgres"
						);
						return createPostgresTokenRecalculationStore(postgresRuntime.client.sql);
					}
					const { getDbPath } = await import("../db/connection");
					const { createTokenRecalculationWorkerStore } = await import(
						"./token-recalculation-worker-client"
					);
					return createTokenRecalculationWorkerStore(getDbPath(), signal);
				},
				async createResolver() {
					// This resolver only reads local configuration/catalog caches; it never calls providers.
					const { createRuntimeTokenRecalculationProtocolResolver } = await import(
						"./token-recalculation-protocol"
					);
					return createRuntimeTokenRecalculationProtocolResolver();
				},
			}),
	);
}
