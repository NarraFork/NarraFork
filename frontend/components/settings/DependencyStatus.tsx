import { api } from "@frontend/lib/api";
import { Badge, Button, Code, Group, Loader, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconCheck, IconMinus, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

const DESC_KEYS: Record<string, string> = {
	git: "depsGitDesc",
	rg: "depsRgDesc",
	dtach: "depsDtachDesc",
};

export function DependencyStatus() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const [installingName, setInstallingName] = useState<string | null>(null);
	const [installError, setInstallError] = useState<string | null>(null);

	const { data, isLoading } = useQuery({
		queryKey: ["dependencies"],
		queryFn: api.checkDependencies,
		staleTime: 5 * 60 * 1000,
	});

	const install = useMutation({
		mutationFn: (name: string) => api.installDependency(name),
		onMutate: (name) => {
			setInstallingName(name);
			setInstallError(null);
		},
		onSuccess: () => {
			setInstallingName(null);
			qc.invalidateQueries({ queryKey: ["dependencies"] });
		},
		onError: (err: Error) => {
			setInstallError(err.message);
			setInstallingName(null);
		},
	});

	if (isLoading) {
		return <Loader size="sm" />;
	}

	if (!data) return null;

	const pm = data.packageManager;

	return (
		<Stack gap="sm">
			<Text size="xs" c="dimmed">
				{pm ? t("depsPackageManager", { pm }) : t("depsNoPackageManager")}
			</Text>

			{data.dependencies.map((dep) => {
				const unsupported = !dep.platformSupported;
				const showInstall = !dep.installed && dep.platformSupported && pm;
				const isInstalling = installingName === dep.name && install.isPending;
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
								{showInstall && (
									<Button
										size="compact-xs"
										variant="light"
										loading={isInstalling}
										onClick={() => install.mutate(dep.name)}
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

						{/* Install error for this dep */}
						{installError && installingName === dep.name && (
							<Text size="xs" c="red" ml={28}>
								{t("depsInstallFailed", { error: installError })}
							</Text>
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
	);
}
