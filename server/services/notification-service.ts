import { db } from "@server/db";
import { chapters, narrators, userPreferences, users } from "@server/db/schema";
import { ForbiddenError } from "@server/lib/errors";
import { eventBus } from "@server/lib/event-bus";
import { logger } from "@server/lib/logger";
import { isPlanModeTrait } from "@server/lib/narrator-utils";
import { resolveEffectiveRelaxedPlan } from "@server/lib/permission-modes";
import { and, eq, inArray, sql } from "drizzle-orm";
import { listNarratorAudience, type NarratorAclRow } from "./narrator-acl";
import {
	deliverNotification,
	type NotificationChannel,
	type NotificationDeliveryResult,
} from "./notification-delivery";
import { getRecentTabUserIdsForNarrator } from "./recent-tabs-service";

export type NotificationTarget = { user_id?: string; username?: string };
const CHANNELS: readonly NotificationChannel[] = ["dingtalk", "feishu"];

async function findNotificationUser(target: NotificationTarget, credentials: boolean) {
	if ((target.user_id !== undefined) === (target.username !== undefined)) {
		throw new Error("Specify exactly one of user_id or username");
	}
	if (!(target.user_id ?? target.username)?.trim()) throw new Error("User identifier is required");
	const [user] = await db
		.select({
			user_id: users.id,
			username: users.username,
			dingtalkEnabled: userPreferences.notifyDingtalkEnabled,
			dingtalkConfigured: sql<boolean>`coalesce(length(trim(${userPreferences.notifyDingtalkWebhook})), 0) > 0`,
			feishuEnabled: userPreferences.notifyFeishuEnabled,
			feishuConfigured: sql<boolean>`coalesce(length(trim(${userPreferences.notifyFeishuWebhook})), 0) > 0`,
			...(credentials
				? {
						dingtalkWebhook: userPreferences.notifyDingtalkWebhook,
						dingtalkSecret: userPreferences.notifyDingtalkSecret,
						feishuWebhook: userPreferences.notifyFeishuWebhook,
						feishuSecret: userPreferences.notifyFeishuSecret,
					}
				: {}),
		})
		.from(users)
		.leftJoin(userPreferences, eq(users.id, userPreferences.userId))
		.where(
			target.user_id !== undefined
				? eq(users.id, target.user_id)
				: eq(users.username, target.username as string),
		)
		.limit(1);
	if (!user) throw new Error("User not found");
	return user;
}

function channelStates(user: Awaited<ReturnType<typeof findNotificationUser>>) {
	return CHANNELS.map((channel) => {
		const configured = Boolean(
			channel === "dingtalk" ? user.dingtalkConfigured : user.feishuConfigured,
		);
		const enabled = Boolean(channel === "dingtalk" ? user.dingtalkEnabled : user.feishuEnabled);
		return { channel, configured, enabled, available: configured && enabled };
	});
}

/** Exact, single-user lookup. Credentials are not even selected for this operation. */
export async function listNotificationChannels(target: NotificationTarget) {
	const user = await findNotificationUser(target, false);
	return { user_id: user.user_id, username: user.username, channels: channelStates(user) };
}

export class NotificationSendForbiddenError extends ForbiddenError {
	constructor() {
		super(
			"Notification sending is prohibited in read-only or strict plan mode, or when the narrator no longer exists.",
		);
	}
}

