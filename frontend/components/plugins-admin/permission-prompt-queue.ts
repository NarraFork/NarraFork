export interface PluginEventDetail {
	type?: string;
	pluginId?: string;
	requestId?: string;
	source?: string;
}

/**
 * Queueing and dedup rules for the global plugin permission prompt.
 *
 * Kept separate from the host component so the policy can be verified without
 * rendering: which events raise a prompt, and when a dismissed request stays
 * dismissed. The two rules that matter most:
 *
 * - upgrade requests never raise the global prompt — they belong to the
 *   admin-initiated upgrade flow, which already surfaces them;
 * - "later" sticks for the session. A plugin retrying a denied capability
 *   rebroadcasts the SAME requestId (`addPendingRequest` is idempotent), and
 *   without the dismissed set the prompt would re-open on every retry.
 */
export class PermissionPromptQueue {
	private readonly dismissed = new Set<string>();
	private queue: string[] = [];

	/** The plugin whose prompt should be visible, if any. */
	get current(): string | undefined {
		return this.queue[0];
	}

	/**
	 * Handle a `narrafork:plugin-event` detail. Returns the plugin id whose
	 * prompt should be visible afterwards (undefined for none).
	 */
	handleEvent(detail: PluginEventDetail | undefined): string | undefined {
		if (detail?.type !== "plugin:permission_request") return this.current;
		if (detail.source === "upgrade") return this.current;
		if (!detail.pluginId || !detail.requestId) return this.current;
		if (this.dismissed.has(detail.requestId)) return this.current;
		if (!this.queue.includes(detail.pluginId)) this.queue.push(detail.pluginId);
		return this.current;
	}

	/**
	 * Close the current prompt and advance to the next plugin in line. Request
	 * ids passed here are never re-prompted for the rest of the session.
	 */
	close(dismissedRequestIds: readonly string[]): string | undefined {
		for (const requestId of dismissedRequestIds) this.dismissed.add(requestId);
		this.queue = this.queue.slice(1);
		return this.current;
	}
}
