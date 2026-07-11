import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	ActionIcon,
	Badge,
	Button,
	Card,
	Group,
	Modal,
	MultiSelect,
	SegmentedControl,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconArrowDown,
	IconArrowUp,
	IconGripVertical,
	IconPlus,
	IconTrash,
} from "@tabler/icons-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelAggregation, ModelOption } from "../../lib/constants";

const MODEL_SELECT_OPTION_LIMIT = 100;

/** Move an item within an array from one index to another (immutable). */
function reorder<T>(list: T[], from: number, to: number): T[] {
	if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
	const next = [...list];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

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

/** Build grouped MultiSelect data from flat model list. */
function buildModelSelectData(
	allModels: ModelOption[],
	providerLabels: Record<string, string>,
): Array<{ group: string; items: Array<{ value: string; label: string }> }> {
	const groups = new Map<string, Array<{ value: string; label: string }>>();
	for (const m of allModels) {
		if (m.provider === "__default__" || m.provider === "__agg__") continue;
		const groupName = providerLabels[m.provider ?? ""] ?? m.provider ?? "";
		let items = groups.get(groupName);
		if (!items) {
			items = [];
			groups.set(groupName, items);
		}
		items.push({ value: m.value, label: `${groupName}:${m.label}` });
	}
	return Array.from(groups.entries()).map(([group, items]) => ({ group, items }));
}

/** Build a value → display label map (e.g. "Provider:model") for member rows. */
function buildModelLabelMap(
	modelSelectData: Array<{ group: string; items: Array<{ value: string; label: string }> }>,
): Map<string, string> {
	const map = new Map<string, string>();
	for (const g of modelSelectData) {
		for (const item of g.items) map.set(item.value, item.label);
	}
	return map;
}

// ---------------------------------------------------------------------------
// Sortable member priority list — shared by the add modal and the edit card
// ---------------------------------------------------------------------------

function MemberPriorityList({
	models,
	labelMap,
	routingMode,
	onChange,
	size = "sm",
}: {
	models: string[];
	labelMap: Map<string, string>;
	routingMode: "priority" | "balanced";
	onChange: (models: string[]) => void;
	size?: "xs" | "sm";
}) {
	const { t } = useTranslation("settings");
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const from = models.indexOf(active.id as string);
			const to = models.indexOf(over.id as string);
			onChange(reorder(models, from, to));
		},
		[models, onChange],
	);

	const move = useCallback(
		(index: number, direction: -1 | 1) => {
			onChange(reorder(models, index, index + direction));
		},
		[models, onChange],
	);

	if (models.length === 0) return null;

	return (
		<div>
			<Text size={size === "xs" ? "xs" : "sm"} fw={500} mb={4}>
				{t("aggMemberOrder")}
			</Text>
			<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
				<SortableContext items={models} strategy={verticalListSortingStrategy}>
					<Stack gap={4}>
						{models.map((value, idx) => (
							<SortableMemberRow
								key={value}
								value={value}
								label={labelMap.get(value) ?? value}
								index={idx}
								isFirst={idx === 0}
								isLast={idx === models.length - 1}
								showPrimaryBadge={routingMode === "priority"}
								onMoveUp={() => move(idx, -1)}
								onMoveDown={() => move(idx, 1)}
							/>
						))}
					</Stack>
				</SortableContext>
			</DndContext>
			<Text size="xs" c="dimmed" mt={4}>
				{routingMode === "priority"
					? t("aggMemberOrderPriorityDesc")
					: t("aggMemberOrderBalancedDesc")}
			</Text>
		</div>
	);
}

const SortableMemberRow = memo(function SortableMemberRow({
	value,
	label,
	index,
	isFirst,
	isLast,
	showPrimaryBadge,
	onMoveUp,
	onMoveDown,
}: {
	value: string;
	label: string;
	index: number;
	isFirst: boolean;
	isLast: boolean;
	showPrimaryBadge: boolean;
	onMoveUp: () => void;
	onMoveDown: () => void;
}) {
	const { t } = useTranslation("settings");
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: value,
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	return (
		<Group
			ref={setNodeRef}
			style={{ ...style, borderRadius: 4 }}
			gap="xs"
			wrap="nowrap"
			px={4}
			py={2}
			bg="var(--mantine-color-default)"
		>
			<ActionIcon
				variant="subtle"
				size="sm"
				color="gray"
				style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
				{...attributes}
				{...listeners}
			>
				<IconGripVertical size={14} />
			</ActionIcon>

			<Text size="xs" c="dimmed" w={18} ta="right" style={{ flexShrink: 0 }}>
				{index + 1}
			</Text>

			<Text size="xs" ff="monospace" truncate style={{ flex: 1, minWidth: 0 }}>
				{label}
			</Text>

			{showPrimaryBadge && isFirst && (
				<Badge size="xs" variant="light" color="indigo" style={{ flexShrink: 0 }}>
					{t("aggPrimary")}
				</Badge>
			)}

			<Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
				<ActionIcon
					variant="subtle"
					size="xs"
					disabled={isFirst}
					onClick={onMoveUp}
					title={t("aggMoveUp")}
				>
					<IconArrowUp size={12} />
				</ActionIcon>
				<ActionIcon
					variant="subtle"
					size="xs"
					disabled={isLast}
					onClick={onMoveDown}
					title={t("aggMoveDown")}
				>
					<IconArrowDown size={12} />
				</ActionIcon>
			</Group>
		</Group>
	);
});

