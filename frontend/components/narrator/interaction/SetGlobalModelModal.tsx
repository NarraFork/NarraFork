import {
	Button,
	type ComboboxData,
	type ComboboxItemGroup,
	Group,
	Modal,
	Select,
	Stack,
} from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

type ModelComboboxItem = string | { value: string; label: string };
type ModelComboboxItemGroup = ComboboxItemGroup<ModelComboboxItem, string>;

/**
 * Modal with a searchable Select to change the global default or summary model.
 * Used from the per-narrator model menu so users with many models can filter by
 * typing instead of scrolling. Excludes meta sentinels (follow-default /
 * follow-summary) to avoid self/circular references.
 */
export function SetGlobalModelModal({
	opened,
	mode,
	groupedModels,
	currentValue,
	saving,
	onClose,
	onConfirm,
}: {
	opened: boolean;
	mode: "default" | "summary" | null;
	groupedModels: ComboboxData;
	currentValue: string | null | undefined;
	saving: boolean;
	onClose: () => void;
	onConfirm: (model: string) => void;
}) {
	const { t } = useTranslation("narrator");
	const [selected, setSelected] = useState<string | null>(null);

	// Reset the selection to the current value whenever the modal (re)opens.
	useEffect(() => {
		if (opened) setSelected(currentValue ?? null);
	}, [opened, currentValue]);

	// Default picker must exclude both sentinels (summary follows default →
	// circular); summary picker only excludes the summary sentinel.
	const data = useMemo<ComboboxData>(() => {
		const exclude =
			mode === "default"
				? ["__default__", "__summary__"]
				: mode === "summary"
					? ["__summary__"]
					: [];
		if (exclude.length === 0) return groupedModels;
		return (groupedModels as ModelComboboxItemGroup[]).filter(
			(g) => !g.items?.some?.((i) => exclude.includes(typeof i === "string" ? i : i.value)),
		);
	}, [groupedModels, mode]);

	const title = mode === "summary" ? t("editSummaryModel") : t("editDefaultModel");

	return (
		<Modal opened={opened} onClose={onClose} title={title} centered size="md">
			<Stack gap="md">
				<Select
					data={data}
					searchable
					limit={100}
					placeholder={t("modelFilterPlaceholder")}
					value={selected}
					onChange={setSelected}
					comboboxProps={{ withinPortal: true }}
					nothingFoundMessage={t("noModelMatches")}
				/>
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose} disabled={saving}>
						{t("cancel")}
					</Button>
					<Button
						onClick={() => selected && onConfirm(selected)}
						disabled={!selected || saving}
						loading={saving}
					>
						{t("confirm")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
