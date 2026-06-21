import {
	Button,
	Center,
	Code,
	Container,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconBrandGit, IconDownload, IconPlayerPlay, IconRefresh } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, getToken } from "../lib/api";
import { Z } from "../lib/z-index";

const OVERLAY_Z_INDEX = Z.criticalOverlay;
const MODAL_Z_INDEX = Z.criticalModal;

/**
 * Full-screen overlay shown when the backend reports git is not installed.
 * Provides one-click install (when a package manager is detected), a manual
 * download link, a recheck button, and a "skip" option. It is only shown after
 * login so first-time account creation is not blocked by Git setup.
 */
export function GitMissingAlert() {
	const { t } = useTranslation("common");
	const qc = useQueryClient();
	const hasToken = !!getToken();
	const [skipped, setSkipped] = useState(false);
	const [confirmOpened, { open: openConfirm, close: closeConfirm }] = useDisclosure(false);

	const {
		data: health,
		refetch,
		isRefetching,
	} = useQuery({
		queryKey: ["health"],
		queryFn: () => api.health(),
		staleTime: Number.POSITIVE_INFINITY,
		enabled: hasToken,
	});

	const { data: deps } = useQuery({
		queryKey: ["dependencies"],
		queryFn: api.checkDependencies,
		staleTime: 5 * 60 * 1000,
		// Only fetch when an authenticated user can act on missing Git.
		enabled: hasToken && !!health && !health.gitAvailable,
	});

	const installMutation = useMutation({
		mutationFn: () => api.installDependency("git"),
		onSuccess: (result) => {
			if (result.ok) {
				// Refresh health + deps
				qc.invalidateQueries({ queryKey: ["health"] });
				qc.invalidateQueries({ queryKey: ["dependencies"] });
			}
			closeConfirm();
		},
		onError: () => {
			closeConfirm();
		},
	});

	// Don't render anything before login, while health is loading, or when Git is available.
	if (!hasToken || !health || health.gitAvailable) return null;

	// User chose to skip — let them through
	if (skipped) return null;

	const pm = deps?.packageManager;
	const gitDep = deps?.dependencies.find((d) => d.name === "git");
	const installCmd = pm && gitDep?.installCommands[pm] ? gitDep.installCommands[pm] : null;
	const canInstall = hasToken;

	return (
		<>
			<Center
				h="100vh"
				w="100vw"
				pos="fixed"
				top={0}
				left={0}
				style={{ zIndex: OVERLAY_Z_INDEX, backgroundColor: "var(--mantine-color-body)" }}
			>
				<Container size="xs" ta="center">
					<IconBrandGit size={64} color="var(--mantine-color-red-6)" />
					<Title order={2} mt="md" mb="sm">
						{t("gitNotInstalled")}
					</Title>
					<Text c="dimmed" mb="lg">
						{t("gitNotInstalledDesc")}
					</Text>
					<Stack gap="sm" align="center">
						{/* One-click install — when package manager is detected and install is allowed. */}
						{installCmd && canInstall ? (
							<Button
								size="lg"
								leftSection={<IconPlayerPlay size={20} />}
								onClick={openConfirm}
								loading={installMutation.isPending}
							>
								{t("gitInstallNow")}
							</Button>
						) : deps && !pm ? (
							<Text size="sm" c="dimmed">
								{t("gitNoPackageManager")}
							</Text>
						) : null}

						{/* Manual download fallback */}
						<Button
							component="a"
							href="https://git-scm.com/downloads"
							target="_blank"
							rel="noopener noreferrer"
							variant="light"
							leftSection={<IconDownload size={16} />}
						>
							{t("gitDownload")}
						</Button>

						{/* Recheck */}
						<Button
							variant="subtle"
							leftSection={<IconRefresh size={16} />}
							onClick={() => refetch()}
							loading={isRefetching}
						>
							{t("gitRecheck")}
						</Button>

						{/* Skip */}
						<div>
							<Button variant="subtle" color="dimmed" size="xs" onClick={() => setSkipped(true)}>
								{t("gitSkip")}
							</Button>
							<Text size="xs" c="dimmed" mt={4} maw={360}>
								{t("gitSkipDesc")}
							</Text>
						</div>
					</Stack>
				</Container>
			</Center>

			{/* Confirm install modal */}
			<Modal
				opened={confirmOpened}
				onClose={closeConfirm}
				title={t("gitInstallConfirmTitle")}
				centered
				size="md"
				zIndex={MODAL_Z_INDEX}
			>
				<Stack gap="md">
					<Text size="sm">{t("gitInstallConfirmMessage")}</Text>
					<Code block style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
						{installCmd}
					</Code>
					{installMutation.isPending && (
						<Group gap="xs">
							<Loader size="xs" />
							<Text size="sm" c="dimmed">
								{t("gitInstalling")}
							</Text>
						</Group>
					)}
					{installMutation.isError && (
						<Text size="sm" c="red">
							{t("gitInstallFailed", {
								error: (installMutation.error as Error)?.message ?? String(installMutation.error),
							})}
						</Text>
					)}
					{installMutation.isSuccess && !installMutation.data?.ok && (
						<Text size="sm" c="red">
							{t("gitInstallFailed", { error: installMutation.data?.error ?? "Unknown error" })}
						</Text>
					)}
					{installMutation.isSuccess && installMutation.data?.ok && (
						<Text size="sm" c="green">
							{t("gitInstallSuccess")}
						</Text>
					)}
					<Group justify="flex-end">
						<Button variant="default" onClick={closeConfirm} disabled={installMutation.isPending}>
							{t("gitInstallCancel")}
						</Button>
						<Button
							onClick={() => installMutation.mutate()}
							loading={installMutation.isPending}
							disabled={installMutation.isSuccess && installMutation.data?.ok}
						>
							{t("gitInstallConfirm")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
}
