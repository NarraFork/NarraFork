/**
 * 设置 · 存储空间：数据导入 / 导出 / 清空。
 *
 * - 导出：直接下载 ZIP（无需确认）。
 * - 导入：选择文件 → 预检（统计 + 会话 id 冲突清单）→ 选择覆盖/跳过策略 → 执行。
 * - 清空：分项（请求历史 / 会话 / 供应商）与全量；先确认弹窗，再输入当前登录密码。
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
	Radio,
	ScrollArea,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type {
	ClearResult,
	ClearTarget,
	ConflictDecision,
	ImportPreviewResult,
	ImportResult,
	TransferSelection,
} from "../../lib/api/storage-transfer";
import { ALL_DATA_KINDS } from "../../lib/api/storage-transfer";
import { describeApiError } from "../../lib/api-error";
import { useConfirmDialog } from "../common/confirm-dialog-context";

const CLEAR_TARGETS: ClearTarget[] = ["requests", "sessions", "providers", "all"];

const KIND_KEYS = ["requests", "sessions", "providers"] as const;

/** 复选组与选择对象互转：Mantine 的 Checkbox.Group 用字符串数组。 */
function selectedKinds(selection: TransferSelection): string[] {
	return KIND_KEYS.filter((key) => selection[key]);
}

function selectionFrom(values: string[]): TransferSelection {
	return {
		requests: values.includes("requests"),
		sessions: values.includes("sessions"),
		providers: values.includes("providers"),
	};
}

function clearLabelKey(target: ClearTarget): string {
	switch (target) {
		case "requests":
			return "dataClearRequests";
		case "sessions":
			return "dataClearSessions";
		case "providers":
			return "dataClearProviders";
		default:
			return "dataClearAll";
	}
}

