import { randomUUID } from "node:crypto";
import { db } from "@server/db";
import { narratorMessageRefs, narrators } from "@server/db/schema";
import { isRetryableError } from "@server/lib/agent/error-handling";
import {
	buildModelTraceProbeParams,
	getModelTraceRequest,
	type ModelTraceRequest,
	requireModelTraceAnchor,
} from "@server/lib/agent/modeltrace-request";
import { OutputContentAccumulator } from "@server/lib/agent/output-content";
import type { ChatParams, ParsedStreamEvent, ProviderAdapter } from "@server/lib/agent/provider";
import type { AgentEvent } from "@server/lib/agent/types";
import { finishApiRequest, startApiRequest } from "@server/lib/api-request-tracker";
import { withDbRetry } from "@server/lib/db-resilience";
import { ValidationError } from "@server/lib/errors";
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import {
	analyzeModelTrace,
	buildModelTraceChallenges,
	MODELTRACE_MAX_TEXT_LENGTH,
} from "@server/lib/modeltrace";
import { parseTraits } from "@server/lib/narrator-utils";
import { buildUsageDataFromSnapshot } from "@server/lib/usage-tracking";
import { normalizeLocale } from "@shared/i18n-locales";
import type { ModelTraceResultBlock, ModelTraceSampleProgress } from "@shared/modeltrace-result";
import { and, eq, ne, sql } from "drizzle-orm";
import { createRuntimeEventContext } from "./agent-runtime/context";
import { type ExecutionOwner, tryClaimExecution } from "./agent-runtime/ownership";
import {
	clearTraceHistory,
	createDiagnosticNarrator,
	ensureTraceNarrator,
} from "./modeltrace-store";
import type { NarratorPrincipal } from "./narrator-acl";

export interface ModelTraceOptions {
	fork?: boolean;
	calibrate?: boolean;
}

type ProbeTarget = { adapter: ProviderAdapter; provider: string; model: string };
type ProbePlan = ProbeTarget & {
	fork?: { anchor: ModelTraceRequest; sourceId: string };
	calibrate: boolean;
};
type Challenge = ReturnType<typeof buildModelTraceChallenges>[number];
type ScoringSample = { text: string; expected_count: number };
type CompletedSlot = { sample: ScoringSample; cacheReadTokens: number | null; attempt: number };
type CalibrationRecord = {
	id: string;
	messageId: string;
	challenges: Challenge[];
	slots: (CompletedSlot | undefined)[];
};
type RoundRecord = { plan: ProbePlan; expiresAt: number; calibration?: CalibrationRecord };
const RECORD_TTL_MS = 30 * 60_000;
const MAX_RECORDS = 64;
const records = hotSafe("modeltrace.roundRecords", () => new Map<string, RoundRecord>());

function rememberRound(id: string, plan: ProbePlan) {
	const now = Date.now();
	for (const [key, record] of records) {
		if (record.expiresAt <= now) records.delete(key);
	}
	records.delete(id);
	const record: RoundRecord = { plan, expiresAt: now + RECORD_TTL_MS };
	records.set(id, record);
	if (records.size > MAX_RECORDS) {
		const oldest = records.keys().next().value;
		if (oldest !== undefined) records.delete(oldest);
	}
	return record;
}

function currentRecord(id: string): RoundRecord | undefined {
	const record = records.get(id);
	if (record && record.expiresAt <= Date.now()) {
		records.delete(id);
		return undefined;
	}
	return record;
}

// Session interrupt imports cancelModelTrace synchronously. Load persistence, websocket
// and narrator-service only on execution to avoid their session dependency cycles.
const controllers = hotSafe("modeltrace.controllers", () => new Map<string, AbortController>());
const ATTEMPT_TIMEOUT_MS = 240_000;
const ROUND_TIMEOUT_MS = 17 * 60_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const MAX_PROGRESS_TEXT = 120;
const PROGRESS_TEXT_STEP = 24;
const PROGRESS_INTERVAL_MS = 150;

class TransientSampleError extends Error {}
class PermanentSampleError extends Error {}
class RoundTimeoutError extends Error {}

async function retryDelay(ms: number, signal: AbortSignal) {
	signal.throwIfAborted();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await withAbort(
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, Math.round(ms * (0.8 + Math.random() * 0.4)));
			}),
			signal,
		);
	} finally {
		clearTimeout(timer);
	}
}

