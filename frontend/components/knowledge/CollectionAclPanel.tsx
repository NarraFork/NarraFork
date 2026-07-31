import { Alert, Badge, Button, Group, Loader, Modal, Select, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconUserShare } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useKnowledgeCollectionAcl,
	useKnowledgeLevels,
	useKnowledgeTags,
	useUpdateKnowledgeCollectionAcl,
} from "../../hooks/useKnowledge";
import { api } from "../../lib/api";
import { TransferOwnerModal } from "./TransferOwnerModal";

/**
 * Collection-level ACL editor (admin only).
 *
 * The collection is the FIRST read gate — `canRead` checks the collection before the entry —
 * so this panel is the strongest lever in the knowledge ACL and the one that explains
 * "why can nobody see this entry?". Mirrors EntryAclPanel's shape minus the review-tag axis
 * (collections have no review dimension) plus an ownership-transfer entry point.
 */
export function CollectionAclPanel({
	collectionId,
	opened,
	onClose,
}: {
	collectionId: string | null;
	opened: boolean;
	onClose: () => void;
}) {
	const { t } = useTranslation("knowledge");

	return (
		<Modal opened={opened} onClose={onClose} title={t("collectionAclTitle")} size="lg">
			{collectionId ? <CollectionAclForm collectionId={collectionId} /> : null}
		</Modal>
	);
}

function CollectionAclForm({ collectionId }: { collectionId: string }) {
	const { t } = useTranslation("knowledge");
	const acl = useKnowledgeCollectionAcl(collectionId);
	const levels = useKnowledgeLevels();
	const tags = useKnowledgeTags();
	const update = useUpdateKnowledgeCollectionAcl();
	const [transferOpen, setTransferOpen] = useState(false);

	// The owner Select needs usernames; the endpoint is admin-only, matching this panel.
	const users = useQuery({
		queryKey: ["admin", "users"],
		queryFn: api.listUsers,
	});

	const [level, setLevel] = useState<string | null>(null);
	const [controlled, setControlled] = useState<string[]>([]);

	// Re-sync whenever the server copy changes (initial load, transfer, other admin's edit).
	useEffect(() => {
		if (acl.data) {
			setLevel(acl.data.classificationLevel);
			setControlled(acl.data.controlledTags);
		}
	}, [acl.data]);

	const levelOptions = useMemo(
		() => (levels.data ?? []).map((l) => ({ value: l.name, label: l.label || l.name })),
		[levels.data],
	);

	const controlledTagOptions = useMemo(
		() =>
			(tags.data ?? [])
				.filter((tag) => tag.controlled)
				.map((tag) => ({ value: tag.id, label: tag.name })),
		[tags.data],
	);

	if (acl.isLoading || levels.isLoading || tags.isLoading) {
		return (
			<Group justify="center" py="lg">
				<Loader size="sm" />
			</Group>
		);
	}

	if (acl.isError) {
		return (
			<Text size="sm" c="red">
				{(acl.error as Error).message}
			</Text>
		);
	}

	const data = acl.data;
	if (!data) return null;

	const dirty =
		(level ?? null) !== (data.classificationLevel ?? null) ||
		JSON.stringify([...controlled].sort()) !== JSON.stringify([...data.controlledTags].sort());

	// A restriction is anything stricter than the current server state — that's when the
	// "this hides content immediately" warning is actually actionable.
	const tightening =
		(!data.classificationLevel && !!level) ||
		controlled.some((id) => !data.controlledTags.includes(id));

	return (
		<Stack gap="md">
			<div>
				<Text size="sm" fw={600}>
					{data.name}
				</Text>
				<Text size="xs" c="dimmed">
					{t("collectionAclDesc")}
				</Text>
			</div>

			<Select
				label={t("classificationLevel")}
				description={t("collectionAclLevelHint")}
				placeholder={t("aclLevelPlaceholder")}
				data={levelOptions}
				value={levelOptions.some((o) => o.value === level) ? level : null}
				onChange={setLevel}
				clearable
				size="sm"
				w={300}
			/>

			<div>
				<Text size="sm" fw={500} mb={4}>
					{t("controlledTags")}
				</Text>
				<Text size="xs" c="dimmed" mb="xs">
					{t("collectionAclTagsHint")}
				</Text>
				{controlledTagOptions.length === 0 ? (
					<Text size="xs" c="dimmed">
						{t("noControlledTags")}
					</Text>
				) : (
					<Group gap={6}>
						{controlledTagOptions.map((opt) => (
							<Badge
								key={opt.value}
								size="md"
								variant={controlled.includes(opt.value) ? "filled" : "outline"}
								color={controlled.includes(opt.value) ? "orange" : "gray"}
								style={{ cursor: "pointer" }}
								onClick={() =>
									setControlled((prev) =>
										prev.includes(opt.value)
											? prev.filter((x) => x !== opt.value)
											: [...prev, opt.value],
									)
								}
							>
								{opt.label}
							</Badge>
						))}
					</Group>
				)}
			</div>

			<Group gap="xs" align="center">
				<Text size="sm" fw={500}>
					{t("owner")}
				</Text>
				<Badge size="sm" variant="light" color={data.ownerUserId ? "grape" : "gray"}>
					{data.ownerUsername ?? data.ownerUserId ?? t("collectionAclNoOwner")}
				</Badge>
				<Button
					size="compact-xs"
					variant="light"
					leftSection={<IconUserShare size={12} />}
					onClick={() => setTransferOpen(true)}
				>
					{t("transferOwnerOpen")}
				</Button>
			</Group>
			<Text size="xs" c="dimmed" mt={-8}>
				{t("collectionAclOwnerHint")}
			</Text>

			<Group gap="xs">
				<Text size="xs" c="dimmed">
					{t("collectionAclDefaultLevel")}:
				</Text>
				<Badge size="xs" variant="outline" color="gray">
					{data.defaultLevel}
				</Badge>
			</Group>

			{tightening ? (
				<Alert color="orange" icon={<IconAlertTriangle size={16} />} p="xs">
					<Text size="xs">{t("collectionAclWarning")}</Text>
				</Alert>
			) : null}

			{update.isError ? (
				<Text size="sm" c="red">
					{(update.error as Error).message}
				</Text>
			) : null}

			<Group justify="flex-end">
				<Button
					size="xs"
					loading={update.isPending}
					disabled={!dirty}
					onClick={() =>
						update.mutate({
							id: collectionId,
							classificationLevel: level,
							controlledTags: controlled,
						})
					}
				>
					{t("collectionAclSave")}
				</Button>
			</Group>

			<TransferOwnerModal
				kind="collection"
				targetId={collectionId}
				targetName={data.name}
				currentOwnerUserId={data.ownerUserId}
				currentOwnerName={data.ownerUsername}
				users={users.data ?? []}
				opened={transferOpen}
				onClose={() => setTransferOpen(false)}
			/>
		</Stack>
	);
}
