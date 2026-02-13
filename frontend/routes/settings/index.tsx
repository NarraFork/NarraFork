import { Button, Loader, NumberInput, Paper, Stack, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

export const Route = createFileRoute("/settings/")({
	component: SettingsPage,
});

function SettingsPage() {
	const { data: settings, isLoading } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
	});
	const qc = useQueryClient();
	const updateSettings = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
	});

	const [port, setPort] = useState<number | undefined>();
	const [projectDir, setProjectDir] = useState("");
	const { t } = useTranslation("settings");
	const { t: tc } = useTranslation("common");

	// Sync state when data loads
	if (settings && port === undefined) {
		setPort(settings.server?.port);
		setProjectDir(settings.paths?.defaultProjectDir ?? "");
	}

	if (isLoading) return <Loader />;

	const handleSave = () => {
		updateSettings.mutate({
			server: { port },
			paths: { defaultProjectDir: projectDir },
		});
	};

	return (
		<Stack>
			<Title order={2}>{t("title")}</Title>
			<Paper withBorder p="md">
				<Stack>
					<NumberInput
						label={t("serverPort")}
						value={port}
						onChange={(v) => setPort(typeof v === "number" ? v : 7778)}
						min={1024}
						max={65535}
					/>
					<TextInput
						label={t("defaultProjectDir")}
						value={projectDir}
						onChange={(e) => setProjectDir(e.currentTarget.value)}
					/>
					<Button onClick={handleSave} loading={updateSettings.isPending} w="fit-content">
						{tc("save")}
					</Button>
				</Stack>
			</Paper>
		</Stack>
	);
}
