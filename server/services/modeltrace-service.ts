import { randomUUID } from "node:crypto";
import { db } from "@server/db";
import { narrators } from "@server/db/schema";
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
import type { ModelTraceResultBlock } from "@shared/modeltrace-result";
import { eq } from "drizzle-orm";
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
// Earlier hot-reload state lacks the parent id needed to authorize a fork retry.
const retryPlans = hotSafe("modeltrace.authorizedRetryPlans", () => new Map<string, ProbePlan>());

function rememberRetry(id: string, plan: ProbePlan) {
	retryPlans.delete(id);
	retryPlans.set(id, plan);
	if (retryPlans.size > 64) {
		const oldest = retryPlans.keys().next().value;
		if (oldest !== undefined) retryPlans.delete(oldest);
	}
}

// Session interrupt imports cancelModelTrace synchronously. Load persistence, websocket
// and narrator-service only on execution to avoid their session dependency cycles.
const controllers = hotSafe("modeltrace.controllers", () => new Map<string, AbortController>());
const TIMEOUT_MS = 180_000;

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

async function report(id: string, result: ModelTraceResultBlock): Promise<void> {
	const { narratorPersistence } = await import("./narrator-persistence");
	const summary = result.error ?? `ModelTrace: ${result.results[0]?.displayName ?? ""}`;
	await narratorPersistence.persistDisplayMessage(id, summary, [result]);
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
) {
	const controller = new AbortController();
	const signal = AbortSignal.any([roundSignal, controller.signal]);
	const params = probeParams(plan, signal, challenge.prompt);
	const { narratorPersistence } = await import("./narrator-persistence");
	const { processEvent, clearStreamingSnapshot } = await import("./narrator-event-handler");
	const request = startApiRequest({
		kind: "modeltrace",
		userId,
		narratorId: id,
		provider: plan.provider,
		model: params.model,
	});
	const startedAt = request.startTime;
	let text = "";
	let usage: ParsedStreamEvent["usage"];
	let cacheReadTokens: number | null = null;
	let upstreamMessageId: string | undefined;
	let persistedMessageId: string | undefined;
	let credentialId: string | undefined;
	let ttftMs: number | undefined;
	let metering: ParsedStreamEvent["metering"];
	let contextPercent: number | undefined;
	let failure: ModelTraceResultBlock | undefined;
	let stream: AsyncGenerator<ParsedStreamEvent> | undefined;
	const output = new OutputContentAccumulator();
	const ctx = createRuntimeEventContext({
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
		for (const event of events) await processEvent(event, ctx);
	};
	const flushText = async () => {
		if (!pendingText) return;
		const delta = pendingText;
		pendingText = "";
		const identity = output.append("text", delta);
		await processEvent({ type: "stream_text", text: delta, ...identity }, ctx);
		lastFlushAt = Date.now();
	};
	const syncUsage = () => {
		ctx.setTokenUsage(usage);
		if (contextPercent !== undefined) ctx.setContextUsagePct(contextPercent);
		if (metering) ctx.setMeterData(metering.usage, metering.unit);
	};
	// This callback belongs only to the probe. Internal transport retries update the
	// credential on the same handle; they never create extra request/billing rows.
	params.onRequestStart = (info) => {
		credentialId = info?.credentialId ?? credentialId;
	};
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
					await flushText();
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
						throw new Error("ModelTrace failed: answer exceeds 10,000 characters");
					}
					text += event.text;
					pendingText += event.text;
				}
				syncUsage();
				if (pendingText && (lastFlushAt === undefined || Date.now() - lastFlushAt >= 40))
					await flushText();
				if (
					event.toolUseChunk ||
					event.toolUses?.length ||
					event.webSearch ||
					event.imageGeneration
				) {
					throw new Error(
						"ModelTrace failed: the model attempted a tool call; no tools were executed",
					);
				}
				if (event.invalidState)
					throw new Error(`ModelTrace failed: ${event.invalidState.message.slice(0, 500)}`);
				if (event.silentDisconnect) throw new Error("ModelTrace failed: upstream disconnected");
				if (
					("error" in event && event.error) ||
					("outputTruncated" in event && event.outputTruncated)
				) {
					throw new Error("ModelTrace failed: provider error or truncated output");
				}
				if (
					event.stopReason &&
					!["stop", "end_turn", "stop_sequence", "completed"].includes(
						event.stopReason.toLowerCase(),
					)
				) {
					throw new Error(
						`ModelTrace failed: incomplete response (${event.stopReason.slice(0, 100)})`,
					);
				}
				nextEvent = stream.next();
			}
		} catch (error) {
			failure = failureReport(error);
			controller.abort(error);
		} finally {
			// A broken adapter must not hold cancellation or the execution owner forever.
			if (stream) void stream.return(undefined).catch(() => {});
		}
		syncUsage();
		await flushText();
		await dispatch(output.flush());
		persistedMessageId = ctx.getPartialMessageId();
		if (text || usage) {
			await processEvent(
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
		// Persistence/publication failures must not leave a reconnect ghost or an
		// open partial. Preserve any durable prefix as interrupted output.
		try {
			const partialId = ctx.getPartialMessageId() ?? persistedMessageId;
			if (partialId) {
				persistedMessageId = partialId;
				await narratorPersistence.patchStepMeta(partialId, {
					durationMs: Date.now() - startedAt,
					ttftMs,
				});
			}
		} catch (cleanupError) {
			logger.warn("Failed to preserve partial ModelTrace metadata", { id, cleanupError });
		}
		try {
			await processEvent({ type: "stream_reset" }, ctx);
		} catch (cleanupError) {
			logger.warn("Failed to reset ModelTrace stream", { id, cleanupError });
		}
	} finally {
		clearStreamingSnapshot(id);
		controller.abort();
	}
	return {
		sample: { text, expected_count: challenge.expectedCount },
		cacheReadTokens,
		failure,
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

async function runRound(
	id: string,
	plan: ProbePlan,
	challenges: Challenge[],
	controller: AbortController,
	owner: ExecutionOwner,
	locale: string,
	userId: string,
) {
	const { narratorPersistence } = await import("./narrator-persistence");
	const signal = controller.signal;
	const timer = setTimeout(
		() => controller.abort(new Error("ModelTrace timed out (180 seconds)")),
		TIMEOUT_MS,
	);
	const samples: ScoringSample[] = [];
	const cacheReadTokens = challenges.map((): number | null => null);
	let singleSample: Awaited<ReturnType<typeof runSample>> | undefined;
	let result: ModelTraceResultBlock | undefined;
	const metadata = { calibrationRequested: plan.calibrate, cacheReadTokens };
	try {
		try {
			for (const [index, challenge] of challenges.entries()) {
				signal.throwIfAborted();
				if (index > 0) await publishChallenge(id, challenge, userId);
				signal.throwIfAborted();
				const sample = await runSample(id, plan, challenge, signal, locale, userId);
				cacheReadTokens[index] = sample.cacheReadTokens;
				if (plan.calibrate) await recordSample(sample, sample.failure?.error);
				else singleSample = sample;
				if (sample.failure) {
					result = sample.failure;
					break;
				}
				samples.push(sample.sample);
			}
			if (!result) {
				// Seal every upstream answer before local scoring. Canceling the worker
				// cannot discard completed billable responses.
				signal.throwIfAborted();
				result = await withAbort(analyzeModelTrace(samples, locale, signal), signal);
			}
		} catch (error) {
			result = failureReport(error);
		}
		try {
			await report(id, { ...result, ...metadata });
		} catch (error) {
			result = failureReport(error);
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
			await report(id, { ...result, ...metadata });
		}
	} finally {
		clearTimeout(timer);
		controller.abort();
		if (singleSample) await recordSample(singleSample, result?.error);
		try {
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
	claimed?: ExecutionOwner,
): Promise<{ id: string }> {
	const owner = claimed ?? tryClaimExecution(id, "run");
	if (!owner) throw new ValidationError("ModelTrace child already has an active execution");
	const controller = new AbortController();
	controllers.set(id, controller);
	try {
		const { narratorPersistence } = await import("./narrator-persistence");
		await narratorPersistence.updateStatus(id, "working", { setTurnStart: true, substatus: [] });
		const count = plan.calibrate ? 3 : 1;
		const challenges = buildModelTraceChallenges(count);
		const first = challenges[0];
		if (!first || challenges.length !== count)
			throw new Error("ModelTrace failed: incorrect number of sampling challenges");
		await publishChallenge(id, first, userId);
		void runRound(id, plan, challenges, controller, owner, locale, userId).catch((error) => {
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

async function requireForkSourceAccess(sourceId: string, principal: NarratorPrincipal) {
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
	if (options.fork) await requireForkSourceAccess(parentId, principal);
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
		rememberRetry(traceId, plan);
	} catch (error) {
		owner.release();
		throw error;
	}
	return launchProbe(traceId, plan, userId, locale, owner);
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
	const plan = retryPlans.get(childId);
	if (!plan)
		throw new ValidationError(
			"ModelTrace retry expired; start a new diagnostic from the source narrator",
		);
	const principal = asPrincipal(user);
	if (plan.fork) await requireForkSourceAccess(plan.fork.sourceId, principal);
	return launchProbe(childId, plan, principal.userId, locale);
}
