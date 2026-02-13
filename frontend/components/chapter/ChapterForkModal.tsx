import { Alert, Button, Modal, Select, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";

interface ChapterForkModalProps {
	chapterId: string;
	opened: boolean;
	onClose: () => void;
}

export function ChapterForkModal({ chapterId, opened, onClose }: ChapterForkModalProps) {
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [type, setType] = useState<string>("meanwhile");
	const [inheritMode, setInheritMode] = useState<string>("fresh");
	const qc = useQueryClient();

	const resetState = () => {
		setTitle("");
		setDescription("");
		setType("meanwhile");
		setInheritMode("fresh");
	};

	const handleClose = () => {
		resetState();
		onClose();
	};

	const fork = useMutation({
		mutationFn: () => api.forkChapter(chapterId, {
			title: title.trim(),
			description: description.trim() || undefined,
			type,
			inheritMode,
		}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["graph"] });
			handleClose();
		},
	});

	return (
		<Modal opened={opened} onClose={handleClose} title="Fork Chapter">
			<Stack>
				<TextInput
					label="Title"
					placeholder="New branch title"
					value={title}
					onChange={(e) => setTitle(e.currentTarget.value)}
					required
				/>
				<Textarea
					label="Description"
					placeholder="What this fork is about..."
					value={description}
					onChange={(e) => setDescription(e.currentTarget.value)}
				/>
				<Select
					label="Type"
					data={[
						{ value: "meanwhile", label: "Meanwhile (parallel work)" },
						{ value: "whatif", label: "WhatIf (exploration)" },
					]}
					value={type}
					onChange={(v) => setType(v ?? "meanwhile")}
				/>
				<Select
					label="Context Inheritance"
					data={[
						{ value: "fresh", label: "Fresh (no context)" },
						{ value: "compressed", label: "Compressed (summary)" },
						{ value: "full", label: "Full (complete history)" },
					]}
					value={inheritMode}
					onChange={(v) => setInheritMode(v ?? "fresh")}
				/>
				{fork.isError && (
					<Alert color="red" title="Fork failed">
						<Text size="sm">{fork.error instanceof Error ? fork.error.message : "Unknown error"}</Text>
					</Alert>
				)}
				<Button onClick={() => fork.mutate()} loading={fork.isPending} disabled={!title.trim()}>
					Fork
				</Button>
			</Stack>
		</Modal>
	);
}