export function ModelAggregationsSection({
	aggregations,
	onChange,
	allModels,
	providerLabels,
	generateId,
}: ModelAggregationsSectionProps) {
	const { t } = useTranslation("settings");
	const [addOpened, { open: openAdd, close: closeAdd }] = useDisclosure(false);

	const modelSelectData = useMemo(
		() => buildModelSelectData(allModels, providerLabels),
		[allModels, providerLabels],
	);

	const labelMap = useMemo(() => buildModelLabelMap(modelSelectData), [modelSelectData]);

	const handleAdd = useCallback(
		(agg: ModelAggregation) => {
			onChange([...aggregations, agg]);
		},
		[aggregations, onChange],
	);

	const handleDelete = useCallback(
		(id: string) => {
			onChange(aggregations.filter((a) => a.id !== id));
		},
		[aggregations, onChange],
	);

	const handleUpdate = useCallback(
		(id: string, patch: Partial<ModelAggregation>) => {
			onChange(aggregations.map((a) => (a.id === id ? { ...a, ...patch } : a)));
		},
		[aggregations, onChange],
	);

	return (
		<Stack gap="xs">
			<Group justify="space-between" align="center">
				<div>
					<Text size="sm" fw={500}>
						{t("modelAggregationsSection")}
					</Text>
					<Text size="xs" c="dimmed">
						{t("modelAggregationsSectionDesc")}
					</Text>
				</div>
				<Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={openAdd}>
					{t("aggAdd")}
				</Button>
			</Group>

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
					labelMap={labelMap}
					onUpdate={handleUpdate}
					onDelete={handleDelete}
				/>
			))}

			<AddAggregationModal
				opened={addOpened}
				onClose={closeAdd}
				modelSelectData={modelSelectData}
				labelMap={labelMap}
				generateId={generateId}
				onAdd={handleAdd}
			/>
		</Stack>
	);
}

// ---------------------------------------------------------------------------
// Add Aggregation Modal
// ---------------------------------------------------------------------------

function AddAggregationModal({
	opened,
	onClose,
	modelSelectData,
	labelMap,
	generateId,
	onAdd,
}: {
	opened: boolean;
	onClose: () => void;
	modelSelectData: Array<{
		group: string;
		items: Array<{ value: string; label: string }>;
	}>;
	labelMap: Map<string, string>;
	generateId: () => string;
	onAdd: (agg: ModelAggregation) => void;
}) {
	const { t } = useTranslation("settings");
	const [name, setName] = useState("");
	const [models, setModels] = useState<string[]>([]);
	const [routingMode, setRoutingMode] = useState<"priority" | "balanced">("priority");

	// Reset form when modal opens
	useEffect(() => {
		if (opened) {
			setName("");
			setModels([]);
			setRoutingMode("priority");
		}
	}, [opened]);

	const canSubmit = name.trim().length > 0 && models.length > 0;

	const handleSubmit = () => {
		if (!canSubmit) return;
		onAdd({
			id: generateId(),
			name: name.trim(),
			models,
			routingMode,
		});
		onClose();
	};

	return (
		<Modal opened={opened} onClose={onClose} title={t("aggAdd")} size="md">
			<Stack gap="sm">
				<TextInput
					label={t("aggName")}
					placeholder={t("aggNamePlaceholder")}
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					data-autofocus
				/>

				<MultiSelect
					label={t("aggModels")}
					data={modelSelectData}
					value={models}
					onChange={setModels}
					searchable
					limit={MODEL_SELECT_OPTION_LIMIT}
					placeholder={t("aggModelsPlaceholder")}
					maxDropdownHeight={240}
				/>

				<MemberPriorityList
					models={models}
					labelMap={labelMap}
					routingMode={routingMode}
					onChange={setModels}
				/>

				<div>
					<Text size="sm" fw={500} mb={4}>
						{t("aggRoutingMode")}
					</Text>
					<SegmentedControl
						size="xs"
						fullWidth
						data={[
							{ value: "priority", label: t("aggRoutingPriority") },
							{ value: "balanced", label: t("aggRoutingBalanced") },
						]}
						value={routingMode}
						onChange={(v) => setRoutingMode(v as "priority" | "balanced")}
					/>
					<Text size="xs" c="dimmed" mt={4}>
						{routingMode === "priority" ? t("aggRoutingPriorityDesc") : t("aggRoutingBalancedDesc")}
					</Text>
				</div>

				<Group justify="flex-end" mt="xs">
					<Button variant="default" size="xs" onClick={onClose}>
						{t("aggCancel")}
					</Button>
					<Tooltip label={t("aggSubmitHint")} disabled={canSubmit} position="top">
						<Button size="xs" onClick={handleSubmit} disabled={!canSubmit}>
							{t("aggConfirm")}
						</Button>
					</Tooltip>
				</Group>
			</Stack>
		</Modal>
	);
}

// ---------------------------------------------------------------------------
// Aggregation card — memoized to avoid re-renders from sibling name edits
// ---------------------------------------------------------------------------

const AggregationCard = memo(function AggregationCard({
	agg,
	modelSelectData,
	labelMap,
	onUpdate,
	onDelete,
}: {
	agg: ModelAggregation;
	modelSelectData: Array<{
		group: string;
		items: Array<{ value: string; label: string }>;
	}>;
	labelMap: Map<string, string>;
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
					limit={MODEL_SELECT_OPTION_LIMIT}
					placeholder={t("aggModelsPlaceholder")}
					maxDropdownHeight={200}
				/>

				<MemberPriorityList
					models={agg.models}
					labelMap={labelMap}
					routingMode={agg.routingMode}
					onChange={(models) => onUpdate(agg.id, { models })}
					size="xs"
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
						{t("aggModelCount", { count: agg.models.length })}
					</Badge>
				</Group>
			</Stack>
		</Card>
	);
});
