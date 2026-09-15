import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Container,
	Group,
	Paper,
	Stack,
	Switch,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { IconArrowLeft, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useMcpServers } from "../../hooks/useMcp";
import {
	useMcpBuiltinToolsCapability,
	useMcpExternalAgentCapability,
	useMcpExternalToolsCapability,
	useNarratorToolInventoryCapability,
} from "../../hooks/usePlatform";
import { api } from "../../lib/api";

export const Route = createFileRoute("/routines/tool-permissions")({
	component: ToolPermissionsPage,
});

// === Tool metadata ===

type PermCategory = "always-allow" | "always-ask" | "read-only" | "default" | "optional";

interface ToolMeta {
	name: string;
	descKey: string;
	category: PermCategory;
}

const BUILTIN_TOOLS: ToolMeta[] = [
	{ name: "Bash", descKey: "tpToolDescBash", category: "default" },
	{ name: "Read", descKey: "tpToolDescRead", category: "read-only" },
	{ name: "Write", descKey: "tpToolDescWrite", category: "default" },
	{ name: "Edit", descKey: "tpToolDescEdit", category: "default" },
	{ name: "Glob", descKey: "tpToolDescGlob", category: "read-only" },
	{ name: "Grep", descKey: "tpToolDescGrep", category: "read-only" },
	{ name: "StructView", descKey: "tpToolDescStructView", category: "read-only" },
	// `default`, not `read-only`: it writes files. Its own dry-run default is a separate
	// guard and does not make the tool read-only.
	{ name: "StructSed", descKey: "tpToolDescStructSed", category: "default" },
	{ name: "WebSearch", descKey: "tpToolDescWebSearch", category: "always-allow" },
	{ name: "WebFetch", descKey: "tpToolDescWebFetch", category: "default" },
	{ name: "Agent", descKey: "tpToolDescAgent", category: "default" },
	{ name: "EnterPlanMode", descKey: "tpToolDescEnterPlanMode", category: "always-allow" },
	{ name: "ExitPlanMode", descKey: "tpToolDescExitPlanMode", category: "always-ask" },
	{ name: "AskUserQuestion", descKey: "tpToolDescAskUserQuestion", category: "always-ask" },
	{ name: "Skill", descKey: "tpToolDescSkill", category: "always-allow" },
	{ name: "Await", descKey: "tpToolDescAwait", category: "always-allow" },
	{ name: "Send", descKey: "tpToolDescSend", category: "default" },
	{ name: "ShareFile", descKey: "tpToolDescShareFile", category: "optional" },
	{ name: "Terminal", descKey: "tpToolDescTerminal", category: "optional" },
	{ name: "Browser", descKey: "tpToolDescBrowser", category: "optional" },
	{ name: "Recall", descKey: "tpToolDescRecall", category: "optional" },
	{ name: "ScheduledTask", descKey: "tpToolDescScheduledTask", category: "optional" },
];

function categoryColor(cat: PermCategory | "mcp"): string {
	switch (cat) {
		case "always-allow":
			return "green";
		case "always-ask":
			return "yellow";
		case "read-only":
			return "blue";
		case "optional":
			return "grape";
		case "mcp":
			return "cyan";
		default:
			return "gray";
	}
}

const MCP_SCHEMA_PREVIEW_MAX_CHARS = 80_000;

function appendWithBudget(parts: string[], text: string, budget: { remaining: number }): boolean {
	if (budget.remaining <= 0) return false;
	const chunk = text.length > budget.remaining ? text.slice(0, budget.remaining) : text;
	parts.push(chunk);
	budget.remaining -= chunk.length;
	return text.length <= chunk.length;
}

