/**
 * Chat group service — multi-party conversations between a user, an origin
 * narrator, and one or more @mentioned "named narrators".
 *
 * Design (see plan): `chat_group_messages` is the source of truth. Each message
 * is delivered into every narrator member's own session:
 *   - idle member  → woken via narrator-session.sendMessage (injected as a user turn)
 *   - working member → queued (chat-group-queue) and drained at the next
 *                       after_tools sidecar boundary; if the message is urgent,
 *                       a soft-stop is requested so it is consumed sooner.
 *
 * Performance notes (server main-thread rules):
 *   - list queries are cursor-paginated with LIMIT n+1 (no COUNT(*))
 *   - message content is capped; we never select large fields in list summaries
 *   - delivery fans out sequentially over a bounded member set (groups are small)
 */

import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "../db";
import {
	chatGroupMembers,
	chatGroupMessages,
	chatGroups,
	narrators,
	narratorToolCalls,
	users,
} from "../db/schema";
import { AsyncMutex } from "../lib/async-mutex";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { parseTraits } from "../lib/narrator-utils";
import type { Locale } from "../lib/prompt-i18n";
import {
	formatGroupMessageForInjection,
	markGroupMessagesConsumedForReply,
	type PendingGroupMember,
	type PendingGroupMessage,
	pushGroupMessageForNarrator,
} from "./chat-group-queue";
import { buildGroupTitle } from "./chat-group-title";

/** Guards member mutations + message posting per group. */
const groupLock = new AsyncMutex();

const MAX_GROUP_MESSAGE_CHARS = 8_000;

// Re-exported so existing importers (and tests) can keep using it from here,
// while the implementation lives in a dependency-free module.
export { buildGroupTitle };

type ChatGroupRow = typeof chatGroups.$inferSelect;
type ChatGroupMemberRow = typeof chatGroupMembers.$inferSelect;
type ChatGroupMessageRow = typeof chatGroupMessages.$inferSelect;

export interface PostGroupMessageInput {
	groupId: string;
	content: string;
	senderType: "user" | "narrator" | "system";
	senderUserId?: string | null;
	senderNarratorId?: string | null;
	urgent?: boolean;
	locale?: Locale;
	/** Narrator member ids to skip delivery for (e.g. the origin session that already has the text). */
	skipNarratorIds?: string[];
}

/** Resolve a friendly label for a sender (used in injected text + WS payloads). */
async function resolveSenderLabel(
	senderType: "user" | "narrator" | "system",
	senderNarratorId: string | null | undefined,
	senderUserId: string | null | undefined,
): Promise<string> {
	if (senderType === "system") return "system";
	if (senderType === "narrator" && senderNarratorId) {
		const n = await db.query.narrators.findFirst({
			where: eq(narrators.id, senderNarratorId),
			columns: { handle: true, title: true },
		});
		return n?.handle || n?.title || "narrator";
	}
	if (senderType === "user" && senderUserId) {
		const u = await db.query.users.findFirst({
			where: eq(users.id, senderUserId),
			columns: { username: true },
		});
		return u?.username || "user";
	}
	return "user";
}

async function buildNarratorMemberContext(groupId: string): Promise<PendingGroupMember[]> {
	const members = await db.query.chatGroupMembers.findMany({
		where: eq(chatGroupMembers.groupId, groupId),
		orderBy: (m, { asc }) => [asc(m.joinedAt)],
	});
	const context: PendingGroupMember[] = [];
	for (const member of members) {
		if (member.memberType !== "narrator" || !member.narratorId) continue;
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, member.narratorId),
			columns: {
				id: true,
				handle: true,
				title: true,
				status: true,
				substatus: true,
			},
		});
		if (!narrator) continue;
		context.push({
			narratorId: narrator.id,
			handle: narrator.handle,
			title: narrator.title,
			role: member.role,
			canControl: member.canControl,
			status: narrator.status,
			substatus: narrator.substatus,
		});
	}
	return context;
}