async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	const abort = Promise.withResolvers<never>();
	const onAbort = () => abort.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		const value = await Promise.race([work, abort.promise]);
		signal.throwIfAborted();
		return value;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Only the diagnostic child is canceled; its parent execution is never touched. */
export function cancelModelTrace(id: string): boolean {
	const controller = controllers.get(id);
	if (!controller) return false;
	controller.abort(new Error("ModelTrace canceled"));
	return true;
}

function probeParams(plan: ProbePlan, signal: AbortSignal, prompt: string): ChatParams {
	// Every sample has its own transport; only explicit fork opts into the
	// parent's cache/affinity keys. Never pass parent callbacks or abort signal.
	const sessionKey = randomUUID();
	if (plan.fork) return buildModelTraceProbeParams(plan.fork.anchor, sessionKey, signal, prompt);
	if (plan.adapter.isDiagnosticConnectionCurrent?.() === false)
		throw new ValidationError("ModelTrace target connection changed; start a new diagnostic");
	return {
		conversationId: sessionKey,
		stickySessionKey: sessionKey,
		transportSessionKey: sessionKey,
		content: prompt,
		model: plan.model,
		cwd: "",
		history: [],
		tools: [],
		toolResults: [],
		diagnostic: true,
		signal,
	};
}

function failureReport(error: unknown): ModelTraceResultBlock {
	return {
		type: "modeltrace_result",
		results: [],
		error: error instanceof Error ? error.message.slice(0, 300) : "ModelTrace failed",
	};
}

function reportSummary(result: ModelTraceResultBlock): string {
	return result.error ?? `ModelTrace: ${result.results[0]?.displayName ?? ""}`;
}

async function report(id: string, result: ModelTraceResultBlock) {
	const { narratorPersistence } = await import("./narrator-persistence");
	return narratorPersistence.persistDisplayMessage(id, reportSummary(result), [result]);
}

async function patchCalibrationCard(id: string, cardId: string, result: ModelTraceResultBlock) {
	const { readEnvelope, writeEnvelopeBody } = await import("./narrator-body-writes");
	const { cowEnvelopeTx } = await import("./narrator-persistence");
	const { broadcastToNarrator } = await import("@server/websocket/narrator-ws");
	const contentJson = [result];
	const contentText = reportSummary(result);
	const updated = await withDbRetry(
		async () =>
			db.transaction(
				(tx) => {
					const ref = tx.query.narratorMessageRefs
						.findFirst({
							where: and(
								eq(narratorMessageRefs.narratorId, id),
								eq(narratorMessageRefs.messageId, cardId),
							),
							columns: { id: true, narratorId: true, seq: true },
						})
						.sync();
					const prior = readEnvelope(tx, cardId);
					if (!ref || prior?.role !== "disp" || prior.narratorId !== id)
						throw new Error("ModelTrace calibration card no longer exists");
					const shared = tx.query.narratorMessageRefs
						.findFirst({
							where: and(
								eq(narratorMessageRefs.messageId, cardId),
								ne(narratorMessageRefs.narratorId, id),
							),
							columns: { id: true },
						})
						.sync();
					let messageId = cardId;
					if (shared) {
						messageId = cowEnvelopeTx(tx, {
							original: prior,
							ref,
							toolCalls: [],
							changes: { contentJson, contentText },
						});
					} else if (!writeEnvelopeBody(tx, cardId, contentJson, { set: { contentText } })) {
						throw new Error("ModelTrace calibration card cannot be updated");
					}
					tx.update(narrators)
						.set({ messageVersion: sql`${narrators.messageVersion} + 1` })
						.where(eq(narrators.id, id))
						.run();
					const persisted = readEnvelope(tx, messageId);
					if (!persisted) throw new Error("ModelTrace calibration card could not be read back");
					return { ...persisted, seq: ref.seq, refId: ref.id, children: [] };
				},
				{ behavior: "immediate" },
			),
		{ label: "modeltrace.patchCalibrationCard" },
	);
	try {
		broadcastToNarrator(id, {
			type: "message_updated",
			narratorId: id,
			message: updated,
			...(updated.id !== cardId ? { oldMessageId: cardId, replacedMessageId: cardId } : {}),
		});
	} catch (error) {
		logger.warn("Failed to broadcast committed ModelTrace progress", { id, error });
	}
	return updated.id;
}

