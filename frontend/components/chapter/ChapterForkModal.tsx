import { Alert, Button, Modal, Select, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";

interface ChapterForkModalProps {
	chapterId: string;
	opened: boolean;
	onClose: () => void;
	forkAtMessageUuid?: string;
}

export function ChapterForkModal({ chapterId, opened, onClose, forkAtMessageUuid }: ChapterForkModalProps) {
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [type, setType] = useState<string>("meanwhile");
	const [inheritMode, setInheritMode] = useState<string>("fresh");
	const qc = useQueryClient();

	// When forking from a specific message, default to full inheritance
	useEffect(() => {
		if (forkAtMessageUuid) {
			setInheritMode("full");
		}
	}, [forkAtMessageUuid]);

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
			forkAtMessageUuid,
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
				{forkAtMessageUuid && (
					<Alert color="blue" variant="light">
						Forking from a specific message point. The new narrator will inherit conversation history up to this message.
					</Alert>
				)}
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
