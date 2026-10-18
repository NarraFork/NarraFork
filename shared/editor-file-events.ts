/** Hints only. Neither an opaque resource id nor a notification grants file access. */
export type EditorFileClientMessage =
	| { type: "editor_file_subscribe"; subscriptionId: string; narratorId: string; docId: string }
	| { type: "editor_file_unsubscribe"; subscriptionId: string };
export type EditorFileServerMessage =
	| {
			type: "editor_file_subscribed" | "editor_file_changed";
			subscriptionId: string;
			resourceId: string;
			generation: string;
			seq: number;
			reason: "poll" | "hint" | "rebind";
	  }
	| { type: "editor_file_error"; subscriptionId: string; code: "access_denied" | "unavailable" };
