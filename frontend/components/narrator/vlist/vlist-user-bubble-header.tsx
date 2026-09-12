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

import {
	MessageOriginBadge,
	OriginAvatar,
	resolveUserBubbleName,
} from "@frontend/components/narrator/message/MessageOriginBadge";
import { UserAvatar } from "@frontend/components/UserAvatar";
import { formatShortMessageTime } from "@frontend/lib/intl-format";
import { Group, Text } from "@mantine/core";
import { parseOriginLabel } from "@shared/message-origin";
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
	return formatShortMessageTime(createdAt);
}

/**
 * User bubble header row (avatar + username + timestamp), injected into the vlist
 * message-bubble render via `extra.header`. Mirrors MessageBubble's user header so
 * the virtual list matches the classic renderer.
 */
export function UserBubbleHeader({
	creator,
	createdAt,
	origin,
	originLabel,
}: {
	creator?: BubbleCreator | null;
	createdAt?: string | null;
	origin?: string | null;
	originLabel?: string | null;
}) {
	const { t } = useTranslation("narrator");
	return (
		<Group gap={6} wrap="nowrap" h="100%" align="center">
			{creator ? (
				<UserAvatar
					username={creator.username}
					avatarColor={creator.avatarColor}
					avatarImageId={creator.avatarImageId}
					userId={creator.id}
					size={20}
					showTooltip={false}
				/>
			) : (
				<OriginAvatar originLabel={originLabel} size={20} />
			)}
			<Text size="xs" fw={600} c="indigo" style={{ whiteSpace: "nowrap" }}>
				{resolveUserBubbleName({ creator, origin, originLabel }, t)}
			</Text>
			{/* Icon-only marker; sits inside the reserved 20px row so height is unchanged. */}
			<MessageOriginBadge origin={origin} originLabel={originLabel} />
			{createdAt ? (
				<Text size="xs" c="dimmed" ml="auto" style={{ whiteSpace: "nowrap" }}>
					{formatBubbleTime(createdAt)}
				</Text>
			) : null}
		</Group>
	);
}

/**
 * Attach the "open attachment in a file panel" handler to a user bubble's render
 * extra.
 *
 * Lives here for the same reason as the header: `resolveRenderExtra` only
 * FORWARDS raw spec data, so live callbacks must be injected by the integration
 * layer. The path itself is a height-neutral passthrough carried on each
 * attachment's measured block, so this only makes an existing row clickable — it
 * never changes the predicted geometry.
 *
 * Mutates `extra` in place and is a no-op for every other kind / role, so callers
 * can invoke it unconditionally per row.
 */
export function injectUserBubbleAttachmentOpen(
	kind: VListElementKind,
	extra: RenderExtra,
	onOpenFilePanel: ((filePath: string) => void) | undefined,
	openLabel: string | undefined,
): void {
	if (kind !== "message-bubble" || extra.role !== "user" || !onOpenFilePanel) return;
	extra.onOpenAttachment = onOpenFilePanel;
	if (openLabel) extra.openAttachmentLabel = openLabel;
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
			origin={(extra.origin as string | null | undefined) ?? null}
			originLabel={(extra.originLabel as string | null | undefined) ?? null}
		/>
	);
}

/**
 * Is this bubble's author the person reading it?
 *
 * NarraFork is a shared deployment: one narrator can be driven by several people, so
 * `role: "user"` means "a human typed this", NOT "you typed this". The right-hand
 * indigo bubble is a claim of authorship, and painting a teammate's turn there tells
 * the reader they wrote something they did not.
 *
 * Two deliberate fallbacks to `true`, both preserving the historical rendering rather
 * than guessing:
 *
 *   - viewer unknown (`useCurrentUser()` still loading, or no auth in a test): every
 *     bubble would otherwise flip left for a frame and then flip back.
 *   - author unknown (`creator` null / no id): pre-`created_by` rows. A row that a
 *     non-human authored never reaches here — the adapter routes `origin: system` /
 *     `assistant` to `origin_notice` before the bubble branch.
 */
export function resolveBubbleIsSelf(
	creator: BubbleCreator | null | undefined,
	currentUserId: string | null | undefined,
	originLabel?: string | null,
): boolean {
	// A turn authored by the plan reflection (a plan auto-approved without a human)
	// never belongs to the reader, so it always paints on the left even though it
	// carries no `creator` (which would otherwise fall through to `true`).
	if (!creator?.id && parseOriginLabel(originLabel)?.source === "planReflection") return false;
	if (!currentUserId) return true;
	const authorId = creator?.id;
	if (!authorId) return true;
	return authorId === currentUserId;
}

/**
 * Attach the authorship flag that decides a bubble's side and tint.
 *
 * Lives in the integration layer for the same reason as the header node, plus one
 * specific to this flag: both sides measure IDENTICALLY, so folding viewer identity
 * into the adapter's data would fork the measure cache per user for a purely cosmetic
 * difference. `render-registry`'s `resolveRenderExtra` only forwards `creator`; the
 * comparison happens here.
 */
export function injectUserBubbleIsSelf(
	kind: VListElementKind,
	extra: RenderExtra,
	currentUserId: string | null | undefined,
): void {
	if (kind !== "message-bubble" || extra.role !== "user") return;
	extra.isSelf = resolveBubbleIsSelf(
		(extra.creator as BubbleCreator | null | undefined) ?? null,
		currentUserId,
		(extra.originLabel as string | null | undefined) ?? null,
	);
}
