import { eventBus } from "@server/lib/event-bus";
import { logger } from "@server/lib/logger";
import { isSubagentVariant, parseSubstatus } from "@server/lib/narrator-utils";
import type { Locale } from "@server/lib/prompt-i18n";
import { backgroundTaskService } from "./background-task-service";
import { narratorService } from "./narrator-service";
import { getSubagentFinalText } from "./narrator-session";
import { resolveTaskAlias, subagentMatchesSelector } from "./subagent-alias";
import { interruptForegroundSubagent } from "./subagent-detach";
import { pushSubagentBufferedMessage } from "./subagent-executor";
import { continueSubagent, waitForBackgroundTask } from "./subagent-runner";

const DEFAULT_TIMEOUT_MS = 30_000;

type Narrator = Awaited<ReturnType<typeof narratorService.getById>>;

export interface ResolveTargetsInput {
	callerNarratorId: string;
	id?: string;
	ids?: string[];
	name?: string;
	names?: string[];
}

export interface SendSubagentInput extends ResolveTargetsInput {
	message: string;
	doInterrupt?: boolean;
	shouldAwait?: boolean;
	timeoutMs?: number;
	toolUseId: string;
	signal: AbortSignal;
	locale: string;
}

export interface AwaitAgentInput {
	callerNarratorId: string;
	id: string;
	timeoutMs?: number;
	signal: AbortSignal;
}

export interface AwaitAgentResult {
	id: string;
	status: string;
	output: string;
	formatted: string;
}

export interface SendTargetResult {
	id: string;
	title?: string | null;
	status: "queued" | "started" | "completed" | "failed" | "timeout" | "aborted" | "cancelled";
	interrupted?: boolean;
	awaited?: boolean;
	error?: string;
}

