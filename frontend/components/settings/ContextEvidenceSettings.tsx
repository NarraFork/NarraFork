import { Card, NativeSelect, NumberInput, Stack, Switch, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useInstanceSettingsContext } from "../../hooks/useInstanceSettings";

export function ContextEvidenceSettings() {
	const { t } = useTranslation("settings");
	const settings = useInstanceSettingsContext();
	return (
		<Card withBorder padding="md">
			<Stack>
				<Title order={4}>{t("contextEvidence.title")}</Title>
				<Text size="sm" c="dimmed">
					{t("contextEvidence.description")}
				</Text>
				<NumberInput
					name="contextEvidenceBudgetBytes"
					label={t("contextEvidence.budget")}
					description={t("contextEvidence.budgetHint")}
					min={0}
					max={65536}
					allowDecimal={false}
					value={settings.contextEvidenceBudgetBytes}
					onChange={(value) =>
						settings.setContextEvidenceBudgetBytes(typeof value === "number" ? value : 0)
					}
					disabled={!settings.initialized}
				/>
				<NativeSelect
					name="knowledgeInjectMode"
					label={t("contextEvidence.injection")}
					value={settings.knowledgeInjectMode}
					onChange={(event) =>
						settings.setKnowledgeInjectMode(event.currentTarget.value as "summary" | "off")
					}
					data={[
						{ value: "summary", label: t("contextEvidence.summary") },
						{ value: "off", label: t("contextEvidence.off") },
					]}
					disabled={!settings.initialized}
				/>
				<NativeSelect
					name="knowledgeRetrievalMode"
					label={t("contextEvidence.retrieval")}
					value={settings.knowledgeRetrievalMode}
					onChange={(event) =>
						settings.setKnowledgeRetrievalMode(event.currentTarget.value as "keywords" | "hybrid")
					}
					data={[
						{ value: "keywords", label: t("contextEvidence.keywords") },
						{ value: "hybrid", label: t("contextEvidence.hybrid") },
					]}
					disabled={!settings.initialized}
				/>
				<Switch
					name="knowledgeScanToolOutput"
					label={t("contextEvidence.scan")}
					checked={settings.knowledgeScanToolOutput}
					onChange={(event) => settings.setKnowledgeScanToolOutput(event.currentTarget.checked)}
					disabled={!settings.initialized}
				/>
			</Stack>
		</Card>
	);
}
