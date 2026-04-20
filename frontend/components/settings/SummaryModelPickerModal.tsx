import { Button, Code, Group, Modal, Select, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllModels } from "../../hooks/useModels";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";

type ErrorKind = "unavailable" | "error";

/**
 * Global modal that opens when the backend broadcasts a
 * `summary_model_unavailable` or `summary_model_error` WebSocket event,
 * prompting the user to pick a new summary model.
 *
 * Also checks `summaryModelAvailable` from the settings API on mount
 * so the modal appears even without a WS trigger (e.g. after page reload).
 */
export function SummaryModelPickerModal() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const { groupedModels } = useAllModels();
	const { data: prefs } = useUserPreferences();
	const [opened, setOpened] = useState(false);
	const [unavailableModel, setUnavailableModel] = useState("");
	const [errorMessage, setErrorMessage] = useState("");
	const [errorKind, setErrorKind] = useState<ErrorKind>("unavailable");
	const [selected, setSelected] = useState<string | null>(null);
	const dismissedRef = useRef(false);

	// Suppress the modal while the setup wizard hasn't been completed yet —
	// the wizard itself handles model selection.
	// Also suppress when prefs haven't loaded yet (undefined) to avoid a race
	// where settings arrive before prefs and the modal flashes before the wizard.
	const wizardIncomplete = !prefs || prefs.setupWizardCompleted === false;

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
			!dismissedRef.current &&
			!wizardIncomplete
		) {
			setUnavailableModel(settingsData.agent.summaryModel);
			setErrorMessage("");
			setErrorKind("unavailable");
			setOpened(true);
		}
	}, [settingsData, wizardIncomplete]);

	// Listen for WS-triggered DOM events
	useEffect(() => {
		const handleUnavailable = (e: Event) => {
			if (wizardIncomplete) return;
			const detail = (e as CustomEvent).detail;
			const model = detail?.model as string | undefined;
			if (model) {
				dismissedRef.current = false;
				setUnavailableModel(model);
				setErrorMessage(detail?.error ?? "");
				setErrorKind("unavailable");
				setOpened(true);
			}
		};
		const handleError = (e: Event) => {
			if (wizardIncomplete) return;
			const detail = (e as CustomEvent).detail;
			const model = detail?.model as string | undefined;
			if (model) {
				dismissedRef.current = false;
				setUnavailableModel(model);
				setErrorMessage(detail?.error ?? "");
				setErrorKind("error");
				setOpened(true);
			}
		};
		window.addEventListener("narrafork:summary-model-unavailable", handleUnavailable);
		window.addEventListener("narrafork:summary-model-error", handleError);
		return () => {
			window.removeEventListener("narrafork:summary-model-unavailable", handleUnavailable);
			window.removeEventListener("narrafork:summary-model-error", handleError);
		};
	}, [wizardIncomplete]);

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

	const title =
		errorKind === "unavailable" ? t("summaryModelUnavailableTitle") : t("summaryModelErrorTitle");

	return (
		<Modal
			opened={opened}
			onClose={() => {
				dismissedRef.current = true;
				setOpened(false);
			}}
			title={title}
			centered
			size="md"
		>
			<Stack gap="md">
				<Stack gap="xs">
					<Text size="sm" c="dimmed">
						{errorKind === "unavailable"
							? t("summaryModelUnavailableDesc")
							: t("summaryModelErrorDescIntro")}
					</Text>
					<Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
						{unavailableModel}
						{errorMessage ? `\n${errorMessage}` : ""}
					</Code>
					{errorKind === "unavailable" && (
						<Text size="sm" c="dimmed">
							{t("summaryModelUnavailableHint")}
						</Text>
					)}
				</Stack>
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
