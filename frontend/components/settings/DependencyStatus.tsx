import { api } from "@frontend/lib/api";
import { Badge, Button, Code, Group, Loader, Modal, Stack, Text, ThemeIcon } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconMinus, IconTerminal2, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DependencyInstallTerminal } from "./DependencyInstallTerminal";

const DESC_KEYS: Record<string, string> = {
	git: "depsGitDesc",
	rg: "depsRgDesc",
	dtach: "depsDtachDesc",
};

export function DependencyStatus() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const [confirmOpened, { open: openConfirm, close: closeConfirm }] = useDisclosure(false);
	const [terminalOpened, { open: openTerminal, close: closeTerminal }] = useDisclosure(false);
	const [selectedDep, setSelectedDep] = useState<{
		name: string;
		command: string;
	} | null>(null);

	const { data, isLoading } = useQuery({
		queryKey: ["dependencies"],
		queryFn: api.checkDependencies,
		staleTime: 5 * 60 * 1000,
	});

	const installMutation = useMutation({
		mutationFn: (name: string) => api.installDependency(name),
		onSuccess: (result, name) => {
			closeConfirm();
			setSelectedDep(null);
			qc.invalidateQueries({ queryKey: ["dependencies"] });
			qc.invalidateQueries({ queryKey: ["health"] });
			if (result.ok) {
				notifications.show({
					color: "green",
					message: t("depsInstallSuccess", { name }),
				});
			} else {
				notifications.show({
					color: "red",
					message: t("depsInstallFailed", { error: result.error ?? "Unknown error" }),
				});
			}
		},
		onError: (err) => {
			closeConfirm();
			setSelectedDep(null);
			notifications.show({
				color: "red",
				message: t("depsInstallFailed", {
					error: (err as Error)?.message ?? String(err),
				}),
			});
		},
	});

	if (isLoading) {
		return <Loader size="sm" />;
	}

	if (!data) return null;

	const pm = data.packageManager;

	const handleInstallClick = (depName: string, command: string) => {
		setSelectedDep({ name: depName, command });
		openConfirm();
	};

	return (
		<>
			<Stack gap="sm">
				<Text size="xs" c="dimmed">
					{pm ? t("depsPackageManager", { pm }) : t("depsNoPackageManager")}
				</Text>

				{data.dependencies.map((dep) => {
					const unsupported = !dep.platformSupported;
					const showInstall = !dep.installed && dep.platformSupported && pm;
					const recommendedCmd = pm && dep.installCommands[pm] ? dep.installCommands[pm] : null;

					return (
						<Stack key={dep.name} gap={4}>
							<Group justify="space-between" wrap="nowrap">
								<Group gap="xs" wrap="nowrap">
									<ThemeIcon
										size="sm"
										variant="light"
										color={unsupported ? "gray" : dep.installed ? "green" : "red"}
									>
										{unsupported ? (
											<IconMinus size={14} />
										) : dep.installed ? (
											<IconCheck size={14} />
										) : (
											<IconX size={14} />
										)}
									</ThemeIcon>
									<Text size="sm" fw={500} c={unsupported ? "dimmed" : undefined}>
										{dep.name}
										{dep.version && (
											<Text span size="xs" c="dimmed" ml={6}>
												{dep.version}
											</Text>
										)}
									</Text>
									<Text size="xs" c="dimmed">
										{t(DESC_KEYS[dep.name] ?? "")}
									</Text>
								</Group>

								<Group gap="xs" wrap="nowrap">
									{unsupported && (
										<Text size="xs" c="dimmed">
											{t("depsPlatformUnsupported")}
										</Text>
									)}
									<Badge size="xs" variant="light" color={dep.required ? "red" : "blue"}>
										{dep.required ? t("depsRequired") : t("depsOptional")}
									</Badge>
									{showInstall && recommendedCmd && (
										<Button
											size="compact-xs"
											variant="light"
											loading={installMutation.isPending && selectedDep?.name === dep.name}
											onClick={() => handleInstallClick(dep.name, recommendedCmd)}
										>
											{t("depsInstallButton")}
										</Button>
									)}
								</Group>
							</Group>

							{/* Show install command when not installed */}
							{!dep.installed && dep.platformSupported && recommendedCmd && (
								<Code block style={{ fontSize: 11, marginLeft: 28, whiteSpace: "pre-wrap" }}>
									{recommendedCmd}
								</Code>
							)}
						</Stack>
					);
				})}

				{data.allRequiredMet && (
					<Text size="xs" c="green">
						{t("depsAllGood")}
					</Text>
				)}
			</Stack>

			{/* Confirm install modal */}
			<Modal
				opened={confirmOpened}
				onClose={() => {
					if (!installMutation.isPending) {
						closeConfirm();
						setSelectedDep(null);
					}
				}}
				title={selectedDep ? t("depsInstallConfirmTitle", { name: selectedDep.name }) : ""}
				size="md"
				closeOnClickOutside={!installMutation.isPending}
				closeOnEscape={!installMutation.isPending}
			>
				<Stack gap="md">
					<Text size="sm">{t("depsInstallConfirmMessage")}</Text>
					<Code block style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
						{selectedDep?.command}
					</Code>
					{installMutation.isPending && (
						<Group gap="xs">
							<Loader size="xs" />
							<Text size="sm" c="dimmed">
								{t("depsInstalling")}
							</Text>
						</Group>
					)}
					<Group justify="flex-end">
						<Button
							variant="default"
							onClick={() => {
								closeConfirm();
								setSelectedDep(null);
							}}
							disabled={installMutation.isPending}
						>
							{t("depsInstallCancel")}
						</Button>
						<Button
							variant="light"
							leftSection={<IconTerminal2 size={14} />}
							onClick={() => {
								closeConfirm();
								openTerminal();
							}}
							disabled={installMutation.isPending}
						>
							{t("depsInstallInTerminal")}
						</Button>
						<Button
							onClick={() => {
								if (selectedDep) {
									installMutation.mutate(selectedDep.name);
								}
							}}
							loading={installMutation.isPending}
						>
							{t("depsInstallConfirm")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			{/* Interactive terminal install modal */}
			<Modal
				opened={terminalOpened}
				onClose={() => {
					closeTerminal();
					qc.invalidateQueries({ queryKey: ["dependencies"] });
					qc.invalidateQueries({ queryKey: ["health"] });
					setSelectedDep(null);
				}}
				title={selectedDep ? t("depsInstallTitle", { name: selectedDep.name }) : ""}
				size="lg"
				closeOnClickOutside={false}
				closeOnEscape={false}
			>
				{selectedDep && (
					<DependencyInstallTerminal
						command={selectedDep.command}
						onDone={() => {
							closeTerminal();
							qc.invalidateQueries({ queryKey: ["dependencies"] });
							qc.invalidateQueries({ queryKey: ["health"] });
							setSelectedDep(null);
						}}
					/>
				)}
			</Modal>
		</>
	);
}
