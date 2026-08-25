import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages, narrators } from "../db/schema";
import { AsyncMutex } from "../lib/async-mutex";
import { ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { isSubagentVariant, parseSubstatus } from "../lib/narrator-utils";
import { getToolMessage, type Locale } from "../lib/prompt-i18n";
import { resolveEffectiveModel, resolveProvider } from "../lib/settings";
import type { ImageRef } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";
import type { RevertScope, RevertWarning } from "./snapshot-revert";
import { loadSubagentHistory } from "./subagent-executor";
import {
	claimManualOverride,
	getManualOverrideRuntime,
	isManualOverride,
	releaseManualOverrideClaim,
	settleManualOverrideClaim,
} from "./subagent-manual-override";
import {
	announceResumedBackgroundTask,
	combineSubagentAbortSignals,
	type SubagentUpdateExecutionLease,
	startContinuedSubagent,
} from "./subagent-runner";

export type SubagentResumeIntent =
	| "follow_up"
	| "retry_last_input"
	| "continue_tool_results"
	| "retry_denied_tool"
	| "regenerate_edited_message";
export type SubagentResumeActor = "user" | "parent_agent";

export interface ResumeSubagentInput {
	subagentId: string;
	intent: SubagentResumeIntent;
	actor: SubagentResumeActor;
	prompt?: string;
	images?: ImageRef[];
	textFiles?: File[];
	commandText?: string | null;
	createdBy?: string | null;
	retryToolUseId?: string;
	editMessageId?: string;
	editContent?: string;
	/**
	 * Roll back the file changes truncated by a `retry_last_input` resume; defaults
	 * to true, which is what every retry did before this was expressible.
	 *
	 * Distinct from `editRevertFiles`: an edit resume rewrites the intent to
	 * `retry_last_input` after its own rollback has already run, and that second
	 * truncation must not revert again.
	 */
	retryRevertFiles?: boolean;
	/** Roll back the truncated messages' file changes; defaults to true. */
	editRevertFiles?: boolean;
	/** How wide that rollback reaches; omitted means the server default. */
	editRevertScope?: RevertScope;
	editKeepImageIds?: string[];
	editNewImages?: File[];
	editKeepTextFilePaths?: string[];
	editNewTextFiles?: File[];
	replyInUserLanguage?: boolean;
	locale: Locale;
	signal?: AbortSignal;
	/** Persistent controller for a recovered background Agent; created automatically when omitted. */
	abortController?: AbortController;
	/** Existing tool/coordinator lease; tool leases are transferred into the runner lifecycle. */
	updateExecutionLease?: SubagentUpdateExecutionLease;
	/** Planned-update recovery may replace a stale RUNNING process-owned state. */
	allowRunningRestart?: boolean;
	/** Do not attach to a stale background runner from the previous process. */
	skipStaleAttach?: boolean;
	/** Keep background task/narrator semantics while restarting the runner. */
	preserveBackground?: boolean;
	/** Background recovery must not publish into the already-completed Agent tool call. */
	skipConclusionDelivery?: boolean;
	/** Keep a recovered Agent checkpointable by subsequent planned updates. */
	resumableUpdateLease?: boolean;
	/** Remaining execution timeout passed to the continued runner. */
	timeoutMs?: number;
	/** Absolute execution deadline preserved by planned-update recovery. */
	executionDeadlineAt?: string | null;
	/** Original timeout used for timeout result formatting after recovery. */
	executionTimeoutMs?: number | null;
}

export interface ResumeSubagentResult {
	started: boolean;
	resumedSuspendedRunner: boolean;
	originToolUseId: string;
	token?: string;
	retryDeniedReason?: string;
	/** Resolves only after the restarted runner reaches its true terminal boundary. */
	terminalCompletion?: Promise<string>;
	userMessage?: Awaited<ReturnType<typeof narratorService.persistSubagentUserMessage>>;
	/**
	 * Advisories from the file rollback a `regenerate_edited_message` resume ran.
	 *
	 * Reported here rather than logged, because a rollback can reach past the scope
	 * the user picked, and editing a subagent message must surface that as plainly
	 * as editing a primary narrator's does.
	 */
	revertWarnings?: RevertWarning[];
}

interface ActiveResumeRun {
	token: string;
	runId: string | null;
	publicationClaimId: string;
	originToolUseId: string;
	phase: "starting" | "running" | "delivering";
	delivered: boolean;
}

const resumeLock = new AsyncMutex();
const activeResumeRuns = new Map<string, ActiveResumeRun>();

export function hasActiveSubagentResumeRun(subagentId: string): boolean {
	return activeResumeRuns.has(subagentId);
}

export function withSubagentResumeLock<T>(subagentId: string, fn: () => Promise<T>): Promise<T> {
	return resumeLock.acquire(subagentId, fn);
}

export async function resolveSubagentOriginToolUseId(subagentId: string): Promise<string> {
	const firstLinkedUserMessage = await db.query.narratorMessages.findFirst({
		where: and(
			eq(narratorMessages.narratorId, subagentId),
			eq(narratorMessages.role, "user"),
			isNotNull(narratorMessages.parentToolUseId),
		),
		columns: { parentToolUseId: true },
		orderBy: [asc(narratorMessages.createdAt)],
	});
	if (!firstLinkedUserMessage?.parentToolUseId) {
		throw new ValidationError("Cannot find the original Agent tool call for this subagent");
	}
	return firstLinkedUserMessage.parentToolUseId;
}

function stripSubagentResultPrefix(output: string): string {
	return output.replace(/^<subagent_id>[^<]+<\/subagent_id>\s*/u, "").trim();
}

function extractPromptText(contentText: string | null | undefined): string {
	const text = contentText?.trim() ?? "";
	if (!text) throw new ValidationError("The last subagent user message has no text to retry");
	return text;
}

async function prepareResumeTurn(input: ResumeSubagentInput) {
	const narrator = await narratorService.getById(input.subagentId);
	const model = narrator.model ?? undefined;
	const effectiveModel = resolveEffectiveModel(model);
	const provider = resolveProvider(effectiveModel);

	let prompt = input.prompt ?? "";
	let persistPrompt = input.intent === "follow_up";
	let initialHistory: unknown[] | undefined;
	let initialTrailingToolResults: unknown[] | undefined;

	if (input.intent === "retry_last_input") {
		const messages = await narratorService.getModelHistorySinceLastCompact(input.subagentId);
		const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
		if (!lastUserMessage)
			throw new ValidationError("No subagent user message is available to retry");
		prompt = extractPromptText(lastUserMessage.contentText);
		// `skipRevert` must be forwarded, not defaulted. `deleteMessagesAfter` rolls the
		// workspace back unless told otherwise, so omitting it here reverts files that
		// the caller may have explicitly asked to keep — and a `regenerate_edited_message`
		// resume arrives here having ALREADY performed (or deliberately skipped) exactly
		// that rollback, so a second one is both unrequested and, once its own
		// regeneration is live, liable to fail on the workspace-write guard.
		const { deletedMessageIds } = await narratorService.deleteMessagesAfter(
			input.subagentId,
			lastUserMessage.id,
			{ skipRevert: input.retryRevertFiles === false },
		);
		if (deletedMessageIds.length > 0) {
			broadcastToNarrator(input.subagentId, {
				type: "messages_deleted",
				narratorId: input.subagentId,
				deletedMessageIds,
			});
			if (narrator.parentNarratorId) {
				broadcastToNarrator(narrator.parentNarratorId, {
					type: "messages_deleted",
					narratorId: narrator.parentNarratorId,
					deletedMessageIds,
				});
			}
		}
		const rebuilt = await loadSubagentHistory(input.subagentId, effectiveModel, provider);
		initialHistory = rebuilt.history;
		initialTrailingToolResults = rebuilt.trailingToolResults;
		persistPrompt = false;
	} else if (input.intent === "continue_tool_results") {
		const rebuilt = await loadSubagentHistory(input.subagentId, effectiveModel, provider);
		if (rebuilt.trailingToolResults.length > 0) {
			prompt = "";
			persistPrompt = false;
			initialHistory = rebuilt.history;
			initialTrailingToolResults = rebuilt.trailingToolResults;
		} else {
			prompt = getToolMessage("userContinue", input.locale);
			persistPrompt = true;
		}
	}

	if (persistPrompt && !prompt.trim() && !input.images?.length && !input.textFiles?.length) {
		throw new ValidationError("A follow-up message or attachment is required");
	}

	return {
		narrator,
		prompt,
		persistPrompt,
		initialHistory,
		initialTrailingToolResults,
	};
}

function broadcastUserMessage(
	subagentId: string,
	parentNarratorId: string,
	userMessage: Awaited<ReturnType<typeof narratorService.persistSubagentUserMessage>>,
): void {
	broadcastToNarrator(parentNarratorId, {
		type: "user_message",
		narratorId: parentNarratorId,
		message: userMessage,
	});
	broadcastToNarrator(subagentId, {
		type: "user_message",
		narratorId: subagentId,
		message: { ...userMessage, parentToolUseId: null },
	});
}

async function restoreTemporaryModel(subagentId: string): Promise<void> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, subagentId),
		columns: { pendingModelRestore: true },
	});
	if (!narrator?.pendingModelRestore) return;
	const model = narrator.pendingModelRestore;
	await db
		.update(narrators)
		.set({ model, pendingModelRestore: null, updatedAt: new Date().toISOString() })
		.where(eq(narrators.id, subagentId));
	broadcastToNarrator(subagentId, { type: "model_changed", narratorId: subagentId, model });
}

