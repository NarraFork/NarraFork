/**
 * Settings · Storage: move credentials to another NarraFork.
 *
 * Export: pick credentials, choose a passphrase, confirm password + second factor; the
 * server returns a passphrase-sealed file. Import: open the file with its passphrase,
 * see which accounts are new or already here, pick what to add or replace.
 */
import {
	Alert,
	Badge,
	Button,
	Card,
	Checkbox,
	FileButton,
	Group,
	Modal,
	PasswordInput,
	ScrollArea,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type CredentialImportPreviewItem,
	type CredentialImportResult,
	credentialTransferApi,
	type TransferableCredential,
} from "../../lib/api/credential-transfer";
import { describeApiError } from "../../lib/api-error";
import { saveBlobAsFile } from "../../lib/file-download";
import { StepUpFields, useStepUpFields } from "./StepUpFields";

const keyOf = (c: { kind: string; id: string }) => `${c.kind}:${c.id}`;

export function CredentialTransferCard() {
	const { t } = useTranslation("settings");
	const [exportOpen, setExportOpen] = useState(false);
	const [importFile, setImportFile] = useState<File | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	return (
		<Card withBorder>
			<Stack gap="md">
				<Stack gap={2}>
					<Title order={5}>{t("credentialTransfer.title")}</Title>
					<Text size="xs" c="dimmed">
						{t("credentialTransfer.desc")}
					</Text>
				</Stack>
				<Group gap="sm">
					<Button variant="light" onClick={() => setExportOpen(true)}>
						{t("credentialTransfer.export")}
					</Button>
					<FileButton accept=".json,application/json" onChange={setImportFile}>
						{(props) => (
							<Button variant="light" {...props}>
								{t("credentialTransfer.import")}
							</Button>
						)}
					</FileButton>
				</Group>
				{notice && (
					<Alert color="green" withCloseButton onClose={() => setNotice(null)}>
						{notice}
					</Alert>
				)}
			</Stack>
			<ExportModal
				opened={exportOpen}
				onClose={() => setExportOpen(false)}
				onDone={(count) => setNotice(t("credentialTransfer.exported", { count }))}
			/>
			<ImportModal
				file={importFile}
				onClose={() => setImportFile(null)}
				onDone={(result) => setNotice(t("credentialTransfer.imported", { ...result }))}
			/>
		</Card>
	);
}

