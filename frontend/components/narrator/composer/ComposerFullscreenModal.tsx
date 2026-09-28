import type { OptimizeStyle, UsePromptOptimizeResult } from "@frontend/hooks/usePromptOptimize";
import { narratorsApi } from "@frontend/lib/api/narrators";
import { Box, Button, Group, Modal, Stack, Text, Textarea } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	TextareaOptimizeControls,
	textareaOptimizeControlsWidth,
} from "./TextareaOptimizeControls";

export interface ComposerFullscreenModalProps {
	opened: boolean;
	onClose: () => void;
	initialText: string;
	onSubmit: (text: string) => void;
	/** Show character/line count */
	showStats?: boolean;
	/** Optional optimize hook for prompt optimization */
	optimizeHook?: UsePromptOptimizeResult;
	/** Narrator ID for optimization API calls */
	narratorId?: string;
	/** Message ID for context (when editing) */
	messageId?: string;
}

export function ComposerFullscreenModal({
	opened,
	onClose,
	initialText,
	onSubmit,
	showStats = true,
	optimizeHook,
	narratorId,
	messageId,
}: ComposerFullscreenModalProps) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const [text, setText] = useState(initialText);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Sync text with initialText when modal opens
	useEffect(() => {
		if (opened) {
			setText(initialText);
		}
	}, [opened, initialText]);

	const handleSubmit = () => {
		onSubmit(text);
		onClose();
	};

	// Keyboard shortcuts
	useHotkeys([
		["mod+Enter", handleSubmit],
		["Escape", onClose],
	]);

	// Stats
	const charCount = text.length;
	const lineCount = text.split("\n").length;
	const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

	// Handle optimize in modal - manually call the API since we can't reuse the hook's textarea ref
	const handleOptimizeInModal = async (style: OptimizeStyle) => {
		if (!optimizeHook || !narratorId || !textareaRef.current || !text.trim()) return;

		const textarea = textareaRef.current;
		try {
			const result = await narratorsApi.optimizePrompt(narratorId, textarea.value, style, {
				withContext: optimizeHook.withContext,
				messageId,
				signal: undefined,
			});

			// Use document.execCommand for browser native undo support
			textarea.focus();
			textarea.setSelectionRange(0, textarea.value.length);
			document.execCommand("insertText", false, result.text);
			setText(result.text);

			notifications.show({
				message: t("optimizeSuccess"),
				color: "green",
				autoClose: 8000,
			});
		} catch (err) {
			notifications.show({
				title: t("optimizeFailed"),
				message: (err as Error).message || t("optimizeFailedGeneric"),
				color: "red",
				autoClose: 10000,
			});
		}
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t("fullscreenComposerTitle")}
			size="xl"
			centered
			styles={{
				content: {
					maxHeight: "85vh",
					display: "flex",
					flexDirection: "column",
				},
				body: {
					flex: 1,
					display: "flex",
					flexDirection: "column",
					padding: 0,
				},
			}}
		>
			<Box p="md" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
				<Textarea
					ref={textareaRef}
					value={text}
					onChange={(e) => setText(e.currentTarget.value)}
					placeholder={t("fullscreenComposerPlaceholder")}
					autoFocus
					minRows={20}
					maxRows={30}
					autosize
					styles={{
						input: {
							fontFamily: "var(--mantine-font-family-monospace)",
							fontSize: "14px",
							lineHeight: 1.6,
						},
					}}
					style={{ flex: 1 }}
					rightSection={
						optimizeHook ? (
							<TextareaOptimizeControls
								disabled={!text.trim() || optimizeHook.loading}
								loading={optimizeHook.loading}
								withContext={optimizeHook.withContext}
								onToggleContext={optimizeHook.toggleContext}
								onOptimize={handleOptimizeInModal}
								contextMessageCount={optimizeHook.contextMessageCount}
								onContextMessageCountChange={optimizeHook.setContextMessageCount}
							/>
						) : undefined
					}
					// No `onExpand` is passed here, so only the optimize button is present and the reserved
					// strip is correspondingly narrower. `top` keeps the buttons beside the FIRST line of a
					// tall textarea rather than centred in it.
					rightSectionWidth={optimizeHook ? textareaOptimizeControlsWidth(false) : undefined}
					rightSectionProps={optimizeHook ? { style: { top: 8 } } : undefined}
				/>
				<Stack gap="sm" mt="md">
					{showStats && text.length > 0 && (
						<Group gap="md">
							<Text size="xs" c="dimmed">
								{t("fullscreenStats", { chars: charCount, lines: lineCount, words: wordCount })}
							</Text>
						</Group>
					)}
					<Group justify="space-between">
						<Text size="xs" c="dimmed">
							{t("fullscreenHint")}
						</Text>
						<Group gap="sm">
							<Button variant="subtle" onClick={onClose}>
								{tc("cancel")}
							</Button>
							<Button onClick={handleSubmit} disabled={!text.trim()}>
								{tc("confirm")}
							</Button>
						</Group>
					</Group>
				</Stack>
			</Box>
		</Modal>
	);
}
