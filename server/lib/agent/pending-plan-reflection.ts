import { hotSafe } from "../hot-safe";

/**
 * On-demand plan reflection for an ExitPlanMode that is ALREADY waiting for a person.
 *
 * The reflection gate normally runs inside the agent loop *before* `executeTool` requests the
 * permission (`resolveExitPlanModeReflection`). Once the gate declined — the switch was off, or
 * the permission mode is not `acceptEdits`/`bypassPermissions` — the plan blocks on its approval
 * card, and the loop is suspended inside `config.permissionHandler(...)`, holding the only
 * `AgentConfig`/`rows` that a reflection needs. Nothing outside that stack frame can start one.
 *
 * This registry is the hand-over: the loop registers a runner for the length of the wait (keyed
 * by narrator + tool_use), `handlePermission` attaches it to the pending request, and the
 * permission service invokes it when the person presses 计划反思 or turns the switch on while the
 * plan waits. The runner's decision is then written back onto that pending permission
 * (`resolvePermission`), so approval, denial and attribution go through the one existing path.
 *
 * Structure over import: the decision union below deliberately mirrors `ExitPlanReflectionDecision`
 * instead of importing it, because `tools/exit-plan-reflection.ts` pulls in service code and this
 * module is imported by the permission service itself (which the agent loop loads dynamically to
 * avoid a cycle). TypeScript's structural typing keeps both ends compatible.
 */
export type PendingPlanReflectionDecision =
	| { action: "confirm"; reflection?: string }
	| { action: "confirm_compact"; reflection?: string }
	| { action: "revise"; feedback: string }
	| { action: "human"; reason: string; input?: Record<string, unknown> }
	| { action: "manual"; reason?: string };

export interface PendingPlanReflectionGateResult {
	decision: PendingPlanReflectionDecision;
	input: Record<string, unknown>;
	checkFailed?: boolean;
}

/**
 * Runs one plan reflection against the input the pending approval is showing, and resolves to
 * the reviewer's decision. It never resolves the permission itself.
 *
 * `signal` aborts the review when the request is decided first: the wait it describes no longer
 * exists, and a nested agent loop left running would burn a provider call to answer nobody.
 */
export type PendingPlanReflectionRunner = (
	input: Record<string, unknown>,
	options?: { signal?: AbortSignal },
) => Promise<PendingPlanReflectionGateResult>;

interface PendingPlanReflectionRegistration {
	narratorId: string;
	toolUseId: string;
	run: PendingPlanReflectionRunner;
}

// Pinned to globalThis so a Bun --hot reload does not orphan the runners of waits that are
// still suspended (the same reason the reflection gates themselves are hot-safe).
const pendingPlanReflectionRunners = hotSafe<Map<string, PendingPlanReflectionRegistration>>(
	"narrafork.pendingPlanReflectionRunners",
	() => new Map(),
);

function runnerKey(narratorId: string, toolUseId: string): string {
	return `${narratorId}:${toolUseId}`;
}

/**
 * Publish the runner for one call's approval wait. Returns an idempotent unregister function
 * which only removes THIS registration (a newer attempt of the same tool_use keeps its own).
 */
export function registerPendingPlanReflectionRunner(
	narratorId: string,
	toolUseId: string,
	run: PendingPlanReflectionRunner,
): () => void {
	const key = runnerKey(narratorId, toolUseId);
	const registration: PendingPlanReflectionRegistration = { narratorId, toolUseId, run };
	pendingPlanReflectionRunners.set(key, registration);
	return () => {
		if (pendingPlanReflectionRunners.get(key) === registration) {
			pendingPlanReflectionRunners.delete(key);
		}
	};
}

export function getPendingPlanReflectionRunner(
	narratorId: string,
	toolUseId: string,
): PendingPlanReflectionRunner | undefined {
	return pendingPlanReflectionRunners.get(runnerKey(narratorId, toolUseId))?.run;
}

/** Whether a request for this call could be reflected on demand if it became pending now. */
export function hasPendingPlanReflectionRunner(narratorId: string, toolUseId: string): boolean {
	return pendingPlanReflectionRunners.has(runnerKey(narratorId, toolUseId));
}
