declare module "node-telegram-bot-api" {
	class TelegramBot {
		constructor(token: string, options?: { polling?: boolean });
		on(event: string, callback: (msg: any) => void): void;
		getMe(): Promise<{ id: number; username: string }>;
		sendMessage(chatId: string | number, text: string, options?: Record<string, unknown>): Promise<any>;
		sendChatAction(chatId: string | number, action: string): Promise<boolean>;
		stopPolling(): Promise<void>;
	}
	export default TelegramBot;
}
