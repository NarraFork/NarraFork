import { Button, Group, Modal, Select, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllModels } from "../../hooks/useModels";
import { api } from "../../lib/api";

/**
 * Global modal that opens when the backend broadcasts a
 * `summary_model_unavailable` WebSocket event, prompting the user
 * to pick a new summary model.
 *
 * Also checks `summaryModelAvailable` from the settings API on mount
 * so the modal appears even without a WS trigger (e.g. after page reload).
 */
export function SummaryModelPickerModal() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const { groupedModels } = useAllModels();
	const [opened, setOpened] = useState(false);
	const [unavailableModel, setUnavailableModel] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const dismissedRef = useRef(false);

	const { data: settingsData } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
	});

	// Check on settings load: if summaryModelAvailable is false, open the modal
	useEffect(() => {
		if (
			settingsData &&
			settingsData.summaryModelAvailable === false &&
			settingsData.agent?.summaryModel &&
			!dismissedRef.current
		) {
			setUnavailableModel(settingsData.agent.summaryModel);
			setOpened(true);
		}
	}, [settingsData]);

	// Listen for WS-triggered DOM event
	useEffect(() => {
		const handler = (e: Event) => {
			const model = (e as CustomEvent).detail?.model as string | undefined;
			if (model) {
				dismissedRef.current = false;
				setUnavailableModel(model);
				setOpened(true);
			}
		};
		window.addEventListener("narrafork:summary-model-unavailable", handler);
		return () => window.removeEventListener("narrafork:summary-model-unavailable", handler);
	}, []);

	const save = useMutation({
		mutationFn: (summaryModel: string) => api.updateSettings({ agent: { summaryModel } }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["settings"] });
			setOpened(false);
			setSelected(null);
		},
	});

	const handleConfirm = useCallback(() => {
		if (selected) {
			save.mutate(selected);
		}
	}, [selected, save]);

	return (
		<Modal
			opened={opened}
			onClose={() => {
				dismissedRef.current = true;
				setOpened(false);
			}}
			title={t("summaryModelUnavailableTitle")}
			centered
			size="md"
		>
			<Stack gap="md">
				<Text size="sm" c="dimmed">
					{t("summaryModelUnavailableDesc", { model: unavailableModel })}
				</Text>
				<Select
					label={t("summaryModel")}
					data={groupedModels}
					searchable
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
