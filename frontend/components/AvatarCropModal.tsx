import { Button, Group, Modal, Slider, Stack, Text } from "@mantine/core";
import { useCallback, useState } from "react";
import type { Area } from "react-easy-crop";
import Cropper from "react-easy-crop";
import { useTranslation } from "react-i18next";

interface AvatarCropModalProps {
	opened: boolean;
	onClose: () => void;
	imageSrc: string;
	onConfirm: (blob: Blob) => void;
	loading?: boolean;
}

async function getCroppedBlob(imageSrc: string, crop: Area): Promise<Blob> {
	const image = new Image();
	image.crossOrigin = "anonymous";
	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = reject;
		image.src = imageSrc;
	});

	const canvas = document.createElement("canvas");
	const size = 256;
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas not supported");

	ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, size, size);

	return new Promise<Blob>((resolve, reject) => {
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error("Failed to create blob"))),
			"image/webp",
			0.85,
		);
	});
}

export function AvatarCropModal({
	opened,
	onClose,
	imageSrc,
	onConfirm,
	loading,
}: AvatarCropModalProps) {
	const { t } = useTranslation("settings");
	const [crop, setCrop] = useState({ x: 0, y: 0 });
	const [zoom, setZoom] = useState(1);
	const [croppedArea, setCroppedArea] = useState<Area | null>(null);

	const onCropComplete = useCallback((_: Area, croppedAreaPixels: Area) => {
		setCroppedArea(croppedAreaPixels);
	}, []);

	const handleConfirm = async () => {
		if (!croppedArea) return;
		const blob = await getCroppedBlob(imageSrc, croppedArea);
		onConfirm(blob);
	};

	return (
		<Modal opened={opened} onClose={onClose} title={t("avatarCropTitle")} size="md" centered>
			<Stack gap="md">
				<div style={{ position: "relative", width: "100%", height: 300 }}>
					<Cropper
						image={imageSrc}
						crop={crop}
						zoom={zoom}
						aspect={1}
						cropShape="round"
						showGrid={false}
						onCropChange={setCrop}
						onZoomChange={setZoom}
						onCropComplete={onCropComplete}
					/>
				</div>
				<Group gap="xs" align="center">
					<Text size="sm" c="dimmed">
						{t("avatarZoom")}
					</Text>
					<Slider
						value={zoom}
						onChange={setZoom}
						min={1}
						max={3}
						step={0.1}
						style={{ flex: 1 }}
						label={null}
					/>
				</Group>
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose} disabled={loading}>
						{t("avatarCropCancel")}
					</Button>
					<Button onClick={handleConfirm} loading={loading}>
						{t("avatarCropConfirm")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
