import { Alert, Button, Checkbox, Modal, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";

interface ChapterCleanupModalProps {
	chapters: Array<{ id: string; title: string; status: string }>;
	opened: boolean;
	onClose: () => void;
}

export function ChapterCleanupModal({ chapters, opened, onClose }: ChapterCleanupModalProps) {
	const [selected, setSelected] = useState<string[]>([]);
	const [force, setForce] = useState(false);
	const [deleteBranch, setDeleteBranch] = useState(false);
	const qc = useQueryClient();

	const resetState = () => {
		setSelected([]);
		setForce(false);
		setDeleteBranch(false);
	};

	const handleClose = () => {
		resetState();
		onClose();
	};

	const cleanup = useMutation({
		mutationFn: () =>
			api.cleanupChapters({
				chapterIds: selected,
				force,
				deleteBranch,
			}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["graph"] });
			handleClose();
		},
	});

	const toggleChapter = (id: string) => {
		setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
	};

	// Only show chapters that can be cleaned up
	const cleanable = chapters.filter(
		(ch) => ch.status === "active" || ch.status === "dormant",
	);

	return (
		<Modal opened={opened} onClose={handleClose} title="Batch Cleanup">
			<Stack>
				<Text size="sm" c="dimmed">
					Select chapters to abandon and clean up. This will remove worktrees and optionally delete branches.
				</Text>
				{cleanable.map((ch) => (
					<Checkbox
						key={ch.id}
						label={ch.title}
						checked={selected.includes(ch.id)}
						onChange={() => toggleChapter(ch.id)}
					/>
				))}
				{cleanable.length === 0 && (
					<Text c="dimmed" size="sm">
						No chapters available for cleanup.
					</Text>
				)}
				<Checkbox
					label="Force (ignore uncommitted changes)"
					checked={force}
					onChange={(e) => setForce(e.currentTarget.checked)}
				/>
				<Checkbox
					label="Delete git branches"
					checked={deleteBranch}
					onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
				/>
				{cleanup.isError && (
					<Alert color="red" title="Cleanup failed">
						<Text size="sm">{cleanup.error instanceof Error ? cleanup.error.message : "Unknown error"}</Text>
					</Alert>
				)}
				<Button
					color="red"
					onClick={() => cleanup.mutate()}
					loading={cleanup.isPending}
					disabled={selected.length === 0}
				>
					Cleanup {selected.length} chapter{selected.length !== 1 ? "s" : ""}
				</Button>
			</Stack>
		</Modal>
	);
}
