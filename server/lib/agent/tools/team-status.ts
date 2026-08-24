import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

type TeamAction = "list" | "list_agents" | "list_bash" | "file_changes" | "broadcast" | "send";

/**
 * Default and maximum rows PER KIND (agents, bash) for the list actions.
 *
 * These listings used to be unbounded. A narrator that keeps working keeps
 * spawning subagents — which are never reaped — and keeps starting background bash
 * tasks, so the output grew for the lifetime of the session until it dominated the
 * turn it was meant to inform.
 *
 * The default is small because the useful answer is "what is still running"; the
 * ordering puts active members first, so a truncated listing still leads with them.
 * `limit` exists for the cases where the caller genuinely wants more, and `query`
 * for reaching a specific member past the window.
 */
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;
/**
 * Terminal bash rows shown alongside the running ones when no `query` is given.
 *
 * Finished tasks are context, not the answer. They are also already age-bounded —
 * `cleanupCompleted` deletes them 30 minutes after completion — so this only caps
 * how much of that window is printed.
 */
const LIST_RECENT_TERMINAL_LIMIT = 5;

function clampListLimit(raw: unknown): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n)) return LIST_DEFAULT_LIMIT;
	return Math.min(Math.max(Math.trunc(n), 1), LIST_MAX_LIMIT);
}

/**
 * Trailing note describing what the listing left out.
 *
 * Always emitted when something was omitted: a silently truncated listing reads
 * as "the team is idle" / "that agent does not exist", and both conclusions are
 * worse than a longer output.
 */
function omissionNote(
	kind: string,
	omitted: number,
	capped: boolean,
	searched: boolean,
): string | null {
	if (omitted <= 0) return null;
	const amount = capped ? `${omitted}+` : `${omitted}`;
	const hint = searched
		? "raise `limit` to see more of them"
		: "use `query` to search by name, or raise `limit`";
	return `(${amount} more ${kind} not shown — ${hint})`;
}

function teamMemberType(variant: string | null | undefined): string {
	return variant?.startsWith("subagent:") ? variant.slice(9) : "primary";
}

/** Short preview used for a background bash task's title/command in list output. */
function bashLabel(title: string | null, command: string | null): string {
	const raw = title ?? command ?? "(no title)";
	return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}

/**
 * Resolve a `target_id` to a real narrator id.
 *
 * `list`/`list_agents` print each member's alias, so an alias is what a model
 * naturally passes back — but `file_changes` and `send` index structures keyed by
 * the real narrator id. Without this, naming a member exactly as it was listed
 * would report "no file changes" or "not a direct subagent".
 *
 * Accepts real ids, id prefixes, titles, title slugs and persisted aliases (the
 * same selector grammar Send/Await honour). Returns the input unchanged when
 * nothing matches, so the caller's own validation produces the error.
 */
async function resolveTeamMemberId(callerNarratorId: string, selector: string): Promise<string> {
	const { resolveSubagentTargets } = await import("@server/services/agent-communication");
	const targets = await resolveSubagentTargets({
		callerNarratorId,
		id: selector,
	}).catch(() => []);
	return targets.length === 1 ? targets[0].id : selector;
}

