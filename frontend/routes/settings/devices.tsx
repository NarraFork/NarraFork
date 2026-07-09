import {
	Alert,
	Badge,
	Box,
	Button,
	Card,
	Checkbox,
	Code,
	CopyButton,
	Group,
	Loader,
	Modal,
	Select,
	Stack,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/ConfirmDialogProvider";
import { api } from "../../lib/api";
import type { CreateDeviceInput, RemoteDevice } from "../../lib/api/devices";

export const Route = createFileRoute("/settings/devices")({
	component: SettingsDevicesPage,
});

function SettingsDevicesPage() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const confirm = useConfirmDialog();
	const [createOpen, setCreateOpen] = useState(false);
	const [issuedToken, setIssuedToken] = useState<{ name: string; token: string } | null>(null);
	const [transferDevice, setTransferDevice] = useState<RemoteDevice | null>(null);

	const { data: devices, isLoading } = useQuery({
		queryKey: ["devices"],
		queryFn: () => api.listDevices(),
		refetchInterval: 10_000,
	});

	const createMut = useMutation({
		mutationFn: (input: CreateDeviceInput) => api.createDevice(input),
		onSuccess: (res) => {
			qc.invalidateQueries({ queryKey: ["devices"] });
			setCreateOpen(false);
			setIssuedToken({ name: res.device.name, token: res.token });
		},
		onError: (err) =>
			notifications.show({
				color: "red",
				message: err instanceof Error ? err.message : String(err),
			}),
	});

	const rotateMut = useMutation({
		mutationFn: (id: string) => api.rotateDeviceToken(id),
		onSuccess: (res, id) => {
			const dev = devices?.find((d) => d.id === id);
			setIssuedToken({ name: dev?.name ?? id, token: res.token });
		},
	});

	const deleteMut = useMutation({
		mutationFn: (id: string) => api.deleteDevice(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["devices"] }),
	});

	return (
		<Box maw={860}>
			<Group justify="space-between" mb="md">
				<Title order={3}>{t("devicesSection")}</Title>
				<Button onClick={() => setCreateOpen(true)}>{t("deviceAddButton")}</Button>
			</Group>

			<Text c="dimmed" size="sm" mb="lg">
				{t("devicesDescription")}
			</Text>

			{isLoading ? (
				<Loader />
			) : !devices || devices.length === 0 ? (
				<Alert color="gray">{t("devicesEmpty")}</Alert>
			) : (
				<Stack>
					{devices.map((d) => (
						<DeviceCard
							key={d.id}
							device={d}
							onTransfer={() => setTransferDevice(d)}
							onRotate={() => rotateMut.mutate(d.id)}
							onDelete={async () => {
								const ok = await confirm({
									title: t("deviceDeleteConfirmTitle"),
									message: t("deviceDeleteConfirmMessage", { name: d.name }),
									confirmLabel: t("deviceDeleteButton"),
									confirmColor: "red",
								});
								if (ok) deleteMut.mutate(d.id);
							}}
						/>
					))}
				</Stack>
			)}

			<CreateDeviceModal
				opened={createOpen}
				onClose={() => setCreateOpen(false)}
				onSubmit={(input) => createMut.mutate(input)}
				loading={createMut.isPending}
			/>

			<TokenModal issued={issuedToken} onClose={() => setIssuedToken(null)} />

			<TransferModal device={transferDevice} onClose={() => setTransferDevice(null)} />
		</Box>
	);
}

