import { Button, Group, MultiSelect, Stack, Text, Textarea } from "@mantine/core";
import { SUBAGENT_POOL_TYPES, type SubagentModelPools } from "@shared/subagent-model-policy";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	SubagentReasoningEffortSection,
	SubagentReasoningEffortSelect,
} from "../common/SubagentReasoningEffortSelect";
import { selectPoolModels, updatePoolModel } from "./subagent-model-pool-state";

const EMPTY_POOLS: SubagentModelPools = {};
const EDITABLE_TYPES = ["explore", "plan", "general"] as const;

/** Keep this state above the details filter so hiding the section cannot discard a draft. */
export function useSubagentModelPoolDraft(
	source: SubagentModelPools = EMPTY_POOLS,
	loaded = true,
	ownerId = "",
) {
	const [pools, setPools] = useState(source);
	const previousOwner = useRef(ownerId);
	useEffect(() => {
		if (loaded || previousOwner.current !== ownerId) setPools(source);
		previousOwner.current = ownerId;
	}, [source, loaded, ownerId]);
	return { pools, setPools };
}

/** The existing session pool editor, preserving complete server-owned pool metadata. */
export function SubagentModelPoolEditor({
	pools,
	setPools,
	availableModels,
	loaded,
	saving,
	clearing,
	onSave,
	onClear,
}: {
	pools: SubagentModelPools;
	setPools: Dispatch<SetStateAction<SubagentModelPools>>;
	availableModels?: { model: string }[];
	loaded: boolean;
	saving: boolean;
	clearing: boolean;
	onSave: (pools: SubagentModelPools) => void;
	onClear: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const disabled = !loaded || saving || clearing;
	const modelOptions = useMemo(() => {
		const models = new Set((availableModels ?? []).map((entry) => entry.model));
		for (const entries of Object.values(pools)) {
			for (const entry of entries) models.add(entry.model);
		}
		return [...models].map((model) => ({ value: model, label: model }));
	}, [availableModels, pools]);
	const fixedCount = Object.values(pools).reduce(
		(count, entries) =>
			count + entries.filter((entry) => entry.reasoningEffort !== undefined).length,
		0,
	);
	const typeLabel = (type: string) =>
		(SUBAGENT_POOL_TYPES as readonly string[]).includes(type)
			? t(`details.subagentType_${type}`)
			: type;

	return (
		<Stack gap="xs">
			<Text size="sm" fw={600}>
				{t("details.subagentModelRestriction")}
			</Text>
			<Text size="xs" c="dimmed">
				{t("details.subagentModelRestrictionDesc")}
			</Text>
			{EDITABLE_TYPES.map((type) => (
				<Stack key={type} gap={6}>
					<MultiSelect
						label={typeLabel(type)}
						data={modelOptions}
						searchable
						clearable
						disabled={disabled}
						value={(pools[type] ?? []).map((entry) => entry.model)}
						onChange={(models) => setPools((old) => selectPoolModels(old, type, models))}
					/>
					{(pools[type] ?? []).map((entry) => (
						<Textarea
							key={entry.model}
							label={entry.model}
							placeholder={t("details.modelPurposePlaceholder")}
							minRows={2}
							disabled={disabled}
							value={entry.purpose ?? ""}
							onChange={(event) => {
								const purpose = event.currentTarget.value;
								setPools((old) => updatePoolModel(old, type, entry.model, { purpose }));
							}}
						/>
					))}
				</Stack>
			))}
			<SubagentReasoningEffortSection
				count={fixedCount}
				help={t("poolReasoningEffort.sessionHelp")}
			>
				{Object.entries(pools).map(
					([type, entries]) =>
						entries.length > 0 && (
							<Stack key={type} gap={6}>
								<Text size="xs" fw={600}>
									{typeLabel(type)}
								</Text>
								{entries.map((entry) => (
									<SubagentReasoningEffortSelect
										key={entry.model}
										model={entry.model}
										value={entry.reasoningEffort}
										disabled={disabled}
										onChange={(reasoningEffort) =>
											setPools((old) =>
												updatePoolModel(old, type, entry.model, { reasoningEffort }),
											)
										}
									/>
								))}
							</Stack>
						),
				)}
			</SubagentReasoningEffortSection>
			<Group justify="flex-end" gap="xs">
				<Button
					variant="default"
					size="xs"
					loading={clearing}
					disabled={disabled}
					onClick={onClear}
				>
					{t("details.clearTrait")}
				</Button>
				<Button
					size="xs"
					loading={saving}
					disabled={disabled}
					onClick={() => {
						if (loaded) onSave(pools);
					}}
				>
					{tc("save")}
				</Button>
			</Group>
		</Stack>
	);
}
