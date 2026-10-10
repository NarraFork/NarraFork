import { Avatar, Button, FileButton, Group, Stack } from "@mantine/core";
import { IconTrash, IconUpload } from "@tabler/icons-react";
import type { UseMutationResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { UserAvatar } from "../UserAvatar";

export interface ProfileSectionProps {
	currentUser:
		| {
				id: string;
				username: string;
				avatarColor: string | null;
				avatarImageId: string | null;
		  }
		| undefined;
	handleAvatarFileSelected: (file: File | null) => void;
	handleDeleteAvatar: () => void;
	// biome-ignore lint/suspicious/noExplicitAny: mutation hook type
	deleteAvatar: UseMutationResult<any, any, any, any>;
}

export function ProfileSection({
	currentUser,
	handleAvatarFileSelected,
	handleDeleteAvatar,
	deleteAvatar,
}: ProfileSectionProps) {
	const { t } = useTranslation("settings");

	return (
		<Stack>
			<Group>
				{currentUser ? (
					<UserAvatar
						username={currentUser.username}
						avatarColor={currentUser.avatarColor}
						avatarImageId={currentUser.avatarImageId}
						userId={currentUser.id}
						size={80}
						showTooltip={false}
					/>
				) : (
					<Avatar size={80} />
				)}
				<Stack gap="xs">
					<FileButton onChange={handleAvatarFileSelected} accept="image/png,image/jpeg,image/webp">
						{(props) => (
							<Button {...props} variant="light" size="xs" leftSection={<IconUpload size={14} />}>
								{t("avatarUpload")}
							</Button>
						)}
					</FileButton>
					{currentUser?.avatarImageId && (
						<Button
							variant="subtle"
							color="red"
							size="xs"
							leftSection={<IconTrash size={14} />}
							onClick={handleDeleteAvatar}
							loading={deleteAvatar.isPending}
						>
							{t("avatarDelete")}
						</Button>
					)}
				</Stack>
			</Group>
		</Stack>
	);
}