function TransferModal({ device, onClose }: { device: RemoteDevice | null; onClose: () => void }) {
	const { t } = useTranslation("settings");
	const [direction, setDirection] = useState<"download" | "upload">("download");
	const [remotePath, setRemotePath] = useState("");
	const [localPath, setLocalPath] = useState("");
	const [recursive, setRecursive] = useState(false);

	const transferMut = useMutation({
		mutationFn: () => {
			if (!device) throw new Error("no device");
			return api.transferDeviceFile(device.id, { direction, remotePath, localPath, recursive });
		},
		onSuccess: (res) => {
			notifications.show({
				color: "green",
				message: t("deviceTransferDone", {
					files: res.filesTransferred,
					bytes: formatBytes(res.bytesTransferred),
				}),
			});
			onClose();
		},
		onError: (err) =>
			notifications.show({
				color: "red",
				message: err instanceof Error ? err.message : String(err),
			}),
	});

	return (
		<Modal
			opened={!!device}
			onClose={onClose}
			title={t("deviceTransferTitle", { name: device?.name ?? "" })}
		>
			<Stack>
				<Select
					label={t("deviceTransferDirection")}
					data={[
						{ value: "download", label: t("deviceTransferDownload") },
						{ value: "upload", label: t("deviceTransferUpload") },
					]}
					value={direction}
					onChange={(v) => setDirection((v as "download" | "upload") ?? "download")}
				/>
				<TextInput
					label={t("deviceTransferRemotePath")}
					placeholder="/home/user/file.bin"
					value={remotePath}
					onChange={(e) => setRemotePath(e.currentTarget.value)}
				/>
				<TextInput
					label={t("deviceTransferLocalPath")}
					placeholder="/path/on/server/file.bin"
					value={localPath}
					onChange={(e) => setLocalPath(e.currentTarget.value)}
				/>
				<Checkbox
					label={t("deviceTransferRecursive")}
					checked={recursive}
					onChange={(e) => setRecursive(e.currentTarget.checked)}
				/>
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button
						loading={transferMut.isPending}
						disabled={!remotePath.trim() || !localPath.trim()}
						onClick={() => transferMut.mutate()}
					>
						{t("deviceTransferStart")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function DeviceCard({
	device,
	onRotate,
	onDelete,
	onTransfer,
}: {
	device: RemoteDevice;
	onRotate: () => void;
	onDelete: () => void;
	onTransfer: () => void;
}) {
	const { t } = useTranslation("settings");
	const platform =
		device.platformOs && device.platformArch ? `${device.platformOs}/${device.platformArch}` : "—";
	return (
		<Card withBorder padding="md">
			<Group justify="space-between" align="flex-start">
				<Stack gap={4}>
					<Group gap="xs">
						<Text fw={600}>{device.name}</Text>
						<Badge color={device.status === "online" ? "green" : "gray"} variant="light">
							{device.status === "online" ? t("deviceOnline") : t("deviceOffline")}
						</Badge>
						<Badge variant="outline">{device.connectionMode}</Badge>
					</Group>
					{device.description ? (
						<Text size="sm" c="dimmed">
							{device.description}
						</Text>
					) : null}
					<Text size="xs" c="dimmed">
						<Code>{device.slug}</Code> · {platform} · {t("deviceTokenPrefix")}: {device.tokenPrefix}
						…{device.defaultCwd ? ` · ${device.defaultCwd}` : ""}
					</Text>
				</Stack>
				<Group gap="xs">
					{device.status === "online" ? (
						<Button size="xs" variant="light" onClick={onTransfer}>
							{t("deviceTransferButton")}
						</Button>
					) : null}
					<Button size="xs" variant="light" onClick={onRotate}>
						{t("deviceRotateButton")}
					</Button>
					<Button size="xs" variant="light" color="red" onClick={onDelete}>
						{t("deviceDeleteButton")}
					</Button>
				</Group>
			</Group>
		</Card>
	);
}

function CreateDeviceModal({
	opened,
	onClose,
	onSubmit,
	loading,
}: {
	opened: boolean;
	onClose: () => void;
	onSubmit: (input: CreateDeviceInput) => void;
	loading: boolean;
}) {
	const { t } = useTranslation("settings");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [mode, setMode] = useState<"reverse" | "direct">("reverse");
	const [directUrl, setDirectUrl] = useState("");

	return (
		<Modal opened={opened} onClose={onClose} title={t("deviceAddButton")}>
			<Stack>
				<TextInput
					label={t("deviceNameLabel")}
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					required
				/>
				<Textarea
					label={t("deviceDescriptionLabel")}
					value={description}
					onChange={(e) => setDescription(e.currentTarget.value)}
					autosize
					minRows={2}
				/>
				<Select
					label={t("deviceModeLabel")}
					data={[
						{ value: "reverse", label: t("deviceModeReverse") },
						{ value: "direct", label: t("deviceModeDirect") },
					]}
					value={mode}
					onChange={(v) => setMode((v as "reverse" | "direct") ?? "reverse")}
				/>
				{mode === "direct" ? (
					<TextInput
						label={t("deviceDirectUrlLabel")}
						placeholder="ws://host:port/ws/device"
						value={directUrl}
						onChange={(e) => setDirectUrl(e.currentTarget.value)}
					/>
				) : null}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button
						loading={loading}
						disabled={!name.trim() || (mode === "direct" && !directUrl.trim())}
						onClick={() =>
							onSubmit({
								name: name.trim(),
								description: description.trim() || undefined,
								connectionMode: mode,
								directUrl: mode === "direct" ? directUrl.trim() : undefined,
								scope: "global",
							})
						}
					>
						{t("deviceCreateSubmit")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function TokenModal({
	issued,
	onClose,
}: {
	issued: { name: string; token: string } | null;
	onClose: () => void;
}) {
	const { t } = useTranslation("settings");
	return (
		<Modal opened={!!issued} onClose={onClose} title={t("deviceTokenModalTitle")}>
			{issued ? (
				<Stack>
					<Alert color="yellow">{t("deviceTokenWarning")}</Alert>
					<Text size="sm">{t("deviceTokenForDevice", { name: issued.name })}</Text>
					<Code block>{issued.token}</Code>
					<CopyButton value={issued.token}>
						{({ copied, copy }) => (
							<Button onClick={copy} variant="light">
								{copied ? t("copied") : t("copy")}
							</Button>
						)}
					</CopyButton>
					<Text size="xs" c="dimmed">
						{t("deviceRunHint")}
					</Text>
					<Code block>
						{`narrafork-executor --server wss://<host>/ws/device \\\n  --device <slug> --token ${issued.token}`}
					</Code>
				</Stack>
			) : null}
		</Modal>
	);
}
