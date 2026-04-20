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
	images?: Array<{ url?: string; base64?: string; mediaType: string; filename: string }>;
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
// Platform adapter interface
// ---------------------------------------------------------------------------

export interface PlatformAdapterEvents {
	message: (msg: InboundMessage) => void | Promise<void>;
}

export interface PlatformAdapter {
	readonly platform: GatewayPlatform;
	readonly maxMessageLength: number;

	/** Connect to the platform. Returns true on success. */
	connect(): Promise<boolean>;

	/** Disconnect from the platform. */
	disconnect(): Promise<void>;

	/** Send a text message to a chat. */
	send(chatId: string, text: string): Promise<void>;

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

export type PlatformConfigUnion =
	| TelegramConfig
	| DiscordConfig
	| SlackConfig
	| FeishuConfig
	| WebhookConfig;

export interface GatewayConfig {
	/** Whether the gateway is enabled at all */
	enabled: boolean;
	/** Default project ID to bind new IM sessions to (optional) */
	defaultProjectId?: string;
	/** Default chapter ID to bind new IM sessions to (optional) */
	defaultChapterId?: string;
	/** Default permission mode for IM-created narrators */
	defaultPermissionMode?: string;
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
	"/help",
] as const;

export type IMCommand = (typeof IM_COMMANDS)[number];
