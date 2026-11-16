import {
	Alert,
	Button,
	Checkbox,
	Group,
	Modal,
	SegmentedControl,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useImportGlobalSkill,
	useImportProjectSkill,
	useUpdateGlobalSkillFromUrl,
	useUpdateProjectSkillFromUrl,
} from "../../hooks/useSkills";

interface SkillLinkModalProps {
	opened: boolean;
	onClose: () => void;
	projectId?: string;
	enabled?: boolean;
	skill?: { name: string; canUpdateFromUrl?: boolean };
	manualForm?: ReactNode;
	manualPending?: boolean;
}

export function SkillLinkModal({
	opened,
	enabled = true,
	projectId,
	skill,
	onClose,
	manualForm,
	manualPending = false,
}: SkillLinkModalProps) {
	// Closing, changing scope/skill or losing capability cancels the old form.
	if (!opened || !enabled || projectId === "" || (skill && !skill.canUpdateFromUrl)) return null;
	return (
		<SkillLinkForm
			key={JSON.stringify([projectId ?? null, skill?.name ?? null])}
			projectId={projectId}
			skill={skill}
			onClose={onClose}
			manualForm={manualForm}
			manualPending={manualPending}
		/>
	);
}

function SkillLinkForm({
	projectId,
	skill,
	onClose,
	manualForm,
	manualPending = false,
}: Pick<SkillLinkModalProps, "projectId" | "skill" | "onClose" | "manualForm" | "manualPending">) {
	const { t } = useTranslation("routines");
	const projectImport = useImportProjectSkill(projectId ?? "");
	const globalImport = useImportGlobalSkill();
	const projectUpdate = useUpdateProjectSkillFromUrl(projectId ?? "");
	const globalUpdate = useUpdateGlobalSkillFromUrl();
	const canChooseMethod = !skill && manualForm !== undefined;
	const [method, setMethod] = useState<"manual" | "link">(canChooseMethod ? "manual" : "link");
	const [url, setUrl] = useState("");
	const [confirmed, setConfirmed] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const requestRef = useRef<AbortController | null>(null);

	useEffect(
		() => () => {
			// An abort stops waiting; the server may already have committed.
			requestRef.current?.abort();
			requestRef.current = null;
		},
		[],
	);

	const busy = pending || manualPending;
	const handleClose = () => {
		if (!requestRef.current && !manualPending) onClose();
	};

	const handleSubmit = async () => {
		const trimmedUrl = url.trim();
		// The ref blocks repeated submissions before pending is rendered.
		if (
			method !== "link" ||
			manualPending ||
			!trimmedUrl ||
			(skill && !confirmed) ||
			requestRef.current
		)
			return;
		const controller = new AbortController();
		requestRef.current = controller;
		setPending(true);
		setError(null);
		try {
			const input = { url: trimmedUrl, signal: controller.signal };
			if (skill) {
				const mutation = projectId === undefined ? globalUpdate : projectUpdate;
				await mutation.mutateAsync({ name: skill.name, ...input });
			} else {
				const mutation = projectId === undefined ? globalImport : projectImport;
				await mutation.mutateAsync(input);
			}
			if (requestRef.current !== controller || controller.signal.aborted) return;
			setUrl("");
			setConfirmed(false);
			onClose();
		} catch (cause) {
			if (requestRef.current !== controller || controller.signal.aborted) return;
			setError(cause instanceof Error && cause.message ? cause.message : t("skillLinkError"));
		} finally {
			if (requestRef.current === controller) {
				requestRef.current = null;
				setPending(false);
			}
		}
	};

	return (
		<Modal
			opened
			onClose={handleClose}
			title={t(
				skill ? "updateSkillFromLink" : canChooseMethod ? "addSkill" : "createSkillFromLink",
			)}
			size="lg"
			closeOnClickOutside={!busy}
			closeOnEscape={!busy}
			withCloseButton={!busy}
		>
			{canChooseMethod && (
				<SegmentedControl
					value={method}
					onChange={(value) => {
						if (requestRef.current || manualPending) return;
						setMethod(value === "manual" ? "manual" : "link");
					}}
					data={[
						{ value: "manual", label: t("skillAddManual") },
						{ value: "link", label: t("skillAddLink") },
					]}
					disabled={busy}
					fullWidth
					mb="md"
				/>
			)}
			{canChooseMethod && method === "manual" ? (
				manualForm
			) : (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void handleSubmit();
					}}
				>
					<Stack>
						{skill && (
							<Text size="sm" style={{ overflowWrap: "anywhere" }}>
								{t("skillName")}: {skill.name}
							</Text>
						)}
						<Text size="sm" c="dimmed" style={{ overflowWrap: "anywhere" }}>
							{t("skillLinkFormat")}
						</Text>
						<TextInput
							label={t("skillLinkUrl")}
							placeholder={t("skillLinkUrlPlaceholder")}
							value={url}
							onChange={(event) => {
								if (requestRef.current) return;
								setUrl(event.currentTarget.value);
								setError(null);
							}}
							disabled={pending}
							maxLength={2048}
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							required
							data-autofocus
						/>
						<Text size="sm" c="dimmed" style={{ overflowWrap: "anywhere" }}>
							{t(skill ? "skillLinkUpdateContents" : "skillLinkCreateContents")}
						</Text>
						{skill ? (
							<>
								<Alert color="yellow">{t("skillLinkOverwriteWarning")}</Alert>
								<Checkbox
									label={t("skillLinkConfirmOverwrite")}
									checked={confirmed}
									onChange={(event) => {
										if (!requestRef.current) setConfirmed(event.currentTarget.checked);
									}}
									disabled={pending}
								/>
							</>
						) : (
							<Alert color="yellow">{t("skillLinkTrust")}</Alert>
						)}
						{error && (
							<Alert color="red" role="alert" style={{ overflowWrap: "anywhere" }}>
								{error}
							</Alert>
						)}
						{pending && (
							<Text size="xs" c="dimmed" role="status">
								{t("skillLinkInterruptedHint")}
							</Text>
						)}
						<Group justify="flex-end" gap="xs">
							<Button variant="subtle" onClick={handleClose} disabled={pending}>
								{t("cancel")}
							</Button>
							<Button
								type="submit"
								loading={pending}
								disabled={pending || !url.trim() || (!!skill && !confirmed)}
							>
								{t(
									pending
										? "skillLinkPending"
										: skill
											? "updateSkillFromLink"
											: "createSkillFromLink",
								)}
							</Button>
						</Group>
					</Stack>
				</form>
			)}
		</Modal>
	);
}
