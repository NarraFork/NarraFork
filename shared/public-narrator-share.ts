/** The anonymous sharing contract. Never extend these DTOs with internal narrator rows. */
export interface PublicShareLink {
	id: string;
	guestName: string;
	label: string | null;
	createdAt: string;
	revokedAt: string | null;
}

export interface PublicShareLinkPage {
	shares: PublicShareLink[];
	hasMore: boolean;
	nextCursor: string | null;
}

/** The secret is returned once, on creation only. */
export interface CreatedPublicShare {
	share: PublicShareLink;
	token: string;
}

export interface PublicSharedSession {
	shareId: string;
	title: string;
	status: string;
	messageVersion: number;
	guestName: string;
}

export interface PublicSharedTool {
	id: string;
	name: string;
	status: string;
}

export interface PublicSharedToolDetail extends PublicSharedTool {
	input: string;
	output: string;
	truncated: boolean;
}

export interface PublicSharedMessage {
	id: string;
	seq: number;
	role: "user" | "assistant" | "system";
	createdAt: string;
	text: string;
	reasoning: string;
	tools: PublicSharedTool[];
	truncated: boolean;
	mediaOmitted: boolean;
}

export interface PublicSharedMessagePage {
	messages: PublicSharedMessage[];
	hasMore: boolean;
	nextBeforeSeq: number | null;
	messageVersion: number;
}

export interface PublicDiscussionMessage {
	id: string;
	seq: number;
	text: string;
	author: { name: string; isGuest: boolean; isSelf: boolean };
	createdAt: string;
	deletedAt: string | null;
	replyTo: { id: string; seq: number | null; name: string; text: string | null } | null;
	hasAttachments: boolean;
}

export interface PublicDiscussionPage {
	messages: PublicDiscussionMessage[];
	hasMore: boolean;
	nextBeforeSeq: number | null;
}

export interface PublicLiveBlock {
	id: string;
	kind: "text" | "reasoning";
	text: string;
}

/** SSE data uses this closed union; no raw internal WS events cross this boundary. */
export type PublicShareEvent =
	| { type: "snapshot"; blocks: PublicLiveBlock[]; truncated: boolean }
	| { type: "delta"; blockId: string; kind: "text" | "reasoning"; text: string; offset: number }
	| { type: "invalidate"; scope: "messages" | "discussion" | "session" }
	| { type: "reset" }
	| { type: "revoked" }
	| { type: "ping" };
