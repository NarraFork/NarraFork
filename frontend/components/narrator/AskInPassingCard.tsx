import { Box, Button, Group, Paper, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowRight, IconMessageQuestion } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAskInPassing, useCancelAskInPassing } from "../../hooks/useNarrator";

const CARD_BG = "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))";

export function AskInPassingPendingCard({
	messageId,
	narratorId,
}: {
	messageId: string;
	narratorId: string;
}) {
	const { t } = useTranslation("narrator");
	const [value, setValue] = useState("");
	const resolveMutation = useAskInPassing();
	const cancelMutation = useCancelAskInPassing();
	const navigate = useNavigate();

	const isBusy = resolveMutation.isPending || cancelMutation.isPending;

	const handleSubmit = () => {
		const question = value.trim();
		if (!question || isBusy) return;

		resolveMutation.mutate(
			{
				narratorId,
				question,
				pendingMessageId: messageId,
			},
			{
				onSuccess: (newNarrator: { id: string }) => {
					navigate({
						to: "/narrators/$narratorId",
						params: { narratorId: newNarrator.id },
					});
				},
				onError: (error: Error) => {
					notifications.show({
						message: error.message,
						color: "red",
						autoClose: 5000,
					});
				},
			},
		);
	};

	const handleCancel = () => {
		if (isBusy) return;
		cancelMutation.mutate(
			{ narratorId, messageId },
			{
				onError: (error: Error) => {
					notifications.show({
						message: error.message,
						color: "red",
						autoClose: 5000,
					});
				},
			},
		);
	};

	return (
		<Box
			px="md"
			py="xs"
			style={{
				borderRadius: "var(--mantine-radius-md)",
				border: "1px dashed var(--mantine-color-indigo-7)",
				backgroundColor: CARD_BG,
			}}
		>
			<Group gap={6} mb={4}>
				<IconMessageQuestion size={14} color="var(--mantine-color-indigo-5)" />
				<Text size="xs" c="dimmed">
					{t("askInPassing_hint")}
				</Text>
			</Group>
			<Group gap="xs" wrap="nowrap">
				<TextInput
					flex={1}
					size="sm"
					placeholder={t("askInPassing_placeholder")}
					value={value}
					onChange={(e) => setValue(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && value.trim()) {
							e.preventDefault();
							handleSubmit();
						}
						if (e.key === "Escape") {
							e.preventDefault();
							handleCancel();
						}
					}}
					disabled={isBusy}
				/>
				<Button
					size="sm"
					variant="filled"
					onClick={handleSubmit}
					loading={resolveMutation.isPending}
					disabled={!value.trim()}
				>
					{t("askInPassing_confirm")}
				</Button>
				<Button size="sm" variant="subtle" onClick={handleCancel} disabled={isBusy}>
					{t("askInPassing_cancel")}
				</Button>
			</Group>
		</Box>
	);
}

export function AskInPassingResolvedCard({
	block,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	block: any;
}) {
	const { t } = useTranslation("narrator");
	const navigate = useNavigate();

	const question = block.question as string;
	const targetNarratorId = block.targetNarratorId as string;
	const truncatedQuestion = question.length > 60 ? `${question.slice(0, 60)}...` : question;

	return (
		<Paper
			px="sm"
			py="xs"
			radius="sm"
			style={{
				backgroundColor: CARD_BG,
				borderLeft: "3px solid var(--mantine-color-indigo-7)",
				cursor: "pointer",
			}}
			onClick={() =>
				navigate({
					to: "/narrators/$narratorId",
					params: { narratorId: targetNarratorId },
				})
			}
		>
			<Group gap={6} wrap="nowrap">
				<IconMessageQuestion size={14} color="var(--mantine-color-indigo-5)" />
				<Stack gap={0} flex={1}>
					<Text size="xs" c="dimmed">
						{t("askInPassing_resolvedLabel")}
					</Text>
					<Text size="sm" lineClamp={2} fw={500}>
						{truncatedQuestion}
					</Text>
				</Stack>
				<IconArrowRight size={14} color="var(--mantine-color-indigo-5)" />
			</Group>
		</Paper>
	);
}
