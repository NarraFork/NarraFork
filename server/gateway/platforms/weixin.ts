/**
 * WeChat (Weixin) platform adapter via Tencent iLink Bot API.
 *
 * Protocol: HTTP long-poll for inbound, REST POST for outbound.
 * Media: AES-128-ECB encrypted CDN upload/download.
 * WeChat does not support message editing — supportsEdit = false.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../../lib/logger";
import { resolveProxyForUrl } from "../../lib/net/proxy";
import type { ProxyOverride } from "../../lib/settings/types";
import { BaseAdapter } from "../base-adapter";
import type { GatewayPlatform, InboundMessage, WeixinConfig } from "../types";

// ---------------------------------------------------------------------------
// iLink protocol constants
// ---------------------------------------------------------------------------

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const ILINK_APP_ID = "bot";
const CHANNEL_VERSION = "2.2.0";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0); // "131584"

const EP_GET_UPDATES = "ilink/bot/getupdates";
const EP_SEND_MESSAGE = "ilink/bot/sendmessage";
const EP_SEND_TYPING = "ilink/bot/sendtyping";
const EP_GET_CONFIG = "ilink/bot/getconfig";
const EP_GET_UPLOAD_URL = "ilink/bot/getuploadurl";

const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_FILE = 4;

const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const MEDIA_IMAGE = 1;
const MEDIA_FILE = 3;

const TYPING_START = 1;
const SESSION_EXPIRED_ERRCODE = -14;

const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;
const MESSAGE_DEDUP_TTL_MS = 300_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;

const CDN_ALLOWLIST = new Set([
	"novac2c.cdn.weixin.qq.com",
	"ilinkai.weixin.qq.com",
	"wx.qlogo.cn",
	"thirdwx.qlogo.cn",
	"res.wx.qq.com",
	"mmbiz.qpic.cn",
	"mmbiz.qlogo.cn",
]);

// ---------------------------------------------------------------------------
// Paths & persistence helpers
// ---------------------------------------------------------------------------

const NARRAFORK_HOME = process.env.NARRAFORK_HOME ?? join(homedir(), ".narrafork");

function weixinAccountDir(): string {
	const dir = join(NARRAFORK_HOME, "weixin", "accounts");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

function atomicJsonWrite(path: string, data: unknown): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
	renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// AES-128-ECB helpers (for media encrypt/decrypt)
// ---------------------------------------------------------------------------

function pkcs7Pad(data: Buffer): Buffer {
	const padLen = 16 - (data.length % 16);
	return Buffer.concat([data, Buffer.alloc(padLen, padLen)]);
}

function pkcs7Unpad(data: Buffer): Buffer {
	if (data.length === 0) return data;
	const padLen = data[data.length - 1];
	if (padLen < 1 || padLen > 16) return data;
	for (let i = data.length - padLen; i < data.length; i++) {
		if (data[i] !== padLen) return data;
	}
	return data.subarray(0, data.length - padLen);
}

function aes128EcbEncrypt(plaintext: Buffer, key: Buffer): Buffer {
	const cipher = createCipheriv("aes-128-ecb", key, null);
	cipher.setAutoPadding(false);
	return Buffer.concat([cipher.update(pkcs7Pad(plaintext)), cipher.final()]);
}

function aes128EcbDecrypt(ciphertext: Buffer, key: Buffer): Buffer {
	const decipher = createDecipheriv("aes-128-ecb", key, null);
	decipher.setAutoPadding(false);
	const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	return pkcs7Unpad(padded);
}

/** Parse iLink aes_key (base64-encoded, may contain hex string or raw bytes). */
function parseAesKey(aesKeyB64: string): Buffer {
	const decoded = Buffer.from(aesKeyB64, "base64");
	if (decoded.length === 16) return decoded;
	if (decoded.length === 32) {
		const hex = decoded.toString("ascii");
		if (/^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, "hex");
	}
	throw new Error(`Unexpected aes_key format (${decoded.length} decoded bytes)`);
}

function aesPaddedSize(rawSize: number): number {
	return Math.ceil((rawSize + 1) / 16) * 16;
}

// ---------------------------------------------------------------------------
// X-WECHAT-UIN generation
// ---------------------------------------------------------------------------

function randomWechatUin(): string {
	const buf = randomBytes(4);
	const uint32 = buf.readUInt32BE(0);
	return Buffer.from(String(uint32), "utf-8").toString("base64");
}

// ---------------------------------------------------------------------------
// iLink HTTP transport
// ---------------------------------------------------------------------------

function ilinkHeaders(token: string | null, bodyStr: string): Record<string, string> {
	const h: Record<string, string> = {
		"Content-Type": "application/json",
		AuthorizationType: "ilink_bot_token",
		"Content-Length": String(Buffer.byteLength(bodyStr, "utf-8")),
		"X-WECHAT-UIN": randomWechatUin(),
		"iLink-App-Id": ILINK_APP_ID,
		"iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
	};
	if (token) h.Authorization = `Bearer ${token}`;
	return h;
}

