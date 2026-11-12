import {
	Alert,
	Badge,
	Button,
	Card,
	Code,
	Group,
	Loader,
	Modal,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type {
	RemoteAccessInvitation,
	RemoteAccessSettings,
} from "@shared/remote-access/management";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useRemoteAccess } from "../../hooks/useRemoteAccess";
import { remoteAccessApi } from "../../lib/api/remote-access";
import { formatLocaleDateTime } from "../../lib/intl-format";
import { CopyButton } from "../common/CopyButton";
import { useConfirmDialog } from "../common/confirm-dialog-context";

export function RemoteAccessSettingsPanel() {
	const { t } = useTranslation("settings");
	const { data: user, isPending: userPending } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const { status, grants, ready, configure, install, revokeGrant, refresh } =
		useRemoteAccess(isAdmin);
	const confirm = useConfirmDialog();
	const [draft, setDraft] = useState<RemoteAccessSettings | null>(null);
	const [stunText, setStunText] = useState<string | null>(null);
	const [invitation, setInvitation] = useState<RemoteAccessInvitation | null>(null);
	const [pairPending, setPairPending] = useState(false);
	const pairRequest = useRef<AbortController | null>(null);
	const invitationOwner = useRef("");

	// Never carry a one-time secret across logout, account changes or instance replacement.
	useEffect(() => {
		const owner = `${user?.id ?? ""}:${status.data?.instanceId ?? ""}`;
		if (invitationOwner.current !== owner) {
			invitationOwner.current = owner;
			setInvitation(null);
			setPairPending(false);
		}
		return () => {
			pairRequest.current?.abort();
			pairRequest.current = null;
		};
	}, [user?.id, status.data?.instanceId]);

	const reportError = (error: unknown) => {
		if (error instanceof Error && error.name === "AbortError") return;
		notifications.show({
			color: "red",
			message: error instanceof Error ? error.message : t("remoteAccess.operationFailed"),
		});
	};

	const createInvitation = async () => {
		if (!ready || pairRequest.current) return;
		const request = new AbortController();
		pairRequest.current = request;
		setPairPending(true);
		try {
			const result = await remoteAccessApi.createInvitation(request.signal);
			if (!request.signal.aborted) setInvitation(result.invitation);
		} catch (error) {
			reportError(error);
		} finally {
			if (pairRequest.current === request) {
				pairRequest.current = null;
				setPairPending(false);
			}
		}
	};

	const cancelInvitation = async () => {
		if (!invitation || pairRequest.current) return;
		const request = new AbortController();
		pairRequest.current = request;
		setPairPending(true);
		try {
			await remoteAccessApi.cancelInvitation(invitation.pairId, request.signal);
			if (!request.signal.aborted) {
				setInvitation(null);
				notifications.show({ color: "green", message: t("remoteAccess.invitationCancelled") });
			}
		} catch (error) {
			reportError(error);
		} finally {
			if (pairRequest.current === request) {
				pairRequest.current = null;
				setPairPending(false);
			}
		}
	};

	if (userPending || (isAdmin && status.isPending)) return <Loader size="sm" />;
	if (!isAdmin) return <Alert color="yellow">{t("remoteAccess.adminOnly")}</Alert>;
	if (!status.data)
		return (
			<Stack>
				<Alert color="red">{t("remoteAccess.loadFailed")}</Alert>
				<Button variant="light" onClick={() => void status.refetch()}>
					{t("remoteAccess.refresh")}
				</Button>
			</Stack>
		);

	const current = status.data;
	const config = draft ?? current.config;
	const busy = configure.isPending || install.isPending;
	const updateDraft = (patch: Partial<RemoteAccessSettings>) => setDraft({ ...config, ...patch });

	return (
		<Stack gap="lg">
			<Group justify="space-between">
				<Title order={3}>{t("remoteAccessSection")}</Title>
				<Badge color={ready ? "green" : current.state === "failed" ? "red" : "gray"}>
					{t(`remoteAccess.state.${current.state}`)}
				</Badge>
			</Group>
			<Text size="sm">{t("remoteAccess.description")}</Text>
			<Alert color="blue">{t("remoteAccess.scope")}</Alert>
			{current.lastError && <Alert color="red">{current.lastError}</Alert>}
			{status.isError && <Alert color="yellow">{t("remoteAccess.loadFailed")}</Alert>}
			<Card withBorder>
				<Stack>
					<Text fw={600}>{t("remoteAccess.component")}</Text>
					<Text size="sm" c="dimmed">
						{t("remoteAccess.installHelp")}
					</Text>
					{current.componentVersion && (
						<Text size="sm">
							{t("remoteAccess.version", { version: current.componentVersion })}
						</Text>
					)}
					<Group>
						<Button
							variant="light"
							loading={install.isPending}
							disabled={busy || current.installed}
							onClick={async () => {
								if (await confirm({ message: t("remoteAccess.installConfirm") })) install.mutate();
							}}
						>
							{t("remoteAccess.install")}
						</Button>
						<Button variant="subtle" onClick={() => void refresh()}>
							{t("remoteAccess.refresh")}
						</Button>
					</Group>
				</Stack>
			</Card>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					try {
						await configure.mutateAsync({
							...config,
							signalUrl: config.signalUrl.trim(),
							stunUrls: (stunText ?? config.stunUrls.join("\n"))
								.split(/\r?\n/)
								.map((value) => value.trim())
								.filter(Boolean),
						});
						setDraft(null);
						setStunText(null);
					} catch {
						// Mutation owns error notification; keep unsaved input for correction.
					}
				}}
			>
				<Stack>
					<Switch
						label={t("remoteAccess.enabled")}
						description={t("remoteAccess.enabledHelp")}
						checked={config.enabled}
						disabled={busy}
						onChange={(event) => updateDraft({ enabled: event.currentTarget.checked })}
					/>
					<TextInput
						label={t("remoteAccess.signalUrl")}
						description={t("remoteAccess.signalUrlHelp")}
						value={config.signalUrl}
						maxLength={4096}
						disabled={busy}
						onChange={(event) => updateDraft({ signalUrl: event.currentTarget.value })}
					/>
					<Textarea
						label={t("remoteAccess.stunUrls")}
						description={t("remoteAccess.stunUrlsHelp")}
						value={stunText ?? config.stunUrls.join("\n")}
						maxLength={8192}
						minRows={2}
						disabled={busy}
						onChange={(event) => setStunText(event.currentTarget.value)}
					/>
					<Group>
						<Button type="submit" loading={configure.isPending} disabled={busy}>
							{t("remoteAccess.save")}
						</Button>
					</Group>
				</Stack>
			</form>
			{current.instanceId && (
				<Stack gap="xs">
					<Text size="sm">{t("remoteAccess.instanceId")}</Text>
					<Code style={{ overflowWrap: "anywhere" }}>{current.instanceId}</Code>
					<Text size="sm">{t("remoteAccess.connections", { count: current.peers })}</Text>
				</Stack>
			)}
			<Group>
				<Button
					disabled={!ready || busy}
					loading={pairPending}
					onClick={() => void createInvitation()}
				>
					{t("remoteAccess.createInvitation")}
				</Button>
			</Group>
			<Stack>
				<Title order={4}>{t("remoteAccess.grants")}</Title>
				{grants.isError && <Alert color="red">{t("remoteAccess.operationFailed")}</Alert>}
				{ready && grants.isPending && <Loader size="xs" />}
				{ready && grants.data?.grants.length === 0 && (
					<Text size="sm" c="dimmed">
						{t("remoteAccess.noGrants")}
					</Text>
				)}
				{ready &&
					grants.data?.grants.map((grant) => (
						<Card key={grant.id} withBorder>
							<Group justify="space-between">
								<Stack gap={4}>
									<Code>{grant.id}</Code>
									<Text size="xs" c="dimmed">
										{t("remoteAccess.expiresAt", {
											time: formatLocaleDateTime(grant.expiresAt * 1000),
										})}
									</Text>
								</Stack>
								<Button
									color="red"
									variant="light"
									disabled={grant.revoked || revokeGrant.isPending}
									onClick={async () => {
										if (
											await confirm({
												message: t("remoteAccess.revokeConfirm"),
												confirmColor: "red",
											})
										)
											revokeGrant.mutate(grant.id);
									}}
								>
									{t("remoteAccess.revoke")}
								</Button>
							</Group>
						</Card>
					))}
			</Stack>
			<Modal
				opened={invitation !== null}
				onClose={() => setInvitation(null)}
				title={t("remoteAccess.invitation")}
				size="lg"
			>
				{invitation && (
					<Stack>
						<Alert color="yellow">{t("remoteAccess.invitationHelp")}</Alert>
						<Text size="sm">
							{t("remoteAccess.expiresAt", {
								time: formatLocaleDateTime(invitation.expiresAt * 1000),
							})}
						</Text>
						<Textarea
							value={JSON.stringify(invitation, null, 2)}
							readOnly
							autoComplete="off"
							minRows={8}
							aria-label={t("remoteAccess.invitation")}
						/>
						<Group>
							<CopyButton value={JSON.stringify(invitation)}>
								{({ copy, copied }) => (
									<Button onClick={copy}>
										{t(copied ? "remoteAccess.copied" : "remoteAccess.copyInvitation")}
									</Button>
								)}
							</CopyButton>
							<Button
								color="red"
								variant="light"
								loading={pairPending}
								onClick={() => void cancelInvitation()}
							>
								{t("remoteAccess.cancelInvitation")}
							</Button>
							<Button variant="subtle" onClick={() => setInvitation(null)}>
								{t("remoteAccess.closeInvitation")}
							</Button>
						</Group>
					</Stack>
				)}
			</Modal>
		</Stack>
	);
}