function formatJsonPreview(value: unknown, maxChars = MCP_SCHEMA_PREVIEW_MAX_CHARS): string {
	const parts: string[] = [];
	const budget = { remaining: maxChars };
	const seen = new WeakSet<object>();

	const write = (current: unknown, depth: number): boolean => {
		if (current == null || typeof current === "number" || typeof current === "boolean") {
			return appendWithBudget(parts, JSON.stringify(current), budget);
		}
		if (typeof current === "string") {
			return appendWithBudget(parts, JSON.stringify(current), budget);
		}
		if (typeof current !== "object") {
			return appendWithBudget(parts, JSON.stringify(String(current)), budget);
		}
		if (seen.has(current)) return appendWithBudget(parts, '"[Circular]"', budget);
		seen.add(current);

		const indent = "  ".repeat(depth);
		const nextIndent = "  ".repeat(depth + 1);
		if (Array.isArray(current)) {
			if (!appendWithBudget(parts, "[", budget)) return false;
			for (let i = 0; i < current.length; i++) {
				if (!appendWithBudget(parts, `${i === 0 ? "" : ","}\n${nextIndent}`, budget)) return false;
				if (!write(current[i], depth + 1)) return false;
			}
			return appendWithBudget(parts, `${current.length ? `\n${indent}` : ""}]`, budget);
		}

		const record = current as Record<string, unknown>;
		const keys = Object.keys(record);
		if (!appendWithBudget(parts, "{", budget)) return false;
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			if (!appendWithBudget(parts, `${i === 0 ? "" : ","}\n${nextIndent}`, budget)) return false;
			if (!appendWithBudget(parts, `${JSON.stringify(key)}: `, budget)) return false;
			if (!write(record[key], depth + 1)) return false;
		}
		return appendWithBudget(parts, `${keys.length ? `\n${indent}` : ""}}`, budget);
	};

	const complete = write(value, 0);
	return complete ? parts.join("") : `${parts.join("")}\n…`;
}

function categoryLabel(cat: PermCategory | "mcp", t: (key: string) => string): string {
	switch (cat) {
		case "always-allow":
			return t("tpCategoryAlwaysAllow");
		case "always-ask":
			return t("tpCategoryAlwaysAsk");
		case "read-only":
			return t("tpCategoryReadOnly");
		case "optional":
			return t("tpCategoryOptional");
		case "mcp":
			return t("tpCategoryMcp");
		default:
			return t("tpCategoryDefault");
	}
}

// === Settings types ===

interface PatternEntry {
	pattern: string;
	enabled?: boolean;
}
interface BlacklistEntry extends PatternEntry {
	denyPrompt?: string;
}
interface WebFetchPolicy {
	allowAll?: boolean;
	whitelist?: PatternEntry[];
	blacklist?: PatternEntry[];
}

// === Main page ===