export const chatGroupService = {
	async getById(groupId: string): Promise<ChatGroupRow | null> {
		const row = await db.query.chatGroups.findFirst({ where: eq(chatGroups.id, groupId) });
		return row ?? null;
	},

	async canUserAccessGroup(groupId: string, userId: string): Promise<boolean> {
		const group = await db.query.chatGroups.findFirst({
			where: eq(chatGroups.id, groupId),
			columns: { createdBy: true, status: true },
		});
		if (!group || group.status !== "active") return false;
		if (group.createdBy === userId) return true;
		const member = await db.query.chatGroupMembers.findFirst({
			where: and(eq(chatGroupMembers.groupId, groupId), eq(chatGroupMembers.userId, userId)),
			columns: { id: true },
		});
		return !!member;
	},

	async listMembers(groupId: string): Promise<ChatGroupMemberRow[]> {
		return db.query.chatGroupMembers.findMany({
			where: eq(chatGroupMembers.groupId, groupId),
			orderBy: (m, { asc }) => [asc(m.joinedAt)],
		});
	},

	/** Narrator members only (delivery targets). */
	async listNarratorMembers(groupId: string): Promise<ChatGroupMemberRow[]> {
		const members = await this.listMembers(groupId);
		return members.filter((m) => m.memberType === "narrator" && m.narratorId);
	},

	/**
	 * Create a new group. The origin narrator becomes the "origin" member; the
	 * creating user (if any) joins as a user member.
	 */
	async createGroup(input: {
		originNarratorId: string;
		createdBy?: string | null;
		title?: string | null;
		projectId?: string | null;
	}): Promise<ChatGroupRow> {
		const now = new Date().toISOString();
		const id = generateId();
		const [group] = await db
			.insert(chatGroups)
			.values({
				id,
				title: input.title ?? null,
				originNarratorId: input.originNarratorId,
				projectId: input.projectId ?? null,
				createdBy: input.createdBy ?? null,
				status: "active",
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		// Origin narrator member
		await db.insert(chatGroupMembers).values({
			id: generateId(),
			groupId: id,
			memberType: "narrator",
			narratorId: input.originNarratorId,
			role: "origin",
			canControl: false,
			joinedAt: now,
		});

		// Creating user member (optional)
		if (input.createdBy) {
			await db.insert(chatGroupMembers).values({
				id: generateId(),
				groupId: id,
				memberType: "user",
				userId: input.createdBy,
				role: "participant",
				canControl: true,
				joinedAt: now,
			});
		}

		eventBus.emit({ type: "group:created", groupId: id, originNarratorId: input.originNarratorId });
		logger.info("Chat group created", { groupId: id, originNarratorId: input.originNarratorId });
		return group;
	},

	/**
	 * Add a named narrator to a group (idempotent). Named members get canControl
	 * so they can drive the origin session per the "full control" design.
	 */
	async addNamedMember(groupId: string, narratorId: string): Promise<void> {
		await groupLock.acquire(groupId, async () => {
			const existing = await db.query.chatGroupMembers.findFirst({
				where: and(
					eq(chatGroupMembers.groupId, groupId),
					eq(chatGroupMembers.narratorId, narratorId),
				),
			});
			if (existing) return;
			await db.insert(chatGroupMembers).values({
				id: generateId(),
				groupId,
				memberType: "narrator",
				narratorId,
				role: "named",
				canControl: true,
				joinedAt: new Date().toISOString(),
			});
			eventBus.emit({
				type: "group:member_joined",
				groupId,
				narratorId,
				userId: null,
			});
			logger.info("Named narrator joined chat group", { groupId, narratorId });
		});
	},

	/**
	 * Find an existing active group for this origin narrator, or create one.
	 * Reuses the most-recently-updated active group so repeated @mentions in the
	 * same session keep accumulating in one conversation instead of spawning many.
	 */
	async findOrCreateGroupForOrigin(input: {
		originNarratorId: string;
		createdBy?: string | null;
		title?: string | null;
		projectId?: string | null;
	}): Promise<ChatGroupRow> {
		// Lock per origin narrator so two concurrent @mentions can't both miss the
		// existing-group check and each create a duplicate group.
		return groupLock.acquire(`origin:${input.originNarratorId}`, async () => {
			const existing = await db.query.chatGroups.findFirst({
				where: and(
					eq(chatGroups.originNarratorId, input.originNarratorId),
					eq(chatGroups.status, "active"),
				),
				orderBy: (g, { desc: d }) => [d(g.updatedAt)],
			});
			if (existing) return existing;
			return this.createGroup(input);
		});
	},

	/**
	 * Orchestrate an @mention from a narrator session: resolve the mentioned
	 * handles to named narrators, ensure a group exists for the origin narrator,
	 * add the mentioned narrators as controlling members, and post the triggering
	 * message to the group (delivered to the mentioned narrators, not back to the
	 * origin which already has the text in its own session).
	 *
	 * Returns the group and the resolved named narrators, or null if no valid
	 * named narrator was mentioned.
	 */
	async handleMentions(input: {
		originNarratorId: string;
		handles: string[];
		content: string;
		createdBy?: string | null;
		projectId?: string | null;
		locale?: Locale;
		/** When true, the originating message is from a user; otherwise from the origin narrator. */
		fromUser?: boolean;
	}): Promise<{ groupId: string; mentioned: { id: string; handle: string }[] } | null> {
		// Resolve handles → named narrators (skip unknown handles and self-mentions).
		const { narratorService } = await import("./narrator-service");
		const mentioned: { id: string; handle: string }[] = [];
		for (const handle of input.handles) {
			const named = await narratorService.getByHandle(handle);
			if (!named) continue;
			if (named.id === input.originNarratorId) continue;
			if (!parseTraits(named.traits).includes("named")) continue;
			if (named.status === "archived") continue;
			mentioned.push({ id: named.id, handle });
		}
		if (mentioned.length === 0) return null;

		// Build a human-readable title from the mentioned handles (for tab/list display).
		const title = buildGroupTitle(mentioned.map((m) => m.handle));

		const group = await this.findOrCreateGroupForOrigin({
			originNarratorId: input.originNarratorId,
			createdBy: input.createdBy,
			projectId: input.projectId,
			title,
		});

		for (const m of mentioned) {
			await this.addNamedMember(group.id, m.id);
		}

		await this.postMessage({
			groupId: group.id,
			content: input.content,
			senderType: input.fromUser ? "user" : "narrator",
			senderUserId: input.fromUser ? (input.createdBy ?? null) : null,
			senderNarratorId: input.fromUser ? null : input.originNarratorId,
			locale: input.locale,
			// Origin session already has the user's text; don't echo it back.
			skipNarratorIds: [input.originNarratorId],
		});

		// Group is fully set up — notify the initiating user so their UI can add a
		// recent tab + show a notification. Targeted delivery via broadcastToUser.
		eventBus.emit({
			type: "group:ready",
			groupId: group.id,
			title: group.title || title,
			createdBy: input.createdBy ?? group.createdBy ?? null,
			originNarratorId: input.originNarratorId,
		});

		return { groupId: group.id, mentioned };
	},

	/**
	 * Post a message to the group: persist it as the source of truth, broadcast
	 * over WS to all narrator members, and deliver it into each narrator member's
	 * session (except the sender).
	 */
	async postMessage(input: PostGroupMessageInput): Promise<ChatGroupMessageRow> {
		const content = input.content.trim();
		if (!content) throw new ValidationError("Group message content is required");
		const capped =
			content.length > MAX_GROUP_MESSAGE_CHARS
				? `${content.slice(0, MAX_GROUP_MESSAGE_CHARS)}…[truncated]`
				: content;

		const group = await this.getById(input.groupId);
		if (!group) throw new ValidationError("Chat group not found");
		if (group.status !== "active") throw new ValidationError("Chat group is archived");

		const now = new Date().toISOString();
		const id = generateId();
		const urgent = input.urgent ?? false;

		const [message] = await db
			.insert(chatGroupMessages)
			.values({
				id,
				groupId: input.groupId,
				senderType: input.senderType,
				senderUserId: input.senderUserId ?? null,
				senderNarratorId: input.senderNarratorId ?? null,
				content: capped,
				urgent,
				createdAt: now,
			})
			.returning();

		await db.update(chatGroups).set({ updatedAt: now }).where(eq(chatGroups.id, input.groupId));

		const senderLabel = await resolveSenderLabel(
			input.senderType,
			input.senderNarratorId,
			input.senderUserId,
		);

		eventBus.emit({
			type: "group:message",
			groupId: input.groupId,
			messageId: id,
			senderType: input.senderType,
			senderNarratorId: input.senderNarratorId ?? null,
			senderUserId: input.senderUserId ?? null,
		});

		// Fan out to narrator members + WS. Group membership is intentionally small.
		const members = await this.listNarratorMembers(input.groupId);
		const memberContext = await buildNarratorMemberContext(input.groupId);
		const skip = new Set(input.skipNarratorIds ?? []);
		const groupTitle = group.title || "untitled";
		for (const member of members) {
			const targetNarratorId = member.narratorId as string;
			// WS broadcast to every narrator member (so the group view updates live),
			// including the sender's own panel.
			eventBus.emit({
				type: "narrator:ws_broadcast",
				narratorId: targetNarratorId,
				message: {
					type: "group_message",
					narratorId: targetNarratorId,
					groupId: input.groupId,
					message: {
						id,
						groupId: input.groupId,
						senderType: input.senderType,
						senderNarratorId: input.senderNarratorId ?? null,
						senderUserId: input.senderUserId ?? null,
						senderLabel,
						content: capped,
						urgent,
						createdAt: now,
					},
				},
			});

			// Don't deliver the message back to its own narrator author, the origin
			// session that already received the text, or any explicitly skipped member.
			if (input.senderType === "narrator" && targetNarratorId === input.senderNarratorId) {
				continue;
			}
			if (skip.has(targetNarratorId)) continue;
			await this.deliverToNarrator(targetNarratorId, {
				groupId: input.groupId,
				groupTitle,
				groupMessageId: id,
				senderLabel,
				senderType: input.senderType,
				content: capped,
				members: memberContext,
				urgent,
				locale: input.locale,
			});
		}

		return message;
	},

	/**
	 * Deliver a single group message into a narrator member's own session.
	 * idle → wake (sendMessage); working/waiting → queue as sidecar (+ soft-stop if urgent).
	 */
	async deliverToNarrator(
		narratorId: string,
		msg: PendingGroupMessage & { urgent: boolean; locale?: Locale },
	): Promise<void> {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { id: true, status: true, traits: true },
		});
		if (!narrator) return;
		if (narrator.status === "archived") return;

		const pending: PendingGroupMessage = {
			groupId: msg.groupId,
			groupTitle: msg.groupTitle,
			groupMessageId: msg.groupMessageId,
			senderLabel: msg.senderLabel,
			senderType: msg.senderType,
			content: msg.content,
			members: msg.members,
			locale: msg.locale,
		};

		const isBusy = narrator.status === "working" || narrator.status === "waiting";
		const isPlan = parseTraits(narrator.traits).includes("plan");

		if (isBusy) {
			// Queue for the next sidecar boundary; optionally nudge with a soft-stop.
			pushGroupMessageForNarrator(narratorId, pending);
			if (msg.urgent) {
				try {
					const { requestBufferedMessageSoftStop } = await import("./narrator-session");
					requestBufferedMessageSoftStop(narratorId);
				} catch (err) {
					logger.warn("Failed to request soft-stop for group message", {
						narratorId,
						error: String(err),
					});
				}
			}
			return;
		}

		// idle: wake the narrator with the message injected as a user turn.
		// Plan-mode narrators are not auto-woken (mirrors goal continuation rules);
		// queue instead so the message surfaces on their next activity.
		if (isPlan) {
			pushGroupMessageForNarrator(narratorId, pending);
			return;
		}

		try {
			const { sendMessage } = await import("./narrator-session");
			await sendMessage(
				narratorId,
				formatGroupMessageForInjection(pending),
				undefined,
				msg.locale ?? "en",
				false,
				null,
				null,
			);
			markGroupMessagesConsumedForReply(narratorId, [pending]);
		} catch (err) {
			// If waking fails (race: narrator just went busy), fall back to the queue.
			logger.warn("Failed to wake narrator for group message; queueing instead", {
				narratorId,
				error: String(err),
			});
			pushGroupMessageForNarrator(narratorId, pending);
		}
	},

	/**
	 * Cursor-paginated message history (most recent first). Uses createdAt as the
	 * cursor with LIMIT n+1 to determine hasMore without a COUNT(*).
	 */
	async listMessages(
		groupId: string,
		opts: { limit?: number; cursor?: string } = {},
	): Promise<{ messages: ChatGroupMessageRow[]; nextCursor: string | null }> {
		const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
		const where = opts.cursor
			? and(eq(chatGroupMessages.groupId, groupId), lt(chatGroupMessages.createdAt, opts.cursor))
			: eq(chatGroupMessages.groupId, groupId);
		const rows = await db.query.chatGroupMessages.findMany({
			where,
			orderBy: [desc(chatGroupMessages.createdAt)],
			limit: limit + 1,
		});
		const hasMore = rows.length > limit;
		const page = hasMore ? rows.slice(0, limit) : rows;
		const nextCursor = hasMore ? page[page.length - 1].createdAt : null;
		return { messages: page, nextCursor };
	},

	/** List active groups a narrator participates in (for the narrator's panel). */
	async listGroupsForNarrator(narratorId: string): Promise<ChatGroupRow[]> {
		const memberships = await db.query.chatGroupMembers.findMany({
			where: eq(chatGroupMembers.narratorId, narratorId),
			columns: { groupId: true },
		});
		if (memberships.length === 0) return [];
		const groupIds = memberships.map((m) => m.groupId);
		const groups = await db.query.chatGroups.findMany({
			where: (g, { inArray: inArr }) => inArr(g.id, groupIds),
			orderBy: (g, { desc: d }) => [d(g.updatedAt)],
		});
		return groups.filter((g) => g.status === "active");
	},

	/**
	 * List active groups visible to a user: groups they created plus groups whose
	 * narrator members they can see. Since this is a small-team shared deployment,
	 * a user sees any active group they created or are a (user) member of.
	 * Returns lightweight summaries (no large fields) with member counts.
	 */
	async listGroupsForUser(
		userId: string,
		opts: { limit?: number } = {},
	): Promise<Array<ChatGroupRow & { memberCount: number }>> {
		const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
		// Groups the user created.
		const created = await db.query.chatGroups.findMany({
			where: and(eq(chatGroups.createdBy, userId), eq(chatGroups.status, "active")),
			orderBy: (g, { desc: d }) => [d(g.updatedAt)],
			limit,
		});
		// Groups where the user is an explicit member.
		const memberships = await db.query.chatGroupMembers.findMany({
			where: eq(chatGroupMembers.userId, userId),
			columns: { groupId: true },
		});
		const byId = new Map<string, ChatGroupRow>();
		for (const g of created) byId.set(g.id, g);
		if (memberships.length > 0) {
			const ids = memberships.map((m) => m.groupId);
			const memberGroups = await db.query.chatGroups.findMany({
				where: (g, { inArray: inArr, and: a, eq: e }) => a(inArr(g.id, ids), e(g.status, "active")),
				orderBy: (g, { desc: d }) => [d(g.updatedAt)],
				limit,
			});
			for (const g of memberGroups) byId.set(g.id, g);
		}
		const groups = [...byId.values()]
			.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
			.slice(0, limit);
		// Attach member counts (bounded set, small groups).
		const result: Array<ChatGroupRow & { memberCount: number }> = [];
		for (const g of groups) {
			const members = await db.query.chatGroupMembers.findMany({
				where: eq(chatGroupMembers.groupId, g.id),
				columns: { id: true },
			});
			result.push({ ...g, memberCount: members.length });
		}
		return result;
	},

	/**
	 * Find an active group that contains BOTH narrators as members. Used by the
	 * Send tool to route a message to a fellow group member (e.g. a named narrator
	 * replying to the origin session). Returns the most-recently-updated match.
	 */
	async findSharedGroup(narratorA: string, narratorB: string): Promise<ChatGroupRow | null> {
		const groupsA = await this.listGroupsForNarrator(narratorA);
		for (const group of groupsA) {
			const member = await db.query.chatGroupMembers.findFirst({
				where: and(
					eq(chatGroupMembers.groupId, group.id),
					eq(chatGroupMembers.narratorId, narratorB),
				),
				columns: { id: true },
			});
			if (member) return group;
		}
		return null;
	},

	/** Whether a narrator is a member of the given group. */
	async isMember(groupId: string, narratorId: string): Promise<boolean> {
		const member = await db.query.chatGroupMembers.findFirst({
			where: and(
				eq(chatGroupMembers.groupId, groupId),
				eq(chatGroupMembers.narratorId, narratorId),
			),
			columns: { id: true },
		});
		return !!member;
	},

	/**
	 * Whether `controllerNarratorId` is authorized to control `targetNarratorId`:
	 * they must share an active chat group in which the controller has canControl
	 * and the target is a narrator member. This backs proxy permission approval.
	 */
	async canControlNarrator(
		controllerNarratorId: string,
		targetNarratorId: string,
	): Promise<boolean> {
		if (controllerNarratorId === targetNarratorId) return false;
		const groups = await this.listGroupsForNarrator(controllerNarratorId);
		for (const group of groups) {
			const controllerMember = await db.query.chatGroupMembers.findFirst({
				where: and(
					eq(chatGroupMembers.groupId, group.id),
					eq(chatGroupMembers.narratorId, controllerNarratorId),
				),
				columns: { canControl: true },
			});
			if (!controllerMember?.canControl) continue;
			const targetMember = await db.query.chatGroupMembers.findFirst({
				where: and(
					eq(chatGroupMembers.groupId, group.id),
					eq(chatGroupMembers.narratorId, targetNarratorId),
				),
				columns: { id: true },
			});
			if (targetMember) return true;
		}
		return false;
	},
};