export interface SendSubagentResult {
	output: string;
	targets: SendTargetResult[];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value?.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function getSelectors(input: ResolveTargetsInput): string[] {
	return uniqueStrings([input.id, ...(input.ids ?? []), input.name, ...(input.names ?? [])]);
}

async function getCommunicationScope(callerNarratorId: string): Promise<{
	caller: Narrator;
	teamParentId: string;
	callerIsSubagent: boolean;
}> {
	const caller = await narratorService.getById(callerNarratorId);
	const callerIsSubagent = isSubagentVariant(caller.variant);
	if (callerIsSubagent && !caller.parentNarratorId) {
		throw new Error("Subagent has no parent narrator");
	}
	return {
		caller,
		teamParentId: callerIsSubagent ? (caller.parentNarratorId as string) : callerNarratorId,
		callerIsSubagent,
	};
}

function assertTargetAllowed(
	target: Narrator,
	scope: Awaited<ReturnType<typeof getCommunicationScope>>,
) {
	if (!isSubagentVariant(target.variant)) {
		throw new Error(`${target.id} is not a subagent`);
	}
	if (target.parentNarratorId !== scope.teamParentId) {
		throw new Error(`${target.id} does not belong to this narrator's subagent team`);
	}
	if (scope.callerIsSubagent && target.id === scope.caller.id) {
		throw new Error("Subagents cannot send messages to themselves");
	}
}

async function resolveAliasCandidate(
	selector: string,
	scope: Awaited<ReturnType<typeof getCommunicationScope>>,
) {
	for (const ownerId of [scope.caller.id, scope.teamParentId]) {
		const inMemory = resolveTaskAlias(ownerId, selector);
		if (inMemory !== selector) return inMemory;
		const task = await backgroundTaskService.getByAlias(selector, ownerId);
		if (task?.subagentNarratorId) return task.subagentNarratorId;
		if (task?.type === "agent") return task.id;
	}
	return selector;
}

async function resolveOneTarget(
	selector: string,
	scope: Awaited<ReturnType<typeof getCommunicationScope>>,
): Promise<Narrator> {
	const aliasCandidate = await resolveAliasCandidate(selector, scope);
	const direct = await narratorService.getById(aliasCandidate).catch(() => null);
	if (direct) {
		assertTargetAllowed(direct, scope);
		return direct;
	}

	const siblings = await narratorService.listSubagentsByParent(scope.teamParentId);
	const candidates = siblings.filter((s) => {
		if (scope.callerIsSubagent && s.id === scope.caller.id) return false;
		return subagentMatchesSelector(s, selector);
	});

	if (candidates.length === 0) {
		throw new Error(`No accessible subagent found for "${selector}"`);
	}
	if (candidates.length > 1) {
		const lines = candidates.map((c) => `- ${c.id} | ${c.title ?? "(untitled)"}`).join("\n");
		throw new Error(`Ambiguous subagent target "${selector}". Candidates:\n${lines}`);
	}

	const target = await narratorService.getById(candidates[0].id);
	assertTargetAllowed(target, scope);
	return target;
}

export async function resolveSubagentTargets(input: ResolveTargetsInput): Promise<Narrator[]> {
	const selectors = getSelectors(input);
	if (selectors.length === 0) {
		throw new Error("At least one target id/name is required");
	}

	const scope = await getCommunicationScope(input.callerNarratorId);
	const resolved: Narrator[] = [];
	const seen = new Set<string>();
	for (const selector of selectors) {
		const target = await resolveOneTarget(selector, scope);
		if (seen.has(target.id)) continue;
		seen.add(target.id);
		resolved.push(target);
	}
	return resolved;
}

function formatSubagentResult(subagentId: string, finalText: string | null | undefined): string {
	return `<subagent_id>${subagentId}</subagent_id>\n\n${finalText || "(no output)"}`;
}

function settledSubagentStatus(narrator: Narrator, fallback = "completed"): string {
	const substatus = parseSubstatus(narrator.substatus);
	if (substatus.includes("error") || narrator.errorMessage) return "failed";
	if (substatus.includes("interrupted")) return "cancelled";
	return fallback;
}

export async function waitForSubagentResult(opts: {
	subagentId: string;
	parentNarratorId: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<{ status: string; output: string }> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const current = await narratorService.getById(opts.subagentId);
	if (current.status !== "working" && current.status !== "waiting") {
		return {
			status: settledSubagentStatus(current),
			output: await getSubagentFinalText(opts.subagentId),
		};
	}

	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			eventBus.off("narrator:subagent_completed", onCompleted);
			opts.signal?.removeEventListener("abort", onAbort);
		};

		const finish = async (status: string) => {
			const [output, latest] = await Promise.all([
				getSubagentFinalText(opts.subagentId).catch(() => "(no output)"),
				narratorService.getById(opts.subagentId).catch(() => null),
			]);
			cleanup();
			resolve({ status: latest ? settledSubagentStatus(latest, status) : status, output });
		};

		const onCompleted = (event: { narratorId: string; parentNarratorId: string }) => {
			if (settled) return;
			if (event.narratorId !== opts.subagentId) return;
			void finish("completed");
		};

		const onAbort = () => {
			cleanup();
			resolve({ status: "aborted", output: "Await aborted." });
		};

		eventBus.on("narrator:subagent_completed", onCompleted);
		if (opts.signal) {
			if (opts.signal.aborted) {
				onAbort();
				return;
			}
			opts.signal.addEventListener("abort", onAbort, { once: true });
		}
		timer = setTimeout(() => {
			cleanup();
			resolve({ status: "timeout", output: "Subagent is still running." });
		}, timeoutMs);
	});
}

