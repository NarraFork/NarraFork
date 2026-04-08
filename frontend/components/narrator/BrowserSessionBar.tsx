import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Collapse,
	Group,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	IconCamera,
	IconChevronDown,
	IconChevronRight,
	IconRefresh,
	IconWorldWww,
	IconX,
} from "@tabler/icons-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBrowserSessions, useCloseBrowserSession } from "../../hooks/useBrowserSessions";
import { getToken } from "../../lib/api";

export function BrowserSessionBar({ narratorId }: { narratorId: string }) {
	const { t } = useTranslation("narrator");
	const { data: sessions } = useBrowserSessions(narratorId);
	const [opened, setOpened] = useState(false);

	if (!sessions?.length) return null;

	return (
		<Box
			style={{
				borderTop: "1px solid var(--mantine-color-default-border)",
				flexShrink: 0,
			}}
		>
			<UnstyledButton
				w="100%"
				px="md"
				py={4}
				onClick={() => setOpened((v) => !v)}
				style={{ display: "flex", alignItems: "center" }}
			>
				<Group gap={6} wrap="nowrap" style={{ flex: 1 }}>
					<IconWorldWww size={14} color="var(--mantine-color-teal-5)" />
				<Text size="xs" fw={500} c="teal">
					{t("browser.title")}
				</Text>
					<Badge size="xs" variant="light" color="teal" circle>
						{sessions.length}
					</Badge>
				</Group>
				{opened ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
			</UnstyledButton>
			<Collapse in={opened}>
				<Box px="md" pb="xs">
					{sessions.map((session) => (
						<SessionCard key={session.id} narratorId={narratorId} session={session} />
					))}
				</Box>
			</Collapse>
		</Box>
	);
}

function SessionCard({
	narratorId,
	session,
}: {
	narratorId: string;
	session: { id: string; url: string; lastActivity: number };
}) {
	const { t } = useTranslation("narrator");
	const closeMutation = useCloseBrowserSession();
	const [showScreenshot, setShowScreenshot] = useState(false);
	const [screenshotKey, setScreenshotKey] = useState(0);
	const [imgError, setImgError] = useState(false);

	const token = getToken();
	const screenshotUrl = `/api/narrators/${narratorId}/browser-sessions/${session.id}/screenshot?token=${token}&t=${screenshotKey}`;

	const handleRefresh = useCallback(() => {
		setImgError(false);
		setScreenshotKey((k) => k + 1);
	}, []);

	const handleToggleScreenshot = useCallback(() => {
		setShowScreenshot((v) => {
			if (!v) {
				setImgError(false);
				setScreenshotKey((k) => k + 1);
			}
			return !v;
		});
	}, []);

	const elapsed = Date.now() - session.lastActivity;
	const elapsedLabel =
		elapsed < 60_000
			? "<1m"
			: elapsed < 3600_000
				? `${Math.floor(elapsed / 60_000)}m`
				: `${Math.floor(elapsed / 3600_000)}h`;

	return (
		<Box
			mt={4}
			p="xs"
			style={{
				borderRadius: "var(--mantine-radius-sm)",
				border: "1px solid var(--mantine-color-default-border)",
			}}
		>
			<Group justify="space-between" wrap="nowrap" gap={6}>
				<Box style={{ flex: 1, minWidth: 0 }}>
					<Text size="xs" ff="monospace" truncate title={session.url}>
						{session.url}
					</Text>
					<Group gap={6} mt={2}>
						<Badge size="xs" variant="outline" color="dimmed">
							{session.id.slice(0, 8)}
						</Badge>
						<Text size="xs" c="dimmed">
							{t("browser.lastActive", { time: elapsedLabel })}
						</Text>
					</Group>
				</Box>
				<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
					<Tooltip
						label={showScreenshot ? t("browser.hideScreenshot") : t("browser.screenshotAlt")}
						fz="xs"
					>
						<ActionIcon
							variant="subtle"
							size="sm"
							color={showScreenshot ? "teal" : "gray"}
							onClick={handleToggleScreenshot}
						>
							<IconCamera size={14} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("browser.closeSession")} fz="xs">
						<ActionIcon
							variant="subtle"
							size="sm"
							color="red"
							loading={closeMutation.isPending}
							onClick={() => closeMutation.mutate({ narratorId, sessionId: session.id })}
						>
							<IconX size={14} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Group>
			<Collapse in={showScreenshot}>
				<Box mt="xs">
					{imgError ? (
						<Group gap={6}>
							<Text size="xs" c="red">
								{t("browser.screenshotFailed")}
							</Text>
							<Button
								size="compact-xs"
								variant="subtle"
								leftSection={<IconRefresh size={12} />}
								onClick={handleRefresh}
							>
								{t("browser.refreshScreenshot")}
							</Button>
						</Group>
					) : (
						<>
							<img
								src={screenshotUrl}
								alt={t("browser.screenshotAlt")}
								onError={() => setImgError(true)}
								style={{
									maxWidth: "100%",
									maxHeight: 300,
									borderRadius: "var(--mantine-radius-sm)",
									objectFit: "contain",
									display: "block",
								}}
							/>
							<Button
								size="compact-xs"
								variant="subtle"
								mt={4}
								leftSection={<IconRefresh size={12} />}
								onClick={handleRefresh}
							>
								{t("browser.refreshScreenshot")}
							</Button>
						</>
					)}
				</Box>
			</Collapse>
		</Box>
	);
}