function createCalibrationProgress(
	id: string,
	initialCardId: string,
	states: ModelTraceSampleProgress[],
) {
	let cardId = initialCardId;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let writing: Promise<void> | undefined;
	let closed = false;
	let dirty = false;
	const snapshot = () => states.map((state) => ({ ...state }));
	const schedule = () => {
		if (closed || timer || writing || !dirty) return;
		timer = setTimeout(() => {
			timer = undefined;
			dirty = false;
			writing = patchCalibrationCard(id, cardId, {
				type: "modeltrace_result",
				results: [],
				calibrationRequested: true,
				progressOnly: true,
				sampleProgress: snapshot(),
			})
				.then((updated) => {
					cardId = updated;
				})
				.catch((error) => {
					logger.warn("Failed to publish ModelTrace progress", { id, error });
				})
				.finally(() => {
					writing = undefined;
					schedule();
				});
		}, PROGRESS_INTERVAL_MS);
	};
	return {
		update(index: number, state: ModelTraceSampleProgress) {
			states[index] = state;
			dirty = true;
			schedule();
		},
		async finish(result: ModelTraceResultBlock) {
			closed = true;
			clearTimeout(timer);
			await writing;
			return patchCalibrationCard(id, cardId, { ...result, sampleProgress: snapshot() });
		},
		snapshot,
	};
}

async function releaseProbe(id: string, owner: ExecutionOwner, locale: string): Promise<void> {
	controllers.delete(id);
	if (!owner.release()) return;
	const { wakeInboxIfEligible } = await import("./agent-runtime/inbox");
	await wakeInboxIfEligible(id, normalizeLocale(locale));
}

