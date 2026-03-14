import { Button, Center, Container, Stack, Text, Title } from "@mantine/core";
import { IconBrandGit, IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

/**
 * Full-screen overlay shown when the backend reports git is not installed.
 * Provides a download link and a recheck button.
 */
export function GitMissingAlert() {
	const { t } = useTranslation("common");
	const { data, refetch, isRefetching } = useQuery({
		queryKey: ["health"],
		queryFn: () => api.health(),
		staleTime: Number.POSITIVE_INFINITY,
	});

	// Don't render anything if health hasn't loaded yet or git is available
	if (!data || data.gitAvailable) return null;

	return (
		<Center
			h="100vh"
			w="100vw"
			pos="fixed"
			top={0}
			left={0}
			style={{ zIndex: 10000, backgroundColor: "var(--mantine-color-body)" }}
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
					<Button
						component="a"
						href="https://git-scm.com/downloads"
						target="_blank"
						rel="noopener noreferrer"
						size="lg"
						leftSection={<IconBrandGit size={20} />}
					>
						{t("gitDownload")}
					</Button>
					<Text size="sm" c="dimmed">
						{t("gitInstallGuide")}
					</Text>
					<Button
						variant="light"
						leftSection={<IconRefresh size={16} />}
						onClick={() => refetch()}
						loading={isRefetching}
					>
						{t("gitRecheck")}
					</Button>
				</Stack>
			</Container>
		</Center>
	);
}