function baseInfo() {
	return { channel_version: CHANNEL_VERSION };
}

async function ilinkPost(
	baseUrl: string,
	endpoint: string,
	payload: Record<string, unknown>,
	token: string | null,
	timeoutMs: number,
	proxyOverride?: ProxyOverride,
): Promise<Record<string, unknown>> {
	const body = JSON.stringify({ ...payload, base_info: baseInfo() });
	const url = `${baseUrl.replace(/\/+$/, "")}/${endpoint}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const proxy = resolveProxyForUrl(url, proxyOverride);
	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: ilinkHeaders(token, body),
			body,
			signal: controller.signal,
			...(proxy ? { proxy } : {}),
		});
		const text = await resp.text();
		if (!resp.ok)
			throw new Error(`iLink POST ${endpoint} HTTP ${resp.status}: ${text.slice(0, 200)}`);
		return JSON.parse(text);
	} finally {
		clearTimeout(timer);
	}
}

/** Exported for use by QR login and future extensions. */
export async function ilinkGet(
	baseUrl: string,
	endpoint: string,
	timeoutMs: number,
	proxyOverride?: ProxyOverride,
): Promise<Record<string, unknown>> {
	const url = `${baseUrl.replace(/\/+$/, "")}/${endpoint}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const proxy = resolveProxyForUrl(url, proxyOverride);
	try {
		const resp = await fetch(url, {
			method: "GET",
			headers: {
				"iLink-App-Id": ILINK_APP_ID,
				"iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
			},
			signal: controller.signal,
			...(proxy ? { proxy } : {}),
		});
		const text = await resp.text();
		if (!resp.ok)
			throw new Error(`iLink GET ${endpoint} HTTP ${resp.status}: ${text.slice(0, 200)}`);
		return JSON.parse(text);
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// iLink API wrappers
// ---------------------------------------------------------------------------

async function getUpdates(
	baseUrl: string,
	token: string,
	syncBuf: string,
	timeoutMs: number,
	proxyOverride?: ProxyOverride,
): Promise<Record<string, unknown>> {
	try {
		return await ilinkPost(
			baseUrl,
			EP_GET_UPDATES,
			{ get_updates_buf: syncBuf },
			token,
			timeoutMs,
			proxyOverride,
		);
	} catch {
		// Timeout → return empty result with original sync_buf
		return { ret: 0, msgs: [], get_updates_buf: syncBuf };
	}
}

async function sendTextMessage(
	baseUrl: string,
	token: string,
	to: string,
	text: string,
	contextToken: string | null,
	clientId: string,
	proxyOverride?: ProxyOverride,
): Promise<Record<string, unknown>> {
	const msg: Record<string, unknown> = {
		from_user_id: "",
		to_user_id: to,
		client_id: clientId,
		message_type: MSG_TYPE_BOT,
		message_state: MSG_STATE_FINISH,
		item_list: [{ type: ITEM_TEXT, text_item: { text } }],
	};
	if (contextToken) msg.context_token = contextToken;
	return ilinkPost(baseUrl, EP_SEND_MESSAGE, { msg }, token, API_TIMEOUT_MS, proxyOverride);
}

async function sendMediaMessage(
	baseUrl: string,
	token: string,
	to: string,
	itemList: unknown[],
	contextToken: string | null,
	clientId: string,
	proxyOverride?: ProxyOverride,
): Promise<Record<string, unknown>> {
	const msg: Record<string, unknown> = {
		from_user_id: "",
		to_user_id: to,
		client_id: clientId,
		message_type: MSG_TYPE_BOT,
		message_state: MSG_STATE_FINISH,
		item_list: itemList,
	};
	if (contextToken) msg.context_token = contextToken;
	return ilinkPost(baseUrl, EP_SEND_MESSAGE, { msg }, token, API_TIMEOUT_MS, proxyOverride);
}

async function sendTypingRequest(
	baseUrl: string,
	token: string,
	toUserId: string,
	typingTicket: string,
	status: number,
	proxyOverride?: ProxyOverride,
): Promise<void> {
	await ilinkPost(
		baseUrl,
		EP_SEND_TYPING,
		{ ilink_user_id: toUserId, typing_ticket: typingTicket, status },
		token,
		CONFIG_TIMEOUT_MS,
		proxyOverride,
	);
}

async function getConfig(
	baseUrl: string,
	token: string,
	userId: string,
	contextToken: string | null,
	proxyOverride?: ProxyOverride,
): Promise<Record<string, unknown>> {
	const payload: Record<string, unknown> = { ilink_user_id: userId };
	if (contextToken) payload.context_token = contextToken;
	return ilinkPost(baseUrl, EP_GET_CONFIG, payload, token, CONFIG_TIMEOUT_MS, proxyOverride);
}

async function getUploadUrl(
	baseUrl: string,
	token: string,
	toUserId: string,
	mediaType: number,
	filekey: string,
	rawsize: number,
	rawfilemd5: string,
	filesize: number,
	aeskeyHex: string,
	proxyOverride?: ProxyOverride,
): Promise<Record<string, unknown>> {
	return ilinkPost(
		baseUrl,
		EP_GET_UPLOAD_URL,
		{
			filekey,
			media_type: mediaType,
			to_user_id: toUserId,
			rawsize,
			rawfilemd5,
			filesize,
			no_need_thumb: true,
			aeskey: aeskeyHex,
		},
		token,
		API_TIMEOUT_MS,
		proxyOverride,
	);
}

function cdnDownloadUrl(cdnBase: string, encryptedQueryParam: string): string {
	return `${cdnBase.replace(/\/+$/, "")}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function cdnUploadUrl(cdnBase: string, uploadParam: string, filekey: string): string {
	return `${cdnBase.replace(/\/+$/, "")}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

function assertWeixinCdnUrl(url: string): void {
	let host: string;
	try {
		host = new URL(url).hostname;
	} catch {
		throw new Error(`Unparseable media URL: ${url}`);
	}
	if (!CDN_ALLOWLIST.has(host)) {
		throw new Error(`Media URL host '${host}' not in WeChat CDN allowlist (SSRF protection)`);
	}
}

async function uploadCiphertext(
	ciphertext: Buffer,
	uploadUrl: string,
	proxyOverride?: ProxyOverride,
): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 120_000);
	const proxy = resolveProxyForUrl(uploadUrl, proxyOverride);
	try {
		const resp = await fetch(uploadUrl, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: new Uint8Array(ciphertext),
			signal: controller.signal,
			...(proxy ? { proxy } : {}),
		});
		if (resp.status === 200) {
			const encryptedParam = resp.headers.get("x-encrypted-param");
			if (encryptedParam) {
				await resp.arrayBuffer(); // drain body
				return encryptedParam;
			}
			const text = await resp.text();
			throw new Error(`CDN upload missing x-encrypted-param header: ${text.slice(0, 200)}`);
		}
		const text = await resp.text();
		throw new Error(`CDN upload HTTP ${resp.status}: ${text.slice(0, 200)}`);
	} finally {
		clearTimeout(timer);
	}
}