async function runSample(
	id: string,
	plan: ProbePlan,
	challenge: Challenge,
	roundSignal: AbortSignal,
	locale: string,
	userId: string,
	onText?: (preview: string) => void,
) {
	const controller = new AbortController();
	const signal = AbortSignal.any([roundSignal, controller.signal]);
	const params = probeParams(plan, signal, challenge.prompt);
	const handler = onText ? undefined : await import("./narrator-event-handler");
	signal.throwIfAborted();
	const request = startApiRequest({
		kind: "modeltrace",
		userId,
		narratorId: id,
		provider: plan.provider,
		model: params.model,
	});
	const startedAt = request.startTime;
	let text = "";
	let previewLength = 0;
	let usage: ParsedStreamEvent["usage"];
	let cacheReadTokens: number | null = null;
	let upstreamMessageId: string | undefined;
	let persistedMessageId: string | undefined;
	let credentialId: string | undefined;
	let ttftMs: number | undefined;
	let metering: ParsedStreamEvent["metering"];
	let contextPercent: number | undefined;
	let failure: ModelTraceResultBlock | undefined;
	let retryable = false;
	let stream: AsyncGenerator<ParsedStreamEvent> | undefined;
	const output = handler && new OutputContentAccumulator();
	const ctx =
		handler &&
		createRuntimeEventContext({
			narratorId: id,
			conversationId: params.conversationId,
			provider: plan.provider,
			model: params.model,
			locale,
			getTurnStartedAt: () => new Date(startedAt).toISOString(),
			getTtftMs: () => ttftMs,
		});
	let pendingText = "";
	let lastFlushAt: number | undefined;
	const dispatch = async (events: Iterable<AgentEvent>) => {
		if (handler && ctx) for (const event of events) await handler.processEvent(event, ctx);
	};
	const flushText = async () => {
		if (!pendingText || !handler || !ctx || !output) return;
		const delta = pendingText;
		pendingText = "";
		const identity = output.append("text", delta);
		await handler.processEvent({ type: "stream_text", text: delta, ...identity }, ctx);
		lastFlushAt = Date.now();
	};
	const syncUsage = () => {
		ctx?.setTokenUsage(usage);
		if (contextPercent !== undefined) ctx?.setContextUsagePct(contextPercent);
		if (metering) ctx?.setMeterData(metering.usage, metering.unit);
	};
	// This callback belongs only to the probe. Internal transport retries update the
	// credential on the same handle; they never create extra request/billing rows.
	params.onRequestStart = (info) => {
		credentialId = info?.credentialId ?? credentialId;
	};
	let transport = true;
	const timer = setTimeout(
		() => controller.abort(new TransientSampleError("ModelTrace attempt timed out (240 seconds)")),
		ATTEMPT_TIMEOUT_MS,
	);
	try {
		try {
			signal.throwIfAborted();
			stream = plan.adapter.chat(params);
			let nextEvent = stream.next();
			while (true) {
				// Keep one outstanding iterator read. A short pause still publishes the
				// final pending delta without waiting for another provider token.
				let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
				const due = pendingText
					? new Promise<null>((resolve) => {
							coalesceTimer = setTimeout(
								() => resolve(null),
								Math.max(0, 40 - (Date.now() - (lastFlushAt ?? 0))),
							);
						})
					: undefined;
				let next: IteratorResult<ParsedStreamEvent> | null;
				try {
					next = await withAbort(due ? Promise.race([nextEvent, due]) : nextEvent, signal);
				} finally {
					clearTimeout(coalesceTimer);
				}
				if (next === null) {
					transport = false;
					await flushText();
					transport = true;
					continue;
				}
				if (next.done) break;
				const event = next.value;
				// Failed terminal events may still carry billable usage and partial text.
				if (event.usage) {
					usage = { ...usage, ...event.usage };
					// Some adapters normalize absent counters to zero for accounting.
					// Do not present those as provider-observed cache measurements.
					const cached = event.usage.cachedInputTokens;
					if (
						event.usage.cacheReported !== false &&
						typeof cached === "number" &&
						Number.isInteger(cached) &&
						cached >= 0
					)
						cacheReadTokens = cached;
				}
				upstreamMessageId = event.messageId ?? upstreamMessageId;
				credentialId = event.credentialId ?? credentialId;
				metering = event.metering ?? metering;
				contextPercent = event.contextUsagePercentage ?? contextPercent;
				if ((event.text || event.reasoning) && ttftMs === undefined)
					ttftMs = Date.now() - startedAt;
				if (event.text) {
					if (text.length + event.text.length > MODELTRACE_MAX_TEXT_LENGTH) {
						throw new PermanentSampleError("ModelTrace failed: answer exceeds 10,000 characters");
					}
					text += event.text;
					if (handler) pendingText += event.text;
					if (
						onText &&
						previewLength < MAX_PROGRESS_TEXT &&
						(previewLength === 0 ||
							text.length - previewLength >= PROGRESS_TEXT_STEP ||
							text.length >= MAX_PROGRESS_TEXT)
					) {
						previewLength = Math.min(text.length, MAX_PROGRESS_TEXT);
						onText(text.slice(0, previewLength));
					}
				}
				syncUsage();
				if (pendingText && (lastFlushAt === undefined || Date.now() - lastFlushAt >= 40)) {
					transport = false;
					await flushText();
					transport = true;
				}
				if (
					event.toolUseChunk ||
					event.toolUses?.length ||
					event.webSearch ||
					event.imageGeneration
				) {
					throw new PermanentSampleError(
						"ModelTrace failed: the model attempted a tool call; no tools were executed",
					);
				}
				if (event.invalidState) {
					const ErrorType = isRetryableError(event.invalidState, [])
						? TransientSampleError
						: PermanentSampleError;
					throw new ErrorType(`ModelTrace failed: ${event.invalidState.message.slice(0, 500)}`);
				}
				if (event.silentDisconnect)
					throw new TransientSampleError("ModelTrace failed: upstream disconnected");
				if (
					("error" in event && event.error) ||
					("outputTruncated" in event && event.outputTruncated)
				) {
					throw new PermanentSampleError("ModelTrace failed: provider error or truncated output");
				}
				if (
					event.stopReason &&
					!["stop", "end_turn", "stop_sequence", "completed"].includes(
						event.stopReason.toLowerCase(),
					)
				) {
					throw new PermanentSampleError(
						`ModelTrace failed: incomplete response (${event.stopReason.slice(0, 100)})`,
					);
				}
				nextEvent = stream.next();
			}
		} catch (error) {
			const cause = signal.aborted ? signal.reason : error;
			failure = failureReport(cause);
			retryable =
				!roundSignal.aborted &&
				(cause instanceof TransientSampleError ||
					(transport &&
						!(cause instanceof PermanentSampleError) &&
						!(cause instanceof ValidationError) &&
						isRetryableError(cause, [])));
			controller.abort(cause);
		} finally {
			clearTimeout(timer);
			// A broken adapter must not hold cancellation or the execution owner forever.
			if (stream)
				void Promise.resolve()
					.then(() => stream?.return(undefined))
					.catch(() => {});
		}
		if (!failure && !text.trim())
			failure = failureReport(new Error("ModelTrace returned no sample text"));
		syncUsage();
		await flushText();
		if (output) await dispatch(output.flush());
		persistedMessageId = ctx?.getPartialMessageId();
		if (handler && ctx && (text || usage)) {
			await handler.processEvent(
				{
					type: "assistant_message",
					messageId: upstreamMessageId ?? randomUUID(),
					text,
					toolUses: [],
					credentialId,
					outputCompleted: !failure,
				},
				ctx,
				{
					// Usage-only responses have no partial. Observe the native writer's
					// identity without adding a second persistence/broadcast path.
					onTitleCheck: async (savedId) => {
						persistedMessageId = savedId;
						return null;
					},
				},
			);
		}
	} catch (error) {
		failure = failureReport(error);
		retryable = false;
		// Persistence/publication failures must not leave a reconnect ghost or an
		// open partial. Preserve any durable prefix as interrupted output.
		try {
			const partialId = ctx?.getPartialMessageId() ?? persistedMessageId;
			if (partialId) {
				persistedMessageId = partialId;
				const { narratorPersistence } = await import("./narrator-persistence");
				await narratorPersistence.patchStepMeta(partialId, {
					durationMs: Date.now() - startedAt,
					ttftMs,
				});
			}
		} catch (cleanupError) {
			logger.warn("Failed to preserve partial ModelTrace metadata", { id, cleanupError });
		}
		try {
			if (handler && ctx) await handler.processEvent({ type: "stream_reset" }, ctx);
		} catch (cleanupError) {
			logger.warn("Failed to reset ModelTrace stream", { id, cleanupError });
		}
	} finally {
		handler?.clearStreamingSnapshot(id);
		controller.abort();
	}
	return {
		sample: { text, expected_count: challenge.expectedCount },
		cacheReadTokens,
		failure,
		retryable,
		request,
		billing: {
			messageId: persistedMessageId,
			credentialId,
			usage: buildUsageDataFromSnapshot(usage),
			ttftMs,
			durationMs: Date.now() - startedAt,
			contextPercent,
			meterUsage: metering?.usage,
			meterUnit: metering?.unit,
		},
	};
}

