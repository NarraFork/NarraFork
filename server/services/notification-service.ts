import { createHmac } from "node:crypto";
import { db } from "@server/db";
import { chapters, narrators, userPreferences } from "@server/db/schema";
import { eventBus } from "@server/lib/event-bus";
import { logger } from "@server/lib/logger";
import { eq } from "drizzle-orm";

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

// --- RecentTab type for JSON parsing ---

interface RecentTab {
	type?: string;
	id?: string;
	narratorId?: string;
}

// --- Core notification logic ---

async function handleStatusChanged(narratorId: string, status: string): Promise<void> {
	if (status !== "done" && status !== "waiting") return;

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
	const markdownText = `**${narratorTitle}** status: **${status}**${chapterLine}`;

	// Query all user preferences
	const allPrefs = await db.select().from(userPreferences);

	for (const pref of allPrefs) {
		// Parse recentTabs and check if this narrator is relevant to the user
		let tabs: RecentTab[] = [];
		try {
			tabs = JSON.parse(pref.recentTabs as string) as RecentTab[];
		} catch {
			continue;
		}

		const isRelevant = tabs.some(
			(t) => (t.type === "session" && t.id === narratorId) || t.narratorId === narratorId,
		);
		if (!isRelevant) continue;

		// Check per-status preference
		if (status === "done" && !pref.notifyOnDone) continue;
		if (status === "waiting" && !pref.notifyOnWaiting) continue;

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

eventBus.on("narrator:status_changed", (event) => {
	handleStatusChanged(event.narratorId, event.status).catch((err) => {
		logger.error("Notification handler error", {
			narratorId: event.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	});
});
