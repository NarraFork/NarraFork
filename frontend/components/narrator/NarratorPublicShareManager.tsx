import {
	Alert,
	Badge,
	Button,
	Card,
	Checkbox,
	Divider,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import type { CreatedPublicShare, PublicShareLink } from "@shared/public-narrator-share";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useClipboard } from "../../hooks/useClipboard";
import { useNarratorPublicShares } from "../../hooks/useNarratorPublicShares";
import { authorizedFetch, readFetchError, request } from "../../lib/api/client";
import { formatLocaleDateTime } from "../../lib/intl-format";
import { buildPublicShareUrl } from "../../lib/public-share-api";

export function NarratorPublicShareManager({
	narratorId,
	canManage,
}: {
	narratorId: string;
	canManage: boolean;
}) {
	const { t, i18n } = useTranslation("narrator");
	const links = useNarratorPublicShares(narratorId, canManage);
	const [guestName, setGuestName] = useState("");
	const [label, setLabel] = useState("");
	const [acknowledged, setAcknowledged] = useState(false);
	const [created, setCreated] = useState<{ id: string; url: string } | null>(null);
	const [revoke, setRevoke] = useState<PublicShareLink | null>(null);
	const [pending, setPending] = useState(false);
	const [failed, setFailed] = useState(false);
	const clipboard = useClipboard();
	const lifetime = useRef(new AbortController());
	useEffect(() => {
		const abort = new AbortController();
		lifetime.current = abort;
		return () => abort.abort();
	}, []);
	const root = `/narrators/${encodeURIComponent(narratorId)}/public-shares`;
	if (!canManage) return null;
	async function create() {
		if (!acknowledged || !guestName.trim() || pending || created) return;
		setPending(true);
		setFailed(false);
		const signal = lifetime.current.signal;
		try {
			// Deliberately not useMutation: the once-only secret must not enter the shared
			// mutation cache/devtools or be recoverable after this manager unmounts.
			const result = await request<CreatedPublicShare>(root, {
				method: "POST",
				signal,
				body: JSON.stringify({
					guestName: guestName.trim(),
					...(label.trim() ? { label: label.trim() } : {}),
				}),
			});
			if (signal.aborted) return;
			setCreated({
				id: result.share.id,
				url: buildPublicShareUrl(result.share.id, result.token, window.location.href),
			});
			clipboard.reset();
			setGuestName("");
			setLabel("");
			setAcknowledged(false);
			void links.refetch();
		} catch {
			if (!signal.aborted) setFailed(true);
		} finally {
			if (!signal.aborted) setPending(false);
		}
	}
	async function confirmRevoke() {
		if (!revoke || pending) return;
		setPending(true);
		setFailed(false);
		const signal = lifetime.current.signal;
		try {
			const response = await authorizedFetch(`/api${root}/${encodeURIComponent(revoke.id)}`, {
				method: "DELETE",
				signal,
			});
			if (!response.ok) throw new Error((await readFetchError(response)).message);
			if (signal.aborted) return;
			if (created?.id === revoke.id) setCreated(null);
			setRevoke(null);
			void links.refetch();
		} catch {
			if (!signal.aborted) setFailed(true);
		} finally {
			if (!signal.aborted) setPending(false);
		}
	}
	return (
		<Stack gap="sm">
			<Divider />
			<Text fw={600} size="sm">
				{t("publicShares.title")}
			</Text>
			<Text size="xs" c="dimmed">
				{t("publicShares.distinction")}
			</Text>
			<Alert color="orange">{t("publicShares.disclosure")}</Alert>
			{created ? (
				<Card withBorder padding="sm">
					<Stack gap="xs">
						<Text fw={600} size="sm">
							{t("publicShares.created")}
						</Text>
						<Text size="xs">{t("publicShares.onceOnly")}</Text>
						<Textarea
							readOnly
							value={created.url}
							aria-label={t("publicShares.completeLink")}
							autosize
							maxRows={4}
							onFocus={(event) => event.currentTarget.select()}
						/>
						<Group>
							<Button size="xs" onClick={() => clipboard.copy(created.url)}>
								{t(clipboard.copied ? "publicShares.copied" : "publicShares.copy")}
							</Button>
							<Button
								size="xs"
								variant="subtle"
								onClick={() => {
									setCreated(null);
									clipboard.reset();
								}}
							>
								{t("publicShares.dismiss")}
							</Button>
						</Group>
						{clipboard.error && (
							<Text size="xs" c="red">
								{t("publicShares.copyFailed")}
							</Text>
						)}
					</Stack>
				</Card>
			) : (
				<Stack gap="xs">
					<TextInput
						label={t("publicShares.guestName")}
						description={t("publicShares.fixedIdentity")}
						value={guestName}
						maxLength={64}
						required
						onChange={(event) => setGuestName(event.currentTarget.value)}
						disabled={pending}
					/>
					<TextInput
						label={t("publicShares.label")}
						value={label}
						maxLength={160}
						onChange={(event) => setLabel(event.currentTarget.value)}
						disabled={pending}
					/>
					<Checkbox
						label={t("publicShares.acknowledge")}
						checked={acknowledged}
						onChange={(event) => setAcknowledged(event.currentTarget.checked)}
						disabled={pending}
					/>
					<Button
						size="xs"
						onClick={() => void create()}
						loading={pending && !revoke}
						disabled={!guestName.trim() || !acknowledged}
					>
						{t("publicShares.create")}
					</Button>
				</Stack>
			)}
			{failed && (
				<Text size="xs" c="red" role="alert">
					{t("publicShares.failed")}
				</Text>
			)}
			{links.isLoading && <Loader size="xs" />}
			{links.isError && (
				<Button size="xs" variant="light" onClick={() => void links.refetch()}>
					{t("publicShares.retryList")}
				</Button>
			)}
			{links.data?.pages.every((page) => page.shares.length === 0) && (
				<Text size="xs" c="dimmed">
					{t("publicShares.empty")}
				</Text>
			)}
			{links.data?.pages
				.flatMap((page) => page.shares)
				.map((share) => (
					<Card key={share.id} withBorder padding="xs">
						<Stack gap={4}>
							<Group justify="space-between">
								<Text size="sm" fw={500}>
									{share.guestName}
								</Text>
								<Badge color={share.revokedAt ? "gray" : "teal"} size="xs">
									{t(share.revokedAt ? "publicShares.revoked" : "publicShares.active")}
								</Badge>
							</Group>
							<Text size="xs" c="dimmed">
								{share.label || t("publicShares.noLabel")}
							</Text>
							<Text size="xs" c="dimmed">
								{t("publicShares.createdAt", {
									date: formatLocaleDateTime(share.createdAt, undefined, i18n.resolvedLanguage),
								})}
							</Text>
							{share.revokedAt ? (
								<Text size="xs" c="dimmed">
									{t("publicShares.revokedAt", {
										date: formatLocaleDateTime(share.revokedAt, undefined, i18n.resolvedLanguage),
									})}
								</Text>
							) : (
								<Button
									size="compact-xs"
									color="red"
									variant="subtle"
									style={{ alignSelf: "flex-start" }}
									onClick={() => setRevoke(share)}
									disabled={pending}
								>
									{t("publicShares.revoke")}
								</Button>
							)}
						</Stack>
					</Card>
				))}
			{links.hasNextPage && (
				<Button
					size="xs"
					variant="light"
					loading={links.isFetchingNextPage}
					onClick={() => void links.fetchNextPage()}
				>
					{t("publicShares.loadMore")}
				</Button>
			)}
			<Modal
				opened={!!revoke}
				onClose={() => {
					if (!pending) setRevoke(null);
				}}
				title={t("publicShares.revokeTitle")}
				centered
			>
				<Stack>
					<Text size="sm">
						{t("publicShares.revokeConfirm", {
							name: revoke?.guestName,
							label: revoke?.label || t("publicShares.noLabel"),
						})}
					</Text>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setRevoke(null)} disabled={pending}>
							{t("publicShares.cancel")}
						</Button>
						<Button color="red" loading={pending} onClick={() => void confirmRevoke()}>
							{t("publicShares.revoke")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	);
}
