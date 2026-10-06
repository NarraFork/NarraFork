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
	/** The narrator this share renders (drives the vlist's dataSource + WS scope). */
	narratorId: string;
	/** The discussion room backing this share (drives the discussion pane). */
	roomId: string;
	title: string;
	status: string;
	messageVersion: number;
	guestName: string;
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
