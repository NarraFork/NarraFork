import {
	Alert,
	Badge,
	Box,
	Button,
	Group,
	Modal,
	PasswordInput,
	Select,
	Stack,
	Text,
	TextInput,
	Title,
	UnstyledButton,
} from "@mantine/core";
import { IconArrowLeft, IconSearch } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	APP_VIEWPORT_BOTTOM,
	SAFE_AREA_INSET_BOTTOM,
	SAFE_AREA_INSET_LEFT,
	SAFE_AREA_INSET_RIGHT,
	SAFE_AREA_INSET_TOP,
} from "../../lib/safe-area";
import classes from "./AddProviderPage.module.css";
import {
	type AddProviderDraft,
	draftFromPreset,
	isValidProviderDraft,
	sanitizeProviderPrefix,
} from "./provider-add-draft";
import {
	type AddProviderType,
	type ProviderPreset,
	searchProviderPresets,
} from "./provider-presets";

const PROTOCOL_KEYS: Record<AddProviderType, string> = {
	"anthropic-messages": "addProviderAnthropicMessages",
	"openai-responses": "addProviderOpenAIResponses",
	"completions-compatible": "addProviderCompletions",
	"gemini-compatible": "addProviderGemini",
	nug: "addProviderNug",
};

export function AddProviderPage({
	onClose,
	onAdd,
}: {
	onClose: () => void;
	onAdd: (draft: AddProviderDraft) => void;
}) {
	const { t } = useTranslation("settings");
	const [query, setQuery] = useState("");
	const [preset, setPreset] = useState<ProviderPreset | null>(null);
	const [draft, setDraft] = useState<AddProviderDraft | null>(null);
	const [showConfig, setShowConfig] = useState(false);
	const catalogRef = useRef<HTMLElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		// Move focus out of the hidden catalog without opening the mobile keyboard.
		if (!preset) return;
		if (showConfig) headingRef.current?.focus();
		else catalogRef.current?.focus();
	}, [showConfig, preset]);
	const presets = useMemo(() => searchProviderPresets(query), [query]);
	const protocolOptions = (
		preset ? Object.keys(preset.endpoints) : Object.keys(PROTOCOL_KEYS)
	) as AddProviderType[];
	const choose = (next: ProviderPreset) => {
		setPreset(next);
		setDraft(draftFromPreset(next));
		setShowConfig(true);
	};
	const chooseCustom = (protocol: AddProviderType) =>
		choose({
			id: `custom-${protocol}`,
			name: t(PROTOCOL_KEYS[protocol]),
			defaultProtocol: protocol,
			endpoints: {
				[protocol]:
					protocol === "gemini-compatible"
						? "https://generativelanguage.googleapis.com/v1beta"
						: "",
			},
		});
	const update = (values: Partial<AddProviderDraft>) =>
		setDraft((prev) => (prev ? { ...prev, ...values } : prev));

	return (
		<Modal
			opened
			fullScreen
			onClose={onClose}
			title={t("addProvider")}
			padding={0}
			classNames={{ content: classes.content, body: classes.body, header: classes.header }}
			styles={{
				content: {
					height: APP_VIEWPORT_BOTTOM,
					maxHeight: APP_VIEWPORT_BOTTOM,
					paddingLeft: SAFE_AREA_INSET_LEFT,
					paddingRight: SAFE_AREA_INSET_RIGHT,
				},
				header: { paddingTop: `max(12px, ${SAFE_AREA_INSET_TOP})` },
			}}
		>
			<div className={classes.layout} data-config={showConfig || undefined}>
				<section
					ref={catalogRef}
					tabIndex={-1}
					className={classes.catalog}
					aria-label={t("addProviderCatalog")}
				>
					<Stack gap="sm" p="md">
						<Text size="sm" c="dimmed">
							{t("addProviderIntro")}
						</Text>
						<TextInput
							label={t("addProviderSearch")}
							placeholder={t("addProviderSearchPlaceholder")}
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
							leftSection={<IconSearch size={16} />}
						/>
						<Text fw={600} size="sm">
							{t("addProviderCustom")}
						</Text>
						<Group gap="xs">
							{(Object.keys(PROTOCOL_KEYS) as AddProviderType[]).map((protocol) => (
								<Button
									key={protocol}
									variant="light"
									size="xs"
									onClick={() => chooseCustom(protocol)}
								>
									{t(PROTOCOL_KEYS[protocol])}
								</Button>
							))}
						</Group>
						<Text fw={600} size="sm">
							{t("addProviderCatalog")} · {presets.length}
						</Text>
						{presets.length === 0 && (
							<Text c="dimmed" size="sm">
								{t("addProviderNoResults")}
							</Text>
						)}
						{presets.map((item) => (
							<UnstyledButton
								key={item.id}
								className={classes.preset}
								data-selected={preset?.id === item.id || undefined}
								onClick={() => choose(item)}
								aria-pressed={preset?.id === item.id}
							>
								<Text fw={600}>{item.name}</Text>
								<Group gap={4} mt={4}>
									{(Object.keys(item.endpoints) as AddProviderType[]).map((protocol) => (
										<Badge key={protocol} size="xs" variant="light">
											{t(PROTOCOL_KEYS[protocol])}
										</Badge>
									))}
								</Group>
							</UnstyledButton>
						))}
						<Text size="xs" c="dimmed">
							{t("addProviderAttribution")}
						</Text>
					</Stack>
				</section>
				<section className={classes.configuration} aria-label={t("addProviderConfigure")}>
					{draft ? (
						<form
							className={classes.form}
							onSubmit={(event) => {
								event.preventDefault();
								if (isValidProviderDraft(draft)) onAdd(draft);
							}}
						>
							<Stack gap="md" p="md" className={classes.fields}>
								<Button
									className={classes.back}
									variant="subtle"
									leftSection={<IconArrowLeft size={16} />}
									onClick={() => setShowConfig(false)}
								>
									{t("addProviderBack")}
								</Button>
								<Title ref={headingRef} tabIndex={-1} order={3}>
									{t("addProviderConfigure")}
								</Title>
								<TextInput
									required
									label={t("addProviderName")}
									value={draft.name}
									onChange={(event) => update({ name: event.currentTarget.value })}
								/>
								<Select
									required
									allowDeselect={false}
									label={t("addProviderProtocol")}
									value={draft.protocol}
									data={protocolOptions.map((value) => ({ value, label: t(PROTOCOL_KEYS[value]) }))}
									onChange={(value) => {
										if (value && preset)
											update({
												protocol: value as AddProviderType,
												baseUrl: preset.endpoints[value as AddProviderType] ?? "",
											});
									}}
								/>
								<Text size="xs" c="dimmed">
									{t(`${PROTOCOL_KEYS[draft.protocol]}Desc`)}
								</Text>
								<TextInput
									required
									label={t("addProviderBaseUrl")}
									description={t("addProviderBaseUrlHint")}
									placeholder="https://api.example.com/v1"
									value={draft.baseUrl}
									onChange={(event) => update({ baseUrl: event.currentTarget.value })}
									type="url"
									autoCapitalize="none"
									spellCheck={false}
								/>
								<PasswordInput
									label={t("addProviderApiKey")}
									description={t("addProviderApiKeyHint")}
									value={draft.apiKey}
									onChange={(event) => update({ apiKey: event.currentTarget.value })}
									autoComplete="off"
								/>
								<TextInput
									label={t("providerPrefix")}
									description={t("addProviderPrefixHint")}
									value={draft.prefix}
									onChange={(event) =>
										update({ prefix: sanitizeProviderPrefix(event.currentTarget.value) })
									}
									autoCapitalize="none"
									spellCheck={false}
								/>
								<Alert variant="light">{t("addProviderDraftNotice")}</Alert>
							</Stack>
							<Group
								justify="flex-end"
								p="md"
								className={classes.actions}
								style={{ paddingBottom: `max(16px, ${SAFE_AREA_INSET_BOTTOM})` }}
							>
								<Button variant="default" onClick={onClose}>
									{t("addProviderCancel")}
								</Button>
								<Button type="submit" disabled={!isValidProviderDraft(draft)}>
									{t("addProviderContinue")}
								</Button>
							</Group>
						</form>
					) : (
						<Box p="xl">
							<Title order={3}>{t("addProviderChoose")}</Title>
							<Text mt="sm" c="dimmed">
								{t("addProviderChooseHint")}
							</Text>
						</Box>
					)}
				</section>
			</div>
		</Modal>
	);
}
