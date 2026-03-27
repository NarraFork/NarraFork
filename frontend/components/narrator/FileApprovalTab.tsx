import { usePermissionFilePreview } from "@frontend/hooks/useNarrator";
import {
	Box,
	Button,
	Center,
	Group,
	Loader,
	ScrollArea,
	Stack,
	Tabs,
	Text,
	Textarea,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DiffView } from "./DiffView";
import type { PendingPermission } from "./narrator-panel-types";

export function FileApprovalTab({
	narratorId,
	permission,
	onDecision,
}: {
	narratorId: string;
	permission: PendingPermission;
	onDecision?: (requestId: string, decision: "allow" | "deny", feedbackText?: string) => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
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

	const handleAllow = () => {
		sessionStorage.removeItem(draftKey);
		onDecision?.(permission.id, "allow", feedback || undefined);
	};

	const handleDeny = () => {
		sessionStorage.removeItem(draftKey);
		onDecision?.(permission.id, "deny", feedback || undefined);
	};

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
	const lang = filePath.split(".").pop() ?? "";
	const currentContent = data?.currentContent ?? "";
	const previewContent = data?.previewContent ?? "";

	// For Edit tool, show the old_string → new_string diff from inputJson
	const isEdit = permission.toolName === "Edit";
	const oldString = isEdit ? ((inputJson?.old_string as string) ?? "") : "";
	const newString = isEdit ? ((inputJson?.new_string as string) ?? "") : "";

	return (
		<Stack gap="xs" h="100%">
			<Group px="sm" py={4}>
				<Text size="xs" fw={500}>
					{permission.toolName}: {filePath}
				</Text>
			</Group>

			<ScrollArea.Autosize mah="calc(100vh - 280px)" style={{ flex: 1 }}>
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
			</ScrollArea.Autosize>

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
					autosize
					minRows={1}
					maxRows={3}
					mb="xs"
				/>
				<Group gap="sm">
					<Button size="sm" color="green" onClick={handleAllow}>
						{tc("allow")}
					</Button>
					<Button size="sm" color="red" variant="light" onClick={handleDeny}>
						{tc("deny")}
					</Button>
				</Group>
			</Box>
		</Stack>
	);
}
