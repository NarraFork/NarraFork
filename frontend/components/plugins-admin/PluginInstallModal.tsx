import { Alert, Button, Modal, Stack, Text, TextInput } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useInstallPlugin } from "../../hooks/usePlugins";
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
	const [path, setPath] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);

	const trimmed = path.trim();
	const extensionError =
		trimmed.length > 0 && !hasSafeExtension(trimmed)
			? t("admin.installModal.invalidExtension")
			: null;

	const close = () => {
		setPath("");
		setLocalError(null);
		install.reset();
		onClose();
	};

	const submit = () => {
		setLocalError(null);
		if (!trimmed) return;
		if (!hasSafeExtension(trimmed)) {
			setLocalError(t("admin.installModal.invalidExtension"));
			return;
		}
		install.mutate(trimmed, { onSuccess: close });
	};

	const serverError = install.error instanceof Error ? localizePluginError(install.error, t) : null;

	return (
		<Modal opened={opened} onClose={close} title={t("admin.installModal.title")} size="md" centered>
			<Stack gap="sm">
				<TextInput
					label={t("admin.installModal.pathLabel")}
					placeholder={t("admin.installModal.pathPlaceholder")}
					description={t("admin.installModal.pathDescription")}
					value={path}
					onChange={(event) => setPath(event.currentTarget.value)}
					error={localError ?? extensionError ?? undefined}
					data-autofocus
				/>
				{serverError && (
					<Alert color="red" variant="light" icon={<IconAlertCircle size={18} />}>
						<Text size="sm">{serverError}</Text>
						{install.error instanceof ApiError && install.error.data?.code ? (
							<Text size="xs" c="dimmed" mt={4}>
								{String(install.error.data.code)}
							</Text>
						) : null}
					</Alert>
				)}
				<Button
					onClick={submit}
					loading={install.isPending}
					disabled={!trimmed || extensionError !== null}
					fullWidth
				>
					{t("admin.installModal.submit")}
				</Button>
			</Stack>
		</Modal>
	);
}
