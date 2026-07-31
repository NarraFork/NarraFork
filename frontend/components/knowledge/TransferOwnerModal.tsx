import { Alert, Badge, Button, Checkbox, Group, Modal, Select, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import {
	useTransferKnowledgeCollectionOwner,
	useTransferKnowledgeEntryOwner,
} from "../../hooks/useKnowledge";

export interface TransferOwnerUser {
	id: string;
	username: string;
	role?: string;
}

/**
 * Ownership transfer for an entry or a collection.
 *
 * Authorization is enforced server-side and is deliberately NOT admin-only: the routes accept
 * "admin OR current owner" (see server/routes/knowledge.ts transfer-owner handlers, whose
 * permission check lives in the service). This component mirrors that rule for visibility —
 * callers gate rendering on `isAdmin || isCurrentOwner`.
 *
 * Only an admin may leave the target unowned (ownerUserId=null); a non-admin owner must hand
 * off to a specific user, which the checkbox reflects.
 */
export function TransferOwnerModal({
	kind,
	targetId,
	targetName,
	currentOwnerUserId,
	currentOwnerName,
	users,
	opened,
	onClose,
}: {
	kind: "entry" | "collection";
	targetId: string;
	targetName: string;
	currentOwnerUserId: string | null;
	/** Optional resolved display name for the current owner. */
	currentOwnerName?: string | null;
	users: TransferOwnerUser[];
	opened: boolean;
	onClose: () => void;
}) {
	const { t } = useTranslation("knowledge");
	const { data: me } = useCurrentUser();
	const isAdmin = me?.role === "admin";
	const transferEntry = useTransferKnowledgeEntryOwner();
	const transferCollection = useTransferKnowledgeCollectionOwner();

	const [newOwner, setNewOwner] = useState<string | null>(null);
	const [unowned, setUnowned] = useState(false);

	// Reset on each open so a previous attempt's selection can't be submitted by accident.
	useEffect(() => {
		if (opened) {
			setNewOwner(null);
			setUnowned(false);
		}
	}, [opened]);

	const options = useMemo(
		() =>
			users
				.filter((u) => u.id !== currentOwnerUserId)
				.map((u) => ({ value: u.id, label: u.role ? `${u.username} (${u.role})` : u.username })),
		[users, currentOwnerUserId],
	);

	const pending = transferEntry.isPending || transferCollection.isPending;
	const error = (transferEntry.error ?? transferCollection.error) as Error | null;
	const ownerUserId = unowned ? null : newOwner;
	const canSubmit = unowned || !!newOwner;

	const submit = () => {
		if (!canSubmit) return;
		const opts = { onSuccess: () => onClose() };
		if (kind === "entry") {
			transferEntry.mutate({ entryId: targetId, ownerUserId }, opts);
		} else {
			transferCollection.mutate({ collectionId: targetId, ownerUserId }, opts);
		}
	};

	return (
		<Modal opened={opened} onClose={onClose} title={t("transferOwnerTitle")} size="md">
			<Stack gap="md">
				<Text size="sm" fw={600}>
					{targetName}
				</Text>
				<Text size="xs" c="dimmed">
					{kind === "entry" ? t("transferOwnerEntryDesc") : t("transferOwnerCollectionDesc")}
				</Text>

				<Group gap="xs" align="center">
					<Text size="xs" c="dimmed">
						{t("transferOwnerCurrent")}:
					</Text>
					<Badge size="sm" variant="light" color={currentOwnerUserId ? "grape" : "gray"}>
						{currentOwnerName ?? currentOwnerUserId ?? t("collectionAclNoOwner")}
					</Badge>
				</Group>

				<Select
					label={t("transferOwnerNew")}
					placeholder={t("transferOwnerPlaceholder")}
					data={options}
					value={newOwner}
					onChange={setNewOwner}
					disabled={unowned}
					searchable
					size="sm"
				/>

				{isAdmin ? (
					<Checkbox
						size="sm"
						label={t("transferOwnerClear")}
						checked={unowned}
						onChange={(e) => setUnowned(e.currentTarget.checked)}
					/>
				) : null}

				{error ? (
					<Alert color="red" icon={<IconAlertTriangle size={16} />} p="xs">
						<Text size="xs">{error.message}</Text>
					</Alert>
				) : null}

				<Group justify="flex-end">
					<Button variant="subtle" size="xs" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button size="xs" loading={pending} disabled={!canSubmit} onClick={submit}>
						{t("transferOwnerSubmit")}
					</Button>
				</Group>

				{!canSubmit ? (
					<Text size="xs" c="dimmed">
						{t("transferOwnerNoneSelected")}
					</Text>
				) : null}
			</Stack>
		</Modal>
	);
}
