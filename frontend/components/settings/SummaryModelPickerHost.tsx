import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useCurrentUser } from "../../hooks/useAuth";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { LazyOverlayBoundary } from "../common/LazyOverlayBoundary";
import type { SummaryModelPickerErrorKind } from "./SummaryModelPickerModal";

const SummaryModelPickerModal = lazy(() =>
	import("./SummaryModelPickerModal").then((m) => ({
		default: m.SummaryModelPickerModal,
	})),
);
const SUMMARY_MODEL_SETTINGS_QUERY_GC_TIME_MS = 60_000;

/**
 * Lightweight global host for summary model warnings.
 *
 * Keeps event/settings listeners mounted, but only loads the picker UI once it
 * actually needs to open.
 */
export function SummaryModelPickerHost() {
	const { data: prefs } = useUserPreferences();
	const { data: user } = useCurrentUser();
	const [opened, setOpened] = useState(false);
	const [unavailableModel, setUnavailableModel] = useState("");
	const [errorMessage, setErrorMessage] = useState("");
	const [errorKind, setErrorKind] = useState<SummaryModelPickerErrorKind>("unavailable");
	const dismissedRef = useRef(false);

	// The picker writes the instance-wide `agent.summaryModel`, which only admins
	// may change, so non-admins never see it — they cannot act on the prompt.
	const isAdmin = user?.role === "admin";

	// Suppress the modal while the setup wizard hasn't been completed yet —
	// the wizard itself handles model selection.
	// Also suppress when prefs haven't loaded yet (undefined) to avoid a race
	// where settings arrive before prefs and the modal flashes before the wizard.
	const suppressed = !isAdmin || !prefs || prefs.setupWizardCompleted === false;

	const { data: settingsData } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		gcTime: SUMMARY_MODEL_SETTINGS_QUERY_GC_TIME_MS,
	});

	// Check on settings load: if summaryModelAvailable is false, open the modal
	useEffect(() => {
		if (
			settingsData &&
			settingsData.summaryModelAvailable === false &&
			settingsData.agent?.summaryModel &&
			!dismissedRef.current &&
			!suppressed
		) {
			setUnavailableModel(settingsData.agent.summaryModel);
			setErrorMessage("");
			setErrorKind("unavailable");
			setOpened(true);
		}
	}, [settingsData, suppressed]);

	// Listen for WS-triggered DOM events. `model` may legitimately be the empty
	// string ("not configured"), so presence — not truthiness — is what matters.
	useEffect(() => {
		const handleUnavailable = (e: Event) => {
			if (suppressed) return;
			const detail = (e as CustomEvent).detail;
			const model = detail?.model as string | undefined;
			if (typeof model === "string") {
				dismissedRef.current = false;
				setUnavailableModel(model);
				setErrorMessage(detail?.error ?? "");
				setErrorKind("unavailable");
				setOpened(true);
			}
		};
		const handleError = (e: Event) => {
			if (suppressed) return;
			const detail = (e as CustomEvent).detail;
			const model = detail?.model as string | undefined;
			if (typeof model === "string") {
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
	}, [suppressed]);

	const handleClose = useCallback(() => {
		dismissedRef.current = true;
		setOpened(false);
	}, []);

	const handleSaved = useCallback(() => {
		setOpened(false);
	}, []);

	if (!opened) return null;

	return (
		// This host is mounted by the app shell, so an unhandled chunk failure here
		// would reach the root error boundary and unmount the whole shell.
		<LazyOverlayBoundary resetKey={opened}>
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
		</LazyOverlayBoundary>
	);
}
