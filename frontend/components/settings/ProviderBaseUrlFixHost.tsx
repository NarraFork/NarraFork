import { Button, Code, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { readSession, writeSession } from "../../lib/session-store";

interface BaseUrlFixDetail {
	providerId: string;
	providerPrefix: string;
	providerName: string;
	currentBaseUrl: string;
	suggestedBaseUrl: string;
}

/** Session-store id for provider IDs the user already dismissed this session. */
const DISMISSED_ID = "baseurl-fix-dismissed";

function readDismissed(): Set<string> {
	try {
		const raw = readSession("ui-flag", DISMISSED_ID);
		return new Set(raw ? (JSON.parse(raw) as string[]) : []);
	} catch {
		return new Set();
	}
}

function persistDismissed(ids: Set<string>): void {
	writeSession("ui-flag", DISMISSED_ID, JSON.stringify([...ids]));
}

/**
 * Global host that prompts the user to permanently append `/v1` to a provider's
 * base URL after the backend detected (and auto-recovered from) a misconfigured
 * URL at runtime. Triggered by the `narrafork:provider-baseurl-fix` window event
 * dispatched from the narrator WS manager.
 */
export function ProviderBaseUrlFixHost() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const [opened, setOpened] = useState(false);
	const [detail, setDetail] = useState<BaseUrlFixDetail | null>(null);
	const dismissedRef = useRef<Set<string>>(readDismissed());

	const fix = useMutation({
		mutationFn: (providerId: string) => api.fixProviderBaseUrl(providerId),
		onSuccess: async (_data, providerId) => {
			await qc.invalidateQueries({ queryKey: ["settings"] });
			dismissedRef.current.add(providerId);
			persistDismissed(dismissedRef.current);
			notifications.show({
				color: "green",
				message: t("baseUrlFixSuccess"),
			});
			setOpened(false);
		},
		onError: (err) => {
			notifications.show({
				color: "red",
				message: err instanceof Error ? err.message : String(err),
			});
		},
	});

	useEffect(() => {
		const handle = (e: Event) => {
			const d = (e as CustomEvent).detail as BaseUrlFixDetail | undefined;
			if (!d?.providerId || !d.suggestedBaseUrl) return;
			if (dismissedRef.current.has(d.providerId)) return;
			setDetail(d);
			setOpened(true);
		};
		window.addEventListener("narrafork:provider-baseurl-fix", handle);
		return () => window.removeEventListener("narrafork:provider-baseurl-fix", handle);
	}, []);

	const handleClose = useCallback(() => {
		if (detail) {
			dismissedRef.current.add(detail.providerId);
			persistDismissed(dismissedRef.current);
		}
		setOpened(false);
	}, [detail]);

	const handleConfirm = useCallback(() => {
		if (detail) fix.mutate(detail.providerId);
	}, [detail, fix]);

	if (!opened || !detail) return null;

	return (
		<Modal opened={opened} onClose={handleClose} title={t("baseUrlFixTitle")} centered size="md">
			<Stack gap="md">
				<Text size="sm" c="dimmed">
					{t("baseUrlFixDescription", { provider: detail.providerName })}
				</Text>
				<Stack gap={4}>
					<Text size="xs" c="dimmed">
						{t("baseUrlFixCurrent")}
					</Text>
					<Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
						{detail.currentBaseUrl}
					</Code>
					<Text size="xs" c="dimmed">
						{t("baseUrlFixSuggested")}
					</Text>
					<Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
						{detail.suggestedBaseUrl}
					</Code>
				</Stack>
				<Group justify="flex-end">
					<Button variant="default" onClick={handleClose}>
						{t("baseUrlFixDismiss")}
					</Button>
					<Button onClick={handleConfirm} loading={fix.isPending}>
						{t("baseUrlFixConfirm")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
