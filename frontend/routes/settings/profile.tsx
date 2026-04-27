import { Loader, Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AvatarCropModal } from "../../components/AvatarCropModal";
import { ProfileSection } from "../../components/settings/ProfileSection";
import {
	useCurrentUser,
	useDeleteAvatar,
	useUpdateProfile,
	useUploadAvatar,
} from "../../hooks/useAuth";

export const Route = createFileRoute("/settings/profile")({
	component: SettingsProfilePage,
});

function SettingsProfilePage() {
	const { t } = useTranslation("settings");
	const { data: currentUser, isLoading } = useCurrentUser();
	const uploadAvatar = useUploadAvatar();
	const deleteAvatar = useDeleteAvatar();
	const updateProfile = useUpdateProfile();
	const [cropSrc, setCropSrc] = useState<string | null>(null);
	const cropSrcRef = useRef<string | null>(null);
	const [gitUsername, setGitUsername] = useState("");
	const [gitEmail, setGitEmail] = useState("");
	const [gitDirty, setGitDirty] = useState(false);

	useEffect(() => {
		if (currentUser) {
			setGitUsername(currentUser.gitUsername ?? "");
			setGitEmail(currentUser.gitEmail ?? "");
		}
	}, [currentUser]);

	useEffect(() => {
		return () => {
			if (cropSrcRef.current) {
				URL.revokeObjectURL(cropSrcRef.current);
				cropSrcRef.current = null;
			}
		};
	}, []);

	const clearCropSrc = () => {
		setCropSrc((prev) => {
			if (prev) URL.revokeObjectURL(prev);
			cropSrcRef.current = null;
			return null;
		});
	};

	const handleAvatarFileSelected = (file: File | null) => {
		if (!file) return;
		const url = URL.createObjectURL(file);
		setCropSrc((prev) => {
			if (prev) URL.revokeObjectURL(prev);
			cropSrcRef.current = url;
			return url;
		});
	};

	const handleCropConfirm = (blob: Blob) => {
		const file = new File([blob], "avatar.webp", { type: "image/webp" });
		uploadAvatar.mutate(file, { onSuccess: () => clearCropSrc() });
	};

	const handleDeleteAvatar = () => {
		if (window.confirm(t("avatarDeleteConfirm"))) {
			deleteAvatar.mutate();
		}
	};

	const handleGitSave = () => {
		updateProfile.mutate({ gitUsername, gitEmail }, { onSuccess: () => setGitDirty(false) });
	};

	if (isLoading) return <Loader />;

	return (
		<Stack>
			<Title order={3}>{t("profileSection")}</Title>
			<ProfileSection
				currentUser={currentUser}
				gitUsername={gitUsername}
				setGitUsername={setGitUsername}
				gitEmail={gitEmail}
				setGitEmail={setGitEmail}
				gitDirty={gitDirty}
				setGitDirty={setGitDirty}
				handleAvatarFileSelected={handleAvatarFileSelected}
				handleDeleteAvatar={handleDeleteAvatar}
				handleGitSave={handleGitSave}
				uploadAvatar={uploadAvatar}
				deleteAvatar={deleteAvatar}
				updateProfile={updateProfile}
			/>
			{cropSrc && (
				<AvatarCropModal
					opened={!!cropSrc}
					onClose={clearCropSrc}
					imageSrc={cropSrc}
					onConfirm={handleCropConfirm}
					loading={uploadAvatar.isPending}
				/>
			)}
		</Stack>
	);
}
