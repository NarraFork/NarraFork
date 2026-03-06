import { Avatar, type AvatarProps, Tooltip } from "@mantine/core";
import { useAvatarBlobUrl } from "../hooks/useAvatarBlobUrl";

interface UserAvatarProps extends Omit<AvatarProps, "color" | "children" | "src"> {
	username: string;
	avatarColor?: string | null;
	avatarImageId?: string | null;
	userId?: string | null;
	showTooltip?: boolean;
}

export function UserAvatar({
	username,
	avatarColor,
	avatarImageId,
	userId,
	showTooltip = true,
	...props
}: UserAvatarProps) {
	const blobUrl = useAvatarBlobUrl(userId, avatarImageId);
	const initials = username.slice(0, 2).toUpperCase();

	const avatar = blobUrl ? (
		<Avatar {...props} src={blobUrl} alt={username} />
	) : (
		<Avatar {...props} style={{ ...props.style, backgroundColor: avatarColor ?? undefined }}>
			{initials}
		</Avatar>
	);

	if (!showTooltip) return avatar;
	return <Tooltip label={username}>{avatar}</Tooltip>;
}
