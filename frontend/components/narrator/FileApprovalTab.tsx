import { usePermissionFilePreview } from "@frontend/hooks/useNarrator";
import { toRelativePath } from "@frontend/lib/format";
import { Box, Button, Center, Group, Loader, Tabs, Text, Textarea } from "@mantine/core";
import { useCallback, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TruncatedPath } from "../common/TruncatedPath";
import { DiffView } from "./DiffView";
import type { PendingPermission } from "./narrator-panel-types";
import { PermEnterHintCtx } from "./ToolCallCard";

export function FileApprovalTab({
	narratorId,
	basePath,
	permission,
	onDecision,
}: {
	narratorId: string;
	basePath: string | null;
	permission: PendingPermission;
	onDecision?: (requestId: string, decision: "allow" | "deny", feedbackText?: string) => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const { focusIndex, setButtonCount, setHasFeedback, registerActions, activePermissionId } =
		useContext(PermEnterHintCtx);
	const isActivePermission = permission.id === activePermissionId;
	const toolUseId = permission.toolUseId ?? null;
	const { data, isLoading } = usePermissionFilePreview(narratorId, toolUseId, !!toolUseId);

	const draftKey = `narrafork_perm_draft_${permission.id}`;
	const [feedback, setFeedback] = useState(() => {
		try {
			const raw = sessionStorage.getItem(draftKey);
			if (raw) return JSON.parse(raw).feedback ?? "";
		} catch {
			// sessionStorage may be disabled or JSON malformed — ignore
		}
		return "";
	});

	useEffect(() => {
		if (feedback) {
			sessionStorage.setItem(draftKey, JSON.stringify({ feedback }));
		} else {
			sessionStorage.removeItem(draftKey);
		}
	}, [draftKey, feedback]);

	// Notify parent when feedback presence changes so the Enter hint can auto-switch
	useEffect(() => {
		if (isActivePermission) setHasFeedback(!!feedback);
	}, [feedback, setHasFeedback, isActivePermission]);

	const handleAllow = useCallback(() => {
		sessionStorage.removeItem(draftKey);
		onDecision?.(permission.id, "allow", feedback || undefined);
	}, [draftKey, onDecision, permission.id, feedback]);

	const handleDeny = useCallback(() => {
		sessionStorage.removeItem(draftKey);
		onDecision?.(permission.id, "deny", feedback || undefined);
	}, [draftKey, onDecision, permission.id, feedback]);

	// Report button count and register actions — only for the active (earliest) permission
	useEffect(() => {
		if (!isActivePermission) return;
		setButtonCount(2);
		registerActions([handleAllow, handleDeny]);
	}, [isActivePermission, setButtonCount, registerActions, handleAllow, handleDeny]);

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
								backgroundColor: "var(--mantine-color-dark-7)",
								borderRadius: "var(--mantine-radius-sm)",
							}}
						>
							{previewContent || "(empty)"}
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
				/>
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
			</Box>
		</Box>
	);
}
