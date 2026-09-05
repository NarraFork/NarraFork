import { Box, Button, Group, Paper, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowRight, IconMessageQuestion } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAskInPassing, useCancelAskInPassing } from "../../hooks/useNarrator";
import { resolveAskInPassingOpenPlan } from "./ask-in-passing-open-target";
import { useNarratorDockContext } from "./dock/NarratorDockContext";

const CARD_BG = "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))";

/**
 * The opener for an ask-in-passing answer, by narrator id.
 *
 * Used by the PENDING card, which only learns the target when its mutation
 * resolves — so it needs the action, not a pre-bound callback. Applies the
 * in-surface-first rule from `resolveAskInPassingOpenPlan`.
 */
export function useOpenAskInPassingNarrator(): (targetNarratorId: string) => void {
	const navigate = useNavigate();
	const dock = useNarratorDockContext();
	const openInDock = dock?.openSubagentPanel;

	return useCallback(
		(targetNarratorId: string) => {
			const plan = resolveAskInPassingOpenPlan({
				targetNarratorId,
				canOpenInDock: !!openInDock,
			});
			if (plan.mode === "none") return;
			// A panel beside this conversation, not a page instead of it: the aside was
			// asked ABOUT what is on screen, so navigating away discards the context
			// that motivated it (scroll position, draft, the message itself).
			if (plan.mode === "dock") {
				openInDock?.(plan.targetNarratorId);
				return;
			}
			navigate({
				to: "/narrators/$narratorId",
				params: { narratorId: plan.targetNarratorId },
			});
		},
		[openInDock, navigate],
	);
}

/**
 * A pre-bound opener for one known target, or null when there is nowhere to go.
 *
 * Null (rather than a no-op) so a legacy resolved card with no recorded target
 * renders inert instead of offering a click that routes to an empty narrator id.
 */
export function useOpenAskInPassingTarget(
	targetNarratorId: string | null | undefined,
): (() => void) | null {
	const openNarrator = useOpenAskInPassingNarrator();
	const resolvedId = targetNarratorId?.trim() ?? "";

	// Built unconditionally (hook rules); only handed back when there is a target.
	const open = useCallback(() => {
		if (resolvedId) openNarrator(resolvedId);
	}, [resolvedId, openNarrator]);

	return resolvedId ? open : null;
}

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
	const openAnswer = useOpenAskInPassingNarrator();
	const inputRef = useRef<HTMLInputElement>(null);

	// The card only ever appears because the reader just picked 顺便提问, so the
	// input is the single thing they want next. Without this they must aim at a
	// freshly-inserted row before typing — and on the virtual list that row may
	// still be settling its height.
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

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
					openAnswer(newNarrator.id);
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
					ref={inputRef}
					flex={1}
					size="sm"
					placeholder={t("askInPassing_placeholder")}
					value={value}
					onChange={(e) => setValue(e.currentTarget.value)}
					onKeyDown={(e) => {
						// isComposing: with a CJK IME the first Enter commits the candidate
						// word. Submitting on it too sends the raw pinyin and closes the input.
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && value.trim()) {
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

	const question = block.question as string;
	const targetNarratorId = block.targetNarratorId as string | undefined;
	const truncatedQuestion = question.length > 60 ? `${question.slice(0, 60)}...` : question;
	// Null for cards written before the target was persisted — such a card stays
	// readable but not clickable, rather than routing to an empty narrator id.
	const open = useOpenAskInPassingTarget(targetNarratorId);

	return (
		<Paper
			px="sm"
			py="xs"
			radius="sm"
			style={{
				backgroundColor: CARD_BG,
				borderLeft: "3px solid var(--mantine-color-indigo-7)",
				cursor: open ? "pointer" : undefined,
			}}
			onClick={open ?? undefined}
			{...(open
				? {
						role: "button",
						tabIndex: 0,
						onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								open();
							}
						},
					}
				: {})}
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
