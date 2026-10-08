import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Loader,
	Modal,
	Paper,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { IconPencil, IconPlus, IconStar, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useCreateGitIdentity,
	useDeleteGitIdentity,
	useGitIdentities,
	useUpdateGitIdentity,
} from "../../hooks/useGitIdentities";
import { useConfirmDialog } from "../common/confirm-dialog-context";

/**
 * The git identities the user commits under, one of which is the default.
 *
 * The "default" flag is promote-only on the server (a user always has a default
 * while they have any identity), so the star is offered only when there is
 * another identity to switch to — with a single identity, that row IS the default
 * and the flag is not a choice.
 */
export function GitIdentitiesSection() {
	const { t } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const { data: identities, isLoading } = useGitIdentities();
	const createIdentity = useCreateGitIdentity();
	const updateIdentity = useUpdateGitIdentity();
	const deleteIdentity = useDeleteGitIdentity();
	// null = closed, "" = new identity, otherwise the id being edited.
	const [editingId, setEditingId] = useState<string | null | undefined>(undefined);
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");

	const rows = identities ?? [];
	const modalOpen = editingId !== undefined;
	const saving = createIdentity.isPending || updateIdentity.isPending;

	const openCreate = () => {
		setName("");
		setEmail("");
		setEditingId(null);
	};

	const openEdit = (id: string, currentName: string, currentEmail: string) => {
		setName(currentName);
		setEmail(currentEmail);
		setEditingId(id);
	};

	const closeModal = () => setEditingId(undefined);

	const save = () => {
		const payload = { name, email };
		if (editingId) {
			updateIdentity.mutate({ id: editingId, ...payload }, { onSuccess: closeModal });
			return;
		}
		createIdentity.mutate(payload, { onSuccess: closeModal });
	};

	const remove = async (id: string) => {
		if (await confirm({ message: t("gitIdentityDeleteConfirm") })) deleteIdentity.mutate(id);
	};

	return (
		<Stack gap="xs">
			<Group justify="space-between">
				<Text fw={500}>{t("gitIdentitiesTitle")}</Text>
				<Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={openCreate}>
					{t("gitIdentityAdd")}
				</Button>
			</Group>
			<Text size="xs" c="dimmed">
				{t("gitIdentitiesDescription")}
			</Text>
			{isLoading ? (
				<Loader size="sm" />
			) : rows.length === 0 ? (
				<Text size="sm" c="dimmed">
					{t("gitIdentitiesEmpty")}
				</Text>
			) : (
				rows.map((identity) => (
					<Paper key={identity.id} withBorder p="xs">
						<Group justify="space-between" wrap="nowrap">
							<Stack gap={2} style={{ minWidth: 0 }}>
								<Group gap="xs">
									<Text size="sm" fw={500} truncate>
										{identity.name}
									</Text>
									{identity.isDefault && (
										<Badge size="xs" variant="light">
											{t("gitIdentityDefaultBadge")}
										</Badge>
									)}
								</Group>
								<Text size="xs" c="dimmed" truncate>
									{identity.email}
								</Text>
							</Stack>
							<Group gap={4} wrap="nowrap">
								{!identity.isDefault && rows.length > 1 && (
									<Tooltip label={t("gitIdentitySetDefault")}>
										<ActionIcon
											variant="subtle"
											size="sm"
											aria-label={t("gitIdentitySetDefault")}
											onClick={() => updateIdentity.mutate({ id: identity.id, isDefault: true })}
										>
											<IconStar size={16} />
										</ActionIcon>
									</Tooltip>
								)}
								<Tooltip label={t("gitIdentityEdit")}>
									<ActionIcon
										variant="subtle"
										size="sm"
										aria-label={t("gitIdentityEdit")}
										onClick={() => openEdit(identity.id, identity.name, identity.email)}
									>
										<IconPencil size={16} />
									</ActionIcon>
								</Tooltip>
								<Tooltip label={t("gitIdentityDelete")}>
									<ActionIcon
										variant="subtle"
										color="red"
										size="sm"
										aria-label={t("gitIdentityDelete")}
										onClick={() => void remove(identity.id)}
									>
										<IconTrash size={16} />
									</ActionIcon>
								</Tooltip>
							</Group>
						</Group>
					</Paper>
				))
			)}
			<Modal
				opened={modalOpen}
				onClose={closeModal}
				title={editingId ? t("gitIdentityEditTitle") : t("gitIdentityCreateTitle")}
			>
				<Stack>
					<TextInput
						label={t("gitUsername")}
						placeholder={t("gitUsernamePlaceholder")}
						value={name}
						onChange={(event) => setName(event.currentTarget.value)}
					/>
					<TextInput
						label={t("gitEmail")}
						placeholder={t("gitEmailPlaceholder")}
						value={email}
						onChange={(event) => setEmail(event.currentTarget.value)}
					/>
					<Group justify="flex-end">
						<Button variant="default" onClick={closeModal}>
							{t("common:cancel")}
						</Button>
						<Button onClick={save} loading={saving} disabled={!name.trim() || !email.trim()}>
							{t("common:save")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	);
}
