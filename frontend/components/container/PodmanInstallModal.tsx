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

	const { data: status, isLoading } = useQuery({
		queryKey: ["podmanStatus"],
		queryFn: api.getPodmanStatus,
		enabled: opened,
	});

	const install = useMutation({
		mutationFn: api.installPodman,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["podmanStatus"] });
		},
	});

	const platform = status?.platform ?? "linux";
	const hint = INSTALL_HINTS[platform] ?? INSTALL_HINTS.linux;

	return (
		<Modal opened={opened} onClose={onClose} title={t("podman.title")} size="md">
			<Stack gap="md">
				{isLoading ? (
					<Loader size="sm" />
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
						<Text size="sm">{t("podman.notInstalled")}</Text>
					</Group>
				)}

				<div>
					<Text size="sm" fw={500} mb={4}>
						{t("podman.installCommand")}
					</Text>
					<Code block style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
						{hint}
					</Code>
				</div>

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
					{!status?.installed && (
						<Button
							onClick={() => install.mutate()}
							loading={install.isPending}
							disabled={status?.installed}
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
