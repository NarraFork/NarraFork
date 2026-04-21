import {
	ActionIcon,
	Badge,
	Button,
	Card,
	Group,
	MultiSelect,
	SegmentedControl,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelAggregation, ModelOption } from "../../lib/constants";

export interface ModelAggregationsSectionProps {
	aggregations: ModelAggregation[];
	onChange: (aggregations: ModelAggregation[]) => void;
	/** All visible models (flat list, for member selection). */
	allModels: ModelOption[];
	/** Provider prefix → display name. */
	providerLabels: Record<string, string>;
	/** Generate a short ID for new aggregations. */
	generateId: () => string;
}

export function ModelAggregationsSection({
	aggregations,
	onChange,
	allModels,
	providerLabels,
	generateId,
}: ModelAggregationsSectionProps) {
	const { t } = useTranslation("settings");
	const [newName, setNewName] = useState("");

	// Build MultiSelect data from allModels (exclude __default__ and __agg__ entries)
	const modelSelectData = allModels
		.filter((m) => m.provider !== "__default__" && m.provider !== "__agg__")
		.map((m) => ({
			value: m.value,
			label: `${providerLabels[m.provider ?? ""] ?? m.provider ?? ""}:${m.label}`,
		}));

	const handleAdd = () => {
		if (!newName.trim()) return;
		const newAgg: ModelAggregation = {
			id: generateId(),
			name: newName.trim(),
			models: [],
			routingMode: "priority",
		};
		onChange([...aggregations, newAgg]);
		setNewName("");
	};

	const handleDelete = (id: string) => {
		onChange(aggregations.filter((a) => a.id !== id));
	};

	const handleUpdate = (id: string, patch: Partial<ModelAggregation>) => {
		onChange(aggregations.map((a) => (a.id === id ? { ...a, ...patch } : a)));
	};

	return (
		<Stack gap="xs">
			<Text size="sm" fw={500}>
				{t("modelAggregationsSection")}
			</Text>
			<Text size="xs" c="dimmed">
				{t("modelAggregationsSectionDesc")}
			</Text>

			{aggregations.length === 0 && (
				<Text size="xs" c="dimmed" fs="italic">
					{t("aggEmpty")}
				</Text>
			)}

			{aggregations.map((agg) => (
				<AggregationCard
					key={agg.id}
					agg={agg}
					modelSelectData={modelSelectData}
					onUpdate={handleUpdate}
					onDelete={handleDelete}
				/>
			))}

			<Group gap="xs">
				<TextInput
					size="xs"
					placeholder={t("aggNamePlaceholder")}
					value={newName}
					onChange={(e) => setNewName(e.currentTarget.value)}
					onKeyDown={(e) => e.key === "Enter" && handleAdd()}
					style={{ flex: 1 }}
				/>
				<Button
					size="xs"
					variant="light"
					leftSection={<IconPlus size={14} />}
					onClick={handleAdd}
					disabled={!newName.trim()}
				>
					{t("aggAdd")}
				</Button>
			</Group>
		</Stack>
	);
}

// ---------------------------------------------------------------------------
// Aggregation card — memoized to avoid re-renders from sibling name edits
// ---------------------------------------------------------------------------

const AggregationCard = memo(function AggregationCard({
	agg,
	modelSelectData,
	onUpdate,
	onDelete,
}: {
	agg: ModelAggregation;
	modelSelectData: Array<{ value: string; label: string }>;
	onUpdate: (id: string, patch: Partial<ModelAggregation>) => void;
	onDelete: (id: string) => void;
}) {
	const { t } = useTranslation("settings");

	// Local state for name — only persist on blur to avoid per-keystroke API calls
	const [localName, setLocalName] = useState(agg.name);
	useEffect(() => {
		setLocalName(agg.name);
	}, [agg.name]);

	const commitName = () => {
		const trimmed = localName.trim();
		if (trimmed && trimmed !== agg.name) {
			onUpdate(agg.id, { name: trimmed });
		}
	};

	return (
		<Card withBorder padding="sm">
			<Stack gap="xs">
				<Group justify="space-between" wrap="nowrap">
					<TextInput
						size="xs"
						value={localName}
						onChange={(e) => setLocalName(e.currentTarget.value)}
						onBlur={commitName}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitName();
						}}
						style={{ flex: 1 }}
						placeholder={t("aggNamePlaceholder")}
					/>
					<ActionIcon
						variant="subtle"
						color="red"
						size="sm"
						onClick={() => onDelete(agg.id)}
						title={t("aggDelete")}
					>
						<IconTrash size={14} />
					</ActionIcon>
				</Group>

				<MultiSelect
					size="xs"
					label={t("aggModels")}
					data={modelSelectData}
					value={agg.models}
					onChange={(v) => onUpdate(agg.id, { models: v })}
					searchable
					placeholder={t("aggModelsPlaceholder")}
					maxDropdownHeight={200}
				/>

				<Group gap="xs" align="center">
					<Text size="xs" c="dimmed">
						{t("aggRoutingMode")}:
					</Text>
					<SegmentedControl
						size="xs"
						data={[
							{ value: "priority", label: t("aggRoutingPriority") },
							{ value: "balanced", label: t("aggRoutingBalanced") },
						]}
						value={agg.routingMode}
						onChange={(v) =>
							onUpdate(agg.id, {
								routingMode: v as "priority" | "balanced",
							})
						}
					/>
					<Badge size="xs" variant="light" color="gray">
						{agg.models.length} models
					</Badge>
				</Group>
			</Stack>
		</Card>
	);
});