function ToolPermissionsPage() {
	const { t } = useTranslation("routines");
	const { data: currentUser } = useCurrentUser();
	const isAdmin = currentUser?.role === "admin";
	const qc = useQueryClient();

	// Settings
	// biome-ignore lint/suspicious/noExplicitAny: settings response shape varies
	const { data: settings } = useQuery<any>({
		queryKey: ["settings"],
		queryFn: api.getSettings,
	});
	const updateSettings = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
	});

	// Command whitelist / blacklist
	const serverCmdWl: PatternEntry[] = useMemo(
		() => settings?.agent?.commandWhitelist ?? [],
		[settings],
	);
	const serverCmdBl: BlacklistEntry[] = useMemo(
		() => settings?.agent?.commandBlacklist ?? [],
		[settings],
	);
	// WebFetch policy
	const serverWfPolicy: WebFetchPolicy = useMemo(
		() => settings?.agent?.webFetchPolicy ?? {},
		[settings],
	);

	const [cmdWl, setCmdWl] = useState<PatternEntry[]>([]);
	const [cmdBl, setCmdBl] = useState<BlacklistEntry[]>([]);
	const [wfAllowAll, setWfAllowAll] = useState(false);
	const [wfWl, setWfWl] = useState<PatternEntry[]>([]);
	const [wfBl, setWfBl] = useState<PatternEntry[]>([]);
	const planReflectionAutoApprove = settings?.agent?.planReflectionAutoApprove ?? false;
	const initialized = useRef(false);

	useEffect(() => {
		if (settings && !initialized.current) {
			setCmdWl(serverCmdWl);
			setCmdBl(serverCmdBl);
			setWfAllowAll(!!serverWfPolicy.allowAll);
			setWfWl(serverWfPolicy.whitelist ?? []);
			setWfBl(serverWfPolicy.blacklist ?? []);
			initialized.current = true;
		}
	}, [settings, serverCmdWl, serverCmdBl, serverWfPolicy]);

	const isBashDirty = useMemo(() => {
		if (!initialized.current) return false;
		return (
			JSON.stringify(cmdWl) !== JSON.stringify(serverCmdWl) ||
			JSON.stringify(cmdBl) !== JSON.stringify(serverCmdBl)
		);
	}, [cmdWl, cmdBl, serverCmdWl, serverCmdBl]);

	const isWfDirty = useMemo(() => {
		if (!initialized.current) return false;
		return (
			wfAllowAll !== !!serverWfPolicy.allowAll ||
			JSON.stringify(wfWl) !== JSON.stringify(serverWfPolicy.whitelist ?? []) ||
			JSON.stringify(wfBl) !== JSON.stringify(serverWfPolicy.blacklist ?? [])
		);
	}, [wfAllowAll, wfWl, wfBl, serverWfPolicy]);

	const handleSaveBash = useCallback(() => {
		updateSettings.mutate({
			agent: { commandWhitelist: cmdWl, commandBlacklist: cmdBl },
		});
	}, [cmdWl, cmdBl, updateSettings]);

	const handleSaveWf = useCallback(() => {
		updateSettings.mutate({
			agent: {
				webFetchPolicy: {
					allowAll: wfAllowAll,
					whitelist: wfWl,
					blacklist: wfBl,
				},
			},
		});
	}, [wfAllowAll, wfWl, wfBl, updateSettings]);

	const handlePlanReflectionAutoApproveChange = useCallback(
		(checked: boolean) => {
			updateSettings.mutate({
				agent: { planReflectionAutoApprove: checked },
			});
		},
		[updateSettings],
	);

	// MCP servers
	const mcpExternalToolsCapability = useMcpExternalToolsCapability();
	const { data: mcpServers } = useMcpServers({
		enabled: isAdmin && mcpExternalToolsCapability.supported,
	});
	const mcpExternalAgentCapability = useMcpExternalAgentCapability();
	const mcpBuiltinToolsCapability = useMcpBuiltinToolsCapability();
	const toolInventoryCapability = useNarratorToolInventoryCapability();
	const supportedOptionalTools = useMemo(
		() => new Set(toolInventoryCapability.supportedOptionalTools),
		[toolInventoryCapability.supportedOptionalTools],
	);
	const unsupportedOptionalTools = useMemo(
		() => new Set(toolInventoryCapability.unsupportedOptionalTools),
		[toolInventoryCapability.unsupportedOptionalTools],
	);
	const optionalToolSupportDeclared = toolInventoryCapability.supportedOptionalTools.length > 0;

	// Selected tool for detail view
	const [selectedTool, setSelectedTool] = useState<string | null>(null);

	const selectedBuiltin = BUILTIN_TOOLS.find((t) => t.name === selectedTool);
	const selectedMcpTool = useMemo(() => {
		if (!selectedTool?.startsWith("mcp:")) return null;
		const [, serverName, toolName] = selectedTool.split(":", 3);
		// biome-ignore lint/suspicious/noExplicitAny: MCP server response shape
		const server = mcpServers?.find((s: any) => s.name === serverName);
		if (!server) return null;
		// biome-ignore lint/suspicious/noExplicitAny: MCP tool shape
		const tool = server.tools?.find((t: any) => t.name === toolName);
		return tool ? { ...tool, serverName } : null;
	}, [selectedTool, mcpServers]);
	const selectedMcpSchemaPreview = useMemo(() => {
		if (selectedMcpTool?.inputSchema == null) return null;
		return formatJsonPreview(selectedMcpTool.inputSchema);
	}, [selectedMcpTool?.inputSchema]);

	// Detail view
	if (selectedTool && (selectedBuiltin || selectedMcpTool)) {
		const isDirty = selectedBuiltin?.name === "Bash" ? isBashDirty : isWfDirty;
		const handleSave = selectedBuiltin?.name === "Bash" ? handleSaveBash : handleSaveWf;

		return (
			<Container size="md" py="lg">
				<Group gap="xs" mb="md">
					<ActionIcon variant="subtle" onClick={() => setSelectedTool(null)}>
						<IconArrowLeft size={18} />
					</ActionIcon>
					<Title order={3}>{selectedBuiltin?.name ?? selectedMcpTool?.name}</Title>
					<Badge
						size="sm"
						variant="light"
						color={categoryColor(selectedBuiltin?.category ?? "mcp")}
					>
						{categoryLabel(selectedBuiltin?.category ?? "mcp", t)}
					</Badge>
				</Group>

				<Stack gap="md">
					<Paper withBorder p="sm">
						<Text size="sm" fw={600} mb={4}>
							{t("tpDescription")}
						</Text>
						<Text size="sm" c="dimmed">
							{selectedBuiltin ? t(selectedBuiltin.descKey) : (selectedMcpTool?.description ?? "—")}
						</Text>
					</Paper>

					{/* Bash: command whitelist / blacklist */}
					{selectedBuiltin?.name === "Bash" && (
						<>
							<PatternListEditor
								title={t("tpCommandWhitelist")}
								description={t("tpCommandWhitelistDesc")}
								items={cmdWl}
								onChange={setCmdWl}
								showDenyPrompt={false}
								patternPlaceholder={t("tpPatternPlaceholder")}
								t={t}
							/>
							<PatternListEditor
								title={t("tpCommandBlacklist")}
								description={t("tpCommandBlacklistDesc")}
								items={cmdBl}
								onChange={setCmdBl}
								showDenyPrompt
								patternPlaceholder={t("tpPatternPlaceholder")}
								t={t}
							/>
						</>
					)}

					{/* WebFetch: URL whitelist / blacklist + allowAll */}
					{selectedBuiltin?.name === "WebFetch" && (
						<>
							<Paper withBorder p="sm">
								<Switch
									label={t("tpWfAllowAll")}
									description={t("tpWfAllowAllDesc")}
									checked={wfAllowAll}
									onChange={(e) => setWfAllowAll(e.currentTarget.checked)}
									size="sm"
								/>
							</Paper>
							{!wfAllowAll && (
								<>
									<PatternListEditor
										title={t("tpWfWhitelist")}
										description={t("tpWfWhitelistDesc")}
										items={wfWl}
										onChange={setWfWl}
										showDenyPrompt={false}
										patternPlaceholder={t("tpWfPatternPlaceholder")}
										t={t}
									/>
									<PatternListEditor
										title={t("tpWfBlacklist")}
										description={t("tpWfBlacklistDesc")}
										items={wfBl}
										onChange={setWfBl}
										showDenyPrompt={false}
										patternPlaceholder={t("tpWfPatternPlaceholder")}
										t={t}
									/>
								</>
							)}
						</>
					)}

					{/* Save button for Bash / WebFetch */}
					{(selectedBuiltin?.name === "Bash" || selectedBuiltin?.name === "WebFetch") && (
						<>
							{isDirty && (
								<Group justify="flex-end">
									<Button size="sm" onClick={handleSave} loading={updateSettings.isPending}>
										{t("save")}
									</Button>
								</Group>
							)}
							{updateSettings.isSuccess && !isDirty && (
								<Text size="sm" c="green" ta="right">
									{t("tpSaved")}
								</Text>
							)}
						</>
					)}

					{/* MCP tool: show parameters */}
					{selectedMcpTool && (
						<Paper withBorder p="sm">
							<Text size="sm" fw={600} mb={4}>
								{t("tpMcpServer", { name: selectedMcpTool.serverName })}
							</Text>
							{selectedMcpSchemaPreview != null && (
								<Text
									size="xs"
									c="dimmed"
									style={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}
								>
									{selectedMcpSchemaPreview}
								</Text>
							)}
						</Paper>
					)}
				</Stack>
			</Container>
		);
	}

	// List view
	return (
		<Container size="md" py="lg">
			<Group gap="xs" mb="md">
				<ActionIcon variant="subtle" component={Link} to="/routines">
					<IconArrowLeft size={18} />
				</ActionIcon>
				<div>
					<Title order={2}>{t("tpTitle")}</Title>
					<Text size="sm" c="dimmed">
						{t("tpBuiltinToolsDesc")}
					</Text>
				</div>
			</Group>

			{/* Built-in tools */}
			<Text size="sm" fw={600} mb="xs">
				{t("tpBuiltinTools")}
			</Text>
			{(mcpBuiltinToolsCapability.parity === "partial" ||
				mcpBuiltinToolsCapability.missing.length > 0 ||
				!mcpBuiltinToolsCapability.supported) && (
				<Alert
					color={!mcpBuiltinToolsCapability.supported ? "yellow" : "blue"}
					variant="light"
					title={t("tpMcpBuiltinToolsPartialTitle")}
					mb="xs"
				>
					{mcpBuiltinToolsCapability.reason ??
						t("tpMcpBuiltinToolsPartial", {
							missing: mcpBuiltinToolsCapability.missing.join(", ") || "—",
						})}
				</Alert>
			)}
			<Stack gap={6} mb="lg">
				{BUILTIN_TOOLS.map((tool) => {
					const unsupportedOptionalTool =
						tool.category === "optional" &&
						(unsupportedOptionalTools.has(tool.name) ||
							(optionalToolSupportDeclared && !supportedOptionalTools.has(tool.name)));
					return (
						<Stack key={tool.name} gap={6}>
							<Paper
								withBorder
								p="xs"
								style={{
									cursor: unsupportedOptionalTool ? "not-allowed" : "pointer",
									opacity: unsupportedOptionalTool ? 0.6 : 1,
								}}
								onClick={() => {
									if (unsupportedOptionalTool) return;
									setSelectedTool(tool.name);
								}}
							>
								<Group justify="space-between" wrap="nowrap">
									<Group gap="xs">
										<Text size="sm" fw={600}>
											{tool.name}
										</Text>
										<Badge size="xs" variant="light" color={categoryColor(tool.category)}>
											{categoryLabel(tool.category, t)}
										</Badge>
										{unsupportedOptionalTool && (
											<Badge size="xs" variant="outline" color="gray">
												{t("tpToolUnsupported")}
											</Badge>
										)}
									</Group>
									<Text size="xs" c="dimmed" lineClamp={1} style={{ maxWidth: 400 }}>
										{t(tool.descKey)}
									</Text>
								</Group>
							</Paper>
							{tool.name === "ExitPlanMode" && (
								<Paper withBorder p="xs" ml="md">
									<Switch
										label={t("tpPlanReflectionAutoApprove")}
										description={t("tpPlanReflectionAutoApproveDesc")}
										checked={planReflectionAutoApprove}
										onChange={(e) => handlePlanReflectionAutoApproveChange(e.currentTarget.checked)}
										disabled={updateSettings.isPending}
										size="sm"
									/>
								</Paper>
							)}
						</Stack>
					);
				})}
			</Stack>

			{/* MCP tools */}
			{mcpServers &&
				mcpServers.length > 0 &&
				(!mcpExternalAgentCapability.supported ||
					mcpExternalAgentCapability.parity === "partial" ||
					mcpExternalAgentCapability.reason) && (
					<Alert
						color={
							!mcpExternalAgentCapability.supported ||
							mcpExternalAgentCapability.parity === "partial"
								? "yellow"
								: "blue"
						}
						variant="light"
						title={t("tpMcpAgentInjectionTitle")}
						mb="xs"
					>
						{mcpExternalAgentCapability.reason ?? t("tpMcpAgentInjectionPartial")}
					</Alert>
				)}
			{mcpServers && mcpServers.length > 0 && !mcpExternalToolsCapability.supported && (
				<Text size="xs" c="orange" mb="xs">
					{mcpExternalToolsCapability.reason ?? t("tpMcpToolsUnsupported")}
				</Text>
			)}
			{mcpServers && mcpServers.length > 0 && mcpExternalToolsCapability.supported && (
				<>
					<Text size="sm" fw={600} mb="xs">
						{t("tpMcpTools")}
					</Text>
					<Text size="xs" c="dimmed" mb="xs">
						{t("tpMcpToolsDesc")}
					</Text>
					<Stack gap={6}>
						{/* biome-ignore lint/suspicious/noExplicitAny: MCP server response shape */}
						{mcpServers.map((server: any) => (
							<Paper key={server.id} withBorder p="xs">
								<Text size="xs" fw={600} c="dimmed" mb={4}>
									{t("tpMcpServer", { name: server.name })}
								</Text>
								{server.tools?.length === 0 && (
									<Text size="xs" c="dimmed">
										{t("tpNoMcpTools")}
									</Text>
								)}
								<Stack gap={4}>
									{/* biome-ignore lint/suspicious/noExplicitAny: MCP tool shape */}
									{server.tools?.map((tool: any) => (
										<Paper
											key={tool.name}
											p="xs"
											withBorder
											style={{
												cursor: "pointer",
												background:
													"light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-7))",
											}}
											onClick={() => setSelectedTool(`mcp:${server.name}:${tool.name}`)}
										>
											<Group justify="space-between" wrap="nowrap">
												<Group gap="xs">
													<Text size="xs" fw={600}>
														{tool.name}
													</Text>
													<Badge size="xs" variant="light" color="cyan">
														{categoryLabel("mcp", t)}
													</Badge>
												</Group>
												{tool.description && (
													<Text size="xs" c="dimmed" lineClamp={1} style={{ maxWidth: 350 }}>
														{tool.description}
													</Text>
												)}
											</Group>
										</Paper>
									))}
								</Stack>
							</Paper>
						))}
					</Stack>
				</>
			)}
		</Container>
	);
}

