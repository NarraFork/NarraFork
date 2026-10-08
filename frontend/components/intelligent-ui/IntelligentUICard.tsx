import { useRenderInteractive } from "@frontend/components/narrator/lod/RenderLodCtx";
import { useMobileViewport } from "@frontend/hooks/useMobileViewport";
import { onTokenChange } from "@frontend/lib/api/client";
import { Box, Button, Drawer, Group, Loader, Modal, Text } from "@mantine/core";
import type { IntelligentUiFileReference } from "@shared/intelligent-ui-files";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const FilePreview = lazy(() =>
	import("./FilePreview").then((module) => ({ default: module.FilePreview })),
);

export interface IntelligentUICardProps {
	narratorId?: string;
	file: IntelligentUiFileReference | null;
	publicSummary?: boolean;
	historyUnavailable?: boolean;
	height: number;
}

/** List rows and public shares never mount a preview, fetch source or execute an iframe. */
export function IntelligentUICard(props: IntelligentUICardProps) {
	const interactive = useRenderInteractive();
	const { t } = useTranslation("narrator");
	if (props.publicSummary || !interactive || !props.narratorId || !props.file) {
		return (
			<Box h={props.height} p="xs">
				<Text fw={600} size="sm">
					{t("intelligentUi.title")}
				</Text>
				<Text size="xs" c="dimmed">
					{t(
						props.publicSummary || !interactive || !props.narratorId
							? "intelligentUi.staticPreview"
							: "intelligentUi.unavailable",
					)}
				</Text>
			</Box>
		);
	}
	return (
		<PrivateCard
			key={`${props.narratorId}:${props.file.toolCallId}`}
			narratorId={props.narratorId}
			file={props.file}
			historyUnavailable={props.historyUnavailable}
			height={props.height}
		/>
	);
}

function PrivateCard({
	narratorId,
	file,
	height,
	historyUnavailable,
}: {
	narratorId: string;
	file: IntelligentUiFileReference;
	height: number;
	historyUnavailable?: boolean;
}) {
	const { t } = useTranslation("narrator");
	const mobile = useMobileViewport();
	const [opened, setOpened] = useState(false);
	useEffect(() => {
		if (!opened) return;
		const unsubscribe = onTokenChange(() => setOpened(false));
		const onStorage = (event: StorageEvent) => {
			if (event.key === "narrafork_token" || event.key === null) setOpened(false);
		};
		window.addEventListener("storage", onStorage);
		return () => {
			unsubscribe();
			window.removeEventListener("storage", onStorage);
		};
	}, [opened]);
	const title = file.title || t("intelligentUi.title");
	const path = `${file.directory.replace(/[\\/]$/, "")}/${file.entry}`;
	const preview = opened ? (
		<Suspense fallback={<Loader size="sm" />}>
			<FilePreview narratorId={narratorId} file={file} />
		</Suspense>
	) : null;
	return (
		<>
			<Box h={height} p="xs" style={{ overflow: "hidden" }}>
				<Group justify="space-between" gap="xs" wrap="nowrap">
					<Text fw={600} size="sm" truncate style={{ minWidth: 0 }} title={title}>
						{title}
					</Text>
					<Button
						size="compact-xs"
						variant="light"
						onClick={() => setOpened(true)}
						style={{ flexShrink: 0 }}
					>
						{t("intelligentUi.open")}
					</Button>
				</Group>
				<Text size="xs" c="dimmed" truncate title={path}>
					{path}
				</Text>
				<Text size="xs" c={historyUnavailable ? "orange" : "dimmed"} truncate>
					{t(
						historyUnavailable ? "intelligentUi.historyUnavailable" : "intelligentUi.currentFiles",
					)}
				</Text>
			</Box>
			{opened &&
				(mobile ? (
					<Drawer
						opened
						onClose={() => setOpened(false)}
						title={title}
						position="bottom"
						size="90%"
					>
						{preview}
					</Drawer>
				) : (
					<Modal opened onClose={() => setOpened(false)} title={title} size="90%">
						{preview}
					</Modal>
				))}
		</>
	);
}
