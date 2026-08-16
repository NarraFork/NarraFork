/**
 * NewDmModal.tsx — Pick someone to start a direct message with.
 *
 * Backed by `/api/chat/directory`, which is the one place a non-admin account can
 * see other usernames. The list is server-capped and returns id + username +
 * avatar only, so this modal cannot surface account attributes (role, MFA state,
 * creation time) even by accident.
 */

import { Box, Group, Loader, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatDirectory } from "../../hooks/useChat";
import type { ChatUserSnapshot } from "../../lib/api/chat";
import { UserAvatar } from "../UserAvatar";

export interface NewDmModalProps {
	opened: boolean;
	onClose: () => void;
	onPick: (user: ChatUserSnapshot) => void;
	isPending?: boolean;
}

export function NewDmModal({ opened, onClose, onPick, isPending }: NewDmModalProps) {
	const { t } = useTranslation("chat");
	const [query, setQuery] = useState("");
	// Debounced so typing does not fire one request per keystroke against a
	// directory query that scans usernames.
	const [debouncedQuery] = useDebouncedValue(query, 250);
	const { data: users, isLoading } = useChatDirectory(debouncedQuery, opened);

	return (
		<Modal opened={opened} onClose={onClose} title={t("newConversation")} size="md">
			<Stack gap="sm">
				<TextInput
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
					placeholder={t("searchUsers")}
					leftSection={<IconSearch size={14} />}
					data-autofocus
				/>
				{isLoading || isPending ? (
					<Group justify="center" py="md">
						<Loader size="sm" />
					</Group>
				) : null}
				{!isLoading && (users?.length ?? 0) === 0 ? (
					<Text size="xs" c="dimmed">
						{t("noUsersFound")}
					</Text>
				) : null}
				<Stack gap={2}>
					{users?.map((user) => (
						<Box
							key={user.id}
							// Styled avatar row; role + key handler keep it keyboard reachable.
							role="button"
							tabIndex={0}
							onClick={() => onPick(user)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onPick(user);
								}
							}}
							style={{ cursor: "pointer", borderRadius: 6, padding: "8px 10px" }}
						>
							<Group gap="sm" wrap="nowrap">
								<UserAvatar
									userId={user.id}
									username={user.username}
									avatarColor={user.avatarColor}
									avatarImageId={user.avatarImageId}
									size={28}
									showTooltip={false}
								/>
								<Text size="sm" truncate>
									{user.username}
								</Text>
							</Group>
						</Box>
					))}
				</Stack>
			</Stack>
		</Modal>
	);
}
