/**
 * vlist-user-bubble-header.tsx — user-bubble header slot for the pretext vlist.
 *
 * The adapter carries height-neutral `creator` / `createdAt` on a user
 * message-bubble spec, and `resolveRenderExtra` only FORWARDS that raw data:
 * the pure render/ templates must never import UserAvatar (they stay
 * zero-dependency so measure/render parity is auditable). Building the actual
 * header node is therefore the integration layer's job — this module owns it.
 *
 * Without the injection step the bubble reserves USER_HEADER_HEIGHT but paints
 * nothing, so the avatar + username + timestamp row silently disappears in the
 * virtual list while the classic renderer still shows it.
 *
 * Kept as its own module (not inlined in PretextExactMessageList) so the
 * injection contract is unit-testable without pulling the whole shell — and its
 * heavy transitive imports — into the test graph.
 */

import { UserAvatar } from "@frontend/components/UserAvatar";
import { formatLocaleDateTime, formatLocaleTime } from "@frontend/lib/intl-format";
import { Group, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { VListElementKind } from "./registry";
import type { RenderExtra } from "./render-registry";

/** Message creator carried on user bubbles (avatar + name). */
export interface BubbleCreator {
	id?: string;
	username: string;
	avatarColor?: string | null;
	avatarImageId?: string | null;
}

/** Format a message timestamp like MessageBubble: today → HH:mm, else MM/DD HH:mm. */
export function formatBubbleTime(createdAt: string): string {
	const d = new Date(createdAt);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const isToday =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	return isToday
		? formatLocaleTime(d, { hour: "2-digit", minute: "2-digit" })
		: formatLocaleDateTime(d, {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			});
}

/**
 * User bubble header row (avatar + username + timestamp), injected into the vlist
 * message-bubble render via `extra.header`. Mirrors MessageBubble's user header so
 * the virtual list matches the classic renderer.
 */
export function UserBubbleHeader({
	creator,
	createdAt,
}: {
	creator?: BubbleCreator | null;
	createdAt?: string | null;
}) {
	const { t } = useTranslation("narrator");
	return (
		<Group gap={6} wrap="nowrap" h="100%" align="center">
			{creator && (
				<UserAvatar
					username={creator.username}
					avatarColor={creator.avatarColor}
					avatarImageId={creator.avatarImageId}
					userId={creator.id}
					size={20}
					showTooltip={false}
				/>
			)}
			<Text size="xs" fw={600} c="indigo" style={{ whiteSpace: "nowrap" }}>
				{creator?.username ?? t("you")}
			</Text>
			{createdAt ? (
				<Text size="xs" c="dimmed" ml="auto" style={{ whiteSpace: "nowrap" }}>
					{formatBubbleTime(createdAt)}
				</Text>
			) : null}
		</Group>
	);
}

/**
 * Attach the header node to a user message-bubble's render extra. Mutates
 * `extra` in place, mirroring how the other integration-owned slots
 * (permissionSlot, rowInteraction) are attached, and is a no-op for every other
 * kind / role so callers can invoke it unconditionally per row.
 */
export function injectUserBubbleHeader(kind: VListElementKind, extra: RenderExtra): void {
	if (kind !== "message-bubble" || extra.role !== "user") return;
	// Measure only reserves header space when hasHeader is not false; keep the
	// painted node in lockstep so height and content never disagree.
	if (extra.hasHeader === false) return;
	extra.header = (
		<UserBubbleHeader
			creator={(extra.creator as BubbleCreator | null | undefined) ?? null}
			createdAt={(extra.createdAt as string | null | undefined) ?? null}
		/>
	);
}
