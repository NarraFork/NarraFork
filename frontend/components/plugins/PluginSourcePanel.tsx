import {
	Alert,
	Button,
	Checkbox,
	Group,
	Loader,
	NativeSelect,
	Paper,
	Stack,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import {
	type PluginSource,
	type PluginSourceView,
	pluginSourceSchema,
} from "@shared/plugin-source";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePluginSource, useSetPluginSource } from "../../hooks/usePlugins";
import { localizePluginError } from "../plugins-admin/errors";
import { pluginUpdateErrorMessage } from "./plugin-source-management";

interface SourceDraft {
	type: "none" | PluginSource["type"];
	homepage: string;
	owner: string;
	repo: string;
	assetName: string;
	metadataAsset: string;
	checksumAsset: string;
	updateApi: string;
	downloadOrigins: string;
	allowInsecureHttp: boolean;
	builtinId: string;
}
function sourceDraft(source: PluginSource | null, pluginId: string): SourceDraft {
	return {
		type: source?.type ?? "none",
		homepage: source?.homepage ?? "",
		owner: source?.type === "github" ? source.owner : "",
		repo: source?.type === "github" ? source.repo : "",
		assetName: source?.type === "github" ? source.assetName : "",
		metadataAsset: source?.type === "github" ? (source.metadataAsset ?? "") : "",
		checksumAsset: source?.type === "github" ? (source.checksumAsset ?? "") : "",
		updateApi: source?.type === "website" ? source.updateApi : "",
		downloadOrigins: source?.type === "website" ? (source.downloadOrigins ?? []).join("\n") : "",
		allowInsecureHttp: source?.type === "website" && source.allowInsecureHttp === true,
		builtinId: source?.type === "local" ? source.builtinId : pluginId,
	};
}
function parseDraft(draft: SourceDraft) {
	if (draft.type === "none") return { success: true as const, data: null };
	const homepage = draft.homepage.trim() ? { homepage: draft.homepage.trim() } : {};
	const source =
		draft.type === "github"
			? {
					type: "github",
					owner: draft.owner.trim(),
					repo: draft.repo.trim(),
					assetName: draft.assetName.trim(),
					...(draft.metadataAsset.trim() ? { metadataAsset: draft.metadataAsset.trim() } : {}),
					...(draft.checksumAsset.trim() ? { checksumAsset: draft.checksumAsset.trim() } : {}),
					...homepage,
				}
			: draft.type === "website"
				? {
						type: "website",
						updateApi: draft.updateApi.trim(),
						downloadOrigins: draft.downloadOrigins
							.split(/\r?\n/)
							.map((line) => line.trim())
							.filter(Boolean),
						allowInsecureHttp: draft.allowInsecureHttp,
						...homepage,
					}
				: { type: "local", builtinId: draft.builtinId.trim(), ...homepage };
	return pluginSourceSchema.safeParse(source);
}
function canonicalSource(source: PluginSource | null): string {
	if (!source) return "null";
	const parsed = pluginSourceSchema.safeParse(source);
	return JSON.stringify(parsed.success ? parsed.data : source);
}