export function DataPortabilityCard() {
	const { t } = useTranslation("settings");
	const confirm = useConfirmDialog();

	const [exporting, setExporting] = useState(false);
	const [exportError, setExportError] = useState<string | null>(null);
	const [exportOpen, setExportOpen] = useState(false);
	const [exportSelection, setExportSelection] = useState<TransferSelection>(ALL_DATA_KINDS);

	const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
	const [importResult, setImportResult] = useState<ImportResult | null>(null);
	const [importError, setImportError] = useState<string | null>(null);
	const [includeSelection, setIncludeSelection] = useState<TransferSelection>(ALL_DATA_KINDS);
	const [conflictDefault, setConflictDefault] = useState<ConflictDecision>("skip");
	const [conflictById, setConflictById] = useState<Record<string, ConflictDecision>>({});

	const [clearTarget, setClearTarget] = useState<ClearTarget | null>(null);
	const [password, setPassword] = useState("");
	const [clearError, setClearError] = useState<string | null>(null);

	const previewMutation = useMutation({
		mutationFn: (file: File) => api.previewImport(file),
		onSuccess: (result) => {
			setPreview(result);
			setImportResult(null);
			setImportError(null);
			setIncludeSelection(ALL_DATA_KINDS);
			setConflictDefault("skip");
			setConflictById(
				Object.fromEntries(result.conflicts.map((c) => [c.id, "skip" as ConflictDecision])),
			);
		},
		onError: (error: Error) => {
			setPreview(null);
			setImportError(describeApiError(error, t).message);
		},
	});

	const applyMutation = useMutation({
		mutationFn: () =>
			api.applyImport(
				preview?.token ?? "",
				conflictDefault,
				preview && preview.conflicts.length > 0 ? conflictById : undefined,
				includeSelection,
			),
		onSuccess: (result) => {
			setImportResult(result);
			setPreview(null);
		},
		onError: (error: Error) => setImportError(describeApiError(error, t).message),
	});

	const clearMutation = useMutation({
		mutationFn: (input: { target: ClearTarget; password: string }) =>
			api.clearData(input.target, input.password),
		onSuccess: (_result: ClearResult) => {
			setClearTarget(null);
			setPassword("");
			setClearError(null);
		},
		onError: (error: Error) => setClearError(describeApiError(error, t).message),
	});

	const handleExport = async () => {
		setExporting(true);
		setExportError(null);
		try {
			const blob = await api.downloadExport(exportSelection);
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `narrafork-export-${new Date().toISOString().slice(0, 10)}.zip`;
			anchor.click();
			URL.revokeObjectURL(url);
			setExportOpen(false);
		} catch (error) {
			setExportError(describeApiError(error, t).message);
		} finally {
			setExporting(false);
		}
	};

	/** 清空入口：先确认，再弹密码输入。 */
	const beginClear = async (target: ClearTarget) => {
		const accepted = await confirm({
			title: t("dataClearConfirmTitle"),
			message:
				target === "all"
					? t("dataClearConfirmAllMessage")
					: t("dataClearConfirmMessage", { target: t(clearLabelKey(target)) }),
			confirmLabel: t("dataClearConfirm"),
			confirmColor: "red",
		});
		if (!accepted) return;
		setPassword("");
		setClearError(null);
		setClearTarget(target);
	};

	return (
		<Card withBorder>
			<Stack gap="md">
				<Group justify="space-between" align="flex-start">
					<Stack gap={2}>
						<Title order={5}>{t("dataPortabilityTitle")}</Title>
						<Text size="xs" c="dimmed">
							{t("dataPortabilityDesc")}
						</Text>
					</Stack>
				</Group>

				{/* 导出 / 导入 */}
				<Group gap="sm">
					<Button variant="light" onClick={() => setExportOpen(true)}>
						{t("dataExport")}
					</Button>
					<FileButton
						accept=".zip"
						onChange={(file) => {
							if (file) previewMutation.mutate(file);
						}}
					>
						{(props) => (
							<Button variant="light" loading={previewMutation.isPending} {...props}>
								{t("dataImport")}
							</Button>
						)}
					</FileButton>
				</Group>
				{exportError && <Alert color="red">{exportError}</Alert>}
				{importError && <Alert color="red">{importError}</Alert>}
				{importResult && (
					<Alert color="green" title={t("dataImportDoneTitle")}>
						<Text size="sm">
							{t("dataImportDoneBody", {
								requests: importResult.requestsInserted,
								sessions: importResult.sessionsInserted,
								overwritten: importResult.sessionsOverwritten,
								skipped: importResult.sessionsSkipped,
								providers: importResult.providersAdded,
								renamed: importResult.providersRenamed,
							})}
						</Text>
						{importResult.sessionsRejected > 0 && (
							<Text size="sm" c="orange.6" mt={4}>
								{t("dataImportRejected", { count: importResult.sessionsRejected })}
							</Text>
						)}
					</Alert>
				)}

				{/* 清空 */}
				<Stack gap="xs">
					<Text size="sm" fw={600}>
						{t("dataClearTitle")}
					</Text>
					<Text size="xs" c="dimmed">
						{t("dataClearHint")}
					</Text>
					<Group gap="xs">
						{CLEAR_TARGETS.map((target) => (
							<Button
								key={target}
								variant={target === "all" ? "filled" : "light"}
								color="red"
								loading={clearMutation.isPending && clearTarget === target}
								onClick={() => void beginClear(target)}
							>
								{t(clearLabelKey(target))}
							</Button>
						))}
					</Group>
				</Stack>
			</Stack>

			{/* 导入预检弹窗 */}
			<Modal
				opened={preview !== null}
				onClose={() => setPreview(null)}
				title={t("dataImportPreviewTitle")}
				size="lg"
			>
				{preview && (
					<Stack gap="sm">
						<Group gap="xs">
							<Badge variant="light">
								{t("dataImportCountsRequests", { count: preview.counts.requests })}
							</Badge>
							<Badge variant="light">
								{t("dataImportCountsSessions", { count: preview.counts.sessions })}
							</Badge>
							<Badge variant="light">
								{t("dataImportCountsProviders", { count: preview.counts.providers })}
							</Badge>
						</Group>

						<Checkbox.Group
							label={t("dataImportSelectTitle")}
							value={selectedKinds(includeSelection)}
							onChange={(values) => setIncludeSelection(selectionFrom(values))}
						>
							<Stack gap={4} mt={4}>
								<Checkbox value="requests" label={t("dataKindRequests")} />
								<Checkbox value="sessions" label={t("dataKindSessions")} />
								<Checkbox value="providers" label={t("dataKindProviders")} />
							</Stack>
						</Checkbox.Group>

						{preview.conflicts.length === 0 ? (
							<Text size="sm" c="dimmed">
								{t("dataImportNoConflicts")}
							</Text>
						) : (
							<Stack gap="xs">
								<Text size="sm" fw={600}>
									{t("dataImportConflictTitle", { count: preview.conflicts.length })}
								</Text>
								<Radio.Group
									value={conflictDefault}
									onChange={(value) => {
										const decision = value as ConflictDecision;
										setConflictDefault(decision);
										setConflictById(
											Object.fromEntries(preview.conflicts.map((c) => [c.id, decision])),
										);
									}}
								>
									<Group gap="md">
										<Radio value="skip" label={t("dataImportSkipAll")} />
										<Radio value="overwrite" label={t("dataImportOverwriteAll")} />
									</Group>
								</Radio.Group>
								<ScrollArea.Autosize mah={220}>
									<Stack gap={6}>
										{preview.conflicts.map((conflict) => (
											<Group key={conflict.id} justify="space-between" wrap="nowrap">
												<Stack gap={0} style={{ minWidth: 0 }}>
													<Text size="sm" truncate>
														{conflict.name}
													</Text>
													<Text size="xs" c="dimmed" truncate>
														{conflict.id} ·{" "}
														{t("dataImportConflictMessages", {
															count: conflict.importedMessages,
														})}
													</Text>
												</Stack>
												<Radio.Group
													value={conflictById[conflict.id] ?? conflictDefault}
													onChange={(value) =>
														setConflictById((prev) => ({
															...prev,
															[conflict.id]: value as ConflictDecision,
														}))
													}
												>
													<Group gap="sm">
														<Radio value="skip" label={t("dataImportSkip")} />
														<Radio value="overwrite" label={t("dataImportOverwrite")} />
													</Group>
												</Radio.Group>
											</Group>
										))}
									</Stack>
								</ScrollArea.Autosize>
							</Stack>
						)}

						<Group justify="flex-end">
							<Button variant="subtle" onClick={() => setPreview(null)}>
								{t("dataImportCancel")}
							</Button>
							<Button loading={applyMutation.isPending} onClick={() => applyMutation.mutate()}>
								{t("dataImportConfirm")}
							</Button>
						</Group>
					</Stack>
				)}
			</Modal>

			{/* 清空密码弹窗 */}
			<Modal
				opened={clearTarget !== null}
				onClose={() => setClearTarget(null)}
				title={t("dataClearPasswordTitle")}
			>
				<Stack gap="sm">
					<Text size="sm">
						{t("dataClearPasswordDesc", {
							target: clearTarget ? t(clearLabelKey(clearTarget)) : "",
						})}
					</Text>
					<PasswordInput
						label={t("dataClearPasswordLabel")}
						value={password}
						onChange={(event) => setPassword(event.currentTarget.value)}
						data-autofocus
					/>
					{clearError && <Alert color="red">{clearError}</Alert>}
					<Group justify="flex-end">
						<Button variant="subtle" onClick={() => setClearTarget(null)}>
							{t("dataClearCancel")}
						</Button>
						<Button
							color="red"
							disabled={!password}
							loading={clearMutation.isPending}
							onClick={() => {
								if (clearTarget) clearMutation.mutate({ target: clearTarget, password });
							}}
						>
							{t("dataClearConfirm")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			{/* 导出选择弹窗 */}
			<Modal
				opened={exportOpen}
				onClose={() => setExportOpen(false)}
				title={t("dataExportSelectTitle")}
			>
				<Stack gap="sm">
					<Checkbox.Group
						value={selectedKinds(exportSelection)}
						onChange={(values) => setExportSelection(selectionFrom(values))}
					>
						<Stack gap={4}>
							<Checkbox value="requests" label={t("dataKindRequests")} />
							<Checkbox value="sessions" label={t("dataKindSessions")} />
							<Checkbox value="providers" label={t("dataKindProviders")} />
						</Stack>
					</Checkbox.Group>
					<Group justify="flex-end">
						<Button variant="subtle" onClick={() => setExportOpen(false)}>
							{t("dataImportCancel")}
						</Button>
						<Button
							disabled={selectedKinds(exportSelection).length === 0}
							loading={exporting}
							onClick={() => void handleExport()}
						>
							{t("dataExport")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Card>
	);
}
