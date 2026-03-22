import { Button, Group, Modal, Table, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

interface RebaseConflictDialogProps {
	opened: boolean;
	onClose: () => void;
	projectId: string;
	chapterId: string;
	chapterTitle: string;
	conflictFiles: Array<{ file: string; conflictLines: number }>;
	onResolved: () => void;
	onNarratorOpened?: (chapterId: string) => void;
}

export function RebaseConflictDialog({
	opened,
	onClose,
	projectId,
	chapterId,
	chapterTitle,
	conflictFiles,
	onResolved,
	onNarratorOpened,
}: RebaseConflictDialogProps) {
	const { t } = useTranslation("graph");
	const [loading, setLoading] = useState<"abort" | "continue" | null>(null);

	const handleAbort = async () => {
		setLoading("abort");
		try {
			await api.rulerRebaseResolve(projectId, { chapterId, action: "abort" });
			onResolved();
			onClose();
		} catch {
			/* global handler */
		} finally {
			setLoading(null);
		}
	};

	const handleContinue = async () => {
		setLoading("continue");
		try {
			await api.rulerRebaseResolve(projectId, { chapterId, action: "continue" });
			notifications.show({
				title: t("ruler.rebaseNarratorSent"),
				message: t("ruler.rebaseNarratorSentDesc"),
				color: "indigo",
			});
			onResolved();
			onClose();
			onNarratorOpened?.(chapterId);
		} catch {
			/* global handler */
		} finally {
			setLoading(null);
		}
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={
				<Text fw={600}>
					{t("ruler.rebaseConflict")} — {chapterTitle}
				</Text>
			}
			size="lg"
			centered
		>
			<Text size="sm" mb="md">
				{t("ruler.rebaseConflictDesc")}
			</Text>

			<Table striped highlightOnHover withTableBorder mb="lg">
				<Table.Thead>
					<Table.Tr>
						<Table.Th>{t("ruler.rebaseConflictFile")}</Table.Th>
						<Table.Th style={{ width: 100, textAlign: "right" }}>
							{t("ruler.rebaseConflictCount")}
						</Table.Th>
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{conflictFiles.map((f) => (
						<Table.Tr key={f.file}>
							<Table.Td>
								<Text size="sm" ff="monospace">
									{f.file}
								</Text>
							</Table.Td>
							<Table.Td style={{ textAlign: "right" }}>
								<Text size="sm">{f.conflictLines}</Text>
							</Table.Td>
						</Table.Tr>
					))}
				</Table.Tbody>
			</Table>

			<Group justify="flex-end">
				<Button
					variant="default"
					onClick={handleAbort}
					loading={loading === "abort"}
					disabled={loading === "continue"}
				>
					{t("ruler.rebaseAbort")}
				</Button>
				<Button
					color="indigo"
					onClick={handleContinue}
					loading={loading === "continue"}
					disabled={loading === "abort"}
				>
					{t("ruler.rebaseLetNarratorResolve")}
				</Button>
			</Group>
		</Modal>
	);
}
