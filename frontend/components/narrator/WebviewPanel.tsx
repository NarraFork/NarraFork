import { ActionIcon, Box, Group, Text, TextInput, Tooltip } from "@mantine/core";
import { IconCheck, IconExternalLink, IconWorld, IconX } from "@tabler/icons-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebviewLeafConfig } from "./split-tree";

interface WebviewPanelProps {
	config: WebviewLeafConfig;
	leafId: string;
	onClose?: () => void;
	/** Called on pointerdown on the header — allows parent to initiate drag. */
	onHeaderPointerDown?: (e: React.PointerEvent) => void;
	/** Called when the user edits the URL or title. */
	onConfigChange?: (config: WebviewLeafConfig) => void;
}

/** Ensure the URL has a protocol prefix. */
function normalizeUrl(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	return `https://${trimmed}`;
}

/**
 * Webview panel for use inside workspace split-tree.
 * Renders an iframe with a header bar showing the URL.
 */
export function WebviewPanel({
	config,
	leafId,
	onClose,
	onHeaderPointerDown,
	onConfigChange,
}: WebviewPanelProps) {
	const { t } = useTranslation("narrators");
	const [editing, setEditing] = useState(!config.url);
	const [editUrl, setEditUrl] = useState(config.url || "");
	const inputRef = useRef<HTMLInputElement>(null);

	const commitUrl = useCallback(() => {
		setEditing(false);
		const url = normalizeUrl(editUrl);
		if (url && url !== config.url) {
			onConfigChange?.({ ...config, url });
		} else if (!url && !config.url) {
			// Keep editing if still empty
			setEditing(true);
		}
	}, [editUrl, config, onConfigChange]);

	const startEditing = useCallback(() => {
		setEditUrl(config.url || "");
		setEditing(true);
		// Focus after state update
		requestAnimationFrame(() => inputRef.current?.focus());
	}, [config.url]);

	const displayLabel = config.title || config.url || t("webviewPlaceholder");

	return (
		<Box style={{ height: "100%", display: "flex", flexDirection: "column" }}>
			{/* Header bar */}
			<Group
				gap={6}
				px="xs"
				py={3}
				wrap="nowrap"
				onPointerDown={editing ? undefined : onHeaderPointerDown}
				style={{
					flexShrink: 0,
					borderBottom: "1px solid var(--mantine-color-dark-4)",
					backgroundColor: "var(--mantine-color-dark-7)",
					cursor: editing ? undefined : onHeaderPointerDown ? "grab" : undefined,
				}}
			>
				<IconWorld size={14} color="var(--mantine-color-dimmed)" />
				{editing ? (
					<TextInput
						ref={inputRef}
						size="xs"
						value={editUrl}
						onChange={(e) => setEditUrl(e.currentTarget.value)}
						onBlur={commitUrl}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitUrl();
							if (e.key === "Escape") {
								setEditing(false);
								setEditUrl(config.url || "");
							}
						}}
						placeholder={t("webviewUrlPlaceholder")}
						autoFocus
						style={{ flex: 1 }}
						styles={{ input: { minWidth: 120, height: 22, minHeight: 22 } }}
						rightSection={
							<ActionIcon size="xs" variant="subtle" onClick={commitUrl}>
								<IconCheck size={12} />
							</ActionIcon>
						}
					/>
				) : (
					<Text
						size="xs"
						c="dimmed"
						truncate
						style={{ flex: 1, cursor: "pointer" }}
						onClick={startEditing}
					>
						{displayLabel}
					</Text>
				)}
				{config.url && !editing && (
					<Tooltip label={t("webviewOpenExternal")}>
						<ActionIcon
							size="xs"
							variant="subtle"
							color="gray"
							component="a"
							href={config.url}
							target="_blank"
							rel="noopener noreferrer"
						>
							<IconExternalLink size={12} />
						</ActionIcon>
					</Tooltip>
				)}
				{onClose && (
					<Tooltip label={t("closeWebview")}>
						<ActionIcon size="xs" variant="subtle" color="gray" onClick={onClose}>
							<IconX size={12} />
						</ActionIcon>
					</Tooltip>
				)}
			</Group>

			{/* Iframe content */}
			<Box style={{ flex: 1, minHeight: 0 }}>
				{config.url ? (
					<iframe
						key={`${leafId}-${config.url}`}
						src={config.url}
						title={config.title || config.url}
						sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
						style={{
							width: "100%",
							height: "100%",
							border: "none",
							backgroundColor: "var(--mantine-color-dark-8)",
						}}
					/>
				) : (
					<Group justify="center" align="center" h="100%">
						<Text size="sm" c="dimmed">
							{t("webviewEmpty")}
						</Text>
					</Group>
				)}
			</Box>
		</Box>
	);
}
