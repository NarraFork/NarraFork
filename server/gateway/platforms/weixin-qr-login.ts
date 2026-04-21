/**
 * WeChat iLink QR code login flow.
 *
 * 1. GET get_bot_qrcode → QR URL + hex token
 * 2. Poll get_qrcode_status until confirmed / expired / timeout
 * 3. On confirmed → persist credentials to ~/.narrafork/weixin/accounts/
 *
 * Designed to be driven by an API route that the frontend polls.
 */

import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../../lib/logger";
import { ilinkGet } from "./weixin";

// ---------------------------------------------------------------------------
// Constants (must match weixin.ts)
// ---------------------------------------------------------------------------

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const QR_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESHES = 3;

const EP_GET_BOT_QR = "ilink/bot/get_bot_qrcode";
const EP_GET_QR_STATUS = "ilink/bot/get_qrcode_status";

const NARRAFORK_HOME = process.env.NARRAFORK_HOME ?? join(homedir(), ".narrafork");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QrLoginSession {
	/** Hex token used to poll status */
	qrcodeToken: string;
	/** Full URL for the user to scan (liteapp URL) */
	qrcodeUrl: string;
	/** Current base URL (may change on redirect) */
	baseUrl: string;
	/** Number of QR refreshes so far */
	refreshCount: number;
	/** Timestamp when the session was created */
	createdAt: number;
}

export type QrPollStatus =
	| { status: "wait" }
	| { status: "scaned" }
	| { status: "expired"; canRefresh: boolean }
	| {
			status: "confirmed";
			accountId: string;
			token: string;
			baseUrl: string;
			userId: string;
	  }
	| { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function accountDir(): string {
	const dir = join(NARRAFORK_HOME, "weixin", "accounts");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

function saveCredentials(creds: {
	accountId: string;
	token: string;
	baseUrl: string;
	userId: string;
}): void {
	const path = join(accountDir(), `${creds.accountId}.json`);
	const payload = {
		token: creds.token,
		base_url: creds.baseUrl,
		user_id: creds.userId,
		saved_at: new Date().toISOString(),
	};
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
	renameSync(tmp, path);
	try {
		chmodSync(path, 0o600);
	} catch {
		// non-fatal on Windows
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a new QR login session.
 * Returns the session object with the QR URL for the user to scan.
 */
export async function startQrLogin(): Promise<QrLoginSession> {
	const resp = await ilinkGet(ILINK_BASE_URL, `${EP_GET_BOT_QR}?bot_type=3`, QR_TIMEOUT_MS);

	const qrcodeToken = String(resp.qrcode ?? "").trim();
	const qrcodeUrl = String(resp.qrcode_img_content ?? "").trim();

	if (!qrcodeToken) {
		throw new Error("QR response missing qrcode token");
	}

	return {
		qrcodeToken,
		qrcodeUrl: qrcodeUrl || qrcodeToken,
		baseUrl: ILINK_BASE_URL,
		refreshCount: 0,
		createdAt: Date.now(),
	};
}

/**
 * Poll the QR login status once.
 * The caller should call this repeatedly (e.g. every 1-2 seconds).
 *
 * Mutates `session` in place when redirect or refresh occurs.
 */
export async function pollQrStatus(session: QrLoginSession): Promise<QrPollStatus> {
	try {
		const resp = await ilinkGet(
			session.baseUrl,
			`${EP_GET_QR_STATUS}?qrcode=${session.qrcodeToken}`,
			QR_TIMEOUT_MS,
		);

		const status = String(resp.status ?? "wait");

		switch (status) {
			case "wait":
				return { status: "wait" };

			case "scaned":
				return { status: "scaned" };

			case "scaned_but_redirect": {
				const redirectHost = String(resp.redirect_host ?? "").trim();
				if (redirectHost) {
					session.baseUrl = `https://${redirectHost}`;
				}
				return { status: "scaned" };
			}

			case "expired": {
				if (session.refreshCount >= MAX_QR_REFRESHES) {
					return { status: "expired", canRefresh: false };
				}
				// Auto-refresh the QR code
				try {
					const refreshResp = await ilinkGet(
						ILINK_BASE_URL,
						`${EP_GET_BOT_QR}?bot_type=3`,
						QR_TIMEOUT_MS,
					);
					const newToken = String(refreshResp.qrcode ?? "").trim();
					const newUrl = String(refreshResp.qrcode_img_content ?? "").trim();
					if (newToken) {
						session.qrcodeToken = newToken;
						session.qrcodeUrl = newUrl || newToken;
						session.refreshCount++;
						session.baseUrl = ILINK_BASE_URL;
					}
				} catch (err) {
					logger.error("[weixin-qr] QR refresh failed", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
				return { status: "expired", canRefresh: session.refreshCount < MAX_QR_REFRESHES };
			}

			case "confirmed": {
				const accountId = String(resp.ilink_bot_id ?? "").trim();
				const token = String(resp.bot_token ?? "").trim();
				const baseUrl = String(resp.baseurl ?? ILINK_BASE_URL).trim();
				const userId = String(resp.ilink_user_id ?? "").trim();

				if (!accountId || !token) {
					return { status: "error", message: "QR confirmed but credentials incomplete" };
				}

				// Persist credentials
				saveCredentials({ accountId, token, baseUrl, userId });
				logger.info(`[weixin-qr] Login successful, accountId=${accountId.slice(0, 8)}…`);

				return { status: "confirmed", accountId, token, baseUrl, userId };
			}

			default:
				return { status: "wait" };
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// Timeouts are normal during long-poll, treat as "wait"
		if (msg.includes("abort")) return { status: "wait" };
		return { status: "error", message: msg };
	}
}
