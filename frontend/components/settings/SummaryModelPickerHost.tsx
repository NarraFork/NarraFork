import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import type { SummaryModelPickerErrorKind } from "./SummaryModelPickerModal";

const SummaryModelPickerModal = lazy(() =>
	import("./SummaryModelPickerModal").then((m) => ({
		default: m.SummaryModelPickerModal,
	})),
);

/**
 * Lightweight global host for summary model warnings.
 *
 * Keeps event/settings listeners mounted, but only loads the picker UI once it
 * actually needs to open.
 */
export function SummaryModelPickerHost() {
	const { data: prefs } = useUserPreferences();
	const [opened, setOpened] = useState(false);
	const [unavailableModel, setUnavailableModel] = useState("");
	const [errorMessage, setErrorMessage] = useState("");
	const [errorKind, setErrorKind] = useState<SummaryModelPickerErrorKind>("unavailable");
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

	const handleClose = useCallback(() => {
		dismissedRef.current = true;
		setOpened(false);
	}, []);

	const handleSaved = useCallback(() => {
		setOpened(false);
	}, []);

	if (!opened) return null;

	return (
		<Suspense fallback={null}>
			<SummaryModelPickerModal
				opened={opened}
				unavailableModel={unavailableModel}
				errorMessage={errorMessage}
				errorKind={errorKind}
				onClose={handleClose}
				onSaved={handleSaved}
			/>
		</Suspense>
	);
}
