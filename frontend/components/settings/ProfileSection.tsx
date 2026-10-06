import { Avatar, Button, FileButton, Group, Stack, TextInput } from "@mantine/core";
import { IconBrandGithub, IconDeviceFloppy, IconTrash, IconUpload } from "@tabler/icons-react";
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
				gitUsername: string | null;
				gitEmail: string | null;
		  }
		| undefined;
	gitUsername: string;
	setGitUsername: (v: string) => void;
	gitEmail: string;
	setGitEmail: (v: string) => void;
	gitDirty: boolean;
	setGitDirty: (v: boolean) => void;
	handleAvatarFileSelected: (file: File | null) => void;
	handleDeleteAvatar: () => void;
	handleGitSave: () => void;
	// biome-ignore lint/suspicious/noExplicitAny: mutation hook type
	uploadAvatar: UseMutationResult<any, any, any, any>;
	// biome-ignore lint/suspicious/noExplicitAny: mutation hook type
	deleteAvatar: UseMutationResult<any, any, any, any>;
	// biome-ignore lint/suspicious/noExplicitAny: mutation hook type
	updateProfile: UseMutationResult<any, any, any, any>;
}

export function ProfileSection({
	currentUser,
	gitUsername,
	setGitUsername,
	gitEmail,
	setGitEmail,
	gitDirty,
	setGitDirty,
	handleAvatarFileSelected,
	handleDeleteAvatar,
	handleGitSave,
	deleteAvatar,
	updateProfile,
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
			<TextInput
				label={t("gitUsername")}
				placeholder={t("gitUsernamePlaceholder")}
				leftSection={<IconBrandGithub size={16} />}
				value={gitUsername}
				onChange={(e) => {
					setGitUsername(e.currentTarget.value);
					setGitDirty(true);
				}}
			/>
			<TextInput
				label={t("gitEmail")}
				placeholder={t("gitEmailPlaceholder")}
				value={gitEmail}
				onChange={(e) => {
					setGitEmail(e.currentTarget.value);
					setGitDirty(true);
				}}
			/>
			{gitDirty && (
				<Group>
					<Button
						size="xs"
						leftSection={<IconDeviceFloppy size={14} />}
						onClick={handleGitSave}
						loading={updateProfile.isPending}
					>
						{t("common:save")}
					</Button>
				</Group>
			)}
		</Stack>
	);
}
