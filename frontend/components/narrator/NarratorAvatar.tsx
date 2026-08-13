/**
 * NarratorAvatar.tsx — a narrator's (or subagent's) visual identity.
 *
 * Two tiers, in priority order:
 *   1. a custom bitmap the user uploaded (`avatarImageId` → blob via the shared
 *      avatar-serving route, keyed by narrator id), then
 *   2. the deterministic identicon derived from the narrator id — zero storage, always
 *      the same glyph for the same narrator.
 *
 * Why not UserAvatar: that component is initials-based and user-scoped (tooltip with
 * username, blob keyed to user accounts). Subagent titles cluster on a few prefixes
 * ("explore-1", "explore-2"), so initials collide; the identicon keyed on the full id
 * does not. This component shares only the blob-fetch hook, not the user framing.
 */

import { Avatar, type AvatarProps, Tooltip } from "@mantine/core";
import { identiconDataUri } from "@shared/identicon";
import { useMemo } from "react";
import { useAvatarBlobUrl } from "../../hooks/useAvatarBlobUrl";

export interface NarratorAvatarProps extends Omit<AvatarProps, "src" | "children"> {
	/** The narrator id — seeds the identicon and keys the custom-avatar blob lookup. */
	narratorId: string;
	/** Custom uploaded avatar image id; null/absent → identicon fallback. */
	avatarImageId?: string | null;
	/** Display name for the tooltip (narrator title). */
	title?: string | null;
	showTooltip?: boolean;
}

export function NarratorAvatar({
	narratorId,
	avatarImageId,
	title,
	showTooltip = true,
	...props
}: NarratorAvatarProps) {
	// The avatar-serving route keys the directory by the id segment with no users-table
	// FK, so the narrator id reuses it directly. Only fetched when a custom image exists.
	const blobUrl = useAvatarBlobUrl(narratorId, avatarImageId ?? null);

	// Deterministic glyph, memoized per id — derived, never stored.
	const identiconSrc = useMemo(() => identiconDataUri(narratorId), [narratorId]);

	const src = blobUrl ?? identiconSrc;
	const avatar = <Avatar {...props} src={src} alt={title ?? narratorId} radius="sm" />;

	if (!showTooltip) return avatar;
	return <Tooltip label={title ?? narratorId}>{avatar}</Tooltip>;
}