export function PluginSourcePanel({
	pluginId,
	canManage = false,
	disabled = false,
	onDirtyChange,
}: {
	pluginId: string;
	canManage?: boolean;
	disabled?: boolean;
	onDirtyChange?: (dirty: boolean) => void;
}) {
	const { t } = useTranslation("plugins");
	const query = usePluginSource(pluginId, { enabled: canManage });
	const mutation = useSetPluginSource(pluginId);
	const view = query.data;
	const [draft, setDraft] = useState(() => sourceDraft(view?.binding.source ?? null, pluginId));
	const [baseRevision, setBaseRevision] = useState<number | null>(view?.binding.revision ?? null);
	const [baseline, setBaseline] = useState(() => canonicalSource(view?.binding.source ?? null));
	const [error, setError] = useState<string | null>(null);
	const parsed = useMemo(() => parseDraft(draft), [draft]);
	const dirty =
		baseRevision !== null && (!parsed.success || canonicalSource(parsed.data) !== baseline);
	const conflicted = view && baseRevision !== null && view.binding.revision !== baseRevision;
	const locked = !canManage || disabled || mutation.isPending || !view;
	const sync = (next: PluginSourceView) => {
		setDraft(sourceDraft(next.binding.source, pluginId));
		setBaseline(canonicalSource(next.binding.source));
		setBaseRevision(next.binding.revision);
		setError(null);
	};
	useEffect(() => {
		if (view && !dirty && baseRevision !== view.binding.revision) {
			setDraft(sourceDraft(view.binding.source, pluginId));
			setBaseline(canonicalSource(view.binding.source));
			setBaseRevision(view.binding.revision);
		}
	}, [view, dirty, baseRevision, pluginId]);
	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);
	const field = <K extends keyof SourceDraft>(name: K, value: SourceDraft[K]) => {
		setDraft((old) => ({ ...old, [name]: value }));
		setError(null);
	};
	const save = (source: PluginSource | null) => {
		if (locked || baseRevision === null) return;
		setError(null);
		mutation.mutate(
			{ source, expectedRevision: baseRevision },
			{
				onSuccess: ({ view: saved }) => {
					if (saved.pluginId === pluginId) sync(saved);
				},
				onError: (cause) => setError(pluginUpdateErrorMessage(cause, t)),
			},
		);
	};

	return (
		<Paper withBorder p="md" radius="md" data-plugin-source-panel={pluginId}>
			<Stack gap="sm">
				<Title order={5}>{t("admin.sources.title")}</Title>
				<Text size="sm" c="dimmed">
					{t("admin.sources.optionalHint")}
				</Text>
				{!canManage && (
					<Text size="sm" c="dimmed">
						{t("admin.sources.adminOnly")}
					</Text>
				)}
				{query.isPending && canManage && (
					<Group gap="xs">
						<Loader size="xs" />
						<Text size="sm">{t("admin.sources.loading")}</Text>
					</Group>
				)}
				{query.error && (
					<Alert color="yellow">
						{localizePluginError(query.error, t)} {t("admin.sources.runtimeUnaffected")}
					</Alert>
				)}
				{view?.diagnostics?.map((diagnostic) => (
					<Alert key={`${diagnostic.code}/${diagnostic.message}`} color="yellow">
						{t(`admin.sources.diagnostics.${diagnostic.code}`, {
							defaultValue: t("admin.sources.invalidMetadata"),
						})}
					</Alert>
				))}
				{error && (
					<Alert color="red" role="alert">
						{error}
					</Alert>
				)}
				{conflicted && (
					<Alert color="yellow">
						<Stack gap="xs">
							<Text size="sm">{t("admin.sources.conflict")}</Text>
							<Button size="compact-xs" variant="light" onClick={() => view && sync(view)}>
								{t("admin.sources.reload")}
							</Button>
						</Stack>
					</Alert>
				)}
				{view && (
					<Text size="xs" c="dimmed">
						{t("admin.sources.origin", {
							origin: t(`admin.sources.origins.${view.origin}`),
							revision: view.binding.revision,
						})}
					</Text>
				)}
				<NativeSelect
					label={t("admin.sources.type")}
					data={["none", "github", "website", "local"].map((type) => ({
						value: type,
						label: t(`admin.sources.types.${type}`),
					}))}
					value={draft.type}
					disabled={locked}
					onChange={(event) => field("type", event.currentTarget.value as SourceDraft["type"])}
				/>
				{draft.type === "github" && (
					<>
						<TextInput
							label={t("admin.sources.owner")}
							value={draft.owner}
							disabled={locked}
							maxLength={100}
							onChange={(event) => field("owner", event.currentTarget.value)}
						/>
						<TextInput
							label={t("admin.sources.repo")}
							value={draft.repo}
							disabled={locked}
							maxLength={100}
							onChange={(event) => field("repo", event.currentTarget.value)}
						/>
						<TextInput
							label={t("admin.sources.assetName")}
							description={t("admin.sources.assetHint")}
							value={draft.assetName}
							disabled={locked}
							maxLength={256}
							onChange={(event) => field("assetName", event.currentTarget.value)}
						/>
						<TextInput
							label={t("admin.sources.metadataAsset")}
							value={draft.metadataAsset}
							disabled={locked}
							maxLength={256}
							onChange={(event) => field("metadataAsset", event.currentTarget.value)}
						/>
						<TextInput
							label={t("admin.sources.checksumAsset")}
							value={draft.checksumAsset}
							disabled={locked}
							maxLength={256}
							onChange={(event) => field("checksumAsset", event.currentTarget.value)}
						/>
					</>
				)}
				{draft.type === "website" && (
					<>
						<TextInput
							label={t("admin.sources.updateApi")}
							value={draft.updateApi}
							disabled={locked}
							maxLength={2048}
							onChange={(event) => field("updateApi", event.currentTarget.value)}
						/>
						<Textarea
							label={t("admin.sources.downloadOrigins")}
							description={t("admin.sources.downloadOriginsHint")}
							value={draft.downloadOrigins}
							disabled={locked}
							maxLength={16_384}
							autosize
							minRows={2}
							maxRows={8}
							onChange={(event) => field("downloadOrigins", event.currentTarget.value)}
						/>
						<Checkbox
							label={t("admin.sources.allowInsecureHttp")}
							description={t("admin.sources.insecureHint")}
							checked={draft.allowInsecureHttp}
							disabled={locked}
							onChange={(event) => field("allowInsecureHttp", event.currentTarget.checked)}
						/>
					</>
				)}
				{draft.type === "local" && (
					<TextInput
						label={t("admin.sources.builtinId")}
						description={t("admin.sources.localHint")}
						value={draft.builtinId}
						disabled={locked}
						maxLength={128}
						onChange={(event) => field("builtinId", event.currentTarget.value)}
					/>
				)}
				{draft.type !== "none" && (
					<TextInput
						label={t("admin.sources.homepage")}
						description={t("admin.sources.homepageHint")}
						value={draft.homepage}
						disabled={locked}
						maxLength={2048}
						onChange={(event) => field("homepage", event.currentTarget.value)}
					/>
				)}
				{view?.declaredSource && (
					<Group gap="xs">
						<Text size="sm" c="dimmed">
							{t("admin.sources.packageHint")}
						</Text>
						<Button
							size="compact-xs"
							variant="light"
							disabled={locked}
							onClick={() =>
								view.declaredSource && setDraft(sourceDraft(view.declaredSource, pluginId))
							}
						>
							{t("admin.sources.adoptPackage")}
						</Button>
					</Group>
				)}
				<Group gap="xs">
					<Button
						size="xs"
						disabled={locked || !dirty}
						loading={mutation.isPending}
						onClick={() => {
							if (!parsed.success) {
								setError(t("admin.sources.invalidSource"));
								return;
							}
							save(parsed.data);
						}}
					>
						{t("admin.sources.save")}
					</Button>
					<Button
						size="xs"
						variant="light"
						disabled={locked || view?.binding.mode === "none"}
						onClick={() => save(null)}
					>
						{t("admin.sources.clear")}
					</Button>
				</Group>
			</Stack>
		</Paper>
	);
}
