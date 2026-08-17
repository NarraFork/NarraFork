/**
 * Full-text search over a single narrator's own conversation history.
 *
 * Rendered as a dock resource panel (sibling of the chat panel). Results are
 * this narrator's messages, newest first; clicking one asks the chat panel to
 * scroll to + highlight it via the dock context's `scrollToMessage` bridge.
 * The panel is chromeless — the dock's ToolPanelShell supplies the header.
 */

import {
	Badge,
	Box,
	Center,
	Group,
	Loader,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	UnstyledButton,
} from "@mantine/core";
import { IconSearch, IconX } from "@tabler/icons-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarratorMessageSearch } from "../../hooks/useNarratorMessageSearch";
import { formatSmartTime } from "../../lib/format";
import { highlightSearchText } from "../../lib/search-utils";
import { useNarratorDockContext } from "./dock/NarratorDockContext";

/** Role → badge color, mirroring the message-role palette used elsewhere. */
function roleColor(role: string): string {
	switch (role) {
		case "user":
			return "blue";
		case "assistant":
			return "grape";
		default:
			return "gray";
	}
}

export interface NarratorSearchPanelProps {
	narratorId: string;
}

export function NarratorSearchPanel({ narratorId }: NarratorSearchPanelProps) {
	const { t } = useTranslation("narrator");
	const dock = useNarratorDockContext();
	const [query, setQuery] = useState("");
	const { data, isLoading, isShortQuery, debouncedQuery } = useNarratorMessageSearch(
		narratorId,
		query,
	);

	const results = useMemo(() => data?.results ?? [], [data?.results]);

	/**
	 * Jumping to a result needs a chat panel to scroll. That is absent when this
	 * panel has been torn out onto the story-network canvas and its source node is
	 * collapsed — so the bridge is missing rather than inert, and the result rows
	 * below go non-interactive instead of swallowing clicks.
	 */
	const scrollToMessage = dock?.scrollToMessage;
	const canJump = !!scrollToMessage;
	const handleJump = useCallback(
		(messageId: string) => {
			scrollToMessage?.(messageId);
		},
		[scrollToMessage],
	);

	return (
		<Box style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
			<Box p="xs" style={{ flexShrink: 0 }}>
				<TextInput
					size="sm"
					value={query}
					onChange={(e) => setQuery(e.currentTarget.value)}
					placeholder={t("search.placeholder")}
					autoFocus
					leftSection={<IconSearch size={16} />}
					rightSection={
						query ? (
							<UnstyledButton
								onClick={() => setQuery("")}
								aria-label={t("search.clear")}
								style={{ display: "flex", alignItems: "center" }}
							>
								<IconX size={16} color="var(--mantine-color-dimmed)" />
							</UnstyledButton>
						) : null
					}
				/>
			</Box>

			<Box style={{ flex: 1, minHeight: 0 }}>
				{isShortQuery ? (
					<Center h="100%" px="md">
						<Text size="sm" c="dimmed" ta="center">
							{t("search.shortQuery")}
						</Text>
					</Center>
				) : isLoading ? (
					<Center h="100%">
						<Loader size="sm" />
					</Center>
				) : !debouncedQuery ? (
					<Center h="100%" px="md">
						<Text size="sm" c="dimmed" ta="center">
							{t("search.empty")}
						</Text>
					</Center>
				) : results.length === 0 ? (
					<Center h="100%" px="md">
						<Text size="sm" c="dimmed" ta="center">
							{t("search.noResults")}
						</Text>
					</Center>
				) : (
					<ScrollArea h="100%" type="auto">
						<Stack gap={4} p="xs">
							<Text size="xs" c="dimmed" px={4}>
								{t("search.resultCount", { count: results.length })}
							</Text>
							{!canJump && (
								<Text size="xs" c="dimmed" px={4}>
									{t("search.jumpUnavailable")}
								</Text>
							)}
							{results.map((result) => (
								<UnstyledButton
									key={result.messageId}
									onClick={() => handleJump(result.messageId)}
									disabled={!canJump}
									style={{
										borderRadius: "var(--mantine-radius-sm)",
										padding: "8px 10px",
										border: "1px solid var(--mantine-color-default-border)",
										cursor: canJump ? undefined : "default",
										opacity: canJump ? undefined : 0.65,
									}}
									className="nf-search-result"
								>
									<Group gap="xs" mb={4} wrap="nowrap">
										<Badge size="xs" color={roleColor(result.role)} variant="light">
											{t(`search.role_${result.role}`, {
												defaultValue: result.role || t("search.role_system"),
											})}
										</Badge>
										<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
											{formatSmartTime(result.createdAt)}
										</Text>
									</Group>
									<Text size="sm" lineClamp={3} style={{ wordBreak: "break-word" }}>
										{highlightSearchText(result.snippet || result.preview, debouncedQuery)}
									</Text>
								</UnstyledButton>
							))}
						</Stack>
					</ScrollArea>
				)}
			</Box>
		</Box>
	);
}
