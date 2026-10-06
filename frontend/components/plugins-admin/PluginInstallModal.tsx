import {
	Alert,
	Button,
	Checkbox,
	Divider,
	FileButton,
	Group,
	Modal,
	Progress,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { IconAlertCircle, IconUpload } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useInstallPlugin, useInstallSources, useUploadPlugin } from "../../hooks/usePlugins";
import { ApiError } from "../../lib/api";
import type { PluginDetail, PluginPermissionSet } from "../../lib/api/plugins";
import { pluginsApi } from "../../lib/api/plugins";
import { localizePluginError } from "./errors";

const SAFE_ARCHIVE_EXTENSIONS = [".nfplugin", ".zip"] as const;

function hasSafeExtension(path: string): boolean {
	const lower = path.trim().toLowerCase();
	return SAFE_ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function PluginInstallModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
	const { t } = useTranslation("plugins");
	const install = useInstallPlugin();
	const upload = useUploadPlugin();
	const sourcesQuery = useInstallSources(opened);
	const [path, setPath] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const [progress, setProgress] = useState(0);
	// Post-install capability authorization step. `installed` non-null switches the
	// modal into the authorization view.
	const [installed, setInstalled] = useState<PluginDetail | null>(null);
	const [pendingGrants, setPendingGrants] = useState<PluginPermissionSet | null>(null);
	const [checked, setChecked] = useState<Set<string>>(new Set());
	const [authError, setAuthError] = useState<string | null>(null);
	const [authorizing, setAuthorizing] = useState(false);

	const trimmed = path.trim();
	const extensionError =
		trimmed.length > 0 && !hasSafeExtension(trimmed)
			? t("admin.installModal.invalidExtension")
			: null;
	const busy = install.isPending || upload.isPending;

	const close = () => {
		setPath("");
		setLocalError(null);
		setProgress(0);
		setInstalled(null);
		setPendingGrants(null);
		setChecked(new Set());
		setAuthError(null);
		setAuthorizing(false);
		install.reset();
		upload.reset();
		onClose();
	};

	// After a successful install, switch to the authorization view: the server
	// already auto-granted every declared capability, so the checkboxes start
	// fully checked and the admin may uncheck capabilities they want to withhold.
	const handleInstalled = async (detail: PluginDetail) => {
		const declared = detail.manifest?.permissions?.host ?? [];
		if (declared.length === 0) {
			close();
			return;
		}
		setInstalled(detail);
		try {
			const grants = await pluginsApi.getGrants(detail.pluginId);
			setPendingGrants(grants);
			setChecked(new Set(grants.grants.map((grant) => grant.capability)));
		} catch {
			// Best effort: if the grant read fails, fall back to checking every
			// declared capability so the view still offers a full picture.
			setPendingGrants(null);
			setChecked(new Set(declared));
		}
	};

	const submitPath = () => {
		setLocalError(null);
		if (!trimmed) return;
		if (!hasSafeExtension(trimmed)) {
			setLocalError(t("admin.installModal.invalidExtension"));
			return;
		}
		install.mutate(trimmed, { onSuccess: (detail) => void handleInstalled(detail) });
	};

	const submitUpload = (file: File | null) => {
		if (!file) return;
		setLocalError(null);
		if (!hasSafeExtension(file.name)) {
			setLocalError(t("admin.installModal.invalidExtension"));
			return;
		}
		setProgress(0);
		upload.mutate(
			{ file, onProgress: (f) => setProgress(Math.round(f * 100)) },
			{ onSuccess: (detail) => void handleInstalled(detail) },
		);
	};

	const toggleCapability = (capability: string) => {
		setChecked((prev) => {
			const next = new Set(prev);
			if (next.has(capability)) next.delete(capability);
			else next.add(capability);
			return next;
		});
	};

	// Commit the admin's selection: only shrinks when capabilities were
	// unchecked (the server already granted everything at install time).
	const confirmAuthorization = async () => {
		if (!installed) return;
		setAuthorizing(true);
		setAuthError(null);
		try {
			const declared = installed.manifest?.permissions?.host ?? [];
			const selected = declared.filter((capability) => checked.has(capability));
			const grants = pendingGrants;
			if (grants) {
				const grantedCapabilities = new Set(grants.grants.map((g) => g.capability));
				const changed =
					selected.length !== grantedCapabilities.size ||
					selected.some((capability) => !grantedCapabilities.has(capability));
				if (changed) {
					await pluginsApi.replaceGrants(installed.pluginId, {
						expectedRevision: grants.revision,
						grants: selected.map((capability) => ({
							capability,
							scope: { type: "global" },
						})),
					});
				}
			}
			close();
		} catch (err) {
			setAuthError(localizePluginError(err, t));
		} finally {
			setAuthorizing(false);
		}
	};

	const activeError = install.error ?? upload.error;
	const serverError = activeError instanceof Error ? localizePluginError(activeError, t) : null;

	// ── Authorization view ──────────────────────────────────────────────────
	if (installed) {
		const declared = installed.manifest?.permissions?.host ?? [];
		const grantedSet = new Set((pendingGrants?.grants ?? []).map((g) => g.capability));
		const displayName = installed.displayName ?? installed.pluginId;
		return (
			<Modal
				opened={opened}
				onClose={close}
				title={t("admin.installModal.authorizeTitle", { name: displayName })}
				size="md"
				centered
			>
				<Stack gap="sm">
					<Text size="sm" c="dimmed">
						{t("admin.installModal.authorizeDescription")}
					</Text>
					{authError && (
						<Alert color="red" variant="light" icon={<IconAlertCircle size={18} />}>
							<Text size="sm">{authError}</Text>
						</Alert>
					)}
					<Stack gap={4}>
						{declared.map((capability) => {
							const granted = grantedSet.has(capability);
							return (
								<Checkbox
									key={capability}
									label={capability}
									checked={checked.has(capability)}
									disabled={!granted || authorizing}
									onChange={() => toggleCapability(capability)}
									description={granted ? undefined : t("admin.installModal.authorizeNotGranted")}
									size="sm"
								/>
							);
						})}
					</Stack>
					<Group justify="flex-end" mt="xs">
						<Button variant="subtle" onClick={close} disabled={authorizing}>
							{t("admin.installModal.authorizeSkip")}
						</Button>
						<Button onClick={() => void confirmAuthorization()} loading={authorizing}>
							{t("admin.installModal.authorizeConfirm")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		);
	}

	// ── Install form view ───────────────────────────────────────────────────
	return (
		<Modal opened={opened} onClose={close} title={t("admin.installModal.title")} size="md" centered>
			<Stack gap="sm">
				{/* Upload a package from the browser */}
				<Text size="sm" fw={500}>
					{t("admin.installModal.uploadLabel")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("admin.installModal.uploadDescription")}
				</Text>
				<Group>
					<FileButton onChange={submitUpload} accept=".zip,.nfplugin">
						{(props) => (
							<Button
								{...props}
								leftSection={<IconUpload size={16} />}
								variant="light"
								loading={upload.isPending}
								disabled={install.isPending}
							>
								{t("admin.installModal.chooseFile")}
							</Button>
						)}
					</FileButton>
				</Group>
				{upload.isPending && (
					<Progress
						value={progress}
						striped
						animated
						aria-label={t("admin.installModal.uploading")}
					/>
				)}

				<Divider label={t("admin.installModal.orDivider")} labelPosition="center" my="xs" />

				{/* Pick a package already present under the server import root */}
				{(sourcesQuery.data?.length ?? 0) > 0 && (
					<Select
						label={t("admin.installModal.sourceLabel")}
						description={t("admin.installModal.sourceDescription")}
						placeholder={t("admin.installModal.sourcePlaceholder")}
						data={(sourcesQuery.data ?? []).map((s) => ({ value: s.path, label: s.name }))}
						value={sourcesQuery.data?.some((s) => s.path === path) ? path : null}
						onChange={(v) => {
							setLocalError(null);
							setPath(v ?? "");
						}}
						searchable
						clearable
					/>
				)}

				{/* Or type a package path directly (confined to the import root) */}
				<TextInput
					label={t("admin.installModal.pathLabel")}
					placeholder={t("admin.installModal.pathPlaceholder")}
					description={t("admin.installModal.pathDescription")}
					value={path}
					onChange={(event) => setPath(event.currentTarget.value)}
					error={localError ?? extensionError ?? undefined}
				/>
				{serverError && (
					<Alert color="red" variant="light" icon={<IconAlertCircle size={18} />}>
						<Text size="sm">{serverError}</Text>
						{activeError instanceof ApiError && activeError.data?.code ? (
							<Text size="xs" c="dimmed" mt={4}>
								{String(activeError.data.code)}
							</Text>
						) : null}
					</Alert>
				)}
				<Button
					onClick={submitPath}
					loading={install.isPending}
					disabled={!trimmed || extensionError !== null || busy}
					fullWidth
				>
					{t("admin.installModal.submit")}
				</Button>
			</Stack>
		</Modal>
	);
}