function ExportModal({
	opened,
	onClose,
	onDone,
}: {
	opened: boolean;
	onClose: () => void;
	onDone: (count: number) => void;
}) {
	const { t } = useTranslation("settings");
	const credentials = useQuery({
		queryKey: ["credential-transfer", "credentials"],
		queryFn: () => credentialTransferApi.list(),
		enabled: opened,
	});
	const list = useMemo(() => credentials.data?.credentials ?? [], [credentials.data]);
	const fields = useStepUpFields(opened);

	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (opened) setError(null);
	}, [opened]);
	useEffect(() => setSelected(new Set(list.map(keyOf))), [list]);

	const ready = selected.size > 0 && fields.ready;

	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			const grant = await fields.verify("credentials.export");
			const all = selected.size === list.length;
			const { blob, filename } = await credentialTransferApi.export({
				stepUpToken: grant.token,
				passphrase: fields.state.passphrase,
				...(all ? {} : { selection: list.filter((c) => selected.has(keyOf(c))) }),
			});
			saveBlobAsFile(blob, filename);
			onDone(selected.size);
			onClose();
		} catch (err) {
			setError(describeApiError(err, t).message);
			fields.clearCode();
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t("credentialTransfer.exportTitle")}
			size="lg"
			centered
		>
			<Stack gap="md">
				{list.length === 0 && !credentials.isLoading ? (
					<Text size="sm" c="dimmed">
						{t("credentialTransfer.none")}
					</Text>
				) : (
					<CredentialChecklist list={list} selected={selected} onChange={setSelected} />
				)}
				<Alert color="yellow" variant="light">
					<Text size="xs">{t("credentialTransfer.rotationWarning")}</Text>
				</Alert>
				<StepUpFields fields={fields} />
				{error && <Alert color="red">{error}</Alert>}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{t("credentialTransfer.cancel")}
					</Button>
					<Button disabled={!ready} loading={busy} onClick={() => void submit()}>
						{t("credentialTransfer.exportButton")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function CredentialChecklist({
	list,
	selected,
	onChange,
}: {
	list: TransferableCredential[];
	selected: Set<string>;
	onChange: (next: Set<string>) => void;
}) {
	const { t } = useTranslation("settings");
	const toggle = (key: string, on: boolean) => {
		const next = new Set(selected);
		if (on) next.add(key);
		else next.delete(key);
		onChange(next);
	};
	return (
		<Stack gap={6}>
			<Checkbox
				label={t("credentialTransfer.selectAll", { count: list.length })}
				checked={list.length > 0 && selected.size === list.length}
				indeterminate={selected.size > 0 && selected.size < list.length}
				onChange={(e) => onChange(e.currentTarget.checked ? new Set(list.map(keyOf)) : new Set())}
			/>
			<ScrollArea.Autosize mah={220}>
				<Stack gap={4} pl="md">
					{list.map((credential) => (
						<Checkbox
							key={keyOf(credential)}
							checked={selected.has(keyOf(credential))}
							onChange={(e) => toggle(keyOf(credential), e.currentTarget.checked)}
							label={
								<Group gap={6} wrap="nowrap">
									<Badge size="xs" variant="light">
										{t(`credentialTransfer.kinds.${credential.kind}`, credential.kind)}
									</Badge>
									<Text size="sm" truncate>
										{credential.label}
									</Text>
									{credential.archived && (
										<Badge size="xs" color="gray" variant="outline">
											{t("credentialTransfer.archived")}
										</Badge>
									)}
								</Group>
							}
						/>
					))}
				</Stack>
			</ScrollArea.Autosize>
		</Stack>
	);
}

function ImportModal({
	file,
	onClose,
	onDone,
}: {
	file: File | null;
	onClose: () => void;
	onDone: (result: CredentialImportResult) => void;
}) {
	const { t, i18n } = useTranslation("settings");
	const [passphrase, setPassphrase] = useState("");
	const [preview, setPreview] = useState<{
		exportedAt: number;
		items: CredentialImportPreviewItem[];
	} | null>(null);
	const [checked, setChecked] = useState<Set<number>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: start over whenever another file is picked
	useEffect(() => {
		setPassphrase("");
		setPreview(null);
		setError(null);
	}, [file]);

	const choices = useMemo(
		() =>
			(preview?.items ?? [])
				.filter((item) => checked.has(item.index) && !item.unsupported)
				.map((item) => ({
					index: item.index,
					action: item.existingId ? ("replace" as const) : ("import" as const),
				})),
		[preview, checked],
	);

	const run = async (step: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await step();
		} catch (err) {
			setError(describeApiError(err, t).message);
		} finally {
			setBusy(false);
		}
	};
	const open = () =>
		run(async () => {
			if (!file) return;
			const result = await credentialTransferApi.previewImport(await file.text(), passphrase);
			setPreview(result);
			// New accounts are preselected; replacing an existing one is an explicit choice.
			setChecked(
				new Set(result.items.filter((i) => !i.unsupported && !i.existingId).map((i) => i.index)),
			);
		});
	const apply = () =>
		run(async () => {
			if (!file) return;
			onDone(await credentialTransferApi.applyImport(await file.text(), passphrase, choices));
			onClose();
		});

	return (
		<Modal
			opened={!!file}
			onClose={onClose}
			title={t("credentialTransfer.importTitle")}
			size="lg"
			centered
		>
			<Stack gap="md">
				<Text size="sm" c="dimmed" truncate>
					{file?.name}
				</Text>
				{!preview ? (
					<PasswordInput
						label={t("credentialTransfer.importPassphrase")}
						value={passphrase}
						onChange={(e) => setPassphrase(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && passphrase) void open();
						}}
						autoComplete="off"
					/>
				) : (
					<>
						<Text size="xs" c="dimmed">
							{t("credentialTransfer.exportedAt", {
								time: new Date(preview.exportedAt).toLocaleString(i18n.language),
							})}
						</Text>
						<ScrollArea.Autosize mah={320}>
							<Stack gap={6}>
								{preview.items.map((item) => (
									<Checkbox
										key={item.index}
										disabled={item.unsupported}
										checked={checked.has(item.index)}
										onChange={(e) => {
											const next = new Set(checked);
											if (e.currentTarget.checked) next.add(item.index);
											else next.delete(item.index);
											setChecked(next);
										}}
										label={
											<Group gap={6} wrap="nowrap">
												<Badge size="xs" variant="light">
													{t(`credentialTransfer.kinds.${item.kind}`, item.kind)}
												</Badge>
												<Text size="sm" truncate>
													{item.label}
												</Text>
												<Badge
													size="xs"
													variant="outline"
													color={item.unsupported ? "gray" : item.existingId ? "orange" : "green"}
												>
													{item.unsupported
														? t("credentialTransfer.statusUnsupported")
														: item.existingId
															? checked.has(item.index)
																? t("credentialTransfer.replace")
																: t("credentialTransfer.statusExists")
															: t("credentialTransfer.statusNew")}
												</Badge>
											</Group>
										}
									/>
								))}
							</Stack>
						</ScrollArea.Autosize>
					</>
				)}
				{error && <Alert color="red">{error}</Alert>}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{t("credentialTransfer.cancel")}
					</Button>
					{preview ? (
						<Button disabled={choices.length === 0} loading={busy} onClick={() => void apply()}>
							{t("credentialTransfer.importButton", { count: choices.length })}
						</Button>
					) : (
						<Button disabled={!passphrase} loading={busy} onClick={() => void open()}>
							{t("credentialTransfer.preview")}
						</Button>
					)}
				</Group>
			</Stack>
		</Modal>
	);
}
