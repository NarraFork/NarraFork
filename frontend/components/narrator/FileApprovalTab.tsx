import { usePermissionFilePreview } from "@frontend/hooks/useNarrator";
import { toRelativePath } from "@frontend/lib/format";
import { readSession, removeSession, writeSession } from "@frontend/lib/session-store";
import { Box, Button, Center, Group, Loader, Tabs, Text, Textarea } from "@mantine/core";
import { useCallback, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TruncatedPath } from "../common/TruncatedPath";
import { DiffView } from "./diff/DiffView";
import type { PendingPermission } from "./narrator-panel-types";
import { PermEnterHintCtx } from "./tool-call/tool-call-contexts";

const MAX_FULL_FILE_PREVIEW_CHARS = 120_000;
/**
 * Longest approval note mirrored into browser storage.
 *
 * Was 120k. This is a reviewer's note attached to one permission decision, and it
 * is keyed by permission id — an id space that grows with every prompt that never
 * reached a decision. A large ceiling on an unbounded key space is what let these
 * drafts consume the `sessionStorage` quota.
 */
const FILE_APPROVAL_FEEDBACK_MAX_CHARS = 8_000;

function readFileApprovalDraft(draftId: string): string {
	try {
		const raw = readSession("permission-draft", draftId);
		if (!raw) return "";
		const feedback = JSON.parse(raw).feedback;
		return typeof feedback === "string" && feedback.length <= FILE_APPROVAL_FEEDBACK_MAX_CHARS
			? feedback
			: "";
	} catch {
		return "";
	}
}

function persistFileApprovalDraft(draftId: string, feedback: string) {
	if (feedback && feedback.length <= FILE_APPROVAL_FEEDBACK_MAX_CHARS) {
		writeSession("permission-draft", draftId, JSON.stringify({ feedback }));
	} else {
		removeSession("permission-draft", draftId);
	}
}

