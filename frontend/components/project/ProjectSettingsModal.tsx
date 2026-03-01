import { Button, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateProject } from "../../hooks/useProjects";

interface ProjectSettingsModalProps {
	projectId: string;
	proxyDomain: string | null;
	opened: boolean;
	onClose: () => void;
}

export function ProjectSettingsModal({
	projectId,
	proxyDomain,
	opened,
	onClose,
}: ProjectSettingsModalProps) {
	const { t } = useTranslation("projects");
	const { t: tc } = useTranslation("common");
	const update = useUpdateProject();
	const [domain, setDomain] = useState(proxyDomain ?? "");

	useEffect(() => {
		if (opened) setDomain(proxyDomain ?? "");
	}, [opened, proxyDomain]);

	const handleSave = () => {
		update.mutate(
			{
				id: projectId,
				data: { proxyDomain: domain.trim() || null },
			},
			{ onSuccess: onClose },
		);
	};

	return (
		<Modal opened={opened} onClose={onClose} title={t("settingsTitle")}>
			<Stack>
				<TextInput
					label={t("proxyDomain")}
					description={t("proxyDomainDesc")}
					placeholder="dev.example.com"
					value={domain}
					onChange={(e) => setDomain(e.currentTarget.value)}
				/>
				<Text size="xs" c="dimmed">
					{t("proxyDomainHint")}
				</Text>
				<Button onClick={handleSave} loading={update.isPending}>
					{tc("save")}
				</Button>
			</Stack>
		</Modal>
	);
}
