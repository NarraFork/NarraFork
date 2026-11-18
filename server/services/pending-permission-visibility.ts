/**
 * Whether a pending tool call is shown to people as waiting for a decision. A call whose
 * reflection (danger, plan, task or question) is still running, or has finished its own way,
 * is not: only one in `awaiting_user` (or with no reflection) waits for a person.
 *
 * Its own module so lists outside the message queries (the team page's approvals) apply the
 * same rule without importing `narrator-messages.ts`.
 */

function getReflectionStatus(suggestions: unknown): string | null {
	if (!Array.isArray(suggestions)) return null;
	for (const suggestion of suggestions) {
		if (!suggestion || typeof suggestion !== "object") continue;
		const record = suggestion as { type?: unknown; status?: unknown };
		const type = String(record.type ?? "");
		if (
			type === "danger_reflection" ||
			type === "plan_reflection" ||
			type === "task_reflection" ||
			type === "question_reflection"
		) {
			return typeof record.status === "string" ? record.status : "running";
		}
	}
	return null;
}

export function shouldHidePendingPermission(suggestions: unknown): boolean {
	const status = getReflectionStatus(suggestions);
	return status !== null && status !== "awaiting_user";
}