async function downloadAndDecryptMedia(
	cdnBase: string,
	encryptedQueryParam: string | null,
	aesKeyB64: string | null,
	fullUrl: string | null,
	timeoutSeconds: number,
	proxyOverride?: ProxyOverride,
): Promise<Buffer> {
	let url: string;
	if (encryptedQueryParam) {
		url = cdnDownloadUrl(cdnBase, encryptedQueryParam);
	} else if (fullUrl) {
		assertWeixinCdnUrl(fullUrl);
		url = fullUrl;
	} else {
		throw new Error("Media item had neither encrypt_query_param nor full_url");
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
	const proxy = resolveProxyForUrl(url, proxyOverride);
	try {
		const resp = await fetch(url, {
			signal: controller.signal,
			...(proxy ? { proxy } : {}),
		});
		if (!resp.ok) throw new Error(`CDN download HTTP ${resp.status}`);
		const raw = Buffer.from(await resp.arrayBuffer());
		if (aesKeyB64) {
			return aes128EcbDecrypt(raw, parseAesKey(aesKeyB64));
		}
		return raw;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Context token store (memory + disk)
// ---------------------------------------------------------------------------

class ContextTokenStore {
	private cache = new Map<string, string>();
	private dir: string;

	constructor() {
		this.dir = weixinAccountDir();
	}

	private path(accountId: string): string {
		return join(this.dir, `${accountId}.context-tokens.json`);
	}

	private key(accountId: string, userId: string): string {
		return `${accountId}:${userId}`;
	}

	restore(accountId: string): void {
		const p = this.path(accountId);
		if (!existsSync(p)) return;
		try {
			const data = JSON.parse(readFileSync(p, "utf-8"));
			let count = 0;
			for (const [userId, token] of Object.entries(data)) {
				if (typeof token === "string" && token) {
					this.cache.set(this.key(accountId, userId), token);
					count++;
				}
			}
			if (count) logger.info(`[weixin] Restored ${count} context token(s)`);
		} catch {
			// ignore corrupt file
		}
	}

	get(accountId: string, userId: string): string | null {
		return this.cache.get(this.key(accountId, userId)) ?? null;
	}

	set(accountId: string, userId: string, token: string): void {
		this.cache.set(this.key(accountId, userId), token);
		this.persist(accountId);
	}

	delete(accountId: string, userId: string): void {
		this.cache.delete(this.key(accountId, userId));
		this.persist(accountId);
	}

	private persist(accountId: string): void {
		const prefix = `${accountId}:`;
		const payload: Record<string, string> = {};
		for (const [k, v] of this.cache) {
			if (k.startsWith(prefix)) payload[k.slice(prefix.length)] = v;
		}
		try {
			atomicJsonWrite(this.path(accountId), payload);
		} catch (err) {
			logger.warn("[weixin] Failed to persist context tokens", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Typing ticket cache (TTL-based)
// ---------------------------------------------------------------------------

class TypingTicketCache {
	private cache = new Map<string, { ticket: string; ts: number }>();
	private ttlMs: number;

	constructor(ttlSeconds = 600) {
		this.ttlMs = ttlSeconds * 1000;
	}

	get(userId: string): string | null {
		const entry = this.cache.get(userId);
		if (!entry) return null;
		if (Date.now() - entry.ts >= this.ttlMs) {
			this.cache.delete(userId);
			return null;
		}
		return entry.ticket;
	}

	set(userId: string, ticket: string): void {
		this.cache.set(userId, { ticket, ts: Date.now() });
	}
}

// ---------------------------------------------------------------------------
// sync_buf persistence
// ---------------------------------------------------------------------------

function syncBufPath(accountId: string): string {
	return join(weixinAccountDir(), `${accountId}.sync.json`);
}

function loadSyncBuf(accountId: string): string {
	const p = syncBufPath(accountId);
	if (!existsSync(p)) return "";
	try {
		return JSON.parse(readFileSync(p, "utf-8")).get_updates_buf ?? "";
	} catch {
		return "";
	}
}

function saveSyncBuf(accountId: string, syncBuf: string): void {
	try {
		atomicJsonWrite(syncBufPath(accountId), { get_updates_buf: syncBuf });
	} catch {
		// non-fatal
	}
}

// ---------------------------------------------------------------------------
// Message deduplicator
// ---------------------------------------------------------------------------

class MessageDeduplicator {
	private seen = new Map<string, number>();

	isDuplicate(messageId: string): boolean {
		const now = Date.now();
		// Prune expired
		if (this.seen.size > 2000) {
			for (const [k, ts] of this.seen) {
				if (now - ts > MESSAGE_DEDUP_TTL_MS) this.seen.delete(k);
			}
		}
		if (this.seen.has(messageId)) return true;
		this.seen.set(messageId, now);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Markdown normalization for WeChat
// ---------------------------------------------------------------------------

const HEADER_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^```([^\n`]*)\s*$/;

function normalizeMarkdownForWeixin(content: string): string {
	const lines = content.split("\n");
	const result: string[] = [];
	let inCodeBlock = false;
	let blankRun = 0;

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (FENCE_RE.test(line.trim())) {
			inCodeBlock = !inCodeBlock;
			result.push(line);
			blankRun = 0;
			continue;
		}
		if (inCodeBlock) {
			result.push(line);
			continue;
		}
		if (!line.trim()) {
			blankRun++;
			if (blankRun <= 1) result.push("");
			continue;
		}
		blankRun = 0;
		// Rewrite headers: # Title → 【Title】, ## Title → **Title**
		const hm = HEADER_RE.exec(line);
		if (hm) {
			const level = hm[1].length;
			const title = hm[2].trim();
			result.push(level === 1 ? `【${title}】` : `**${title}**`);
			continue;
		}
		result.push(line);
	}
	return result.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Outbound media upload helper
// ---------------------------------------------------------------------------

interface UploadedMedia {
	encryptQueryParam: string;
	aesKeyForApi: string;
	ciphertextSize: number;
	plaintextSize: number;
	rawfileMd5: string;
}

async function uploadMediaFile(
	baseUrl: string,
	cdnBase: string,
	token: string,
	toUserId: string,
	fileData: Buffer,
	mediaType: number,
	proxyOverride?: ProxyOverride,
): Promise<UploadedMedia> {
	const aesKey = randomBytes(16);
	const rawsize = fileData.length;
	const rawfilemd5 = createHash("md5").update(fileData).digest("hex");
	const filesize = aesPaddedSize(rawsize);
	const filekey = randomBytes(16).toString("hex");

	const uploadResp = await getUploadUrl(
		baseUrl,
		token,
		toUserId,
		mediaType,
		filekey,
		rawsize,
		rawfilemd5,
		filesize,
		aesKey.toString("hex"),
		proxyOverride,
	);

	const ciphertext = aes128EcbEncrypt(fileData, aesKey);

	// Prefer upload_full_url, fall back to constructed CDN URL
	const uploadFullUrl = String(uploadResp.upload_full_url ?? "").trim();
	const uploadParam = String(uploadResp.upload_param ?? "").trim();
	let targetUrl: string;
	if (uploadFullUrl) {
		targetUrl = uploadFullUrl;
	} else if (uploadParam) {
		targetUrl = cdnUploadUrl(cdnBase, uploadParam, filekey);
	} else {
		throw new Error("getUploadUrl returned neither upload_param nor upload_full_url");
	}

	const encryptQueryParam = await uploadCiphertext(ciphertext, targetUrl, proxyOverride);

	// iLink expects aes_key as base64(hex_string), NOT base64(raw_bytes)
	const aesKeyForApi = Buffer.from(aesKey.toString("hex"), "ascii").toString("base64");

	return {
		encryptQueryParam,
		aesKeyForApi,
		ciphertextSize: ciphertext.length,
		plaintextSize: rawsize,
		rawfileMd5: rawfilemd5,
	};
}

function buildImageItem(media: UploadedMedia) {
	return {
		type: ITEM_IMAGE,
		image_item: {
			media: {
				encrypt_query_param: media.encryptQueryParam,
				aes_key: media.aesKeyForApi,
				encrypt_type: 1,
			},
			mid_size: media.ciphertextSize,
		},
	};
}

function buildFileItem(media: UploadedMedia, filename: string) {
	return {
		type: ITEM_FILE,
		file_item: {
			media: {
				encrypt_query_param: media.encryptQueryParam,
				aes_key: media.aesKeyForApi,
				encrypt_type: 1,
			},
			file_name: filename,
			len: String(media.plaintextSize),
		},
	};
}

// ---------------------------------------------------------------------------
// Inbound message parsing helpers
// ---------------------------------------------------------------------------

/** Strip internal gateway markers (e.g. [perm:xxx]) from text. */
function stripGatewayTags(text: string): string {
	return text.replace(/\[perm:[a-zA-Z0-9_-]+\]/g, "").trim();
}

function extractText(itemList: unknown[]): string {
	const parts: string[] = [];
	for (const item of itemList) {
		if (!item || typeof item !== "object") continue;
		const it = item as Record<string, unknown>;
		if (it.type === ITEM_TEXT) {
			const textItem = it.text_item as Record<string, unknown> | undefined;
			const text = String(textItem?.text ?? "").trim();

			// Handle quoted/referenced message
			const refMsg = it.ref_msg as Record<string, unknown> | undefined;
			if (refMsg) {
				const refItem = refMsg.message_item as Record<string, unknown> | undefined;
				const refType = refItem?.type as number | undefined;
				const title = String(refMsg.title ?? "").trim();

				if (refType === ITEM_IMAGE || refType === ITEM_FILE || refType === 3 || refType === 5) {
					// Referenced media — add a hint prefix
					const prefix = title ? `[引用媒体: ${title}]` : "[引用媒体]";
					if (text) parts.push(`${prefix}\n${text}`);
					else parts.push(prefix);
				} else if (refItem) {
					// Referenced text — recursively extract
					const refText = stripGatewayTags(extractText([refItem]));
					const quoteParts: string[] = [];
					if (title) quoteParts.push(stripGatewayTags(title));
					if (refText) quoteParts.push(refText);
					if (quoteParts.length > 0) {
						parts.push(`[引用: ${quoteParts.join(" | ")}]\n${text}`);
					} else if (text) {
						parts.push(text);
					}
				} else if (text) {
					parts.push(text);
				}
			} else if (text) {
				parts.push(text);
			}
		}
		// Voice items may have transcribed text
		if (it.type === 3) {
			const voiceItem = it.voice_item as Record<string, unknown> | undefined;
			const text = String(voiceItem?.text ?? "").trim();
			if (text) parts.push(text);
		}
	}
	return parts.join("\n").trim();
}

function mediaReference(item: Record<string, unknown>, key: string): Record<string, unknown> {
	const sub = item[key] as Record<string, unknown> | undefined;
	return (sub?.media as Record<string, unknown>) ?? {};
}

async function downloadInboundImage(
	cdnBase: string,
	item: Record<string, unknown>,
	proxyOverride?: ProxyOverride,
): Promise<{ data: Buffer; filename: string } | null> {
	const imageItem = item.image_item as Record<string, unknown> | undefined;
	if (!imageItem) return null;
	const media = mediaReference(item, "image_item");

	// aeskey in image_item is hex string; convert to base64 for the decrypt helper
	let aesKeyB64 = String(media.aes_key ?? "").trim() || null;
	const hexKey = String(imageItem.aeskey ?? "").trim();
	if (!aesKeyB64 && hexKey) {
		aesKeyB64 = Buffer.from(hexKey, "hex").toString("base64");
	}

	try {
		const data = await downloadAndDecryptMedia(
			cdnBase,
			String(media.encrypt_query_param ?? "") || null,
			aesKeyB64,
			String(media.full_url ?? "") || null,
			30,
			proxyOverride,
		);
		return { data, filename: `image_${Date.now()}.jpg` };
	} catch (err) {
		logger.warn("[weixin] Image download failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/** Download and decrypt an inbound file attachment. */
async function downloadInboundFile(
	cdnBase: string,
	item: Record<string, unknown>,
	proxyOverride?: ProxyOverride,
): Promise<{ data: Buffer; filename: string; mediaType: string } | null> {
	const fileItem = item.file_item as Record<string, unknown> | undefined;
	if (!fileItem) return null;
	const media = mediaReference(item, "file_item");

	const filename = String(fileItem.file_name ?? `file_${Date.now()}.bin`).trim();

	// aeskey in file_item may be hex string; convert to base64 for the decrypt helper
	let aesKeyB64 = String(media.aes_key ?? "").trim() || null;
	const hexKey = String(fileItem.aeskey ?? "").trim();
	if (!aesKeyB64 && hexKey) {
		aesKeyB64 = Buffer.from(hexKey, "hex").toString("base64");
	}

	try {
		const data = await downloadAndDecryptMedia(
			cdnBase,
			String(media.encrypt_query_param ?? "") || null,
			aesKeyB64,
			String(media.full_url ?? "") || null,
			60, // longer timeout for files
			proxyOverride,
		);

		// Guess MIME type from filename extension
		const ext = filename.split(".").pop()?.toLowerCase() ?? "";
		const mimeMap: Record<string, string> = {
			txt: "text/plain",
			md: "text/markdown",
			csv: "text/csv",
			json: "application/json",
			xml: "application/xml",
			html: "text/html",
			js: "text/javascript",
			ts: "text/typescript",
			py: "text/x-python",
			java: "text/x-java",
			c: "text/x-c",
			cpp: "text/x-c++",
			h: "text/x-c",
			rs: "text/x-rust",
			go: "text/x-go",
			rb: "text/x-ruby",
			sh: "text/x-shellscript",
			yaml: "text/yaml",
			yml: "text/yaml",
			toml: "text/toml",
			ini: "text/plain",
			cfg: "text/plain",
			log: "text/plain",
			pdf: "application/pdf",
			doc: "application/msword",
			docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			xls: "application/vnd.ms-excel",
			xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			zip: "application/zip",
		};
		const mediaType = mimeMap[ext] ?? "application/octet-stream";

		return { data, filename, mediaType };
	} catch (err) {
		logger.warn("[weixin] File download failed", {
			filename,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/** Save image bytes to a temp file and return the path. */
function saveTempImage(data: Buffer, filename: string): string {
	const dir = join(NARRAFORK_HOME, "weixin", "tmp");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const path = join(dir, `${Date.now()}_${filename}`);
	writeFileSync(path, data);
	return path;
}

/** Remove temp images older than 1 hour. Called periodically. */
function cleanupTempImages(): void {
	const dir = join(NARRAFORK_HOME, "weixin", "tmp");
	if (!existsSync(dir)) return;
	const cutoff = Date.now() - 3_600_000; // 1 hour
	try {
		for (const name of readdirSync(dir)) {
			const filePath = join(dir, name);
			try {
				const stat = statSync(filePath);
				if (stat.mtimeMs < cutoff) {
					unlinkSync(filePath);
				}
			} catch {
				// skip individual file errors
			}
		}
	} catch {
		// non-fatal
	}
}

// ---------------------------------------------------------------------------
// WeixinAdapter — main adapter class
// ---------------------------------------------------------------------------

export class WeixinAdapter extends BaseAdapter {
	readonly platform: GatewayPlatform = "weixin";
	readonly maxMessageLength = 4000;
	override readonly supportsEdit = false;

	private config: WeixinConfig;
	private baseUrl: string;
	private cdnBaseUrl: string;
	private accountId: string;
	private token: string;
	private sendChunkDelay: number;
	private sendChunkRetries: number;

	private tokenStore = new ContextTokenStore();
	private typingCache = new TypingTicketCache();
	private dedup = new MessageDeduplicator();

	private pollAbort: AbortController | null = null;
	private pollPromise: Promise<void> | null = null;
	private running = false;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config: WeixinConfig) {
		super();
		this.config = config;
		this.token = config.token;
		this.accountId = config.accountId;
		this.baseUrl = (config.baseUrl ?? ILINK_BASE_URL).replace(/\/+$/, "");
		this.cdnBaseUrl = (config.cdnBaseUrl ?? WEIXIN_CDN_BASE_URL).replace(/\/+$/, "");
		this.sendChunkDelay = config.sendChunkDelay ?? 0.35;
		this.sendChunkRetries = config.sendChunkRetries ?? 2;
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	async connect(): Promise<boolean> {
		if (!this.token) {
			logger.error("[weixin] Missing token — run QR login first");
			return false;
		}
		if (!this.accountId) {
			logger.error("[weixin] Missing accountId — run QR login first");
			return false;
		}

		this.tokenStore.restore(this.accountId);
		this.running = true;
		this.connected = true;
		this.pollAbort = new AbortController();
		this.pollPromise = this.pollLoop();
		// Periodic cleanup of temp images every 30 minutes
		this.cleanupTimer = setInterval(() => cleanupTempImages(), 1_800_000);
		cleanupTempImages(); // Run once on startup
		logger.info(`[weixin] Connected account=${this.accountId.slice(0, 8)}… base=${this.baseUrl}`);
		return true;
	}

	async disconnect(): Promise<void> {
		this.running = false;
		this.pollAbort?.abort();
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		if (this.pollPromise) {
			await this.pollPromise.catch(() => {});
			this.pollPromise = null;
		}
		this.connected = false;
		logger.info("[weixin] Disconnected");
	}

	// -----------------------------------------------------------------------
	// Long-poll loop
	// -----------------------------------------------------------------------

	private async pollLoop(): Promise<void> {
		let syncBuf = loadSyncBuf(this.accountId);
		let timeoutMs = LONG_POLL_TIMEOUT_MS;
		let consecutiveFailures = 0;

		while (this.running) {
			try {
				const response = await getUpdates(
					this.baseUrl,
					this.token,
					syncBuf,
					timeoutMs,
					this.config.proxy,
				);

				const suggestedTimeout = response.longpolling_timeout_ms;
				if (typeof suggestedTimeout === "number" && suggestedTimeout > 0) {
					timeoutMs = suggestedTimeout;
				}

				const ret = (response.ret as number) ?? 0;
				const errcode = (response.errcode as number) ?? 0;

				if (ret !== 0 || errcode !== 0) {
					if (ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE) {
						logger.error("[weixin] Session expired; pausing 10 minutes");
						await this.sleep(600_000);
						consecutiveFailures = 0;
						continue;
					}
					consecutiveFailures++;
					logger.warn(
						`[weixin] getUpdates failed ret=${ret} errcode=${errcode} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
					);
					await this.sleep(
						consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS,
					);
					if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
					continue;
				}

				consecutiveFailures = 0;
				const newSyncBuf = String(response.get_updates_buf ?? "");
				if (newSyncBuf) {
					syncBuf = newSyncBuf;
					saveSyncBuf(this.accountId, syncBuf);
				}

				const msgs = (response.msgs as unknown[]) ?? [];
				for (const msg of msgs) {
					this.processMessageSafe(msg as Record<string, unknown>);
				}
			} catch (err) {
				if (!this.running) break;
				consecutiveFailures++;
				logger.error(`[weixin] Poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`, {
					error: err instanceof Error ? err.message : String(err),
				});
				await this.sleep(
					consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS,
				);
				if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
			}
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, ms);
			this.pollAbort?.signal.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	// -----------------------------------------------------------------------
	// Inbound message processing
	// -----------------------------------------------------------------------

	private processMessageSafe(message: Record<string, unknown>): void {
		this.processMessage(message).catch((err) => {
			logger.error("[weixin] Unhandled inbound error", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	private async processMessage(message: Record<string, unknown>): Promise<void> {
		const senderId = String(message.from_user_id ?? "").trim();
		if (!senderId) return;
		// Skip own messages
		if (senderId === this.accountId) return;

		// iLink API uses msg_id (consistent with from_user_id, to_user_id, etc.)
		const messageId = String(message.msg_id ?? message.message_id ?? "").trim();
		if (messageId) {
			if (this.dedup.isDuplicate(messageId)) {
				logger.debug(`[weixin] Dedup: skipping duplicate message ${messageId}`);
				return;
			}
		} else {
			logger.warn("[weixin] Message has no msg_id — dedup disabled for this message", {
				fromUser: senderId.slice(0, 8),
			});
		}

		// Allowlist check
		if (this.config.allowedUsers?.length) {
			if (!this.config.allowedUsers.includes(senderId)) {
				logger.debug(`[weixin] Ignoring message from unauthorized user ${senderId.slice(0, 8)}`);
				return;
			}
		}

		// Save context token
		const contextToken = String(message.context_token ?? "").trim();
		if (contextToken) {
			this.tokenStore.set(this.accountId, senderId, contextToken);
		}

		// Async fetch typing ticket
		this.fetchTypingTicket(senderId, contextToken || null).catch(() => {});

		const itemList = (message.item_list as unknown[]) ?? [];
		const text = extractText(itemList);

		// Extract images
		const images: InboundMessage["images"] = [];
		for (const item of itemList) {
			if (!item || typeof item !== "object") continue;
			const it = item as Record<string, unknown>;
			if (it.type === ITEM_IMAGE) {
				const result = await downloadInboundImage(this.cdnBaseUrl, it, this.config.proxy);
				if (result) {
					const tmpPath = saveTempImage(result.data, result.filename);
					images.push({
						url: tmpPath,
						mediaType: "image/jpeg",
						filename: result.filename,
					});
				}
			}
			// Also check ref_msg for quoted images
			const refMsg = it.ref_msg as Record<string, unknown> | undefined;
			const refItem = refMsg?.message_item as Record<string, unknown> | undefined;
			if (refItem?.type === ITEM_IMAGE) {
				const result = await downloadInboundImage(this.cdnBaseUrl, refItem, this.config.proxy);
				if (result) {
					const tmpPath = saveTempImage(result.data, result.filename);
					images.push({
						url: tmpPath,
						mediaType: "image/jpeg",
						filename: result.filename,
					});
				}
			}
		}

		// Extract files
		const files: InboundMessage["files"] = [];
		for (const item of itemList) {
			if (!item || typeof item !== "object") continue;
			const it = item as Record<string, unknown>;
			if (it.type === ITEM_FILE) {
				const result = await downloadInboundFile(this.cdnBaseUrl, it, this.config.proxy);
				if (result) {
					files.push({
						data: result.data,
						filename: result.filename,
						mediaType: result.mediaType,
					});
				}
			}
			// Also check ref_msg for quoted files
			const refMsg = it.ref_msg as Record<string, unknown> | undefined;
			const refItem = refMsg?.message_item as Record<string, unknown> | undefined;
			if (refItem?.type === ITEM_FILE) {
				const result = await downloadInboundFile(this.cdnBaseUrl, refItem, this.config.proxy);
				if (result) {
					files.push({
						data: result.data,
						filename: result.filename,
						mediaType: result.mediaType,
					});
				}
			}
		}

		if (!text && images.length === 0 && files.length === 0) return;

		const inbound: InboundMessage = {
			platform: "weixin",
			chatId: senderId, // iLink is DM-only, chatId = userId
			userId: senderId,
			username: senderId,
			text,
			images: images.length > 0 ? images : undefined,
			files: files.length > 0 ? files : undefined,
			raw: message,
		};

		await this.dispatchMessage(inbound);
	}

	private async fetchTypingTicket(userId: string, contextToken: string | null): Promise<void> {
		if (this.typingCache.get(userId)) return;
		try {
			const resp = await getConfig(
				this.baseUrl,
				this.token,
				userId,
				contextToken,
				this.config.proxy,
			);
			const ticket = String(resp.typing_ticket ?? "").trim();
			if (ticket) this.typingCache.set(userId, ticket);
		} catch {
			// non-fatal
		}
	}

	// -----------------------------------------------------------------------
	// Outbound: send text
	// -----------------------------------------------------------------------

	async send(chatId: string, text: string): Promise<void> {
		const formatted = normalizeMarkdownForWeixin(text);
		const chunks = this.splitMessage(formatted);
		for (let i = 0; i < chunks.length; i++) {
			await this.sendTextChunk(chatId, chunks[i]);
			if (i < chunks.length - 1 && this.sendChunkDelay > 0) {
				await new Promise((r) => setTimeout(r, this.sendChunkDelay * 1000));
			}
		}
	}

	private async sendTextChunk(chatId: string, chunk: string): Promise<void> {
		let contextToken = this.tokenStore.get(this.accountId, chatId);
		let retriedWithoutToken = false;

		for (let attempt = 0; attempt <= this.sendChunkRetries; attempt++) {
			try {
				const clientId = `narrafork-wx-${randomUUID().replace(/-/g, "")}`;
				const resp = await sendTextMessage(
					this.baseUrl,
					this.token,
					chatId,
					chunk,
					contextToken,
					clientId,
					this.config.proxy,
				);

				const ret = (resp.ret as number) ?? 0;
				const errcode = (resp.errcode as number) ?? 0;

				if (ret === 0 && errcode === 0) return; // success

				const isSessionExpired =
					ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE;

				if (isSessionExpired && !retriedWithoutToken && contextToken) {
					retriedWithoutToken = true;
					this.tokenStore.delete(this.accountId, chatId);
					contextToken = null;
					logger.warn(
						`[weixin] Session expired for ${chatId.slice(0, 8)}; retrying without context_token`,
					);
					continue;
				}

				const errmsg = String(resp.errmsg ?? resp.msg ?? "unknown error");
				throw new Error(`iLink sendmessage error: ret=${ret} errcode=${errcode} errmsg=${errmsg}`);
			} catch (err) {
				if (attempt >= this.sendChunkRetries) throw err;
				const wait = 1000 * (attempt + 1);
				logger.warn(
					`[weixin] Send chunk failed attempt=${attempt + 1}/${this.sendChunkRetries + 1}, retrying in ${wait}ms`,
				);
				await new Promise((r) => setTimeout(r, wait));
			}
		}
	}

	// -----------------------------------------------------------------------
	// Outbound: send media (image/file upload)
	// -----------------------------------------------------------------------

	async sendImage(chatId: string, imageData: Buffer, _filename: string): Promise<void> {
		const media = await uploadMediaFile(
			this.baseUrl,
			this.cdnBaseUrl,
			this.token,
			chatId,
			imageData,
			MEDIA_IMAGE,
			this.config.proxy,
		);
		const contextToken = this.tokenStore.get(this.accountId, chatId);
		const clientId = `narrafork-wx-${randomUUID().replace(/-/g, "")}`;
		await sendMediaMessage(
			this.baseUrl,
			this.token,
			chatId,
			[buildImageItem(media)],
			contextToken,
			clientId,
			this.config.proxy,
		);
	}

	async sendFile(chatId: string, fileData: Buffer, filename: string): Promise<void> {
		const media = await uploadMediaFile(
			this.baseUrl,
			this.cdnBaseUrl,
			this.token,
			chatId,
			fileData,
			MEDIA_FILE,
			this.config.proxy,
		);
		const contextToken = this.tokenStore.get(this.accountId, chatId);
		const clientId = `narrafork-wx-${randomUUID().replace(/-/g, "")}`;
		await sendMediaMessage(
			this.baseUrl,
			this.token,
			chatId,
			[buildFileItem(media, filename)],
			contextToken,
			clientId,
			this.config.proxy,
		);
	}

	// -----------------------------------------------------------------------
	// Typing indicator
	// -----------------------------------------------------------------------

	async sendTyping(chatId: string): Promise<void> {
		const ticket = this.typingCache.get(chatId);
		if (!ticket) return;
		try {
			await sendTypingRequest(
				this.baseUrl,
				this.token,
				chatId,
				ticket,
				TYPING_START,
				this.config.proxy,
			);
		} catch {
			// non-fatal
		}
	}
}