async function deliverCompletedResume(
	subagentId: string,
	token: string,
	runId: string,
	publicationClaimId: string,
	originToolUseId: string,
	completionOutput: string,
): Promise<void> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			await withSubagentResumeLock(subagentId, async () => {
				const active = activeResumeRuns.get(subagentId);
				if (
					!active ||
					active.token !== token ||
					active.runId !== runId ||
					active.publicationClaimId !== publicationClaimId ||
					active.delivered
				) {
					return;
				}
				active.phase = "delivering";

				const narrator = await narratorService.getById(subagentId);
				const substatus = parseSubstatus(narrator.substatus);
				const hasError = substatus.includes("error") || !!narrator.errorMessage;
				const finalText = stripSubagentResultPrefix(completionOutput) || "(no output)";
				const { getSubagentResultMessageId, updateToolCallConclusion } = await import(
					"./narrator-session"
				);
				const resultMessageId = await getSubagentResultMessageId(subagentId);
				const toolCall = await narratorService.getToolCallByToolUseId(originToolUseId);
				let privateMessageId: string | undefined;
				if (
					toolCall?.messageId &&
					(await narratorService.isMessageSharedByMultipleNarrators(toolCall.messageId))
				) {
					privateMessageId = await narratorService.copyOnWriteToolCallMessage(
						narrator.parentNarratorId as string,
						toolCall.messageId,
						originToolUseId,
					);
				}
				await updateToolCallConclusion({
					subagentId,
					parentNarratorId: narrator.parentNarratorId as string,
					toolUseId: originToolUseId,
					finalText,
					hasError,
					messageId: privateMessageId,
					resultMessageId,
				});
				active.delivered = true;
				activeResumeRuns.delete(subagentId);
			});
			return;
		} catch (error) {
			lastError = error;
			if (attempt < 3) {
				await new Promise((resolve) => setTimeout(resolve, attempt * 50));
			}
		}
	}
	throw lastError;
}

