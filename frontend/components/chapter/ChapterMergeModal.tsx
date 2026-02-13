import { Alert, Button, Loader, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";

interface ChapterMergeModalProps {
	chapterId: string;
	projectId: string;
	opened: boolean;
	onClose: () => void;
}

export function ChapterMergeModal({ chapterId, projectId, opened, onClose }: ChapterMergeModalProps) {
	const [targetId, setTargetId] = useState<string | null>(null);
	const [strategy, setStrategy] = useState<string>("merge");
	const [message, setMessage] = useState("");
	const [conflicts, setConflicts] = useState<any>(null);
	const qc = useQueryClient();

	const resetState = () => {
		setTargetId(null);
		setStrategy("merge");
		setMessage("");
		setConflicts(null);
	};

	const handleClose = () => {
		resetState();
		onClose();
	};

	// Get available target chapters (active chapters in the same project, excluding self)
	const { data: chapters } = useQuery({
		queryKey: ["chapters", { projectId }],
		queryFn: () => api.listChapters(projectId),
		enabled: opened,
	});

	const targetOptions = (chapters ?? [])
		.filter((ch: any) => ch.id !== chapterId && ch.status === "active")
		.map((ch: any) => ({ value: ch.id, label: ch.title }));

	const checkConflicts = useMutation({
		mutationFn: () => api.checkMergeConflicts(chapterId, targetId!),
		onSuccess: (data) => setConflicts(data),
	});

	const merge = useMutation({
		mutationFn: () =>
			api.mergeChapter(chapterId, {
				targetChapterId: targetId!,
				strategy,
				message: message.trim() || undefined,
			}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["graph"] });
			handleClose();
		},
	});

	const handleCheck = () => {
		if (targetId) checkConflicts.mutate();
	};

	return (
		<Modal opened={opened} onClose={handleClose} title="Merge Chapter">
			<Stack>
				<Select
					label="Merge into"
					placeholder="Select target chapter"
					data={targetOptions}
					value={targetId}
					onChange={setTargetId}
					searchable
				/>
				<Select
					label="Strategy"
					data={[
						{ value: "merge", label: "Merge (preserve history)" },
						{ value: "squash", label: "Squash (single commit)" },
						{ value: "cherry-pick", label: "Cherry-pick (individual commits)" },
					]}
					value={strategy}
					onChange={(v) => setStrategy(v ?? "merge")}
				/>
				<TextInput
					label="Merge message (optional)"
					placeholder="Describe the merge..."
					value={message}
					onChange={(e) => setMessage(e.currentTarget.value)}
				/>

				{conflicts && conflicts.hasConflicts && (
					<Alert color="yellow" title="Conflicts detected">
						<Text size="sm">
							{conflicts.conflictFiles?.length ?? 0} file(s) have conflicts.
							You may proceed, and the AI narrator can help resolve them.
						</Text>
					</Alert>
				)}

				{conflicts && !conflicts.hasConflicts && (
					<Alert color="green" title="No conflicts">
						<Text size="sm">Merge can proceed cleanly.</Text>
					</Alert>
				)}

				{checkConflicts.isError && (
					<Alert color="red" title="Conflict check failed">
						<Text size="sm">{checkConflicts.error instanceof Error ? checkConflicts.error.message : "Unknown error"}</Text>
					</Alert>
				)}

				{merge.isError && (
					<Alert color="red" title="Merge failed">
						<Text size="sm">{merge.error instanceof Error ? merge.error.message : "Unknown error"}</Text>
					</Alert>
				)}

				<Button variant="light" onClick={handleCheck} loading={checkConflicts.isPending} disabled={!targetId}>
					Check Conflicts
				</Button>
				<Button onClick={() => merge.mutate()} loading={merge.isPending} disabled={!targetId}>
					Merge
				</Button>
			</Stack>
		</Modal>
	);
}
