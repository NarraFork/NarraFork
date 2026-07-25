import {
	Alert,
	Button,
	Divider,
	FileButton,
	Group,
	Modal,
	Progress,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { IconAlertCircle, IconUpload } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useInstallPlugin, useInstallSources, useUploadPlugin } from "../../hooks/usePlugins";
import { ApiError } from "../../lib/api";
import { localizePluginError } from "./errors";

const SAFE_ARCHIVE_EXTENSIONS = [".nfplugin", ".zip"] as const;

function hasSafeExtension(path: string): boolean {
	const lower = path.trim().toLowerCase();
	return SAFE_ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function PluginInstallModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
	const { t } = useTranslation("plugins");
	const install = useInstallPlugin();
	const upload = useUploadPlugin();
	const sourcesQuery = useInstallSources(opened);
	const [path, setPath] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const [progress, setProgress] = useState(0);

	const trimmed = path.trim();
	const extensionError =
		trimmed.length > 0 && !hasSafeExtension(trimmed)
			? t("admin.installModal.invalidExtension")
			: null;
	const busy = install.isPending || upload.isPending;

	const close = () => {
		setPath("");
		setLocalError(null);
		setProgress(0);
		install.reset();
		upload.reset();
		onClose();
	};

	const submitPath = () => {
		setLocalError(null);
		if (!trimmed) return;
		if (!hasSafeExtension(trimmed)) {
			setLocalError(t("admin.installModal.invalidExtension"));
			return;
		}
		install.mutate(trimmed, { onSuccess: close });
	};

	const submitUpload = (file: File | null) => {
		if (!file) return;
		setLocalError(null);
		if (!hasSafeExtension(file.name)) {
			setLocalError(t("admin.installModal.invalidExtension"));
			return;
		}
		setProgress(0);
		upload.mutate(
			{ file, onProgress: (f) => setProgress(Math.round(f * 100)) },
			{ onSuccess: close },
		);
	};

	const activeError = install.error ?? upload.error;
	const serverError = activeError instanceof Error ? localizePluginError(activeError, t) : null;

	return (
		<Modal opened={opened} onClose={close} title={t("admin.installModal.title")} size="md" centered>
			<Stack gap="sm">
				{/* Upload a package from the browser */}
				<Text size="sm" fw={500}>
					{t("admin.installModal.uploadLabel")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("admin.installModal.uploadDescription")}
				</Text>
				<Group>
					<FileButton onChange={submitUpload} accept=".zip,.nfplugin">
						{(props) => (
							<Button
								{...props}
								leftSection={<IconUpload size={16} />}
								variant="light"
								loading={upload.isPending}
								disabled={install.isPending}
							>
								{t("admin.installModal.chooseFile")}
							</Button>
						)}
					</FileButton>
				</Group>
				{upload.isPending && (
					<Progress
						value={progress}
						striped
						animated
						aria-label={t("admin.installModal.uploading")}
					/>
				)}

				<Divider label={t("admin.installModal.orDivider")} labelPosition="center" my="xs" />

				{/* Pick a package already present under the server import root */}
				{(sourcesQuery.data?.length ?? 0) > 0 && (
					<Select
						label={t("admin.installModal.sourceLabel")}
						description={t("admin.installModal.sourceDescription")}
						placeholder={t("admin.installModal.sourcePlaceholder")}
						data={(sourcesQuery.data ?? []).map((s) => ({ value: s.path, label: s.name }))}
						value={sourcesQuery.data?.some((s) => s.path === path) ? path : null}
						onChange={(v) => {
							setLocalError(null);
							setPath(v ?? "");
						}}
						searchable
						clearable
					/>
				)}

				{/* Or type a package path directly (confined to the import root) */}
				<TextInput
					label={t("admin.installModal.pathLabel")}
					placeholder={t("admin.installModal.pathPlaceholder")}
					description={t("admin.installModal.pathDescription")}
					value={path}
					onChange={(event) => setPath(event.currentTarget.value)}
					error={localError ?? extensionError ?? undefined}
				/>
				{serverError && (
					<Alert color="red" variant="light" icon={<IconAlertCircle size={18} />}>
						<Text size="sm">{serverError}</Text>
						{activeError instanceof ApiError && activeError.data?.code ? (
							<Text size="xs" c="dimmed" mt={4}>
								{String(activeError.data.code)}
							</Text>
						) : null}
					</Alert>
				)}
				<Button
					onClick={submitPath}
					loading={install.isPending}
					disabled={!trimmed || extensionError !== null || busy}
					fullWidth
				>
					{t("admin.installModal.submit")}
				</Button>
			</Stack>
		</Modal>
	);
}
