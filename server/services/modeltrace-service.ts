import { randomUUID } from "node:crypto";
import { db } from "@server/db";
import { narratorMessageRefs, narrators } from "@server/db/schema";
import {
	getModelTraceRequest,
	type ModelTraceRequest,
	rememberModelTraceRequest,
} from "@server/lib/agent/modeltrace-request";
import { OutputContentAccumulator } from "@server/lib/agent/output-content";
import type { ChatParams, ParsedStreamEvent } from "@server/lib/agent/provider";
import type { AgentEvent } from "@server/lib/agent/types";
import { finishApiRequest, startApiRequest } from "@server/lib/api-request-tracker";
import { ValidationError } from "@server/lib/errors";
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import {
	analyzeModelTrace,
	buildModelTracePrompt,
	MODELTRACE_MAX_TEXT_LENGTH,
} from "@server/lib/modeltrace";
import { addTrait, parseTraits } from "@server/lib/narrator-utils";
import { buildUsageDataFromSnapshot } from "@server/lib/usage-tracking";
import { normalizeLocale } from "@shared/i18n-locales";
import type { ModelTraceResultBlock } from "@shared/modeltrace-result";
import { desc, eq } from "drizzle-orm";
import { createRuntimeEventContext } from "./agent-runtime/context";
import { type ExecutionOwner, tryClaimExecution } from "./agent-runtime/ownership";

// Session interrupt imports cancelModelTrace synchronously. Load persistence, websocket
// and narrator-service only on execution to avoid their session dependency cycles.
const controllers = hotSafe("modeltrace.controllers", () => new Map<string, AbortController>());
const TIMEOUT_MS = 180_000;

/** Only the diagnostic child is canceled; its parent execution is never touched. */
export function cancelModelTrace(id: string): boolean {
	const controller = controllers.get(id);
	if (!controller) return false;
	controller.abort(new Error("ModelTrace canceled"));
	return true;
}

