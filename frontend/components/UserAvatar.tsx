import { Avatar, type AvatarProps, Tooltip } from "@mantine/core";

interface UserAvatarProps extends Omit<AvatarProps, "color" | "children"> {
	username: string;
	avatarColor?: string | null;
	showTooltip?: boolean;
}

export function UserAvatar({
	username,
	avatarColor,
	showTooltip = true,
	...props
}: UserAvatarProps) {
	const initials = username.slice(0, 2).toUpperCase();
	const avatar = (
		<Avatar {...props} style={{ ...props.style, backgroundColor: avatarColor ?? undefined }}>
			{initials}
		</Avatar>
	);
	if (!showTooltip) return avatar;
	return <Tooltip label={username}>{avatar}</Tooltip>;
}
