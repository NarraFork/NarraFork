/**
 * Shared types for the IM Gateway module.
 */

// ---------------------------------------------------------------------------
// Platform identifiers
// ---------------------------------------------------------------------------

export const GATEWAY_PLATFORMS = [
	"telegram",
	"discord",
	"slack",
	"feishu",
	"webhook",
	"weixin",
] as const;

export type GatewayPlatform = (typeof GATEWAY_PLATFORMS)[number];

// ---------------------------------------------------------------------------
// Inbound message (IM → Gateway)
// ---------------------------------------------------------------------------

export interface InboundMessage {
	/** Platform identifier */
	platform: GatewayPlatform;
	/** Platform-specific chat/channel ID */
	chatId: string;
	/** Platform-specific user ID */
	userId: string;
	/** Display name of the sender */
	username: string;
	/** Message text */
	text: string;
	/** Optional image attachments */
	images?: Array<{
		url?: string;
		base64?: string;
		mediaType: string;
		filename: string;
	}>;
	/** Platform-specific raw event (for debugging) */
	raw?: unknown;
}

// ---------------------------------------------------------------------------
// Outbound message (Gateway → IM)
// ---------------------------------------------------------------------------

export interface OutboundMessage {
	/** Text content to send */
	text: string;
	/** Optional image URL or path */
	imageUrl?: string;
	/** Optional file path to send as attachment */
	filePath?: string;
}

// ---------------------------------------------------------------------------
// Send result — returned by sendAndGetId / editMessage
// ---------------------------------------------------------------------------

export interface SendResult {
	success: boolean;
	/** Platform message ID (for subsequent edits). Null if platform doesn't support editing. */
	messageId?: string | null;
	error?: string;
}

// ---------------------------------------------------------------------------
// Platform adapter interface
// ---------------------------------------------------------------------------

export interface PlatformAdapterEvents {
	message: (msg: InboundMessage) => void | Promise<void>;
}

export interface PlatformAdapter {
	readonly platform: GatewayPlatform;
	readonly maxMessageLength: number;

	/** Whether this platform supports message editing (progressive streaming). */
	readonly supportsEdit: boolean;

	/** Connect to the platform. Returns true on success. */
	connect(): Promise<boolean>;

	/** Disconnect from the platform. */
	disconnect(): Promise<void>;

	/** Send a text message to a chat (fire-and-forget, no message ID returned). */
	send(chatId: string, text: string): Promise<void>;

	/** Send a text message and return the message ID for subsequent edits. */
	sendAndGetId(chatId: string, text: string): Promise<SendResult>;

	/** Edit an existing message. */
	editMessage(chatId: string, messageId: string, text: string): Promise<SendResult>;

	/** Send a typing indicator. */
	sendTyping(chatId: string): Promise<void>;

	/** Register the inbound message handler. */
	onMessage(handler: PlatformAdapterEvents["message"]): void;
}

// ---------------------------------------------------------------------------
// Gateway configuration (loaded from gateway.json / env vars)
// ---------------------------------------------------------------------------

export interface GatewayPlatformConfig {
	platform: GatewayPlatform;
	enabled: boolean;
	/** Platform-specific credentials and settings */
	[key: string]: unknown;
}

export interface TelegramConfig extends GatewayPlatformConfig {
	platform: "telegram";
	token: string;
	allowedUsers?: string[];
}

export interface DiscordConfig extends GatewayPlatformConfig {
	platform: "discord";
	token: string;
	allowedUsers?: string[];
}

export interface SlackConfig extends GatewayPlatformConfig {
	platform: "slack";
	botToken: string;
	appToken: string;
	allowedUsers?: string[];
}

export interface FeishuConfig extends GatewayPlatformConfig {
	platform: "feishu";
	appId: string;
	appSecret: string;
	allowedUsers?: string[];
}

export interface WebhookConfig extends GatewayPlatformConfig {
	platform: "webhook";
	secret: string;
	port?: number;
}

export interface WeixinConfig extends GatewayPlatformConfig {
	platform: "weixin";
	/** iLink bot token obtained via QR login */
	token: string;
	/** iLink bot account ID obtained via QR login */
	accountId: string;
	/** iLink API base URL (default: https://ilinkai.weixin.qq.com) */
	baseUrl?: string;
	/** WeChat CDN base URL (default: https://novac2c.cdn.weixin.qq.com/c2c) */
	cdnBaseUrl?: string;
	/** Allowlisted user IDs (empty = allow all) */
	allowedUsers?: string[];
	/** Delay in seconds between outbound text chunks (default: 0.35) */
	sendChunkDelay?: number;
	/** Number of retries per outbound chunk (default: 2) */
	sendChunkRetries?: number;
}

export type PlatformConfigUnion =
	| TelegramConfig
	| DiscordConfig
	| SlackConfig
	| FeishuConfig
	| WebhookConfig
	| WeixinConfig;

export interface GatewayConfig {
	/** Whether the gateway is enabled at all */
	enabled: boolean;
	/** Default project ID to bind new IM sessions to (optional) */
	defaultProjectId?: string;
	/** Default chapter ID to bind new IM sessions to (optional) */
	defaultChapterId?: string;
	/** Default permission mode for IM-created narrators */
	defaultPermissionMode?: string;
	/** Session idle timeout in minutes. Sessions older than this auto-reset. 0 = never. */
	sessionIdleMinutes?: number;
	/** Max messages per user per minute. 0 = unlimited. */
	rateLimitPerMinute?: number;
	/** Enable streaming (progressive message editing) for platforms that support it. */
	streaming?: boolean;
	/** Platform configurations */
	platforms: PlatformConfigUnion[];
}

// ---------------------------------------------------------------------------
// Chat commands recognised inside IM messages
// ---------------------------------------------------------------------------

export const IM_COMMANDS = [
	"/new",
	"/model",
	"/stop",
	"/status",
	"/list",
	"/search",
	"/switch",
	"/help",
] as const;

export type IMCommand = (typeof IM_COMMANDS)[number];
