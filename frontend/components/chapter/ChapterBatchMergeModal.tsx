import { Alert, Button, Checkbox, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";

interface ChapterBatchMergeModalProps {
	chapters: Array<{ id: string; title: string; status: string }>;
	opened: boolean;
	onClose: () => void;
}

export function ChapterBatchMergeModal({ chapters, opened, onClose }: ChapterBatchMergeModalProps) {
	const [selected, setSelected] = useState<string[]>([]);
	const [baseChapterId, setBaseChapterId] = useState<string | null>(null);
	const [title, setTitle] = useState("");
	const [strategy, setStrategy] = useState<string>("merge");
	const qc = useQueryClient();

	const resetState = () => {
		setSelected([]);
		setBaseChapterId(null);
		setTitle("");
		setStrategy("merge");
	};

	const handleClose = () => {
		resetState();
		onClose();
	};

	const batchMerge = useMutation({
		mutationFn: () =>
			api.batchMerge({
				baseChapterId: baseChapterId!,
				sourceChapterIds: selected,
				title: title.trim(),
				strategy,
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

	const activeChapters = chapters.filter((ch) => ch.status === "active");

	// Target chapter options: active chapters that are not selected as source
	const targetOptions = activeChapters
		.filter((ch) => !selected.includes(ch.id))
		.map((ch) => ({ value: ch.id, label: ch.title }));

	// Source chapter options: active chapters that are not the selected target
	const sourceChapters = activeChapters.filter((ch) => ch.id !== baseChapterId);

	return (
		<Modal opened={opened} onClose={handleClose} title="Batch Merge">
			<Stack>
				<Text size="sm" c="dimmed">
					Merge multiple source chapters into a target chapter. A temporary fork is created for the merge; all sources are merged sequentially.
				</Text>

				<Select
					label="Target Chapter"
					placeholder="Select target chapter"
					data={targetOptions}
					value={baseChapterId}
					onChange={setBaseChapterId}
				/>

				<Text size="sm" fw={500}>Source Chapters</Text>
				{sourceChapters.map((ch) => (
					<Checkbox
						key={ch.id}
						label={ch.title}
						checked={selected.includes(ch.id)}
						onChange={() => toggleChapter(ch.id)}
					/>
				))}
				{sourceChapters.length === 0 && (
					<Text c="dimmed" size="sm">
						No chapters available as source.
					</Text>
				)}

				<TextInput
					label="Merge Session Title"
					placeholder="Merge sprint-3 branches"
					value={title}
					onChange={(e) => setTitle(e.currentTarget.value)}
					required
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

				{batchMerge.isError && (
					<Alert color="red" title="Batch merge failed">
						<Text size="sm">{batchMerge.error instanceof Error ? batchMerge.error.message : "Unknown error"}</Text>
					</Alert>
				)}
				<Button
					color="green"
					onClick={() => batchMerge.mutate()}
					loading={batchMerge.isPending}
					disabled={!baseChapterId || selected.length === 0 || !title.trim()}
				>
					Merge {selected.length} chapter{selected.length !== 1 ? "s" : ""}
				</Button>
			</Stack>
		</Modal>
	);
}