export function FileApprovalTab({
	narratorId,
	basePath,
	permission,
	onDecision,
	readOnly,
}: {
	narratorId: string;
	basePath: string | null;
	permission: PendingPermission;
	onDecision?: (requestId: string, decision: "allow" | "deny", feedbackText?: string) => void;
	readOnly?: boolean;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const { focusIndex, setButtonCount, setHasFeedback, registerActions, activePermissionId } =
		useContext(PermEnterHintCtx);
	const isActivePermission = permission.id === activePermissionId;
	const toolUseId = permission.toolUseId ?? null;
	const { data, isLoading } = usePermissionFilePreview(narratorId, toolUseId, !!toolUseId);

	const draftKey = permission.id;
	const [feedback, setFeedback] = useState(() => readFileApprovalDraft(draftKey));

	useEffect(() => {
		persistFileApprovalDraft(draftKey, feedback);
	}, [draftKey, feedback]);

	// Notify parent when feedback presence changes so the Enter hint can auto-switch
	useEffect(() => {
		if (isActivePermission) setHasFeedback(!!feedback);
	}, [feedback, setHasFeedback, isActivePermission]);

	const handleAllow = useCallback(() => {
		removeSession("permission-draft", draftKey);
		onDecision?.(permission.id, "allow", feedback || undefined);
	}, [draftKey, onDecision, permission.id, feedback]);

	const handleDeny = useCallback(() => {
		removeSession("permission-draft", draftKey);
		onDecision?.(permission.id, "deny", feedback || undefined);
	}, [draftKey, onDecision, permission.id, feedback]);

	// Report button count and register actions — only for the active (earliest) permission
	useEffect(() => {
		if (!isActivePermission) return;
		if (readOnly) {
			setButtonCount(0);
			registerActions([]);
			return;
		}
		setButtonCount(2);
		registerActions([handleAllow, handleDeny]);
	}, [isActivePermission, readOnly, setButtonCount, registerActions, handleAllow, handleDeny]);

	if (isLoading) {
		return (
			<Center py="xl">
				<Loader size="sm" />
			</Center>
		);
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const inputJson = permission.inputJson as Record<string, any> | null;
	const filePath = data?.filePath ?? (inputJson?.file_path as string) ?? "unknown";
	const displayPath = toRelativePath(filePath, basePath);
	const lang = filePath.split(".").pop() ?? "";
	const currentContent = data?.currentContent ?? "";
	const previewContent = data?.previewContent ?? "";
	const fullPreviewContent =
		previewContent.length > MAX_FULL_FILE_PREVIEW_CHARS
			? `${previewContent.slice(0, MAX_FULL_FILE_PREVIEW_CHARS)}\n\n${t("filePreview_truncated")}`
			: previewContent;

	// For Edit tool, show the old_string → new_string diff from inputJson
	const isEdit = permission.toolName === "Edit";
	const oldString = isEdit ? ((inputJson?.old_string as string) ?? "") : "";
	const newString = isEdit ? ((inputJson?.new_string as string) ?? "") : "";

	return (
		<Box
			style={{
				overflow: "hidden",
				minWidth: 0,
				width: "100%",
				display: "flex",
				flexDirection: "column",
				flex: 1,
			}}
		>
			<Group px="sm" py={4} wrap="nowrap" style={{ minWidth: 0, overflow: "hidden" }}>
				<Text size="xs" fw={500} style={{ flexShrink: 0 }}>
					{permission.toolName}:
				</Text>
				<TruncatedPath path={displayPath} fw={500} />
			</Group>

			<Box
				style={{
					flex: 1,
					maxHeight: "calc(100vh - 280px)",
					overflowY: "auto",
					overflowX: "hidden",
					width: "100%",
				}}
			>
				<Tabs defaultValue="diff" variant="outline" mx="xs">
					<Tabs.List>
						<Tabs.Tab value="diff">{t("fileMod_changeDiff")}</Tabs.Tab>
						<Tabs.Tab value="full">{t("fileMod_fullFilePreview")}</Tabs.Tab>
					</Tabs.List>

					<Tabs.Panel value="diff" pt="xs">
						{isEdit && oldString ? (
							<DiffView oldStr={oldString} newStr={newString} maxHeight={500} language={lang} />
						) : (
							<DiffView
								oldStr={currentContent}
								newStr={previewContent}
								maxHeight={500}
								language={lang}
							/>
						)}
					</Tabs.Panel>

					<Tabs.Panel value="full" pt="xs">
						<Box
							style={{
								maxHeight: 500,
								overflow: "auto",
								fontFamily: "monospace",
								fontSize: "var(--mantine-font-size-xs)",
								whiteSpace: "pre-wrap",
								padding: "var(--mantine-spacing-xs)",
								backgroundColor: "var(--mantine-color-body)",
								border: "1px solid var(--mantine-color-default-border)",
								borderRadius: "var(--mantine-radius-sm)",
							}}
						>
							{fullPreviewContent || "(empty)"}
						</Box>
					</Tabs.Panel>
				</Tabs>
			</Box>

			<Box px="sm" pb="sm">
				{permission.decisionReason && (
					<Text size="xs" c="dimmed" mb={4}>
						{permission.decisionReason}
					</Text>
				)}
				<Textarea
					size="xs"
					placeholder={t("feedbackPlaceholder")}
					value={feedback}
					onChange={(e) => setFeedback(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && feedback.trim()) {
							e.preventDefault();
							handleDeny();
						}
					}}
					autosize
					minRows={1}
					maxRows={3}
					mb="xs"
					disabled={readOnly}
				/>
				{readOnly ? (
					<Text size="xs" c="dimmed">
						{t("permissionActionsUnavailable")}
					</Text>
				) : (
					<Group gap="sm">
						<Button
							size="sm"
							color="green"
							onClick={handleAllow}
							className={isActivePermission && focusIndex === 0 ? "perm-btn-pulse" : undefined}
							style={
								isActivePermission && focusIndex === 0
									? ({
											"--perm-pulse-color": "var(--mantine-color-green-filled)",
										} as React.CSSProperties)
									: undefined
							}
						>
							{tc("allow")}
							{isActivePermission && focusIndex === 0 && (
								<Text span size="xs" ml={4} opacity={0.7}>
									⏎
								</Text>
							)}
						</Button>
						<Button
							size="sm"
							color="red"
							variant="light"
							onClick={handleDeny}
							className={isActivePermission && focusIndex === 1 ? "perm-btn-pulse" : undefined}
							style={
								isActivePermission && focusIndex === 1
									? ({
											"--perm-pulse-color": "var(--mantine-color-red-filled)",
										} as React.CSSProperties)
									: undefined
							}
						>
							{tc("deny")}
							{isActivePermission && focusIndex === 1 && (
								<Text span size="xs" ml={4} opacity={0.7}>
									⏎
								</Text>
							)}
						</Button>
					</Group>
				)}
			</Box>
		</Box>
	);
}
