import { Menu, Text, UnstyledButton } from "@mantine/core";
import { IconLicense, IconLogout, IconMessageReport, IconSettings } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { UserAvatar } from "../UserAvatar";

interface NavUserMenuProps {
	/** Trigger logout confirmation (opens the confirm modal in the parent). */
	onLogout: () => void;
}

/**
 * Bottom-bar user menu: avatar button that opens a popup with the profile, feedback,
 * version / licenses and logout. Sits opposite the "More" overflow menu.
 */
export function NavUserMenu({ onLogout }: NavUserMenuProps) {
	const { t } = useTranslation("nav");
	const navigate = useNavigate();
	const { data: user } = useCurrentUser();

	if (!user) return null;

	return (
		<Menu position="top-start" withArrow shadow="md" width={220}>
			<Menu.Target>
				<UnstyledButton
					aria-label={user.username}
					style={{ display: "flex", flexShrink: 0, borderRadius: "50%" }}
				>
					<UserAvatar
						username={user.username}
						avatarColor={user.avatarColor}
						avatarImageId={user.avatarImageId}
						userId={user.id}
						size={28}
						radius="xl"
						showTooltip={false}
					/>
				</UnstyledButton>
			</Menu.Target>
			<Menu.Dropdown>
				<Menu.Label>
					<Text size="sm" fw={600} truncate>
						{user.username}
					</Text>
				</Menu.Label>
				<Menu.Item
					leftSection={<IconSettings size={14} />}
					onClick={() => navigate({ to: "/settings/profile" })}
				>
					{t("profile")}
				</Menu.Item>
				<Menu.Item
					leftSection={<IconMessageReport size={14} />}
					component="a"
					href="https://github.com/NarraFork/NarraFork/issues"
					target="_blank"
					rel="noopener noreferrer"
				>
					{t("feedback")}
				</Menu.Item>
				<Menu.Item
					leftSection={<IconLicense size={14} />}
					onClick={() => navigate({ to: "/licenses" })}
					rightSection={
						<Text size="xs" c="dimmed">
							v{__APP_VERSION__}
						</Text>
					}
				>
					{t("licenses")}
				</Menu.Item>
				<Menu.Divider />
				<Menu.Item color="red" leftSection={<IconLogout size={14} />} onClick={onLogout}>
					{t("logout")}
				</Menu.Item>
			</Menu.Dropdown>
		</Menu>
	);
}