async function publishChallenge(id: string, challenge: Challenge, userId: string) {
	const { narratorPersistence } = await import("./narrator-persistence");
	const { broadcastToNarrator } = await import("@server/websocket/narrator-ws");
	const saved = await narratorPersistence.persistUserMessage(
		id,
		challenge.prompt,
		undefined,
		"/modeltrace",
		userId,
	);
	broadcastToNarrator(id, {
		type: "message",
		narratorId: id,
		message: { ...saved, children: [] },
	});
}

async function recordSample(sample: Awaited<ReturnType<typeof runSample>>, errorMessage?: string) {
	try {
		await finishApiRequest(sample.request, { ...sample.billing, errorMessage });
	} catch (error) {
		logger.warn("Failed to record ModelTrace API request", { requestId: sample.request.id, error });
	}
}

type Round = {
	id: string;
	plan: ProbePlan;
	challenges: Challenge[];
	slots: (CompletedSlot | undefined)[];
	cacheReadTokens: (number | null)[];
	controller: AbortController;
	owner: ExecutionOwner;
	locale: string;
	userId: string;
	record: RoundRecord;
	progress?: ReturnType<typeof createCalibrationProgress>;
	previousSlots?: CalibrationRecord["slots"];
};

async function runSlot(round: Round, challenge: Challenge, index: number) {
	const { id, plan, controller, locale, userId, progress } = round;
	const { signal } = controller;
	let attempt = 0;
	let text: string | undefined;
	const update = (state: ModelTraceSampleProgress["state"]) => {
		progress?.update(index, { state, attempt: attempt || undefined, text });
	};
	try {
		for (;;) {
			signal.throwIfAborted();
			attempt++;
			text = undefined;
			update("running");
			const result = await runSample(
				id,
				plan,
				challenge,
				signal,
				locale,
				userId,
				progress &&
					((preview) => {
						text = preview;
						update("running");
					}),
			);
			if (progress) text = result.sample.text.slice(0, MAX_PROGRESS_TEXT) || undefined;
			// Visible cache observations belong to this round, even for samples scoring rejects.
			round.cacheReadTokens[index] = result.cacheReadTokens;
			// One ledger entry per attempted request, including partial usage from failed tries.
			await recordSample(result, result.failure?.error);
			if (!result.failure) {
				round.slots[index] = {
					sample: result.sample,
					cacheReadTokens: result.cacheReadTokens,
					attempt,
				};
				update("complete");
				return;
			}
			signal.throwIfAborted();
			const delay = RETRY_DELAYS_MS[attempt - 1];
			if (!result.retryable || delay === undefined) {
				update("failed");
				return result.failure;
			}
			update("retrying");
			await retryDelay(delay, signal);
		}
	} catch (error) {
		update(
			signal.aborted && !(signal.reason instanceof RoundTimeoutError) ? "cancelled" : "failed",
		);
		return failureReport(error);
	}
}

