import {
	Button,
	Code,
	type ComboboxItemGroup,
	Group,
	Modal,
	Select,
	Stack,
	Text,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllModels } from "../../hooks/useModels";
import { api } from "../../lib/api";
import { FOLLOW_SUMMARY_MODEL } from "../../lib/constants";

const MODEL_SELECT_OPTION_LIMIT = 100;

type ModelComboboxItem = string | { value: string; label: string };
type ModelComboboxItemGroup = ComboboxItemGroup<ModelComboboxItem, string>;

export type SummaryModelPickerErrorKind = "unavailable" | "error";

export interface SummaryModelPickerModalProps {
	opened: boolean;
	unavailableModel: string;
	errorMessage: string;
	errorKind: SummaryModelPickerErrorKind;
	onClose: () => void;
	onSaved: () => void;
}

/**
 * UI-only summary model picker.
 *
 * The host mounts this component only while opened, so model queries and the
 * save mutation are created after the modal is needed.
 */
export function SummaryModelPickerModal({
	opened,
	unavailableModel,
	errorMessage,
	errorKind,
	onClose,
	onSaved,
}: SummaryModelPickerModalProps) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const { groupedModels } = useAllModels();
	const [selected, setSelected] = useState<string | null>(null);

	// Exclude the "follow summary" sentinel — it would be self-referential here.
	const summaryModelOptions = useMemo(
		() =>
			(groupedModels as ModelComboboxItemGroup[]).filter(
				(g) =>
					!g.items?.some?.((i) => (typeof i === "string" ? i : i.value) === FOLLOW_SUMMARY_MODEL),
			),
		[groupedModels],
	);

	const save = useMutation({
		mutationFn: (summaryModel: string) => api.updateSettings({ agent: { summaryModel } }),
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: ["settings"] });
			setSelected(null);
			onSaved();
		},
	});

	const handleConfirm = useCallback(() => {
		if (selected) {
			save.mutate(selected);
		}
	}, [selected, save]);

	const title =
		errorKind === "unavailable" ? t("summaryModelUnavailableTitle") : t("summaryModelErrorTitle");

	return (
		<Modal opened={opened} onClose={onClose} title={title} centered size="md">
			<Stack gap="md">
				<Stack gap="xs">
					<Text size="sm" c="dimmed">
						{errorKind === "unavailable"
							? t("summaryModelUnavailableDesc")
							: t("summaryModelErrorDescIntro")}
					</Text>
					{/* The model may be empty when the summary model is simply unset —
					    render the block only when there is something to show. */}
					{(unavailableModel || errorMessage) && (
						<Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
							{unavailableModel}
							{errorMessage ? `${unavailableModel ? "\n" : ""}${errorMessage}` : ""}
						</Code>
					)}
					{errorKind === "unavailable" && (
						<Text size="sm" c="dimmed">
							{t("summaryModelUnavailableHint")}
						</Text>
					)}
				</Stack>
				<Select
					label={t("summaryModel")}
					data={summaryModelOptions}
					searchable
					limit={MODEL_SELECT_OPTION_LIMIT}
					value={selected}
					onChange={setSelected}
				/>
				<Group justify="flex-end">
					<Button onClick={handleConfirm} disabled={!selected} loading={save.isPending}>
						{t("summaryModelUnavailableConfirm")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
