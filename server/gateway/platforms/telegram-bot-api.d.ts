declare module "node-telegram-bot-api" {
	export interface TelegramMessage {
		from?: { id?: string | number; username?: string; first_name?: string };
		photo?: Array<{ file_id: string }>;
		document?: { mime_type?: string; file_id: string; file_name?: string };
		text?: string;
		caption?: string;
		chat: { id: string | number };
	}

	export interface TelegramSentMessage {
		message_id?: string | number;
	}

	class TelegramBot {
		constructor(
			token: string,
			options?: {
				polling?: boolean;
				/** Options forwarded to the underlying HTTP client (@cypress/request). */
				request?: { url?: string; proxy?: string };
			},
		);
		on(event: "message", callback: (msg: TelegramMessage) => void): void;
		on(event: "polling_error", callback: (err: Error) => void): void;
		on(event: string, callback: (payload: unknown) => void): void;
		getMe(): Promise<{ id: number; username: string }>;
		sendMessage(
			chatId: string | number,
			text: string,
			options?: Record<string, unknown>,
		): Promise<TelegramSentMessage>;
		editMessageText(text: string, options?: Record<string, unknown>): Promise<unknown>;
		sendChatAction(chatId: string | number, action: string): Promise<boolean>;
		getFileLink(fileId: string): Promise<string>;
		stopPolling(): Promise<void>;
	}
	export default TelegramBot;
}
