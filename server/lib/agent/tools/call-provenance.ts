import type { ToolContext } from "../types";

/** Resolve durable attribution only from the host's execution binding, never tool arguments. */
export async function callProvenance(
	ctx: Pick<ToolContext, "narratorId" | "toolCallBinding" | "currentToolUseId">,
): Promise<{ messageId: string | null; toolCallId: string | null; toolUseId: string | null }> {
	const binding = ctx.toolCallBinding;
	if (!binding && !ctx.currentToolUseId)
		return { messageId: null, toolCallId: null, toolUseId: null };
	const [{ db }, { narratorToolCalls }, { and, eq }] = await Promise.all([
		import("@server/db"),
		import("@server/db/schema"),
		import("drizzle-orm"),
	]);
	const row = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.narratorId, ctx.narratorId),
			binding
				? eq(narratorToolCalls.id, binding.toolCallId)
				: eq(narratorToolCalls.toolUseId, ctx.currentToolUseId as string),
		),
		columns: { id: true, messageId: true, toolUseId: true },
	});
	return {
		messageId: row?.messageId ?? null,
		toolCallId: row?.id ?? null,
		toolUseId: row?.toolUseId ?? ctx.currentToolUseId ?? null,
	};
}
