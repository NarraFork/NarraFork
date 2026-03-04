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
	const normalized = domain.trim().toLowerCase();
	const hasInvalidChars = /[^a-z0-9.-]/.test(normalized);
	const hasConsecutiveDots = normalized.includes("..");
	const validShape =
		/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/.test(
			normalized,
		);
	const domainError =
		normalized.length === 0
			? null
			: hasInvalidChars || hasConsecutiveDots || !validShape
				? t("proxyDomainInvalid")
				: null;

	useEffect(() => {
		if (opened) setDomain(proxyDomain ?? "");
	}, [opened, proxyDomain]);

	const handleSave = () => {
		if (domainError) return;
		update.mutate(
			{
				id: projectId,
				data: { proxyDomain: normalized || null },
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
					error={domainError}
				/>
				<Text size="xs" c="dimmed">
					{t("proxyDomainHint")}
				</Text>
				<Button onClick={handleSave} loading={update.isPending} disabled={!!domainError}>
					{tc("save")}
				</Button>
			</Stack>
		</Modal>
	);
}