async function awaitBackgroundAgentTask(opts: AwaitAgentInput) {
	const resolvedId = resolveTaskAlias(opts.callerNarratorId, opts.id);
	let task = await backgroundTaskService.getById(resolvedId);
	if (!task && resolvedId === opts.id) {
		task = await backgroundTaskService.getByAlias(opts.id, opts.callerNarratorId);
	}
	if (!task) return null;
	if (task.type !== "agent") {
		throw new Error(`Background task "${opts.id}" is ${task.type}, not agent`);
	}
	if (task.parentNarratorId !== opts.callerNarratorId) {
		throw new Error(`Background agent "${opts.id}" does not belong to this narrator`);
	}

	const subagentId = task.subagentNarratorId ?? task.id;
	const current = await narratorService.getById(subagentId).catch(() => null);
	if (current && task.status !== "running" && !current.isBackground) {
		// The background task row is from a previous run. The same subagent may have
		// since been continued via Send, so fall through to narrator-state waiting.
		return null;
	}

	if (task.status === "running") {
		const waited = await backgroundTaskService.waitForCompletion(
			task.id,
			opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			opts.signal,
		);
		return {
			id: subagentId,
			status: waited.status,
			output: waited.output,
		};
	}
	return { id: subagentId, status: task.status, output: task.output };
}

