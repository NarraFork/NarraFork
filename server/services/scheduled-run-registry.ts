import type { Locale } from "@shared/i18n-locales";
import type {
	RunBlockReason,
	TaskModelPolicy,
	TaskOnBlockedPolicy,
} from "@shared/scheduled-task-status";
import { hotSafe } from "../lib/hot-safe";

/** A trusted dispatcher supplies these facts; tool input never establishes ownership. */
export interface ScheduledRunRegistration {
	runId: string;
	taskId: string;
	narratorId: string;
	ownerUserId: string | null;
	onBlocked: TaskOnBlockedPolicy;
	blockedWaitMinutes: number;
	deadlineAt: string | null;
	permissionMode: string;
	/** Undefined only for legacy/test registrations; null explicitly clears an old prompt. */
	systemPrompt?: string | null;
	modelPolicy: TaskModelPolicy;
	model: string | null;
	locale?: Locale;
	logicalRunId?: string;
	triggerMessageId?: string;
	/** Cold recovery has no authoritative terminal receipt. Never infer success from idle. */
	recoveredAt?: number;
	terminal?: ScheduledRunTerminal;
	turns?: number;
	/** The single follow-up can report only, never execute business tools again. */
	reportOnly?: boolean;
}

export interface ScheduledRunTerminal {
	logicalRunId: string;
	status: "completed" | "failed" | "interrupted" | "timed_out";
	error?: string;
	settledAt: number;
}

export interface ScheduledRunMember {
	runId: string;
	narratorId: string;
	logicalRunId: string;
	/** Present only after the service checked the real persisted parent chain. */
	parentNarratorId?: string;
}

const registry = hotSafe("narrafork.scheduled-runs.v1", () => ({
	roots: new Map<string, ScheduledRunRegistration>(),
	members: new Map<string, ScheduledRunMember>(),
}));

export function registerScheduledRun(input: ScheduledRunRegistration): ScheduledRunRegistration {
	const existing = registry.roots.get(input.narratorId);
	if (existing) {
		if (existing.runId !== input.runId) throw new Error("Narrator already has a scheduled run");
		return existing;
	}
	const registration = { ...input };
	registry.roots.set(input.narratorId, registration);
	return registration;
}

export function getRegisteredScheduledRun(narratorId: string) {
	return registry.roots.get(narratorId);
}

export function getScheduledRunById(runId: string) {
	for (const registration of registry.roots.values()) {
		if (registration.runId === runId) return registration;
	}
	return undefined;
}

export function listRegisteredScheduledRuns(): ScheduledRunRegistration[] {
	return [...registry.roots.values()];
}

export function getScheduledRunMember(narratorId: string) {
	return registry.members.get(narratorId);
}

export function listScheduledRunMembers(runId: string): ScheduledRunMember[] {
	return [...registry.members.values()].filter((member) => member.runId === runId);
}

export function bindScheduledRunMember(member: ScheduledRunMember): boolean {
	const root = getScheduledRunById(member.runId);
	if (!root) return false;
	registry.members.set(member.narratorId, { ...member });
	if (member.narratorId === root.narratorId) {
		root.logicalRunId = member.logicalRunId;
		root.terminal = undefined;
		root.turns = (root.turns ?? 0) + 1;
	}
	return true;
}

export function recordScheduledRunTerminal(
	runId: string,
	narratorId: string,
	terminal: ScheduledRunTerminal,
): boolean {
	const root = registry.roots.get(narratorId);
	if (root?.runId !== runId || root.logicalRunId !== terminal.logicalRunId) return false;
	root.terminal = terminal;
	return true;
}

/** Compare-and-delete: a late callback must not unregister a subsequent task run. */
export function unregisterScheduledRun(runId: string): void {
	for (const [id, registration] of registry.roots) {
		if (registration.runId === runId) registry.roots.delete(id);
	}
	for (const [id, member] of registry.members) {
		if (member.runId === runId) registry.members.delete(id);
	}
}

/** Runtime-only overlay: no persisted preference, restore marker, or late restore write. */
export function scheduledRunModelOverride(
	narratorId: string,
	logicalRunId?: string,
): string | undefined {
	const root = registry.roots.get(narratorId);
	if (!root || root.modelPolicy !== "temporary") return undefined;
	if (logicalRunId && root.logicalRunId !== logicalRunId) return undefined;
	return root.model ?? "__default__";
}

export function scheduledBlockReason(toolName: string): RunBlockReason {
	if (toolName === "AskUserQuestion" || toolName === "Ask") return "question";
	if (toolName === "EnterPlanMode" || toolName === "ExitPlanMode") return "plan";
	return "permission";
}

/** Only narrows a decision. Existing denies, fatal rules and runtime ceilings always win. */
export function unattendedPermissionDecision(input: {
	onBlocked: TaskOnBlockedPolicy;
	toolName: string;
	decision: "allow" | "ask" | "deny" | "fatal";
	isPlanMode?: boolean;
}): "allow" | "deny" | undefined {
	if (input.onBlocked !== "auto" || input.decision === "deny" || input.decision === "fatal")
		return undefined;
	if (["AskUserQuestion", "Ask", "EnterPlanMode", "RequestPermissionRule"].includes(input.toolName))
		return "deny";
	if (input.toolName === "ExitPlanMode" && input.isPlanMode) return "allow";
	return input.decision === "ask" ? "deny" : undefined;
}

export const UNATTENDED_PERMISSION_MESSAGE =
	"This scheduled run is unattended and cannot obtain interactive approval. Do not ask questions or enter plan mode. Continue within existing permissions; if blocked, use ScheduledTaskReport to report the limitation.";