async function assertNotificationSendAllowed(narratorId: string): Promise<void> {
	// Explicit retry approval can bypass permissionHandler. Re-read the live hard
	// ceiling here instead of trusting the authorization or mode of the first attempt.
	const [narrator] = await db
		.select({
			permissionMode: narrators.permissionMode,
			traits: narrators.traits,
			relaxedPlan: narrators.relaxedPlan,
		})
		.from(narrators)
		.where(eq(narrators.id, narratorId))
		.limit(1);
	if (
		!narrator ||
		narrator.permissionMode === "readOnly" ||
		(isPlanModeTrait(narrator.traits) &&
			!resolveEffectiveRelaxedPlan(narrator.permissionMode, narrator.relaxedPlan))
	) {
		throw new NotificationSendForbiddenError();
	}
}
/** Explicit sends deliberately do not consult notifyOnDone / notifyOnWaiting or recent tabs. */
export async function sendUserNotification(
	input: NotificationTarget & {
		title: string;
		message: string;
		channels?: NotificationChannel[];
	},
	context: { narratorId: string; signal?: AbortSignal },
) {
	if (
		!input.title?.trim() ||
		input.title.length > 120 ||
		!input.message?.trim() ||
		input.message.length > 4000
	) {
		throw new Error("title must contain 1-120 characters and message 1-4000 characters");
	}
	if (
		input.channels &&
		(input.channels.length < 1 ||
			input.channels.length > 2 ||
			input.channels.some((channel) => !CHANNELS.includes(channel)))
	) {
		throw new Error("channels must contain 1-2 dingtalk/feishu entries");
	}
	await assertNotificationSendAllowed(context.narratorId);
	const user = await findNotificationUser(input, true);
	const states = channelStates(user);
	const requested = input.channels
		? [...new Set(input.channels)]
		: states.filter((state) => state.available).map((state) => state.channel);
	const results = await Promise.all(
		requested.map(async (channel): Promise<NotificationDeliveryResult> => {
			const state = states.find((state) => state.channel === channel);
			if (!state?.available) {
				const result: NotificationDeliveryResult = {
					channel,
					status: "not_sent",
					reason: state?.configured ? "disabled" : "not_configured",
				};
				logger.info("Webhook notification delivery", {
					source: "narrator",
					narratorId: context.narratorId,
					userId: user.user_id,
					channel,
					durationMs: 0,
					status: result.status,
					reason: result.reason,
				});
				return result;
			}
			return deliverNotification({
				channel,
				webhook: (channel === "dingtalk" ? user.dingtalkWebhook : user.feishuWebhook) ?? "",
				secret: (channel === "dingtalk" ? user.dingtalkSecret : user.feishuSecret) ?? "",
				title: input.title,
				message: input.message,
				signal: context.signal,
				source: "narrator",
				narratorId: context.narratorId,
				userId: user.user_id,
			});
		}),
	);
	const successes = results.filter((result) => result.status === "success").length;
	return {
		user_id: user.user_id,
		username: user.username,
		status:
			successes === results.length && results.length > 0
				? "success"
				: successes > 0
					? "partial_failure"
					: results.some((result) => result.status === "failed")
						? "failed"
						: "not_sent",
		...(results.length === 0 ? { reason: "no_available_channels" } : {}),
		results,
	};
}

async function sendDingtalk(
	webhook: string,
	secret: string,
	title: string,
	message: string,
): Promise<void> {
	const result = await deliverNotification({
		channel: "dingtalk",
		webhook,
		secret,
		title,
		message,
		source: "test",
	});
	if (result.status !== "success") throw new Error(`Notification failed: ${result.reason}`);
}

async function sendFeishu(
	webhook: string,
	secret: string,
	title: string,
	message: string,
): Promise<void> {
	const result = await deliverNotification({
		channel: "feishu",
		webhook,
		secret,
		title,
		message,
		source: "test",
	});
	if (result.status !== "success") throw new Error(`Notification failed: ${result.reason}`);
}

// --- Test helpers ---

export async function sendTestDingtalk(webhook: string, secret: string): Promise<void> {
	await sendDingtalk(
		webhook,
		secret,
		"NarraFork: Test",
		"**Test Notification**\n\nDingTalk webhook is working.",
	);
}

export async function sendTestFeishu(webhook: string, secret: string): Promise<void> {
	await sendFeishu(
		webhook,
		secret,
		"NarraFork Notification",
		"**Test Notification**\n\nFeishu webhook is working.",
	);
}

// --- Core notification logic ---

type AttentionReason = "waiting_permission" | "done" | "error";

/**
 * Narrow a candidate recipient list to the users who may still read the narrator.
 *
 * Short-circuits on a broadly visible narrator so the common case costs nothing.
 * Otherwise the audience is resolved once (owner + grants) and intersected, rather
 * than running one authorization check per candidate.
 */
async function filterUsersWhoCanRead(
	narrator: NarratorAclRow,
	candidateUserIds: string[],
): Promise<string[]> {
	const audience = await listNarratorAudience(narrator);
	if (audience.everyone) return candidateUserIds;
	const allowed = new Set(audience.userIds);
	const admins = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.role, "admin"), inArray(users.id, candidateUserIds)));
	for (const admin of admins) allowed.add(admin.id);
	return candidateUserIds.filter((userId) => allowed.has(userId));
}