async function runRound(round: Round) {
	const { id, plan, challenges, slots, controller, owner, locale, progress, record } = round;
	const signal = controller.signal;
	const timer = setTimeout(
		() => controller.abort(new RoundTimeoutError("ModelTrace timed out (17 minutes)")),
		ROUND_TIMEOUT_MS,
	);
	let result: ModelTraceResultBlock | undefined;
	const activeChallenges = plan.calibrate ? challenges : challenges.slice(0, 1);
	const cacheReadTokens = () => round.cacheReadTokens.slice(0, activeChallenges.length);
	try {
		try {
			const failures = await Promise.all(
				activeChallenges.map((challenge, index) =>
					slots[index] ? undefined : runSlot(round, challenge, index),
				),
			);
			signal.throwIfAborted();
			const completed = slots.flatMap((slot, index) => (slot ? [{ slot, index }] : []));
			if (completed.length) {
				const { acceptedSampleIndexes, ...ranking } = await withAbort(
					analyzeModelTrace(
						completed.map(({ slot }) => slot.sample),
						locale,
						signal,
					),
					signal,
				);
				result = ranking;
				if (acceptedSampleIndexes) {
					const accepted = new Set(acceptedSampleIndexes);
					for (const [inputIndex, { slot, index }] of completed.entries()) {
						if (accepted.has(inputIndex)) continue;
						slots[index] = undefined;
						progress?.update(index, {
							state: "failed",
							attempt: slot.attempt,
							text: slot.sample.text.slice(0, MAX_PROGRESS_TEXT),
						});
					}
				}
			} else {
				result =
					failures.find(Boolean) ?? failureReport(new Error("ModelTrace produced no samples"));
			}
		} catch (error) {
			result = failureReport(error);
		}
		// A result grants a one-use token only when a supplemental round can reuse
		// at least one answer and still has slots to fill. No text is stored in the token.
		const reusableSlots =
			result.decision === "partial" || result.decision === "scored"
				? slots
				: result.decision !== "not_model"
					? round.previousSlots
					: undefined;
		const calibrationId =
			currentRecord(id) === record &&
			reusableSlots?.some(Boolean) &&
			reusableSlots.includes(undefined)
				? randomUUID()
				: undefined;
		const decorated = {
			...result,
			calibrationRequested: plan.calibrate,
			cacheReadTokens: cacheReadTokens(),
			calibrationId,
		};
		try {
			const messageId = progress
				? await progress.finish(decorated)
				: (await report(id, decorated)).id;
			if (calibrationId && reusableSlots && currentRecord(id) === record && messageId) {
				record.calibration = { id: calibrationId, messageId, challenges, slots: reusableSlots };
				record.expiresAt = Date.now() + RECORD_TTL_MS;
			}
		} catch (error) {
			result = failureReport(error);
			if (!progress) {
				const { processEvent, clearStreamingSnapshot } = await import("./narrator-event-handler");
				const ctx = createRuntimeEventContext({
					narratorId: id,
					conversationId: id,
					provider: plan.provider,
					model: plan.model,
					locale,
				});
				try {
					await processEvent({ type: "stream_reset" }, ctx);
				} finally {
					clearStreamingSnapshot(id);
				}
			}
			await report(id, {
				...result,
				calibrationRequested: plan.calibrate,
				cacheReadTokens: cacheReadTokens(),
				sampleProgress: progress?.snapshot(),
			});
		}
	} finally {
		clearTimeout(timer);
		controller.abort();
		try {
			const { narratorPersistence } = await import("./narrator-persistence");
			await narratorPersistence.updateStatus(id, "idle", {
				substatus: result?.error ? ["error"] : [],
				errorMessage: result?.error,
				skipErrorMessage: true,
			});
		} finally {
			await releaseProbe(id, owner, locale);
		}
	}
}

