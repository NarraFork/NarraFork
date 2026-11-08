import { Alert, Group, Stack, Switch, Text } from "@mantine/core";
import type { AutoModelInfo } from "@shared/auto-model";
import { useQuery } from "@tanstack/react-query";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { modelCatalogApi } from "../../lib/api/model-catalog";
import { autoModelCountFor, autoModelsOnlyServedBy } from "./auto-participation";

const MAX_LISTED = 5;

export interface AutoParticipationSwitchProps {
	prefix: string;
	/** Draft: whether this provider joins `auto:<model>` routing. */
	participates: boolean;
	/** Whether it joins in the saved settings, which the server's auto list reflects. */
	savedParticipates: boolean;
	onChange: (participates: boolean) => void;
}

/**
 * "Join auto" switch for one provider (`agent.autoExcludedProviders`). Turning it off is a
 * draft like every other change on this page, saved by the save bar. When it would leave
 * some `auto:` models with no source, the models are named so the user knows what breaks.
 */
export const AutoParticipationSwitch = React.memo(function AutoParticipationSwitch({
	prefix,
	participates,
	savedParticipates,
	onChange,
}: AutoParticipationSwitchProps) {
	const { t } = useTranslation("settings");
	const { data } = useQuery({
		queryKey: ["settings", "auto-models", "participation"],
		queryFn: modelCatalogApi.autoModels,
		staleTime: 30_000,
	});
	const models: AutoModelInfo[] = data?.models ?? [];
	// The server's list reflects saved settings, so it only says what turning this provider off
	// would strand while the provider is still in auto as saved.
	const stranded = useMemo(
		() => (savedParticipates ? autoModelsOnlyServedBy(models, prefix) : []),
		[savedParticipates, models, prefix],
	);
	const count = autoModelCountFor(models, prefix);

	return (
		<Stack gap={6}>
			<Group justify="space-between" wrap="nowrap" align="flex-start">
				<Stack gap={2}>
					<Text size="sm" fw={500}>
						{t("autoParticipation.label")}
					</Text>
					<Text size="xs" c="dimmed">
						{savedParticipates && count > 0
							? t("autoParticipation.descServing", { count })
							: t("autoParticipation.desc")}
					</Text>
				</Stack>
				<Switch
					checked={participates}
					onChange={(event) => onChange(event.currentTarget.checked)}
					aria-label={t("autoParticipation.label")}
					data-auto-participation
				/>
			</Group>
			{!participates && savedParticipates && stranded.length > 0 && (
				<Alert color="yellow" variant="light" p="xs">
					<Text size="xs">
						{t("autoParticipation.stranded", {
							count: stranded.length,
							models: stranded
								.slice(0, MAX_LISTED)
								.map((model) => model.name)
								.join(", "),
						})}
					</Text>
				</Alert>
			)}
		</Stack>
	);
});