export async function awaitAgentResultDetailed(opts: AwaitAgentInput): Promise<AwaitAgentResult> {
	const background = await awaitBackgroundAgentTask(opts);
	if (background) {
		const output = formatSubagentResult(background.id, background.output);
		return {
			id: background.id,
			status: background.status,
			output: background.output ?? "(no output)",
			formatted: `Agent ${background.id} status: ${background.status}\n\n${output}`,
		};
	}

	const scope = await getCommunicationScope(opts.callerNarratorId);
	const target = await resolveOneTarget(opts.id, scope);
	if (target.isBackground && target.backgroundStatus === "running") {
		const waited = await waitForBackgroundTask(target.id, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const output = formatSubagentResult(target.id, waited.result);
		return {
			id: target.id,
			status: waited.status,
			output: waited.result ?? "(no output)",
			formatted: `Agent ${target.id} status: ${waited.status}\n\n${output}`,
		};
	}
	if (target.isBackground && target.backgroundStatus) {
		const output = formatSubagentResult(target.id, target.backgroundResult);
		return {
			id: target.id,
			status: target.backgroundStatus,
			output: target.backgroundResult ?? "(no output)",
			formatted: `Agent ${target.id} status: ${target.backgroundStatus}\n\n${output}`,
		};
	}
	if (target.status === "working" || target.status === "waiting") {
		const waited = await waitForSubagentResult({
			subagentId: target.id,
			parentNarratorId: target.parentNarratorId as string,
			timeoutMs: opts.timeoutMs,
			signal: opts.signal,
		});
		const output = formatSubagentResult(target.id, waited.output);
		return {
			id: target.id,
			status: waited.status,
			output: waited.output,
			formatted: `Agent ${target.id} status: ${waited.status}\n\n${output}`,
		};
	}
	const finalText = await getSubagentFinalText(target.id);
	const output = formatSubagentResult(target.id, finalText);
	const status = settledSubagentStatus(target);
	return {
		id: target.id,
		status,
		output: finalText,
		formatted: `Agent ${target.id} status: ${status}\n\n${output}`,
	};
}

export async function awaitAgentResult(opts: AwaitAgentInput): Promise<string> {
	return (await awaitAgentResultDetailed(opts)).formatted;
}

/**
 * Resolve a single selector to a fellow chat-group member narrator of the caller.
 * Matches by exact id, handle, slugified title, or title. Returns the member's
 * narrator id and the shared group id, or null if the selector is not a fellow
 * group member.
 */
function normalizeGroupMemberSelector(selector: string): string {
	const trimmed = selector.trim();
	return trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
}

async function resolveGroupMemberSelector(
	callerNarratorId: string,
	selector: string,
): Promise<{ narratorId: string; groupId: string } | null> {
	const { chatGroupService } = await import("./chat-group-service");
	const groups = await chatGroupService.listGroupsForNarrator(callerNarratorId);
	if (groups.length === 0) return null;

	const rawSelector = selector.trim();
	const normalizedSelector = normalizeGroupMemberSelector(selector);
	const normalizedHandle = normalizedSelector.toLowerCase();

	for (const group of groups) {
		const members = await chatGroupService.listNarratorMembers(group.id);
		for (const member of members) {
			if (!member.narratorId || member.narratorId === callerNarratorId) continue;
			const narrator = await narratorService.getById(member.narratorId).catch(() => null);
			if (!narrator) continue;
			if (
				narrator.id === rawSelector ||
				narrator.id === normalizedSelector ||
				narrator.handle === normalizedHandle ||
				subagentMatchesSelector(narrator, rawSelector) ||
				subagentMatchesSelector(narrator, normalizedSelector)
			) {
				return { narratorId: narrator.id, groupId: group.id };
			}
		}
	}
	return null;
}

/**
 * Attempt to route a Send via a chat group. Returns a result if every selector
 * resolves to a fellow group member; returns null if no selector matches a group
 * member (so the caller can fall through to the subagent-team path).
 */
async function tryRouteViaChatGroup(input: SendSubagentInput): Promise<SendSubagentResult | null> {
	const selectors = getSelectors(input);
	if (selectors.length === 0) return null;

	const { chatGroupService } = await import("./chat-group-service");
	const resolved: { selector: string; narratorId: string; groupId: string }[] = [];
	for (const selector of selectors) {
		const match = await resolveGroupMemberSelector(input.callerNarratorId, selector);
		if (match) resolved.push({ selector, ...match });
	}
	// If none of the selectors are group members, this isn't a group send.
	if (resolved.length === 0) return null;
	if (resolved.length !== selectors.length) {
		const resolvedSelectors = new Set(resolved.map((item) => item.selector));
		const targets = selectors.map((selector) => ({
			id: selector,
			status: "failed" as const,
			error: resolvedSelectors.has(selector)
				? "Mixed group and non-group Send targets are not delivered together; split this into separate Send calls."
				: "Target is not a fellow chat-group member.",
		}));
		return {
			output: targets
				.map((target) => `Failed to deliver to "${target.id}": ${target.error}`)
				.join("\n"),
			targets,
		};
	}

	const targetResults: SendTargetResult[] = [];
	const sections: string[] = [];
	const postedGroups = new Set<string>();
	for (const { selector, groupId } of resolved) {
		try {
			// Post once per distinct group (a single message reaches all members).
			if (!postedGroups.has(groupId)) {
				await chatGroupService.postMessage({
					groupId,
					content: input.message,
					senderType: "narrator",
					senderNarratorId: input.callerNarratorId,
					locale: input.locale as Locale,
				});
				postedGroups.add(groupId);
			}
			targetResults.push({ id: selector, status: "completed" });
			sections.push(`Delivered to group member "${selector}".`);
		} catch (err) {
			targetResults.push({
				id: selector,
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
			});
			sections.push(
				`Failed to deliver to "${selector}": ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return { output: sections.join("\n"), targets: targetResults };
}

export async function sendSubagentMessageDetailed(
	input: SendSubagentInput,
): Promise<SendSubagentResult> {
	const scope = await getCommunicationScope(input.callerNarratorId);

	// Chat-group routing: if the caller is a primary narrator and the selector(s)
	// resolve to fellow chat-group member narrators, deliver via the group instead
	// of the subagent-team path. This is how named narrators converse across
	// sessions. Subagents continue to use the team path exclusively.
	if (!scope.callerIsSubagent && !input.doInterrupt) {
		const groupResult = await tryRouteViaChatGroup(input);
		if (groupResult) return groupResult;
	}

	if (input.doInterrupt && scope.callerIsSubagent) {
		throw new Error("doInterrupt is only supported from a primary narrator to its child subagents");
	}

	const targets = await resolveSubagentTargets(input);
	const sections: string[] = [];
	const targetResults: SendTargetResult[] = [];
	for (const target of targets) {
		try {
			if (input.doInterrupt && target.parentNarratorId !== input.callerNarratorId) {
				throw new Error("doInterrupt is only supported for this narrator's direct child subagents");
			}

			const fresh = await narratorService.getById(target.id);
			if (fresh.status === "archived") {
				throw new Error("Target subagent is archived");
			}

			if (fresh.status === "working" || fresh.status === "waiting") {
				const buffered = pushSubagentBufferedMessage(
					fresh.id,
					input.message,
					undefined,
					input.doInterrupt ? "front" : "back",
				);
				if (!buffered.ok) {
					throw new Error(
						buffered.full ? "Target message queue is full" : "Message was not buffered",
					);
				}
				let interruptNote = "";
				if (input.doInterrupt) {
					const interrupted = interruptForegroundSubagent(fresh.id);
					interruptNote = interrupted
						? " Interrupted foreground subagent."
						: " Target is not an interruptible foreground subagent.";
				}
				if (input.shouldAwait) {
					const waited = fresh.isBackground
						? await backgroundTaskService.waitForCompletion(
								fresh.id,
								input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
								input.signal,
							)
						: await waitForSubagentResult({
								subagentId: fresh.id,
								parentNarratorId: fresh.parentNarratorId as string,
								timeoutMs: input.timeoutMs,
								signal: input.signal,
							});
					sections.push(
						`Sent to ${fresh.id}.${interruptNote}\nStatus: ${waited.status}\n${formatSubagentResult(
							fresh.id,
							waited.output,
						)}`,
					);
					targetResults.push({
						id: fresh.id,
						title: fresh.title,
						status: normalizeSendStatus(waited.status),
						interrupted: input.doInterrupt ? interruptNote.includes("Interrupted") : undefined,
						awaited: true,
					});
				} else {
					sections.push(`Sent to ${fresh.id}; message queued.${interruptNote}`);
					targetResults.push({
						id: fresh.id,
						title: fresh.title,
						status: "queued",
						interrupted: input.doInterrupt ? interruptNote.includes("Interrupted") : undefined,
						awaited: false,
					});
				}
				continue;
			}

			if (input.shouldAwait) {
				const result = await continueSubagent({
					subagentId: fresh.id,
					parentNarratorId: fresh.parentNarratorId as string,
					toolUseId: input.toolUseId,
					prompt: input.message,
					signal: input.signal,
					locale: input.locale as Locale,
				});
				const latest = await narratorService.getById(fresh.id).catch(() => null);
				const status = latest ? normalizeSendStatus(settledSubagentStatus(latest)) : "completed";
				sections.push(`Sent to ${fresh.id} and awaited result.\n${result}`);
				targetResults.push({
					id: fresh.id,
					title: fresh.title,
					status,
					awaited: true,
				});
			} else {
				const bgAbort = new AbortController();
				continueSubagent({
					subagentId: fresh.id,
					parentNarratorId: fresh.parentNarratorId as string,
					toolUseId: input.toolUseId,
					prompt: input.message,
					signal: bgAbort.signal,
					locale: input.locale as Locale,
				}).catch((err) => {
					logger.warn("Async Send subagent continuation failed", {
						subagentId: fresh.id,
						error: err instanceof Error ? err.message : String(err),
					});
				});
				sections.push(`Sent to ${fresh.id}; subagent started asynchronously.`);
				targetResults.push({
					id: fresh.id,
					title: fresh.title,
					status: "started",
					awaited: false,
				});
			}
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			sections.push(`Failed to send to ${target.id}: ${error}`);
			targetResults.push({
				id: target.id,
				title: target.title,
				status: "failed",
				awaited: input.shouldAwait,
				error,
			});
		}
	}
	return { output: sections.join("\n\n"), targets: targetResults };
}

function normalizeSendStatus(status: string): SendTargetResult["status"] {
	if (
		status === "queued" ||
		status === "started" ||
		status === "completed" ||
		status === "failed" ||
		status === "timeout" ||
		status === "aborted" ||
		status === "cancelled"
	) {
		return status;
	}
	return "completed";
}

export async function sendSubagentMessage(input: SendSubagentInput): Promise<string> {
	return (await sendSubagentMessageDetailed(input)).output;
}
