import { useChapterContainersCapability } from "@frontend/hooks/usePlatform";
import { api } from "@frontend/lib/api";
import { Button, Code, Group, Loader, Modal, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconCheck, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

interface PodmanInstallModalProps {
	opened: boolean;
	onClose: () => void;
}

const INSTALL_HINTS: Record<string, string> = {
	macos: "brew install podman && podman machine init && podman machine start",
	linux: "sudo apt-get install -y podman  # or dnf / pacman",
	windows: "winget install -e --id RedHat.Podman",
};

export function PodmanInstallModal({ opened, onClose }: PodmanInstallModalProps) {
	const { t } = useTranslation("containers");
	const qc = useQueryClient();
	const containerCapability = useChapterContainersCapability();
	const containerCapabilityReason = containerCapability.reason ?? t("capabilityUnsupported");
	const canReadPodmanStatus =
		containerCapability.supported && containerCapability.routes.podmanStatus;
	const canInstallPodman =
		containerCapability.supported && containerCapability.routes.podmanInstall;

	const { data: status, isLoading } = useQuery({
		queryKey: ["podmanStatus"],
		queryFn: api.getPodmanStatus,
		enabled: opened && canReadPodmanStatus,
	});

	const install = useMutation({
		mutationFn: api.installPodman,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["podmanStatus"] });
		},
	});

	const platform = status?.platform ?? "linux";
	const hint = INSTALL_HINTS[platform] ?? INSTALL_HINTS.linux;
	const statusFallbackMessage = status?.reason ?? status?.message ?? status?.error ?? status?.code;
	const showInstallHint = canReadPodmanStatus && status?.supported !== false;

	return (
		<Modal opened={opened} onClose={onClose} title={t("podman.title")} size="md">
			<Stack gap="md">
				{isLoading ? (
					<Loader size="sm" />
				) : !canReadPodmanStatus ? (
					<Group gap="xs">
						<ThemeIcon color="gray" size="sm" variant="light">
							<IconX size={14} />
						</ThemeIcon>
						<Text size="sm">{containerCapabilityReason}</Text>
					</Group>
				) : status?.supported === false ? (
					<Group gap="xs">
						<ThemeIcon color="gray" size="sm" variant="light">
							<IconX size={14} />
						</ThemeIcon>
						<Text size="sm">{statusFallbackMessage ?? t("podman.unsupportedPlatform")}</Text>
					</Group>
				) : status?.installed ? (
					<Group gap="xs">
						<ThemeIcon color="green" size="sm" variant="light">
							<IconCheck size={14} />
						</ThemeIcon>
						<Text size="sm">{t("podman.installed", { version: status.version })}</Text>
					</Group>
				) : (
					<Group gap="xs">
						<ThemeIcon color="red" size="sm" variant="light">
							<IconX size={14} />
						</ThemeIcon>
						<Text size="sm">{statusFallbackMessage ?? t("podman.notInstalled")}</Text>
					</Group>
				)}

				{showInstallHint && (
					<div>
						<Text size="sm" fw={500} mb={4}>
							{t("podman.installCommand")}
						</Text>
						<Code block style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
							{hint}
						</Code>
					</div>
				)}

				{install.isError && (
					<Text size="sm" c="red">
						{t("podman.installFailed")}: {(install.error as Error).message}
					</Text>
				)}

				{install.isSuccess && install.data?.ok && (
					<Group gap="xs">
						<ThemeIcon color="green" size="sm" variant="light">
							<IconCheck size={14} />
						</ThemeIcon>
						<Text size="sm" c="green">
							{t("podman.installSuccess", { version: install.data.version })}
						</Text>
					</Group>
				)}

				<Group justify="flex-end">
					{!status?.installed && status?.supported !== false && (
						<Button
							onClick={() => canInstallPodman && install.mutate()}
							loading={install.isPending}
							disabled={status?.installed || !canInstallPodman}
							title={!canInstallPodman ? containerCapabilityReason : undefined}
						>
							{t("podman.installButton")}
						</Button>
					)}
					<Button variant="subtle" onClick={onClose}>
						{t("podman.close")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