function targetFromSnapshot(snapshot: ModelTraceRequest): ProbeTarget {
	return { adapter: snapshot.adapter, provider: snapshot.provider, model: snapshot.params.model };
}

async function isolatedTarget(parentId: string): Promise<ProbeTarget> {
	const snapshot = getModelTraceRequest(parentId);
	if (snapshot?.provider) return targetFromSnapshot(snapshot);
	const source = await db.query.narrators.findFirst({
		where: eq(narrators.id, parentId),
		columns: { model: true },
	});
	if (!source) throw new ValidationError("ModelTrace source narrator does not exist");
	const { resolveProviderAndModel } = await import("@server/lib/agent/provider");
	return resolveProviderAndModel(source.model ?? undefined);
}

/** Both first launch and same-child retries have exactly one owner and controller. */
async function launchProbe(
	id: string,
	plan: ProbePlan,
	userId: string,
	locale: string,
	owner: ExecutionOwner,
	record: RoundRecord,
	seed?: CalibrationRecord,
): Promise<{ id: string }> {
	const controller = new AbortController();
	controllers.set(id, controller);
	try {
		const { narratorPersistence } = await import("./narrator-persistence");
		// Reserve a complete, distinct challenge set before sending the first sample.
		const challenges = seed?.challenges ?? buildModelTraceChallenges(3);
		const first = challenges[0];
		if (
			!first ||
			challenges.length !== 3 ||
			new Set(challenges.map(({ expectedCount }) => expectedCount)).size !== 3
		)
			throw new Error("ModelTrace failed: expected three distinct sampling challenges");
		const slots = challenges.map((_, index) => seed?.slots[index]);
		await narratorPersistence.updateStatus(id, "working", { setTurnStart: true, substatus: [] });
		let progress: Round["progress"];
		if (plan.calibrate) {
			const states = slots.map(
				(slot): ModelTraceSampleProgress =>
					slot
						? {
								state: "complete",
								attempt: slot.attempt,
								text: slot.sample.text.slice(0, MAX_PROGRESS_TEXT),
							}
						: { state: "pending" },
			);
			const card = await report(id, {
				type: "modeltrace_result",
				results: [],
				calibrationRequested: true,
				progressOnly: true,
				sampleProgress: states.map((state) => ({ ...state })),
			});
			progress = createCalibrationProgress(id, card.id, states);
		} else {
			await publishChallenge(id, first, userId);
		}
		record.calibration = undefined;
		void runRound({
			id,
			plan,
			challenges,
			slots,
			cacheReadTokens: slots.map((slot) => slot?.cacheReadTokens ?? null),
			controller,
			owner,
			locale,
			userId,
			record,
			progress,
			previousSlots: seed?.slots,
		}).catch((error) => {
			logger.error("ModelTrace finalization failed", { id, error });
		});
		return { id };
	} catch (error) {
		controller.abort();
		try {
			const { narratorPersistence } = await import("./narrator-persistence");
			await narratorPersistence.updateStatus(id, "idle", {
				substatus: ["error"],
				errorMessage: failureReport(error).error,
				skipErrorMessage: true,
			});
		} finally {
			await releaseProbe(id, owner, locale);
		}
		throw error;
	}
}

function asPrincipal(user: string | NarratorPrincipal): NarratorPrincipal {
	return typeof user === "string" ? { userId: user, isAdmin: false } : user;
}

async function requireReadWriteAccess(sourceId: string, principal: NarratorPrincipal) {
	const { assertNarratorAccess, loadNarratorForAccess } = await import("./narrator-acl");
	const source = await loadNarratorForAccess(sourceId, principal, "write");
	// Write audiences and visibility are separate axes. Replaying the frozen
	// request requires permission to read the source as well as drive it.
	await assertNarratorAccess(source, principal, "read");
}