/**
 * Register chat-group event listeners (side-effect, called once at startup).
 *
 * When a narrator that belongs to a chat group raises a permission request, post
 * a system message into each shared group so controlling named narrators learn
 * they can proxy-approve it (via the GroupControl tool). Idempotent per process.
 */
let _listenersRegistered = false;
export function registerChatGroupEventListeners(): void {
	if (_listenersRegistered) return;
	_listenersRegistered = true;

	eventBus.on("narrator:permission_request", (event) => {
		void notifyGroupsOfPermissionRequest(event.narratorId, event.requestId).catch((err) => {
			logger.warn("Failed to notify chat groups of permission request", {
				narratorId: event.narratorId,
				error: String(err),
			});
		});
	});
}

async function notifyGroupsOfPermissionRequest(
	requestingNarratorId: string,
	requestId: string,
): Promise<void> {
	const groups = await chatGroupService.listGroupsForNarrator(requestingNarratorId);
	if (groups.length === 0) return;

	// Resolve the requester's display label + the pending tool name once.
	const requester = await db.query.narrators.findFirst({
		where: eq(narrators.id, requestingNarratorId),
		columns: { handle: true, title: true },
	});
	const requesterLabel = requester?.handle || requester?.title || requestingNarratorId.slice(0, 8);
	const pending = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, requestId),
		columns: { toolName: true },
	});
	const toolName = pending?.toolName ?? "a tool";

	for (const group of groups) {
		// Only notify groups that have at least one OTHER controlling narrator member.
		const members = await chatGroupService.listNarratorMembers(group.id);
		const hasController = members.some(
			(m) => m.canControl && m.narratorId && m.narratorId !== requestingNarratorId,
		);
		if (!hasController) continue;

		await chatGroupService.postMessage({
			groupId: group.id,
			content:
				`@${requesterLabel} is requesting permission to use ${toolName} ` +
				`(request_id=${requestId}). A controlling member may approve or deny it with the ` +
				`GroupControl tool.`,
			senderType: "system",
			// Don't deliver back to the requester; they already know they're paused.
			skipNarratorIds: [requestingNarratorId],
		});
	}
}
