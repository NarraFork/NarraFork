import { ActionIcon, Alert, Badge, Card, Group, Stack, Text } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ModelAggregation, ModelOption } from "../../lib/constants";

/**
 * Model aggregations, read-only.
 *
 * `auto:<model>` replaced aggregations (docs/PROVIDER-SOURCING-DESIGN.md §11): every model
 * value that named one was moved to `auto:` or a provider value on startup. The entries stay
 * so a value the migration could not move still resolves, and can be deleted here once
 * nothing needs them. New aggregations can no longer be created.
 */
export interface ModelAggregationsSectionProps {
	aggregations: ModelAggregation[];
	onChange: (aggregations: ModelAggregation[]) => void;
	/** All visible models, to label members. */
	allModels: ModelOption[];
	/** Provider prefix → display name. */
	providerLabels: Record<string, string>;
}

export function ModelAggregationsSection({
	aggregations,
	onChange,
	allModels,
	providerLabels,
}: ModelAggregationsSectionProps) {
	const { t } = useTranslation("settings");

	const memberLabel = useCallback(
		(value: string) => {
			const option = allModels.find((model) => model.value === value);
			const prefix = value.slice(0, Math.max(0, value.indexOf(":")));
			const provider = providerLabels[prefix] ?? prefix;
			const model = option?.label ?? value.slice(prefix.length + 1);
			return provider ? `${provider} · ${model}` : value;
		},
		[allModels, providerLabels],
	);

	if (aggregations.length === 0) return null;

	return (
		<Stack gap="xs">
			<Text size="sm" fw={500}>
				{t("modelAggregationsSection")}
			</Text>
			<Alert variant="light" color="gray" p="xs">
				<Text size="xs">{t("modelAggregationsRetired")}</Text>
			</Alert>
			{aggregations.map((agg) => (
				<Card key={agg.id} withBorder padding="sm">
					<Stack gap={6}>
						<Group justify="space-between" wrap="nowrap">
							<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
								<Text size="sm" fw={500} truncate>
									{agg.name}
								</Text>
								<Badge size="xs" variant="light" color="gray">
									{agg.routingMode === "balanced"
										? t("aggRoutingBalanced")
										: t("aggRoutingPriority")}
								</Badge>
							</Group>
							<ActionIcon
								variant="subtle"
								color="red"
								size="sm"
								aria-label={t("aggDelete")}
								title={t("aggDelete")}
								onClick={() => onChange(aggregations.filter((a) => a.id !== agg.id))}
							>
								<IconTrash size={14} />
							</ActionIcon>
						</Group>
						{agg.models.map((member, index) => (
							<Text key={member} size="xs" c="dimmed" ff="monospace" truncate>
								{index + 1}. {memberLabel(member)}
							</Text>
						))}
					</Stack>
				</Card>
			))}
		</Stack>
	);
}