export async function startModelTrace(
	parentId: string,
	user: string | NarratorPrincipal,
	locale = "en",
	options: ModelTraceOptions = {},
): Promise<{ id: string }> {
	const principal = asPrincipal(user);
	const { userId } = principal;
	if (options.fork) await requireReadWriteAccess(parentId, principal);
	const anchor = options.fork ? requireModelTraceAnchor(parentId) : undefined;
	if (anchor && !anchor.provider)
		throw new ValidationError("ModelTrace fork anchor expired; send a message and try again");
	const target = anchor ? targetFromSnapshot(anchor) : await isolatedTarget(parentId);
	const plan: ProbePlan = {
		...target,
		fork: anchor ? { anchor, sourceId: parentId } : undefined,
		calibrate: options.calibrate === true,
	};
	const identity = { userId, model: plan.model, title: `ModelTrace: ${plan.model}`, locale };
	const traceId = anchor
		? await createDiagnosticNarrator(identity)
		: await ensureTraceNarrator({ ...identity, parentId, provider: plan.provider });
	// 先占住可复用舱的执行锁再清历史，重叠的一次运行不能删掉正在用的记录。
	const owner = tryClaimExecution(traceId, "run");
	if (!owner) throw new ValidationError("ModelTrace child already has an active execution");
	try {
		if (!anchor) await clearTraceHistory(traceId);
	} catch (error) {
		owner.release();
		throw error;
	}
	return launchProbe(traceId, plan, userId, locale, owner, rememberRound(traceId, plan));
}

export async function retryModelTrace(
	childId: string,
	user: string | NarratorPrincipal,
	locale = "en",
): Promise<{ id: string }> {
	const child = await db.query.narrators.findFirst({
		where: eq(narrators.id, childId),
		columns: { traits: true, status: true },
	});
	if (!child || !parseTraits(child.traits).includes("modeltrace"))
		throw new ValidationError("Only a ModelTrace child can be retried");
	if (child.status === "working" || child.status === "waiting")
		throw new ValidationError("ModelTrace child already has an active execution");
	const owner = tryClaimExecution(childId, "run");
	if (!owner) throw new ValidationError("ModelTrace child already has an active execution");
	const principal = asPrincipal(user);
	let record: RoundRecord;
	try {
		const current = currentRecord(childId);
		if (!current)
			throw new ValidationError(
				"ModelTrace retry expired; start a new diagnostic from the source narrator",
			);
		if (current.plan.fork) await requireReadWriteAccess(current.plan.fork.sourceId, principal);
		record = rememberRound(childId, current.plan);
	} catch (error) {
		owner.release();
		throw error;
	}
	return launchProbe(childId, record.plan, principal.userId, locale, owner, record);
}

export async function calibrateModelTrace(
	childId: string,
	resultId: string,
	principal: NarratorPrincipal,
	locale = "en",
): Promise<{ id: string }> {
	await requireReadWriteAccess(childId, principal);
	const owner = tryClaimExecution(childId, "run");
	if (!owner) throw new ValidationError("ModelTrace child already has an active execution");
	let record: RoundRecord;
	let seed: CalibrationRecord;
	try {
		const child = await db.query.narrators.findFirst({
			where: eq(narrators.id, childId),
			columns: { traits: true, status: true, model: true },
		});
		if (!child || !parseTraits(child.traits).includes("modeltrace"))
			throw new ValidationError("Only a ModelTrace child can be calibrated");
		if (child.status === "working" || child.status === "waiting")
			throw new ValidationError("ModelTrace child already has an active execution");
		const expired = () =>
			new ValidationError(
				"ModelTrace calibration result expired or was replaced; start a new diagnostic",
			);
		const current = currentRecord(childId);
		if (!current?.calibration || current.calibration.id !== resultId) throw expired();
		record = current;
		seed = current.calibration;
		if (record.plan.fork) await requireReadWriteAccess(record.plan.fork.sourceId, principal);
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, childId),
				eq(narratorMessageRefs.messageId, seed.messageId),
			),
			columns: { id: true },
		});
		if (!ref || currentRecord(childId) !== record) throw expired();
		if (
			child.model !== record.plan.model ||
			record.plan.adapter.isDiagnosticConnectionCurrent?.() === false ||
			record.plan.fork?.anchor.validateCredential?.() === false
		) {
			throw new ValidationError("ModelTrace calibration target changed; start a new diagnostic");
		}
	} catch (error) {
		owner.release();
		throw error;
	}
	return launchProbe(
		childId,
		{ ...record.plan, calibrate: true },
		principal.userId,
		locale,
		owner,
		record,
		seed,
	);
}
