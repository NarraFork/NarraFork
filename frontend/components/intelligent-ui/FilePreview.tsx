import { subscribeHostPresentation } from "@frontend/components/plugins/host-presentation";
import { useIntelligentUI } from "@frontend/hooks/useIntelligentUI";
import { Alert, Button, Group, Loader, Stack, Text } from "@mantine/core";
import type { IntelligentUiFileReference } from "@shared/intelligent-ui-files";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewBundle } from "./preview-loader";
import { createPreviewShell, readPreviewTheme } from "./preview-shell";

/** This component's entire lifetime is the open modal's lifetime. */
export function FilePreview({
	narratorId,
	file,
}: {
	narratorId: string;
	file: IntelligentUiFileReference;
}) {
	const { t } = useTranslation("narrator");
	const { bundle, error, reload } = useIntelligentUI(narratorId, file);
	return (
		<Stack gap="sm">
			<Group justify="space-between">
				<Text size="xs" c="dimmed">
					{t("intelligentUi.currentFiles")}
				</Text>
				<Button size="compact-sm" variant="light" onClick={reload}>
					{t("intelligentUi.reload")}
				</Button>
			</Group>
			{error ? (
				<Alert color="red" title={t("intelligentUi.loadFailed")}>
					<Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
						{error}
					</Text>
				</Alert>
			) : bundle ? (
				<>
					<Text size="xs" c="dimmed">
						{t("intelligentUi.untrustedPreview")}
					</Text>
					<PreviewFrame
						bundle={bundle}
						title={file.title}
						failureMessage={t("intelligentUi.renderFailed")}
					/>
				</>
			) : (
				<Group>
					<Loader size="sm" />
					<Text size="sm">{t("intelligentUi.loading")}</Text>
				</Group>
			)}
		</Stack>
	);
}

function PreviewFrame({
	bundle,
	title,
	failureMessage,
}: {
	bundle: PreviewBundle;
	title: string;
	failureMessage: string;
}) {
	const { t } = useTranslation("narrator");
	const frame = useRef<HTMLIFrameElement>(null);
	const loads = useRef(0);
	const loadProbe = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [navigated, setNavigated] = useState(false);
	// Theme changes update only tokens/provider state, never recreate the user's open UI.
	const [srcDoc] = useState(() => createPreviewShell(bundle, readPreviewTheme(), failureMessage));
	const sendTheme = () =>
		frame.current?.contentWindow?.postMessage(
			{ type: "narrafork:preview-theme", theme: readPreviewTheme() },
			"*",
		);
	useEffect(() => {
		if (navigated) return;
		const update = () =>
			frame.current?.contentWindow?.postMessage(
				{ type: "narrafork:preview-theme", theme: readPreviewTheme() },
				"*",
			);
		const onNavigation = (event: MessageEvent) => {
			if (event.source !== frame.current?.contentWindow) return;
			if (event.data?.type === "narrafork:preview-left") setNavigated(true);
			if (event.data?.type === "narrafork:preview-present" && event.data.id === loads.current)
				clearTimeout(loadProbe.current);
		};
		window.addEventListener("message", onNavigation);
		const unsubscribe = subscribeHostPresentation(update);
		return () => {
			clearTimeout(loadProbe.current);
			window.removeEventListener("message", onNavigation);
			unsubscribe();
		};
	}, [navigated]);
	if (navigated) return <Alert color="orange">{t("intelligentUi.navigationStopped")}</Alert>;
	return (
		<iframe
			ref={frame}
			title={title}
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			srcDoc={srcDoc}
			onLoad={() => {
				// Best-effort teardown, NOT a network firewall: navigation has already happened.
				if (++loads.current > 1) setNavigated(true);
				else {
					// Immediate navigation can replace srcdoc before its first load. Probe only
					// for best-effort teardown, not authentication or proof of zero external IO.
					loadProbe.current = setTimeout(() => setNavigated(true), 1000);
					frame.current?.contentWindow?.postMessage(
						{ type: "narrafork:preview-check", id: loads.current },
						"*",
					);
					sendTheme();
				}
			}}
			style={{ width: "100%", height: "65dvh", border: 0, display: "block" }}
		/>
	);
}
