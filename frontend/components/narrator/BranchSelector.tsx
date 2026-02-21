import { ActionIcon, Badge, Group, Menu, Text, TextInput, Tooltip } from "@mantine/core";
import { IconGitBranch, IconGitFork, IconPencil, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useBranches,
	useDeleteBranch,
	useSwitchBranch,
	useUpdateBranch,
} from "../../hooks/useNarrator";

interface BranchSelectorProps {
	narratorId: string;
	activeBranchId: string | null;
}

export function BranchSelector({ narratorId, activeBranchId }: BranchSelectorProps) {
	const { t } = useTranslation("narrator");
	const { data: branches } = useBranches(narratorId);
	const switchMutation = useSwitchBranch();
	const deleteMutation = useDeleteBranch();
	const updateMutation = useUpdateBranch();
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");

	// Don't render if no branches exist
	if (!branches?.length) return null;

	const rootBranch = branches.find((b: any) => b.isRoot);
	const nonRootBranches = branches.filter((b: any) => !b.isRoot);

	const handleSwitch = (branchId: string) => {
		if (branchId === activeBranchId) return;
		switchMutation.mutate({ narratorId, branchId });
	};

	const handleRename = (branchId: string) => {
		if (!renameValue.trim()) return;
		updateMutation.mutate(
			{ narratorId, branchId, data: { name: renameValue.trim() } },
			{ onSuccess: () => setRenamingId(null) },
		);
	};

	const handleDelete = (branchId: string) => {
		deleteMutation.mutate({ narratorId, branchId });
	};

	return (
		<Menu shadow="md" width={240} position="bottom-start">
			<Menu.Target>
				<Tooltip label={t("branchSwitch", "Switch branch")}>
					<ActionIcon size="sm" variant="subtle" color="gray">
						<IconGitBranch size={16} />
					</ActionIcon>
				</Tooltip>
			</Menu.Target>
			<Menu.Dropdown>
				<Menu.Label>{t("branches", "Branches")}</Menu.Label>
				{/* Root branch */}
				{rootBranch && (
					<Menu.Item
						leftSection={<IconGitBranch size={14} />}
						rightSection={
							rootBranch.id === activeBranchId ? (
								<Badge size="xs" variant="dot" color="green">
									{t("branchActive", "active")}
								</Badge>
							) : null
						}
						onClick={() => handleSwitch(rootBranch.id)}
					>
						<Text size="sm">{t("branchRoot", "Main")}</Text>
					</Menu.Item>
				)}
				{nonRootBranches.length > 0 && <Menu.Divider />}
				{nonRootBranches.map((branch: { id: string; name: string; status: string }) => (
					<Menu.Item
						key={branch.id}
						leftSection={<IconGitFork size={14} />}
						rightSection={
							<Group gap={4} wrap="nowrap">
								{branch.id === activeBranchId && (
									<Badge size="xs" variant="dot" color="green">
										{t("branchActive", "active")}
									</Badge>
								)}
								<ActionIcon
									size="xs"
									variant="subtle"
									color="gray"
									onClick={(e: React.MouseEvent) => {
										e.stopPropagation();
										setRenamingId(branch.id);
										setRenameValue(branch.name);
									}}
								>
									<IconPencil size={12} />
								</ActionIcon>
								<ActionIcon
									size="xs"
									variant="subtle"
									color="red"
									onClick={(e: React.MouseEvent) => {
										e.stopPropagation();
										handleDelete(branch.id);
									}}
								>
									<IconTrash size={12} />
								</ActionIcon>
							</Group>
						}
						onClick={() => handleSwitch(branch.id)}
					>
						{renamingId === branch.id ? (
							<TextInput
								size="xs"
								value={renameValue}
								onChange={(e) => setRenameValue(e.currentTarget.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleRename(branch.id);
									if (e.key === "Escape") setRenamingId(null);
								}}
								onBlur={() => handleRename(branch.id)}
								onClick={(e: React.MouseEvent) => e.stopPropagation()}
								autoFocus
								style={{ maxWidth: 140 }}
							/>
						) : (
							<Text size="sm" truncate>
								{branch.name}
							</Text>
						)}
					</Menu.Item>
				))}
			</Menu.Dropdown>
		</Menu>
	);
}