/** Whitelist request data: never retain parent callbacks, signal or request-dump collectors. */
function probeParams(
	source: ModelTraceRequest["params"],
	childId: string,
	signal: AbortSignal,
	prompt: string,
): ChatParams {
	return {
		conversationId: source.conversationId,
		content: `${source.content}\n\n${prompt}`,
		model: source.model,
		cwd: source.cwd,
		history: source.history.slice(),
		tools: source.tools.slice(),
		toolLoadingStrategy: source.toolLoadingStrategy,
		toolResults: source.toolResults.slice(),
		images: source.images?.slice(),
		stickySessionKey: source.stickySessionKey,
		transportSessionKey: childId,
		reasoningEffort: source.reasoningEffort,
		maxOutputTokens: source.maxOutputTokens,
		serviceTier: source.serviceTier,
		metadata: source.metadata ? { ...source.metadata } : undefined,
		signal,
		resetUpstreamSession: false,
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

async function runProbe(
	id: string,
	snapshot: ModelTraceRequest,
	params: ChatParams,
	controller: AbortController,
	owner: ExecutionOwner,
	locale: string,
	userId: string,
): Promise<void> {
	const { narratorPersistence } = await import("./narrator-persistence");
	const { processEvent, clearStreamingSnapshot } = await import("./narrator-event-handler");
	const request = startApiRequest({
		kind: "modeltrace",
		userId,
		narratorId: id,
		provider: snapshot.provider,
		model: snapshot.params.model,
	});
	const startedAt = request.startTime;
	const timer = setTimeout(
		() => controller.abort(new Error("ModelTrace timed out (180 seconds)")),
		TIMEOUT_MS,
	);
	let text = "";
	let usage: ParsedStreamEvent["usage"];
	let upstreamMessageId: string | undefined;
	let persistedMessageId: string | undefined;
	let credentialId: string | undefined;
	let ttftMs: number | undefined;
	let metering: ParsedStreamEvent["metering"];
	let contextPercent: number | undefined;
	let failure: unknown;
	let result: ModelTraceResultBlock | undefined;
	let stream: AsyncGenerator<ParsedStreamEvent> | undefined;
	const output = new OutputContentAccumulator();
	const ctx = createRuntimeEventContext({
		narratorId: id,
		conversationId: params.conversationId,
		provider: snapshot.provider,
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
	const abort = Promise.withResolvers<never>();
	const onAbort = () => abort.reject(controller.signal.reason ?? new Error("ModelTrace canceled"));
	controller.signal.addEventListener("abort", onAbort, { once: true });
	void abort.promise.catch(() => {});
	try {
		try {
			controller.signal.throwIfAborted();
			stream = snapshot.adapter.chat(params);
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
					: new Promise<never>(() => {});
				let next: IteratorResult<ParsedStreamEvent> | null;
				try {
					next = await Promise.race([nextEvent, abort.promise, due]);
				} finally {
					clearTimeout(coalesceTimer);
				}
				controller.signal.throwIfAborted();
				if (next === null) {
					await flushText();
					continue;
				}
				if (next.done) break;
				const event = next.value;
				// Failed terminal events may still carry billable usage and partial text.
				if (event.usage) usage = { ...usage, ...event.usage };
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
			failure = error;
		} finally {
			clearTimeout(timer);
			controller.signal.removeEventListener("abort", onAbort);
			controller.abort();
			// A broken adapter must not hold cancellation or the execution owner forever.
			if (stream) void stream.return(undefined).catch(() => {});
		}
		result = failure ? failureReport(failure) : analyzeModelTrace(text, locale);
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
		await report(id, result);
	} catch (error) {
		result = failureReport(error);
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
		} finally {
			try {
				await processEvent({ type: "stream_reset" }, ctx);
			} finally {
				clearStreamingSnapshot(id);
			}
		}
		await report(id, result);
	} finally {
		try {
			await finishApiRequest(request, {
				messageId: persistedMessageId,
				credentialId,
				usage: buildUsageDataFromSnapshot(usage),
				ttftMs,
				durationMs: Date.now() - startedAt,
				contextPercent,
				meterUsage: metering?.usage,
				meterUnit: metering?.unit,
				errorMessage: result?.error,
			});
		} catch (error) {
			logger.warn("Failed to record ModelTrace API request", { requestId: request.id, error });
		} finally {
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
}

function requireSnapshot(id: string): ModelTraceRequest {
	const snapshot = getModelTraceRequest(id);
	// Hot reload can retain an old snapshot without its effective provider. Never
	// guess billing attribution from a raw model name; require a fresh source request.
	if (!snapshot?.provider)
		throw new ValidationError(
			"请回到源会话先发送一条消息，再运行 /modeltrace（请求快照已过期或没有可复用的模型请求）",
		);
	return snapshot;
}

/** Both first launch and same-child retries have exactly one owner and controller. */
async function launchProbe(
	id: string,
	snapshot: ModelTraceRequest,
	userId: string,
	locale: string,
): Promise<{ id: string }> {
	const owner = tryClaimExecution(id, "run");
	if (!owner) throw new ValidationError("ModelTrace child already has an active execution");
	const controller = new AbortController();
	controllers.set(id, controller);
	try {
		const { narratorPersistence } = await import("./narrator-persistence");
		const { broadcastToNarrator } = await import("@server/websocket/narrator-ws");
		await narratorPersistence.updateStatus(id, "working", { setTurnStart: true, substatus: [] });
		const prompt = buildModelTracePrompt();
		const params = probeParams(snapshot.params, id, controller.signal, prompt);
		const saved = await narratorPersistence.persistUserMessage(
			id,
			prompt,
			undefined,
			"/modeltrace",
			userId,
		);
		broadcastToNarrator(id, {
			type: "message",
			narratorId: id,
			message: { ...saved, children: [] },
		});
		void runProbe(id, snapshot, params, controller, owner, locale, userId).catch((error) => {
			console.error("[modeltrace] Finalization failed", error);
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

export async function startModelTrace(
	parentId: string,
	userId: string,
	locale = "en",
): Promise<{ id: string }> {
	const snapshot = requireSnapshot(parentId);
	const { narratorService } = await import("./narrator-service");
	const latest = await db.query.narratorMessageRefs.findFirst({
		where: eq(narratorMessageRefs.narratorId, parentId),
		orderBy: [desc(narratorMessageRefs.seq)],
		columns: { messageId: true },
	});
	if (!latest) throw new ValidationError("请先发送一条消息，再运行 /modeltrace");
	const child = await narratorService.forkNarrator(parentId, null, {
		title: "ModelTrace",
		inheritMode: "full",
		specCarryover: "clear",
		forkMessageId: latest.messageId,
		userId,
		locale,
	});
	await db
		.update(narrators)
		.set({
			traits: addTrait(parseTraits(child.traits), "modeltrace"),
			parentNarratorId: parentId,
		})
		.where(eq(narrators.id, child.id));
	// Keep the original prefix, not the probe params with the diagnostic prompt appended.
	rememberModelTraceRequest(child.id, snapshot.adapter, snapshot.params, snapshot.provider);
	return launchProbe(child.id, snapshot, userId, locale);
}

export async function retryModelTrace(
	childId: string,
	userId: string,
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
	return launchProbe(childId, requireSnapshot(childId), userId, locale);
}
