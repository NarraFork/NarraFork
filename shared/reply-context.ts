import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from "./i18n-locales";

/** Durable model reply policy, independent of the execution principal and display locale. */
export interface ReplyContext {
	locale: Locale;
	replyInUserLanguage: boolean;
}

export const DEFAULT_REPLY_CONTEXT: Readonly<ReplyContext> = {
	locale: DEFAULT_LOCALE,
	replyInUserLanguage: false,
};

/** Null means legacy/uninitialized, never an implicit change to the default policy. */
export function parseReplyContext(value: unknown): ReplyContext | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "object") throw new Error("Invalid reply context");
	const pair = value as Partial<ReplyContext>;
	if (
		!SUPPORTED_LOCALES.includes(pair.locale as Locale) ||
		typeof pair.replyInUserLanguage !== "boolean"
	)
		throw new Error("Invalid reply context");
	return { locale: pair.locale as Locale, replyInUserLanguage: pair.replyInUserLanguage };
}

/** Only a trusted human admission writes this metadata. Sender identity is not evidence. */
export function mailboxReplyContext(row: {
	kind: string;
	metadataJson: string | null;
}): ReplyContext | null {
	if (row.kind !== "user_input" || !row.metadataJson) return null;
	return parseReplyContext(JSON.parse(row.metadataJson).humanReplyContext);
}