// === Pattern list editor (reused for Bash commands and WebFetch URLs) ===

function PatternListEditor({
	title,
	description,
	items,
	onChange,
	showDenyPrompt,
	patternPlaceholder,
	t,
}: {
	title: string;
	description: string;
	items: Array<{ pattern: string; denyPrompt?: string; enabled?: boolean }>;
	onChange: (items: Array<{ pattern: string; denyPrompt?: string; enabled?: boolean }>) => void;
	showDenyPrompt: boolean;
	patternPlaceholder: string;
	t: (key: string) => string;
}) {
	const handleAdd = () => {
		onChange([...items, { pattern: "", enabled: true }]);
	};

	const handleRemove = (index: number) => {
		onChange(items.filter((_, i) => i !== index));
	};

	const handlePatternChange = (index: number, value: string) => {
		const next = [...items];
		next[index] = { ...next[index], pattern: value };
		onChange(next);
	};

	const handleDenyPromptChange = (index: number, value: string) => {
		const next = [...items];
		next[index] = { ...next[index], denyPrompt: value || undefined };
		onChange(next);
	};

	return (
		<Paper withBorder p="sm">
			<Group justify="space-between" mb={4}>
				<div>
					<Text size="sm" fw={600}>
						{title}
					</Text>
					<Text size="xs" c="dimmed">
						{description}
					</Text>
				</div>
				<Button
					size="compact-xs"
					variant="light"
					leftSection={<IconPlus size={12} />}
					onClick={handleAdd}
				>
					{t("tpAddPattern")}
				</Button>
			</Group>

			{items.length === 0 && (
				<Text size="xs" c="dimmed">
					{t("tpNoPatterns")}
				</Text>
			)}

			<Stack gap={6}>
				{items.map((item, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: dynamic list without stable IDs
					<Group key={i} gap="xs" wrap="nowrap">
						<TextInput
							placeholder={patternPlaceholder}
							value={item.pattern}
							onChange={(e) => handlePatternChange(i, e.currentTarget.value)}
							size="xs"
							style={{ flex: 1 }}
							styles={{ input: { fontFamily: "monospace" } }}
						/>
						{showDenyPrompt && (
							<TextInput
								placeholder={t("tpDenyPromptPlaceholder")}
								value={item.denyPrompt ?? ""}
								onChange={(e) => handleDenyPromptChange(i, e.currentTarget.value)}
								size="xs"
								style={{ flex: 1 }}
							/>
						)}
						<ActionIcon variant="subtle" color="red" size="sm" onClick={() => handleRemove(i)}>
							<IconTrash size={12} />
						</ActionIcon>
					</Group>
				))}
			</Stack>
		</Paper>
	);
}
