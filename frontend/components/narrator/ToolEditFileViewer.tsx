import { Alert, Badge, Box, Button, Center, Group, Loader, Stack, Tabs, Text } from "@mantine/core";
import type { ToolEditPreviewSide } from "@shared/tool-edit-preview";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { toolCallDetailQueryKey } from "../../lib/api/narrators";
import { getShikiLang } from "../../lib/shiki-lang";
import { DiffView } from "./DiffView";
import { MonacoEditor } from "./file-editor/MonacoEditor";
import { buildToolEditDiff, toolEditSelection } from "./tool-edit-diff";
import {
	isToolEditReference,
	type ToolEditReference,
	toolEditReferenceKey,
} from "./tool-edit-reference";

export interface ToolEditFileViewerProps {
	reference: ToolEditReference;
	filePath: string;
	navigationRequestId?: string;
}

/** A separate, read-only historical resource; never mounts a current-file reader/editor. */
export function ToolEditFileViewer(props: ToolEditFileViewerProps) {
	return <HistoricalEdit key={toolEditReferenceKey(props.reference)} {...props} />;
}

function HistoricalEdit({ reference, filePath, navigationRequestId }: ToolEditFileViewerProps) {
	const { t } = useTranslation("narrator");
	const [mode, setMode] = useState<"old" | "new" | "diff">("diff");
	const [jump, setJump] = useState(0);
	const valid = isToolEditReference(reference);
	const query = useQuery({
		queryKey: [
			...toolCallDetailQueryKey(reference.narratorId, reference.toolUseId, reference),
			"file-edit-preview",
		],
		enabled: valid,
		queryFn: ({ signal }) =>
			api.getToolEditPreview(
				reference.narratorId,
				reference.toolUseId,
				reference,
				AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
			),
		retry: false,
		staleTime: 30_000,
		gcTime: 30_000,
		refetchOnWindowFocus: false,
	});
	const preview = query.data;
	const diff = useMemo(() => {
		if (
			!preview ||
			preview.before.status === "unavailable" ||
			preview.after.status === "unavailable"
		)
			return null;
		return buildToolEditDiff(preview.before.content, preview.after.content);
	}, [preview]);
	const selectedSide = mode === "old" ? preview?.before : preview?.after;
	const selection = useMemo(
		() => (preview ? toolEditSelection(preview, mode === "old" ? "old" : "new", diff) : undefined),
		[preview, mode, diff],
	);
	const requestId = `${navigationRequestId ?? "initial"}:${jump}:${mode}`;
	const language = getShikiLang(preview?.filePath ?? filePath);
	const unavailable = (side: ToolEditPreviewSide, label: string) =>
		side.status === "unavailable" ? (
			<Alert color="yellow" title={label} key={label}>
				{t(`editPreview.reason.${side.reason}`)}
			</Alert>
		) : null;

	return (
		<Stack h="100%" gap="xs" p="xs" style={{ minHeight: 0, overflow: "hidden" }}>
			<Group justify="space-between" gap="xs" wrap="wrap">
				<Tabs
					value={mode}
					onChange={(value) => {
						if (value) setMode(value as typeof mode);
					}}
				>
					<Tabs.List aria-label={t("editPreview.views")}>
						<Tabs.Tab value="old">{t("editPreview.old")}</Tabs.Tab>
						<Tabs.Tab value="new">{t("editPreview.new")}</Tabs.Tab>
						<Tabs.Tab value="diff">Diff</Tabs.Tab>
					</Tabs.List>
				</Tabs>
				<Group gap="xs">
					<Badge variant="light" size="sm">
						{t("editPreview.readOnly")}
					</Badge>
					<Button
						size="compact-xs"
						variant="subtle"
						disabled={!preview}
						onClick={() => setJump((value) => value + 1)}
					>
						{t("editPreview.locate")}
					</Button>
					<Button
						size="compact-xs"
						variant="subtle"
						loading={query.isFetching}
						disabled={!valid}
						onClick={() => void query.refetch()}
					>
						{t("editPreview.reload")}
					</Button>
				</Group>
			</Group>
			<Text size="xs" c="dimmed" truncate title={preview?.filePath ?? filePath}>
				{preview?.deviceId ? `${preview.deviceId} · ` : ""}
				{preview?.filePath ?? filePath}
			</Text>
			{!valid && <Alert color="red">{t("editPreview.reason.identity_unverified")}</Alert>}
			{valid && query.isPending && (
				<Center style={{ flex: 1 }}>
					<Loader size="sm" />
				</Center>
			)}
			{query.isError && (
				<Alert color="red" title={t("editPreview.failed")}>
					{query.error.message}
				</Alert>
			)}
			{preview && mode === "diff" && (
				<>
					{unavailable(preview.before, t("editPreview.old"))}
					{unavailable(preview.after, t("editPreview.new"))}
					{diff?.unavailable && <Alert color="yellow">{t("editPreview.diffBudget")}</Alert>}
					{diff?.truncated && <Alert color="yellow">{t("editPreview.diffTruncated")}</Alert>}
					{diff &&
						!diff.unavailable &&
						(diff.lines.length ? (
							<DiffView
								key={requestId}
								lines={diff.lines}
								hunks={diff.hunks}
								language={language}
								gutterMinWidth={1}
							/>
						) : (
							<Text size="sm" c="dimmed">
								{t("editPreview.noChanges")}
							</Text>
						))}
				</>
			)}
			{preview && mode !== "diff" && selectedSide && (
				<>
					{unavailable(selectedSide, t(mode === "old" ? "editPreview.old" : "editPreview.new"))}
					{selectedSide.status === "absent" && (
						<Text size="sm" c="dimmed">
							{t("editPreview.absent")}
						</Text>
					)}
					{selectedSide.status === "available" && (
						<Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
							<MonacoEditor
								key={mode}
								documentKey={`historical:${toolEditReferenceKey(reference)}:${mode}`}
								initialValue={selectedSide.content}
								filePath={preview.filePath ?? filePath}
								readOnly
								selection={selection}
								navigationRequestId={requestId}
							/>
						</Box>
					)}
				</>
			)}
		</Stack>
	);
}
