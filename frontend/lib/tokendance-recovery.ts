import { parseTokenDanceRecoveryAction, type TokenDanceRecoveryAction } from "@shared/tokendance";

export const TOKENDANCE_RECOVERY_EVENT = "narrafork:tokendance-recovery";

export interface TokenDanceRecoveryDetail {
	action: TokenDanceRecoveryAction;
	narratorId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Only our own TokenDance diagnostics may request recovery, never arbitrary upstream URLs. */
export function getTokenDanceRecoveryDetail(input: unknown): TokenDanceRecoveryDetail | undefined {
	const data = record(input);
	if (!data) return undefined;
	const diagnostics = record(data.diagnostics);
	if (diagnostics?.provider !== "tokendance") return undefined;
	const action = parseTokenDanceRecoveryAction(diagnostics.tokendanceRecoveryAction);
	if (!action) return undefined;
	return {
		action,
		...(typeof data.narratorId === "string" && data.narratorId.length <= 128
			? { narratorId: data.narratorId }
			: {}),
	};
}

/** Called before normal WS fan-out; it does not swallow the original narrator error. */
export function dispatchTokenDanceRecovery(input: unknown, target: EventTarget = window): void {
	const data = record(input);
	if (data?.type !== "narrator_error") return;
	const detail = getTokenDanceRecoveryDetail(data);
	if (detail) target.dispatchEvent(new CustomEvent(TOKENDANCE_RECOVERY_EVENT, { detail }));
}
