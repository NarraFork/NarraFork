import {
	loadIntelligentUiPreview,
	type PreviewBundle,
} from "@frontend/components/intelligent-ui/preview-loader";
import {
	INTELLIGENT_UI_FILE_LIMITS,
	type IntelligentUiFileReference,
} from "@shared/intelligent-ui-files";
import { useCallback, useEffect, useState } from "react";

/** Mounted only inside an open preview. No query cache, history, drafts or retained builds. */
export function useIntelligentUI(narratorId: string, file: IntelligentUiFileReference) {
	const [bundle, setBundle] = useState<PreviewBundle | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const { toolUseId, toolCallId } = file;
	const reload = useCallback(() => {
		setBundle(null);
		setError(null);
		setAttempt((value) => value + 1);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: an explicit refresh must rebuild unchanged file references.
	useEffect(() => {
		const controller = new AbortController();
		let active = true;
		const timer = setTimeout(() => {
			controller.abort();
			if (active) setError("Preview build timed out");
		}, INTELLIGENT_UI_FILE_LIMITS.timeoutMs + 5_000);
		setBundle(null);
		setError(null);
		void loadIntelligentUiPreview(narratorId, { toolUseId, toolCallId }, controller.signal)
			.then((next) => {
				if (active && !controller.signal.aborted) setBundle(next);
			})
			.catch((reason: unknown) => {
				if (active && !controller.signal.aborted) {
					setError(reason instanceof Error ? reason.message : "Preview build failed");
					controller.abort();
				}
			})
			.finally(() => clearTimeout(timer));
		return () => {
			active = false;
			clearTimeout(timer);
			controller.abort();
		};
	}, [narratorId, toolUseId, toolCallId, attempt]);
	return { bundle, error, reload };
}
