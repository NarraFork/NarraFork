import { WINDOWS_FIRST_CAPTURE_LIMITS } from "@shared/windows-first-capture";

export interface WindowsFirstCaptureReadIntent {
	state: "preauthorizing" | "capturing" | "captured" | "unknown";
	readonly expiresAt: number;
	readonly connectionId: string;
}
/** Bounded ephemeral accounting only; NEVER a grant or recovery authority.
 * Old operation replay remains rejected by the helper's durable source/scope/op master.
 * Only the production completion verifier can mark an actual intent captured.
 * Unknown/in-flight work retains its slot regardless of time or disconnect. */
export class WindowsFirstCaptureReadIntents {
	private readonly intents = new Map<string, WindowsFirstCaptureReadIntent>();
	get size() {
		return this.intents.size;
	}
	reserve(key: string, connectionId: string, now: number): WindowsFirstCaptureReadIntent {
		for (const [existing, intent] of this.intents)
			if (intent.state === "captured" && intent.expiresAt <= now) this.intents.delete(existing);
		if (this.intents.has(key))
			throw new Error("WINDOWS_FIRST_CAPTURE_ORIGINAL_OPERATION_ALREADY_CONSUMED");
		if (
			this.intents.size >= WINDOWS_FIRST_CAPTURE_LIMITS.processTokens ||
			[...this.intents.values()].filter((intent) => intent.connectionId === connectionId).length >=
				WINDOWS_FIRST_CAPTURE_LIMITS.perConnection
		)
			throw new Error("WINDOWS_FIRST_CAPTURE_READ_INTENT_CAPACITY");
		const intent: WindowsFirstCaptureReadIntent = {
			state: "preauthorizing",
			connectionId,
			expiresAt: now + WINDOWS_FIRST_CAPTURE_LIMITS.tokenTtlMs,
		};
		this.intents.set(key, intent);
		return intent;
	}
	/** Proven no dispatch only: caller must retain Unknown if any preauth/RPC was sent. */
	discardBeforeDispatch(key: string, intent: WindowsFirstCaptureReadIntent) {
		if (this.intents.get(key) === intent && intent.state === "preauthorizing")
			this.intents.delete(key);
	}
}