export async function handleAttention(narratorId: string, reason: AttentionReason): Promise<void> {
	// Server-side IM only alerts on done / waiting-for-permission. Errors are
	// surfaced elsewhere (in-app + gateway); keep behavior as before and skip.
	if (reason === "error") return;

	// Fetch narrator + optional chapter info
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
	});
	if (!narrator) return;

	const narratorTitle = narrator.title || narratorId;
	let chapterName: string | undefined;
	if (narrator.chapterId) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
		});
		chapterName = chapter?.title;
	}

	const chapterLine = chapterName ? `\n\n> Chapter: ${chapterName}` : "";
	const displayStatus = reason === "done" ? "done" : "waiting";
	const markdownText = `**${narratorTitle}** status: **${displayStatus}**${chapterLine}`;

	// Recipients are everyone with this narrator in a recent tab, minus anyone who
	// may no longer read it. Access can be revoked after a tab was opened, and a
	// webhook carrying the narrator's title and status would otherwise keep
	// delivering to them — a notification must never outlive the permission.
	const recentTabUserIds = await getRecentTabUserIdsForNarrator(narratorId);
	if (recentTabUserIds.length === 0) return;
	const relevantUserIds = await filterUsersWhoCanRead(narrator, recentTabUserIds);
	if (relevantUserIds.length === 0) return;

	const notificationPrefs: Array<{
		userId: string;
		notifyOnDone: boolean;
		notifyOnWaiting: boolean;
		notifyDingtalkEnabled: boolean;
		notifyDingtalkWebhook: string;
		notifyDingtalkSecret: string;
		notifyFeishuEnabled: boolean;
		notifyFeishuWebhook: string;
		notifyFeishuSecret: string;
	}> = [];
	for (let offset = 0; offset < relevantUserIds.length; offset += 500) {
		notificationPrefs.push(
			...(await db
				.select({
					userId: userPreferences.userId,
					notifyOnDone: userPreferences.notifyOnDone,
					notifyOnWaiting: userPreferences.notifyOnWaiting,
					notifyDingtalkEnabled: userPreferences.notifyDingtalkEnabled,
					notifyDingtalkWebhook: userPreferences.notifyDingtalkWebhook,
					notifyDingtalkSecret: userPreferences.notifyDingtalkSecret,
					notifyFeishuEnabled: userPreferences.notifyFeishuEnabled,
					notifyFeishuWebhook: userPreferences.notifyFeishuWebhook,
					notifyFeishuSecret: userPreferences.notifyFeishuSecret,
				})
				.from(userPreferences)
				.where(inArray(userPreferences.userId, relevantUserIds.slice(offset, offset + 500)))),
		);
	}

	for (const pref of notificationPrefs) {
		if (reason === "done" && !pref.notifyOnDone) continue;
		if (reason === "waiting_permission" && !pref.notifyOnWaiting) continue;

		const promises: Promise<NotificationDeliveryResult>[] = [];
		const context = { source: "automatic" as const, narratorId, userId: pref.userId };
		if (pref.notifyDingtalkEnabled && pref.notifyDingtalkWebhook) {
			promises.push(
				deliverNotification({
					...context,
					channel: "dingtalk",
					webhook: pref.notifyDingtalkWebhook,
					secret: pref.notifyDingtalkSecret,
					title: `NarraFork: ${narratorTitle}`,
					message: markdownText,
				}),
			);
		}
		if (pref.notifyFeishuEnabled && pref.notifyFeishuWebhook) {
			promises.push(
				deliverNotification({
					...context,
					channel: "feishu",
					webhook: pref.notifyFeishuWebhook,
					secret: pref.notifyFeishuSecret,
					title: "NarraFork Notification",
					message: markdownText,
				}),
			);
		}
		await Promise.all(promises);
	}
}

// --- Register event listener (side-effect on import) ---
//
// Listens to the semantic `narrator:attention` intent instead of re-deriving
// "should I notify?" from raw status/substatus. Reflection mid-states and
// takeover fallbacks never emit attention, so they can never leak an IM.

eventBus.on("narrator:attention", (event) => {
	handleAttention(event.narratorId, event.reason).catch((err) => {
		logger.error("Notification handler error", {
			narratorId: event.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	});
});
