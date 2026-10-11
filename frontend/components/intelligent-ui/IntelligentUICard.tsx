import { useRenderInteractive } from "@frontend/components/narrator/lod/RenderLodCtx";
import { useMobileViewport } from "@frontend/hooks/useMobileViewport";
import { onTokenChange } from "@frontend/lib/api/client";
import { Box, Button, Drawer, Group, Loader, Modal, Text } from "@mantine/core";
import type { IntelligentUiFileReference } from "@shared/intelligent-ui-files";
import type { IntelligentUiKitNotice } from "@shared/intelligent-ui-kit";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const FilePreview = lazy(() =>
	import("./FilePreview").then((module) => ({ default: module.FilePreview })),
);
const InlineRender = lazy(() =>
	import("./InlineRender").then((module) => ({ default: module.InlineRender })),
);
const KitNoticeBar = lazy(() =>
	import("./KitNoticeBar").then((module) => ({ default: module.KitNoticeBar })),
);

/** Header row of an inline card; the frame gets the rest of the reserved height. */
const INLINE_HEADER = 28;
/** Reserved for the kit confirmation row, so it never moves the frame when it appears. */
const NOTICE_ROW = 26;

export interface IntelligentUICardProps {
	narratorId?: string;
	file: IntelligentUiFileReference | null;
	publicSummary?: boolean;
	historyUnavailable?: boolean;
	height: number;
	/** `render` markup, drawn in the row itself and re-drawn as it streams. */
	inline?: {
		source: string;
		live: boolean;
		title?: string;
		/** What the finished call was drawn with; old UI keeps that runtime. */
		runtime?: "builtin" | "project";
	};
	/** The kit this result used, and any build the user is being asked to confirm. */
	kit?: IntelligentUiKitNotice;
}

/** List rows and public shares never mount a preview, fetch source or execute an iframe. */
export function IntelligentUICard(props: IntelligentUICardProps) {
	const interactive = useRenderInteractive();
	const { t } = useTranslation("narrator");
	const usable = !props.publicSummary && interactive && !!props.narratorId;
	if (usable && props.narratorId && props.inline) {
		return (
			<InlineCard
				key={props.narratorId}
				narratorId={props.narratorId}
				inline={props.inline}
				kit={props.kit}
				height={props.height}
			/>
		);
	}
	if (usable && props.narratorId && props.file) {
		return (
			<PrivateCard
				key={`${props.narratorId}:${props.file.toolCallId}`}
				narratorId={props.narratorId}
				file={props.file}
				historyUnavailable={props.historyUnavailable}
				kit={props.kit}
				height={props.height}
			/>
		);
	}
	if (usable && props.narratorId && props.kit?.request) {
		return (
			<Box h={props.height} p="xs" style={{ overflow: "hidden" }}>
				<Text fw={600} size="sm">
					{t("intelligentUi.kit.title")}
				</Text>
				<Text size="xs" c="dimmed" truncate>
					{t(`intelligentUi.kit.state.${props.kit.state}`)}
				</Text>
				<Suspense fallback={null}>
					<KitNoticeBar narratorId={props.narratorId} notice={props.kit} />
				</Suspense>
			</Box>
		);
	}
	return (
		<Box h={props.height} p="xs">
			<Text fw={600} size="sm">
				{props.inline?.title || t("intelligentUi.title")}
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

function InlineCard({
	narratorId,
	inline,
	kit,
	height,
}: {
	narratorId: string;
	inline: NonNullable<IntelligentUICardProps["inline"]>;
	kit?: IntelligentUiKitNotice;
	height: number;
}) {
	const { t } = useTranslation("narrator");
	const mobile = useMobileViewport();
	const [expanded, setExpanded] = useState(false);
	const title = inline.title || t("intelligentUi.title");
	const notice = kit?.request ? NOTICE_ROW : 0;
	const expandedFrame = expanded ? (
		<Suspense fallback={<Loader size="sm" />}>
			<InlineRender
				narratorId={narratorId}
				source={inline.source}
				live={inline.live}
				height="70dvh"
				title={title}
				runtime={inline.runtime}
			/>
		</Suspense>
	) : null;
	return (
		<Box h={height} style={{ overflow: "hidden" }}>
			<Group h={INLINE_HEADER} px="xs" gap="xs" wrap="nowrap" justify="space-between">
				<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
					{inline.live && <Loader size={12} />}
					<Text fw={600} size="xs" truncate title={title}>
						{inline.live ? t("intelligentUi.streaming", { title }) : title}
					</Text>
				</Group>
				<Button
					size="compact-xs"
					variant="subtle"
					onClick={() => setExpanded(true)}
					style={{ flexShrink: 0 }}
				>
					{t("intelligentUi.expand")}
				</Button>
			</Group>
			{kit?.request && (
				<Box px="xs">
					<Suspense fallback={<Box h={NOTICE_ROW} />}>
						<KitNoticeBar narratorId={narratorId} notice={kit} />
					</Suspense>
				</Box>
			)}
			<Suspense fallback={null}>
				<InlineRender
					narratorId={narratorId}
					source={inline.source}
					live={inline.live}
					height={Math.max(60, height - INLINE_HEADER - notice)}
					title={title}
					runtime={inline.runtime}
				/>
			</Suspense>
			{expanded &&
				(mobile ? (
					<Drawer
						opened
						onClose={() => setExpanded(false)}
						title={title}
						position="bottom"
						size="90%"
					>
						{expandedFrame}
					</Drawer>
				) : (
					<Modal opened onClose={() => setExpanded(false)} title={title} size="90%">
						{expandedFrame}
					</Modal>
				))}
		</Box>
	);
}

function PrivateCard({
	narratorId,
	file,
	height,
	historyUnavailable,
	kit,
}: {
	narratorId: string;
	file: IntelligentUiFileReference;
	height: number;
	historyUnavailable?: boolean;
	kit?: IntelligentUiKitNotice;
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
				{kit?.request ? (
					// Takes the status line's place: the card's height is fixed.
					<Suspense fallback={null}>
						<KitNoticeBar narratorId={narratorId} notice={kit} />
					</Suspense>
				) : (
					<Text size="xs" c={historyUnavailable ? "orange" : "dimmed"} truncate>
						{t(
							historyUnavailable
								? "intelligentUi.historyUnavailable"
								: "intelligentUi.currentFiles",
						)}
					</Text>
				)}
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
