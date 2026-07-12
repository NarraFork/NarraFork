export interface PendingPermission {
	id: string;
	toolName: string;
	toolUseId?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	inputJson: any;
	decisionReason?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	suggestions?: any[];
	/** Frozen execution target captured before permission handling. */
	executionDeviceId?: string | null;
	executionCwd?: string | null;
	resolvedFilePath?: string | null;
	deviceSelectionSource?: "explicit" | "session_default" | "local_default" | null;
	suppressNotifications?: boolean;
	/**
	 * Absolute epoch-ms deadline for automatic AskUserQuestion reflection, used to
	 * render a live countdown. Cleared once the timer is disarmed or fires.
	 */
	reflectionDeadline?: number;
}