export const teamStatusTool: ToolDefinition = {
	name: "TeamStatus",
	description:
		"Query background agents and bash tasks in the current team/session, see which files " +
		"subagents modified, and send messages within the team.\n\n" +
		"Actions:\n" +
		'- "list": List background agents and background bash tasks (kind=agent|bash)\n' +
		'- "list_agents": List sibling subagents only\n' +
		'- "list_bash": List background bash tasks only\n' +
		'- "file_changes": Show files modified by each subagent (or a specific one via target_id)\n' +
		'- "broadcast": Send a message to ALL direct subagents\n' +
		'- "send": Send a message to a specific direct subagent (requires target_id)\n\n' +
		"Notes:\n" +
		"- The primary narrator is the team root; subagents use their parent's team scope.\n" +
		"- All actions are limited to the current narrator's direct subagent team.\n" +
		`- The list actions are bounded: active members come first, then a few recent finished ones, up to ${LIST_DEFAULT_LIMIT} rows per kind. A trailing note reports what was omitted.\n` +
		"- Use `query` to find a specific member by name/alias/id prefix past that window, and `limit` to widen it.\n" +
		"- file_changes only tracks modifications made via Write and Edit tools; Bash changes are not tracked.",
	parameters: z.object({
		action: z
			.enum(["list", "list_agents", "list_bash", "file_changes", "broadcast", "send"])
			.describe("The action to perform"),
		target_id: z
			.string()
			.optional()
			.describe("Target subagent ID (required for 'send', optional for 'file_changes')"),
		message: z.string().optional().describe("Message text (required for 'broadcast' and 'send')"),
		query: z
			.string()
			.optional()
			.describe(
				"List actions only: filter members by title, alias or id prefix. Searches the whole team, past the default window.",
			),
		limit: z
			.number()
			.int()
			.optional()
			.describe(
				`List actions only: max rows per kind (default ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT}).`,
			),
	}),
	rawJsonSchema: {
		type: "object",
		properties: {
			action: {
				description: "The action to perform",
				type: "string",
				enum: ["list", "list_agents", "list_bash", "file_changes", "broadcast", "send"],
			},
			target_id: {
				description: "Target subagent ID (required for 'send', optional for 'file_changes')",
				type: "string",
			},
			message: {
				description: "Message text (required for 'broadcast' and 'send')",
				type: "string",
			},
			query: {
				description:
					"List actions only: filter members by title, alias or id prefix. Searches the whole team, past the default window.",
				type: "string",
			},
			limit: {
				description: `List actions only: max rows per kind (default ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT}).`,
				type: "integer",
			},
		},
		required: ["action"],
		additionalProperties: false,
	},
	async execute(args, ctx): Promise<ToolResult> {
		const { action, target_id, message, query, limit } = args as {
			action: TeamAction;
			target_id?: string;
			message?: string;
			query?: string;
			limit?: number;
		};

		// The primary narrator is the team root; a subagent shares its parent's team scope.
		const scopeId = ctx.parentNarratorId ?? ctx.narratorId;

		if (action === "list" || action === "list_agents" || action === "list_bash") {
			const { narratorService } = await import("@server/services/narrator-service");
			const { backgroundTaskService } = await import("@server/services/background-task-service");

			const wantAgents = action !== "list_bash";
			const wantBash = action !== "list_agents";
			const rowLimit = clampListLimit(limit);
			const needle = query?.trim() || undefined;

			// Both kinds are bounded independently so one crowded kind cannot starve the
			// other — a team with 80 finished agents would otherwise hide every running
			// bash task under a shared budget.
			const agentView = wantAgents
				? await narratorService.listSubagentsForTeamView({
						parentNarratorId: scopeId,
						limit: rowLimit,
						query: needle,
					})
				: null;

			// Bash tasks are keyed by the narrator that STARTED them, so the team scope has
			// to include the parent, this narrator and every sibling. The sibling ids come
			// from the unbounded listing on purpose: a bounded one would drop tasks owned
			// by siblings outside the display window, which is a wrong answer rather than
			// a shortened one. Only ids are read, so no large columns are materialized.
			const bashView = wantBash
				? await (async () => {
						const siblingIds = (await narratorService.listSubagentsByParent(scopeId)).map(
							(s) => s.id,
						);
						return backgroundTaskService.listTeamBashTasks({
							parentNarratorIds: [scopeId, ctx.narratorId, ...siblingIds],
							limit: rowLimit,
							recentTerminalLimit: LIST_RECENT_TERMINAL_LIMIT,
							query: needle,
						});
					})()
				: null;

			const { agentLabelFromNarrator } = await import("@server/services/subagent-label");
			const lines: string[] = [];
			const notes: string[] = [];
			if (agentView) {
				for (const s of agentView.subagents) {
					const isSelf = s.id === ctx.narratorId ? " (you)" : "";
					const sType = s.variant.startsWith("subagent:") ? s.variant.slice(9) : "unknown";
					// Lead with the alias, like the bash rows below, so the model addresses
					// agents by a readable handle instead of copying the nanoid back.
					lines.push(
						`- kind=agent | alias=${agentLabelFromNarrator(s, scopeId)}${isSelf} | id=${s.id} | type=${sType} | status=${s.status} | title=${s.title ?? "(untitled)"}`,
					);
				}
				const note = omissionNote(
					"agents",
					agentView.omitted,
					agentView.omittedCapped,
					Boolean(needle),
				);
				if (note) notes.push(note);
			}
			if (bashView) {
				for (const task of bashView.tasks) {
					const status = task.effectiveStatus ?? task.status;
					const alias = task.alias ? ` | alias=${task.alias}` : "";
					const cancel = task.canCancelActiveWork ? " | canCancel=true" : "";
					lines.push(
						`- kind=bash | id=${task.id}${alias} | status=${status}${cancel} | title=${bashLabel(task.title, task.command)}`,
					);
				}
				const note = omissionNote(
					"bash tasks",
					bashView.omitted,
					bashView.omittedCapped,
					Boolean(needle),
				);
				if (note) notes.push(note);
			}

			if (lines.length === 0) {
				const scope =
					action === "list_agents"
						? "sibling subagents"
						: action === "list_bash"
							? "background bash tasks"
							: "background agents or bash tasks";
				// A search that found nothing is a different fact from an empty team, and
				// the model's next move differs: broaden the needle vs. stop looking.
				return {
					output: needle ? `No ${scope} match "${needle}".` : `No ${scope} found.`,
				};
			}
			const header =
				action === "list_agents"
					? `Sibling subagents (${lines.length}):`
					: action === "list_bash"
						? `Background bash tasks (${lines.length}):`
						: `Background tasks (${lines.length}):`;
			const body = `${header}\n${lines.join("\n")}`;
			return { output: notes.length > 0 ? `${body}\n${notes.join("\n")}` : body };
		}

		// The remaining actions operate on the current narrator's direct subagent team.
		const parentNarratorId = scopeId;
		const { getTeamFileChanges, deliverTeamMessage } = await import(
			"@server/services/narrator-subagent"
		);
		type TeamMessage = import("@server/services/narrator-subagent").TeamMessage;

		switch (action) {
			case "file_changes": {
				const changes = getTeamFileChanges(parentNarratorId);
				if (changes.size === 0) {
					return { output: "No file changes recorded by any team member." };
				}
				// Only ids are tracked here, so labels need the async resolver.
				const { resolveAgentLabel } = await import("@server/services/subagent-label");
				if (target_id) {
					// The listing above prints aliases, so `target_id` is very likely one.
					// The change map is keyed by real narrator id, so resolve first.
					const resolvedId = await resolveTeamMemberId(ctx.narratorId, target_id);
					const files = changes.get(resolvedId);
					const label = await resolveAgentLabel(scopeId, resolvedId);
					if (!files?.size) {
						return { output: `No file changes recorded for ${label}.` };
					}
					return {
						output: `Files modified by ${label} (${files.size}):\n${[...files].join("\n")}`,
					};
				}
				const sections: string[] = [];
				for (const [subId, files] of changes) {
					const isSelf = subId === ctx.narratorId ? " (you)" : "";
					const label = await resolveAgentLabel(scopeId, subId);
					sections.push(
						`${label}${isSelf} (${files.size} files):\n${[...files].map((f) => `  ${f}`).join("\n")}`,
					);
				}
				return { output: sections.join("\n\n") };
			}

			case "broadcast": {
				if (!message) {
					return { output: "Message text is required for broadcast.", isError: true };
				}
				const { narratorService } = await import("@server/services/narrator-service");
				const { agentLabelFromNarrator } = await import("@server/services/subagent-label");
				const sender = await narratorService.getById(ctx.narratorId);
				const siblings = await narratorService.listSubagentsByParent(parentNarratorId);
				const targets = siblings.filter(
					(s: { id: string; variant?: string | null }) =>
						s.id !== ctx.narratorId && s.variant?.startsWith("subagent:") === true,
				);
				if (targets.length === 0) {
					const targetKind = ctx.parentNarratorId ? "sibling subagents" : "child subagents";
					return { output: `No ${targetKind} to broadcast to.` };
				}
				const senderType = teamMemberType(sender.variant);
				const now = new Date().toISOString();
				// Reader-only navigation target: where the sender was in its own session
				// when it broadcast this. Best-effort — a sender that has written nothing
				// has nothing to point at, and that must not fail the broadcast.
				const { getSubagentResultMessageId } = await import("@server/services/narrator-session");
				const fromMessageId = await getSubagentResultMessageId(ctx.narratorId).catch(
					() => undefined,
				);
				const msg: TeamMessage = {
					fromId: ctx.narratorId,
					fromTitle: sender.title,
					fromLabel: agentLabelFromNarrator(sender, parentNarratorId),
					fromType: senderType,
					...(fromMessageId ? { fromMessageId } : {}),
					text: message,
					timestamp: now,
					isBroadcast: true,
				};
				for (const target of targets) {
					deliverTeamMessage(target.id, msg, parentNarratorId);
				}
				const nonWorking = targets.filter(
					(t: { id: string; status: string }) => t.status !== "working",
				);
				const targetKind = ctx.parentNarratorId ? "sibling(s)" : "child subagent(s)";
				let output = `Broadcast sent to ${targets.length} ${targetKind}: ${targets
					.map((t) => agentLabelFromNarrator(t, parentNarratorId))
					.join(", ")}`;
				if (nonWorking.length > 0) {
					output += `\n(warning: ${nonWorking.length} target(s) not currently working — messages may not be received)`;
				}
				return { output };
			}

			case "send": {
				if (!target_id) {
					return { output: "target_id is required for 'send' action.", isError: true };
				}
				if (!message) {
					return { output: "Message text is required for 'send' action.", isError: true };
				}
				const { narratorService } = await import("@server/services/narrator-service");
				const { agentLabelFromNarrator } = await import("@server/services/subagent-label");
				const sender = await narratorService.getById(ctx.narratorId);
				// `list` prints aliases, so an alias is the likely input here. Resolve it to
				// a real id before the lookup — `getById` alone would throw NotFound.
				const resolvedTargetId = await resolveTeamMemberId(ctx.narratorId, target_id);
				const target = await narratorService.getById(resolvedTargetId).catch(() => null);
				if (
					!target?.variant?.startsWith("subagent:") ||
					target.parentNarratorId !== parentNarratorId
				) {
					return {
						output: `${target_id} is not a direct subagent in this team.`,
						isError: true,
					};
				}
				const sendSenderType = teamMemberType(sender.variant);
				const now = new Date().toISOString();
				// See the broadcast branch: reader-only navigation target, best-effort.
				const { getSubagentResultMessageId: resolveSenderMessageId } = await import(
					"@server/services/narrator-session"
				);
				const sendFromMessageId = await resolveSenderMessageId(ctx.narratorId).catch(
					() => undefined,
				);
				const msg: TeamMessage = {
					fromId: ctx.narratorId,
					fromTitle: sender.title,
					fromLabel: agentLabelFromNarrator(sender, parentNarratorId),
					fromType: sendSenderType,
					...(sendFromMessageId ? { fromMessageId: sendFromMessageId } : {}),
					text: message,
					timestamp: now,
					isBroadcast: false,
				};
				// Inbox keys are real narrator ids; delivering under an alias would drop the
				// message into an inbox nobody drains.
				deliverTeamMessage(resolvedTargetId, msg, parentNarratorId);
				const warning =
					target.status !== "working"
						? ` (warning: target is ${target.status}, message may not be received)`
						: "";
				return {
					output: `Message sent to ${agentLabelFromNarrator(target, parentNarratorId)}.${warning}`,
				};
			}

			default:
				return { output: `Unknown action: ${action}`, isError: true };
		}
	},
};
