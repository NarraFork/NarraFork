/**
 * MessageOriginBadge.tsx — attribution marker for messages that were not typed
 * directly into this session.
 *
 * `narrator_messages.role` cannot express authorship: providers treat the
 * trailing `user` message as the current turn and the continuation scheduler
 * only resumes from user/assistant, so system- and AI-injected turns must also
 * be stored as `role: "user"`. `origin` carries the real author, and this badge
 * surfaces it.
 *
 * Deliberately understated: an icon only, with the full source in a tooltip.
 * Message headers are a fixed 20px row in the virtual list
 * (`USER_HEADER_HEIGHT`), so this must never grow the line box — hence a
 * borderless icon rather than a labelled badge.
 */

import { Group, Paper, Text, Tooltip } from "@mantine/core";
import {
	type MessageOrigin,
	type MessageOriginSource,
	normalizeMessageOrigin,
	parseOriginLabel,
} from "@shared/message-origin";
import {
	IconApi,
	IconClock,
	IconEye,
	IconGitBranch,
	IconGitMerge,
	IconMessages,
	IconPlugConnected,
	IconRepeat,
	IconRobot,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

const SYSTEM_MESSAGE_BG = "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))";

/** Icon per known source. Falls back to an origin-level icon when unrecognized. */
const SOURCE_ICONS: Record<MessageOriginSource, typeof IconRobot> = {
	autoContinuation: IconRepeat,
	review: IconEye,
	rebase: IconGitBranch,
	batchMerge: IconGitMerge,
	scheduledTask: IconClock,
	forkNarrator: IconGitBranch,
	chatGroup: IconMessages,
	gateway: IconPlugConnected,
	oauth: IconApi,
	recovery: IconRepeat,
};

const ORIGIN_FALLBACK_ICONS: Record<Exclude<MessageOrigin, "user">, typeof IconRobot> = {
	system: IconRepeat,
	assistant: IconRobot,
};

/**
 * Resolve the tooltip text. Recognized sources are translated; the dynamic
 * detail (a platform handle, OAuth client, task name) is appended verbatim
 * because it is an identifier, not prose.
 */
export function useOriginTooltip(
	origin: string | null | undefined,
	originLabel: string | null | undefined,
): string | null {
	const { t } = useTranslation("narrator");
	const parsed = parseOriginLabel(originLabel);
	const normalized = normalizeMessageOrigin(origin);

	if (parsed?.source) {
		const sourceName = t(`origin.source.${parsed.source}`);
		return parsed.detail ? `${sourceName} · ${parsed.detail}` : sourceName;
	}
	// Unrecognized label: show it raw rather than dropping the information.
	if (parsed?.raw) return parsed.raw;
	if (normalized === "user") return null;
	return t(`origin.kind.${normalized}`);
}

/**
 * Display name for a user-bubble header.
 *
 * A known creator always wins. Without one, the previous code said "you" for
 * every authorless message, which was wrong for every system- and AI-injected
 * turn. Now the source label names the actual author, and "you" is only used
 * where it is actually true (a human message whose sender was not recorded).
 */
export function resolveUserBubbleName(
	message: {
		creator?: { username: string } | null;
		origin?: string | null;
		originLabel?: string | null;
	},
	t: (key: string) => string,
): string {
	if (message.creator?.username) return message.creator.username;

	const parsed = parseOriginLabel(message.originLabel);
	if (parsed?.source) return t(`origin.source.${parsed.source}`);

	const normalized = normalizeMessageOrigin(message.origin);
	if (normalized !== "user") return t(`origin.kind.${normalized}`);
	if (parsed?.raw) return parsed.raw;
	return t("you");
}

/**
 * Renders nothing for plain in-app human messages (the common case), so callers
 * can drop it in unconditionally.
 */
export function MessageOriginBadge({
	origin,
	originLabel,
	size = 13,
}: {
	origin?: string | null;
	originLabel?: string | null;
	size?: number;
}) {
	const tooltip = useOriginTooltip(origin, originLabel);
	const normalized = normalizeMessageOrigin(origin);
	const parsed = parseOriginLabel(originLabel);

	// A human typing in the app needs no marker.
	if (normalized === "user" && !parsed) return null;
	if (!tooltip) return null;

	const Icon = parsed?.source
		? SOURCE_ICONS[parsed.source]
		: normalized === "user"
			? IconPlugConnected
			: ORIGIN_FALLBACK_ICONS[normalized];

	return (
		<Tooltip label={tooltip} withArrow openDelay={200}>
			<Icon
				size={size}
				stroke={1.6}
				aria-label={tooltip}
				style={{ color: "var(--mantine-color-dimmed)", flexShrink: 0 }}
			/>
		</Tooltip>
	);
}

/** Format a notice timestamp: today → HH:mm, otherwise MM/DD HH:mm. */
function formatNoticeTime(createdAt: string): string {
	const d = new Date(createdAt);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const isToday =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	const pad = (n: number) => String(n).padStart(2, "0");
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return isToday ? time : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`;
}

/**
 * Low-contrast card for messages that entered the conversation as `role: "user"`
 * but were not authored by a human, plus plain-text `sys` notices.
 *
 * Matches the existing system-card language (`Paper p="xs"` + xs dimmed text) so
 * these stop competing visually with real user messages.
 */
export function SystemOriginNotice({
	text,
	origin,
	originLabel,
	createdAt,
}: {
	text: string;
	origin?: string | null;
	originLabel?: string | null;
	createdAt?: string | null;
}) {
	const { t } = useTranslation("narrator");
	const tooltip = useOriginTooltip(origin, originLabel);
	const parsed = parseOriginLabel(originLabel);
	const normalized = normalizeMessageOrigin(origin);
	const heading =
		tooltip ?? (normalized === "user" ? t("origin.kind.system") : t(`origin.kind.${normalized}`));
	const Icon = parsed?.source
		? SOURCE_ICONS[parsed.source]
		: normalized === "user"
			? IconPlugConnected
			: ORIGIN_FALLBACK_ICONS[normalized];

	return (
		<Paper p="xs" radius="sm" style={{ backgroundColor: SYSTEM_MESSAGE_BG }}>
			<Group gap={6} wrap="nowrap" mb={text.trim() ? 4 : 0}>
				<Icon size={13} stroke={1.6} style={{ color: "var(--mantine-color-dimmed)" }} />
				<Text size="xs" c="dimmed" fw={600} style={{ whiteSpace: "nowrap" }}>
					{heading}
				</Text>
				{createdAt ? (
					<Text size="xs" c="dimmed" ml="auto" style={{ whiteSpace: "nowrap" }}>
						{formatNoticeTime(createdAt)}
					</Text>
				) : null}
			</Group>
			{text.trim() ? (
				<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
					{text}
				</Text>
			) : null}
		</Paper>
	);
}
