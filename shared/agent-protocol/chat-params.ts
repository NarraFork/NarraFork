/**
 * The subset of chat parameters the protocol request builder reads.
 *
 * The host's full `ChatParams` (`server/lib/agent/provider.ts`) additionally
 * carries an `AbortSignal`, an `ApiRequestDumpCollector` instance and several
 * callbacks. Those are host runtime concerns that the protocol layer never
 * touches, and depending on them would pull host classes into plugin bundles.
 *
 * This interface is structurally satisfied by the host's `ChatParams`, so host
 * callers can keep passing their existing object unchanged.
 */

/** Base64 image attached to the current user message. */
export interface ProtocolChatImage {
	format: string;
	base64: string;
}

export interface ChatParams {
	conversationId: string;
	content: string;
	model: string;
	cwd: string;
	history: unknown[];
	tools: unknown[];
	toolResults: unknown[];
	/** Base64-encoded images to attach to the current user message. */
	images?: ProtocolChatImage[];
}
