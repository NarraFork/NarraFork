import { Loader, Stack, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/confirm-dialog-context";
import { GitIdentitiesSection } from "../../components/settings/GitIdentitiesSection";
import { ProfileSection } from "../../components/settings/ProfileSection";
import { useCurrentUser, useDeleteAvatar, useUploadAvatar } from "../../hooks/useAuth";

const AvatarCropModal = lazy(() =>
	import("../../components/AvatarCropModal").then((m) => ({ default: m.AvatarCropModal })),
);

export const Route = createFileRoute("/settings/profile")({
	component: SettingsProfilePage,
});

const MAX_AVATAR_SOURCE_FILE_BYTES = 20 * 1024 * 1024;

function SettingsProfilePage() {
	const { t } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const { data: currentUser, isLoading } = useCurrentUser();
	const uploadAvatar = useUploadAvatar();
	const deleteAvatar = useDeleteAvatar();
	const [cropSrc, setCropSrc] = useState<string | null>(null);
	const cropSrcRef = useRef<string | null>(null);

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
		if (file.size > MAX_AVATAR_SOURCE_FILE_BYTES) {
			notifications.show({ color: "red", message: t("avatarFileTooLarge", { max: "20 MB" }) });
			return;
		}
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

	const handleDeleteAvatar = async () => {
		if (await confirm({ message: t("avatarDeleteConfirm") })) {
			deleteAvatar.mutate();
		}
	};

	if (isLoading) return <Loader />;

	return (
		<Stack>
			<Title order={3}>{t("profileSection")}</Title>
			<ProfileSection
				currentUser={currentUser}
				handleAvatarFileSelected={handleAvatarFileSelected}
				handleDeleteAvatar={handleDeleteAvatar}
				deleteAvatar={deleteAvatar}
			/>
			<GitIdentitiesSection />
			{cropSrc && (
				<Suspense fallback={null}>
					<AvatarCropModal
						opened={!!cropSrc}
						onClose={clearCropSrc}
						imageSrc={cropSrc}
						onConfirm={handleCropConfirm}
						loading={uploadAvatar.isPending}
					/>
				</Suspense>
			)}
		</Stack>
	);
}
