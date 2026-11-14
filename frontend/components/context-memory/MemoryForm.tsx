import { Alert, Button, Group, Stack, Textarea, TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MemoryDraft } from "../../lib/api/context-memory";

export function MemoryForm({
	initial,
	pending,
	disabled,
	onSave,
	onCancel,
}: {
	initial?: MemoryDraft;
	pending: boolean;
	disabled?: boolean;
	onSave: (draft: MemoryDraft & { key: string }) => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation("settings");
	const [key, setKey] = useState("");
	const [content, setContent] = useState(initial?.content ?? "");
	// An ISO field avoids silently changing an existing expiry's timezone or precision.
	const [expiresAt, setExpiresAt] = useState(initial?.expiresAt ?? "");
	const [invalid, setInvalid] = useState(false);
	const submit = () => {
		const expiry = expiresAt.trim();
		if (
			(!initial && !key.trim()) ||
			!content.trim() ||
			(expiry && (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now()))
		) {
			setInvalid(true);
			return;
		}
		setInvalid(false);
		onSave({
			key: key.trim(),
			content: content.trim(),
			expiresAt: expiry ? new Date(expiry).toISOString() : null,
		});
	};
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				if (!pending && !disabled) submit();
			}}
		>
			<Stack gap="sm">
				{!initial && (
					<TextInput
						name="memoryKey"
						label={t("memory.key")}
						required
						maxLength={128}
						value={key}
						onChange={(event) => setKey(event.currentTarget.value)}
						disabled={pending || disabled}
					/>
				)}
				<Textarea
					name="memoryContent"
					label={t("memory.content")}
					required
					maxLength={4096}
					minRows={4}
					autosize
					value={content}
					onChange={(event) => setContent(event.currentTarget.value)}
					disabled={pending || disabled}
				/>
				<TextInput
					name="memoryExpiry"
					label={t("memory.expiry")}
					description={t("memory.expiryHint")}
					value={expiresAt}
					onChange={(event) => setExpiresAt(event.currentTarget.value)}
					disabled={pending || disabled}
				/>
				{invalid && (
					<Alert color="red" role="alert">
						{t("memory.invalidDraft")}
					</Alert>
				)}
				<Group>
					<Button type="submit" loading={pending} disabled={disabled}>
						{t("memory.saveCandidate")}
					</Button>
					<Button variant="subtle" onClick={onCancel} disabled={pending}>
						{t("memory.cancel")}
					</Button>
				</Group>
			</Stack>
		</form>
	);
}
