import { randomUUID } from "node:crypto";
import { db } from "@server/db";
import { narratorMessageRefs, narrators } from "@server/db/schema";
import { getModelTraceRequest, type ModelTraceRequest } from "@server/lib/agent/modeltrace-request";
import type { ChatParams, ParsedStreamEvent } from "@server/lib/agent/provider";
import { ValidationError } from "@server/lib/errors";
import { hotSafe } from "@server/lib/hot-safe";
import {
	analyzeModelTrace,
	buildModelTracePrompt,
	MODELTRACE_MAX_TEXT_LENGTH,
} from "@server/lib/modeltrace";
import { addTrait, parseTraits } from "@server/lib/narrator-utils";
import { normalizeLocale } from "@shared/i18n-locales";
import type { ModelTraceResultBlock } from "@shared/modeltrace-result";
import { desc, eq } from "drizzle-orm";
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
	snapshot: NonNullable<ReturnType<typeof getModelTraceRequest>>,
	params: ChatParams,
	controller: AbortController,
	owner: ExecutionOwner,
	locale: string,
): Promise<void> {
	const { narratorPersistence } = await import("./narrator-persistence");
	const { broadcastToNarrator } = await import("@server/websocket/narrator-ws");
	const startedAt = Date.now();
	const timer = setTimeout(
		() => controller.abort(new Error("ModelTrace timed out (180 seconds)")),
		TIMEOUT_MS,
	);
	let text = "";
	let usage: ParsedStreamEvent["usage"];
	let messageId: string | undefined;
	let credentialId: string | undefined;
	let failure: unknown;
	let stream: AsyncGenerator<ParsedStreamEvent> | undefined;
	const abort = Promise.withResolvers<never>();
	const onAbort = () => abort.reject(controller.signal.reason ?? new Error("ModelTrace canceled"));
	controller.signal.addEventListener("abort", onAbort, { once: true });
	// Observe even an early abort, before the stream's first next() races it.
	void abort.promise.catch(() => {});
	try {
		controller.signal.throwIfAborted();
		stream = snapshot.adapter.chat(params);
		while (true) {
			const next = await Promise.race([stream.next(), abort.promise]);
			controller.signal.throwIfAborted();
			if (next.done) break;
			const event = next.value;
			// A failed terminal event can still carry the final billable usage and text.
			if (event.usage) usage = { ...usage, ...event.usage };
			messageId = event.messageId ?? messageId;
			credentialId = event.credentialId ?? credentialId;
			if (event.text) {
				if (text.length + event.text.length > MODELTRACE_MAX_TEXT_LENGTH) {
					throw new Error("ModelTrace failed: answer exceeds 10,000 characters");
				}
				text += event.text;
			}
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
				!["stop", "end_turn", "stop_sequence", "completed"].includes(event.stopReason.toLowerCase())
			) {
				throw new Error(
					`ModelTrace failed: incomplete response (${event.stopReason.slice(0, 100)})`,
				);
			}
		}
	} catch (error) {
		failure = error;
	} finally {
		clearTimeout(timer);
		controller.signal.removeEventListener("abort", onAbort);
		controller.abort();
		// A broken adapter must not keep cancellation or the execution owner waiting forever.
		if (stream) void stream.return(undefined).catch(() => {});
	}
	try {
		if (text || usage) {
			const saved = await narratorPersistence.persistAssistantMessage(id, {
				uuid: messageId ?? randomUUID(),
				session_id: params.conversationId,
				message: {
					content: [{ type: "text", text }],
					usage: usage
						? {
								input_tokens: usage.inputTokens ?? usage.promptTokens,
								output_tokens: usage.completionTokens,
							}
						: undefined,
				},
				model: params.model,
				credentialId,
				outputTokens: usage?.completionTokens,
				cachedInputTokens: usage?.cachedInputTokens,
				cacheCreationInputTokens: usage?.cacheCreationInputTokens,
				cacheCreation5mTokens: usage?.cacheCreation5mTokens,
				cacheCreation1hTokens: usage?.cacheCreation1hTokens,
				reasoningTokens: usage?.reasoningTokens,
				durationMs: Date.now() - startedAt,
			});
			broadcastToNarrator(id, {
				type: "message",
				narratorId: id,
				message: { ...saved, children: [] },
			});
		}
		const result = failure ? failureReport(failure) : analyzeModelTrace(text, locale);
		await report(id, result);
	} catch (error) {
		await report(id, failureReport(error));
	} finally {
		try {
			await narratorPersistence.updateStatus(id, "idle");
		} finally {
			await releaseProbe(id, owner, locale);
		}
	}
}

export async function startModelTrace(
	parentId: string,
	userId: string,
	locale = "en",
): Promise<{ id: string }> {
	const snapshot = getModelTraceRequest(parentId);
	if (!snapshot)
		throw new ValidationError("请先发送一条消息，再运行 /modeltrace（没有可复用的模型请求）");
	const { narratorService } = await import("./narrator-service");
	const { narratorPersistence } = await import("./narrator-persistence");
	const { broadcastToNarrator } = await import("@server/websocket/narrator-ws");
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
	const owner = tryClaimExecution(child.id, "run");
	if (!owner) throw new ValidationError("ModelTrace child already has an active execution");
	const controller = new AbortController();
	controllers.set(child.id, controller);
	try {
		// This is a sampling fork of the frozen last request, not a rebuilt system prompt.
		// Only this probe reuses upstream routing; ordinary forks retain their isolation.
		await narratorPersistence.updateStatus(child.id, "working", { setTurnStart: true });
		const prompt = buildModelTracePrompt();
		const params = probeParams(snapshot.params, child.id, controller.signal, prompt);
		const saved = await narratorPersistence.persistUserMessage(
			child.id,
			prompt,
			undefined,
			"/modeltrace",
			userId,
		);
		broadcastToNarrator(child.id, {
			type: "message",
			narratorId: child.id,
			message: { ...saved, children: [] },
		});
		void runProbe(child.id, snapshot, params, controller, owner, locale).catch((error) => {
			console.error("[modeltrace] Finalization failed", error);
		});
		return { id: child.id };
	} catch (error) {
		controller.abort();
		try {
			await narratorPersistence.updateStatus(child.id, "idle");
		} finally {
			await releaseProbe(child.id, owner, locale);
		}
		throw error;
	}
}
