import { api } from "@frontend/lib/api";
import { Badge, Button, Code, Group, Loader, Modal, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconCheck, IconMinus, IconX } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
	const [installingDep, setInstallingDep] = useState<{ name: string; command: string } | null>(
		null,
	);

	const { data, isLoading } = useQuery({
		queryKey: ["dependencies"],
		queryFn: api.checkDependencies,
		staleTime: 5 * 60 * 1000,
	});

	if (isLoading) {
		return <Loader size="sm" />;
	}

	if (!data) return null;

	const pm = data.packageManager;

	const handleInstallDone = () => {
		setInstallingDep(null);
		qc.invalidateQueries({ queryKey: ["dependencies"] });
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
											onClick={() => setInstallingDep({ name: dep.name, command: recommendedCmd })}
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

			{/* Interactive install terminal modal */}
			<Modal
				opened={!!installingDep}
				onClose={handleInstallDone}
				title={installingDep ? t("depsInstallTitle", { name: installingDep.name }) : ""}
				size="lg"
				closeOnClickOutside={false}
				closeOnEscape={false}
			>
				{installingDep && (
					<DependencyInstallTerminal command={installingDep.command} onDone={handleInstallDone} />
				)}
			</Modal>
		</>
	);
}
