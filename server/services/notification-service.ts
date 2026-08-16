import { createHmac } from "node:crypto";
import { db } from "@server/db";
import { chapters, narrators, userPreferences, users } from "@server/db/schema";
import { eventBus } from "@server/lib/event-bus";
import { logger } from "@server/lib/logger";
import { and, eq, inArray } from "drizzle-orm";
import { listNarratorAudience } from "./narrator-acl";
import { getRecentTabUserIdsForNarrator } from "./recent-tabs-service";

// --- DingTalk helpers ---

function buildDingtalkUrl(webhook: string, secret: string): string {
	if (!secret) return webhook;
	const timestamp = Date.now().toString();
	const stringToSign = `${timestamp}\n${secret}`;
	const sign = createHmac("sha256", secret).update(stringToSign).digest("base64");
	return `${webhook}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

async function sendDingtalk(
	webhook: string,
	secret: string,
	title: string,
	text: string,
): Promise<void> {
	const url = buildDingtalkUrl(webhook, secret);
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			msgtype: "markdown",
			markdown: { title, text },
		}),
	});
	if (!res.ok) {
		throw new Error(`DingTalk webhook failed: ${res.status} ${await res.text()}`);
	}
}

// --- Feishu helpers ---

function buildFeishuSign(timestamp: string, secret: string): string {
	const stringToSign = `${timestamp}\n${secret}`;
	return createHmac("sha256", stringToSign).update("").digest("base64");
}

async function sendFeishu(
	webhook: string,
	secret: string,
	title: string,
	content: string,
): Promise<void> {
	const timestamp = Math.floor(Date.now() / 1000).toString();
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON body
	const body: any = {
		msg_type: "interactive",
		card: {
			header: {
				title: { tag: "plain_text", content: title },
			},
			elements: [{ tag: "markdown", content }],
		},
	};
	if (secret) {
		body.timestamp = timestamp;
		body.sign = buildFeishuSign(timestamp, secret);
	}
	const res = await fetch(webhook, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`Feishu webhook failed: ${res.status} ${await res.text()}`);
	}
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
	narrator: {
		id: string;
		ownerUserId: string | null;
		visibility: string;
		chapterId: string | null;
	},
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

		const promises: Promise<void>[] = [];

		if (pref.notifyDingtalkEnabled && pref.notifyDingtalkWebhook) {
			promises.push(
				sendDingtalk(
					pref.notifyDingtalkWebhook,
					pref.notifyDingtalkSecret,
					`NarraFork: ${narratorTitle}`,
					markdownText,
				),
			);
		}

		if (pref.notifyFeishuEnabled && pref.notifyFeishuWebhook) {
			promises.push(
				sendFeishu(
					pref.notifyFeishuWebhook,
					pref.notifyFeishuSecret,
					"NarraFork Notification",
					markdownText,
				),
			);
		}

		if (promises.length > 0) {
			const results = await Promise.allSettled(promises);
			for (const r of results) {
				if (r.status === "rejected") {
					logger.error("Webhook notification failed", {
						narratorId,
						userId: pref.userId,
						error: r.reason instanceof Error ? r.reason.message : String(r.reason),
					});
				}
			}
		}
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