export async function resumeSubagent(input: ResumeSubagentInput): Promise<ResumeSubagentResult> {
	return withSubagentResumeLock(input.subagentId, async () => {
		const original = await narratorService.getById(input.subagentId);
		if (!isSubagentVariant(original.variant) || !original.parentNarratorId) {
			throw new ValidationError("Target narrator is not a resumable subagent");
		}
		if (original.status === "archived") {
			throw new ValidationError("Archived subagents cannot be resumed");
		}
		const manualOverride = isManualOverride(input.subagentId);
		if (!manualOverride && activeResumeRuns.has(input.subagentId)) {
			throw new ValidationError("Subagent already has an active resumed run");
		}
		// Reconcile BEFORE judging the status, the same way every primary-narrator entry
		// point does (send, continue, recover-subagents, re-execute). A `working` row whose
		// runtime owner is gone would otherwise refuse this resume forever, and the subagent
		// card offers no other way out — the parent's interrupt path only settles subagents
		// belonging to a cancelled tool call, so a row orphaned any other way (its owning
		// turn died mid-flight, a detach setup threw) was never repaired by anything.
		//
		// `reconcileRunningStatus` is safe here despite its primary-narrator call sites: it
		// consults the runtime, not the variant, and returns false while any owner is still
		// live, so a genuinely running subagent is still refused below.
		// Dynamic import for the same reason as every other narrator-session call in this
		// file: a static one closes a require cycle between the two modules.
		const { reconcileRunningStatus } = await import("./narrator-session");
		if (await reconcileRunningStatus(input.subagentId)) {
			original.status = (await narratorService.getById(input.subagentId)).status;
		}
		if (
			!manualOverride &&
			(original.status === "working" || original.status === "waiting") &&
			!input.allowRunningRestart
		) {
			throw new ValidationError("Subagent is already running; queue the message instead");
		}

		const originToolUseId = await resolveSubagentOriginToolUseId(input.subagentId);
		let effectiveInput = input;
		// Set by the regenerate_edited_message branch below, then attached to every
		// return path so the advisory is not lost between the rollback and the reply.
		let editRevertWarnings: RevertWarning[] | undefined;
		if (input.intent === "retry_denied_tool") {
			if (!input.retryToolUseId) {
				throw new ValidationError("retryToolUseId is required to retry a denied tool");
			}
			const { reExecuteDeniedToolCall } = await import("./narrator-session");
			const retried = await reExecuteDeniedToolCall(
				input.subagentId,
				input.retryToolUseId,
				input.locale,
				input.replyInUserLanguage ?? false,
				input.createdBy,
				{ autoContinue: false },
			);
			if (!retried.ok || !retried.shouldContinue) {
				return {
					started: false,
					resumedSuspendedRunner: false,
					originToolUseId,
					...(!retried.ok ? { retryDeniedReason: retried.reason } : {}),
				};
			}
			effectiveInput = { ...input, intent: "continue_tool_results" };
		}
		if (effectiveInput.intent === "regenerate_edited_message") {
			if (!effectiveInput.editMessageId || effectiveInput.editContent === undefined) {
				throw new ValidationError(
					"editMessageId and editContent are required to regenerate an edited subagent message",
				);
			}
			const { editAndRegenerate } = await import("./narrator-session");
			const edited = await editAndRegenerate(
				effectiveInput.subagentId,
				effectiveInput.editMessageId,
				effectiveInput.editContent,
				effectiveInput.locale,
				effectiveInput.replyInUserLanguage ?? false,
				{
					keepImageIds: effectiveInput.editKeepImageIds,
					newImages: effectiveInput.editNewImages,
					keepTextFilePaths: effectiveInput.editKeepTextFilePaths,
					newTextFiles: effectiveInput.editNewTextFiles,
					userId: effectiveInput.createdBy,
					deferContinuation: true,
					revertFiles: effectiveInput.editRevertFiles ?? true,
					...(effectiveInput.editRevertScope
						? { revertScope: effectiveInput.editRevertScope }
						: {}),
				},
			);
			if (!edited.ok) {
				throw new ValidationError("Cannot edit a subagent message while it is running");
			}
			// Carried out to the route: the rollback that just ran may have reached past
			// the chosen scope, and the user has to hear about it here exactly as they
			// would for a primary narrator.
			editRevertWarnings = edited.warnings;
			// The edit above owns the rollback decision and has already carried it out.
			// The retry this becomes truncates history a second time, so it must be told
			// NOT to revert again: repeating it would undo file changes the user asked to
			// keep, and — because the edit may have already started regenerating into the
			// same worktree — can fail outright on the workspace-write guard, surfacing as
			// "something is writing to this workspace" on a rollback nobody requested.
			effectiveInput = {
				...effectiveInput,
				intent: "retry_last_input",
				retryRevertFiles: false,
			};
		}
		const manualClaim = manualOverride ? claimManualOverride(input.subagentId, "resume") : null;
		if (manualOverride && !manualClaim) {
			throw new ValidationError("Subagent suspension is already being consumed");
		}
		let prepared: Awaited<ReturnType<typeof prepareResumeTurn>>;
		try {
			prepared = await prepareResumeTurn(effectiveInput);
		} catch (error) {
			if (manualClaim) releaseManualOverrideClaim(manualClaim);
			throw error;
		}

		if (manualClaim) {
			try {
				let userMessage: ResumeSubagentResult["userMessage"];
				if (prepared.persistPrompt) {
					const { saveTextFileToWorktree } = await import("../lib/uploads");
					const savedTextFiles = [];
					for (const file of input.textFiles ?? []) {
						savedTextFiles.push(await saveTextFileToWorktree(prepared.narrator.cwd ?? ".", file));
					}
					userMessage = await narratorService.persistSubagentUserMessage(
						input.subagentId,
						prepared.prompt,
						originToolUseId,
						{
							images: input.images,
							textFiles: savedTextFiles,
							commandText: input.commandText,
							createdBy: input.createdBy,
						},
					);
				}
				const rebuilt =
					prepared.initialHistory && prepared.initialTrailingToolResults
						? {
								history: prepared.initialHistory,
								trailingToolResults: prepared.initialTrailingToolResults,
							}
						: await loadSubagentHistory(
								input.subagentId,
								resolveEffectiveModel(prepared.narrator.model),
								resolveProvider(resolveEffectiveModel(prepared.narrator.model)),
							);

				const runtime = getManualOverrideRuntime(input.subagentId);
				if (runtime?.pendingTerminal) {
					settleManualOverrideClaim(manualClaim, runtime.pendingTerminal);
					throw new ValidationError("Subagent suspension ended while the resume was preparing");
				}
				await narratorService.updateStatus(input.subagentId, "working");
				const resumed = settleManualOverrideClaim(manualClaim, {
					action: "resume",
					prompt: prepared.prompt,
					history: rebuilt.history,
					trailingToolResults: rebuilt.trailingToolResults,
					userId: input.createdBy ?? null,
				});
				if (!resumed) {
					throw new ValidationError("Subagent suspension ended before it could be resumed");
				}
				if (userMessage) {
					broadcastUserMessage(input.subagentId, original.parentNarratorId, userMessage);
				}
				return {
					started: true,
					resumedSuspendedRunner: true,
					originToolUseId,
					userMessage,
					...(editRevertWarnings?.length ? { revertWarnings: editRevertWarnings } : {}),
				};
			} catch (error) {
				releaseManualOverrideClaim(manualClaim);
				throw error;
			}
		}

		const token = generateId();
		const publicationClaimId = generateId();
		const abortController = input.preserveBackground
			? (input.abortController ?? new AbortController())
			: input.abortController;
		const runSignal = combineSubagentAbortSignals(abortController?.signal, input.signal);
		activeResumeRuns.set(input.subagentId, {
			token,
			runId: null,
			publicationClaimId,
			originToolUseId,
			phase: "starting",
			delivered: false,
		});
		try {
			const started = await startContinuedSubagent({
				subagentId: input.subagentId,
				parentNarratorId: original.parentNarratorId,
				toolUseId: originToolUseId,
				prompt: prepared.prompt,
				images: input.images,
				textFiles: input.textFiles,
				commandText: input.commandText,
				createdBy: input.createdBy,
				userId: input.createdBy,
				canReportToParent: input.actor === "parent_agent",
				signal: runSignal,
				abortController,
				updateExecutionLease: input.updateExecutionLease,
				locale: input.locale,
				persistPrompt: prepared.persistPrompt,
				initialHistory: prepared.initialHistory,
				initialTrailingToolResults: prepared.initialTrailingToolResults,
				allowRunningRestart: input.allowRunningRestart,
				skipStaleAttach: input.skipStaleAttach,
				preserveBackground: input.preserveBackground,
				// Forwarded so the resumed-task notice knows whether the tool result below
				// will be rewritten (i.e. whether the parent already has the output).
				skipConclusionDelivery: input.skipConclusionDelivery,
				resumableUpdateLease: input.resumableUpdateLease,
				timeoutMs: input.timeoutMs,
				executionDeadlineAt: input.executionDeadlineAt,
				executionTimeoutMs: input.executionTimeoutMs,
			});
			const active = activeResumeRuns.get(input.subagentId);
			if (active?.token === token && active.publicationClaimId === publicationClaimId) {
				active.runId = started.runId;
				active.phase = "running";
			}
			if (started.userMessage) {
				broadcastUserMessage(input.subagentId, original.parentNarratorId, started.userMessage);
			}
			const terminalCompletion = started.terminalCompletion.then(async (output) => {
				if (!input.skipConclusionDelivery && !runSignal.aborted) {
					await deliverCompletedResume(
						input.subagentId,
						token,
						started.runId,
						publicationClaimId,
						originToolUseId,
						output,
					);
				} else {
					await withSubagentResumeLock(input.subagentId, async () => {
						const active = activeResumeRuns.get(input.subagentId);
						if (active?.token === token && active.runId === started.runId) {
							activeResumeRuns.delete(input.subagentId);
						}
					});
				}
				// AFTER the conclusion above, never before: this wakes the parent, and a turn
				// started while the historical Agent tool result still held the previous run's
				// output would be built from a result this continuation just superseded.
				// Failure here must not fail the run — the notice is an affordance, the
				// conclusion is the record.
				const announcement = started.takeResumedBackgroundAnnouncement?.();
				if (announcement) {
					await announceResumedBackgroundTask(announcement).catch((err) => {
						logger.warn("Failed to announce a resumed background task", {
							subagentId: input.subagentId,
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
				return output;
			});
			void terminalCompletion.catch(async (error) => {
				logger.error("Resumed subagent run failed", {
					subagentId: input.subagentId,
					token,
					error: error instanceof Error ? error.message : String(error),
				});
				await withSubagentResumeLock(input.subagentId, async () => {
					const failed = activeResumeRuns.get(input.subagentId);
					if (
						failed?.token === token &&
						failed.runId === started.runId &&
						failed.publicationClaimId === publicationClaimId
					) {
						activeResumeRuns.delete(input.subagentId);
					}
				});
			});
			return {
				started: true,
				resumedSuspendedRunner: false,
				originToolUseId,
				token,
				terminalCompletion,
				userMessage: started.userMessage,
				...(editRevertWarnings?.length ? { revertWarnings: editRevertWarnings } : {}),
			};
		} catch (error) {
			if (activeResumeRuns.get(input.subagentId)?.token === token) {
				activeResumeRuns.delete(input.subagentId);
			}
			await narratorService
				.updateStatus(input.subagentId, "idle", {
					substatus: ["error"],
					errorMessage: error instanceof Error ? error.message : String(error),
				})
				.catch(() => {});
			await restoreTemporaryModel(input.subagentId).catch(() => {});
			throw error;
		}
	});
}
