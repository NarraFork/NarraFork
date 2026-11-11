import { Alert, Badge, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type MemoryCommand,
	useContextMemory,
	useContextMemoryEvents,
	useContextMemoryMutation,
} from "../../hooks/useContextMemories";
import { ApiError } from "../../lib/api";
import { useConfirmDialog } from "../common/confirm-dialog-context";
import { MemoryForm } from "./MemoryForm";

export function MemoryDetailPanel({
	userId,
	id,
	onClose,
}: {
	userId: string;
	id: string;
	onClose: () => void;
}) {
	const { t } = useTranslation("settings");
	const detail = useContextMemory(userId, id);
	const audit = useContextMemoryEvents(userId, id);
	const mutation = useContextMemoryMutation(userId);
	const confirm = useConfirmDialog();
	const [editing, setEditing] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [notice, setNotice] = useState(false);
	const busy = useRef(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const conflict = mutation.error instanceof ApiError && mutation.error.status === 409;
	const disabled = mutation.isPending || confirming || conflict;
	const run = async (command: MemoryCommand) => {
		if (busy.current || conflict) return;
		busy.current = true;
		setNotice(false);
		try {
			if (command.type === "forget") {
				setConfirming(true);
				if (
					!(await confirm({
						title: t("memory.forget"),
						message: t("memory.forgetWarning"),
						confirmLabel: t("memory.forget"),
						confirmColor: "red",
					}))
				)
					return;
			}
			if (!mounted.current) return;
			await mutation.mutateAsync(command);
			if (!mounted.current) return;
			setEditing(false);
			setNotice(true);
			if (command.type === "forget") onClose();
		} catch {
			/* The mutation's error is rendered without claiming success. */
		} finally {
			busy.current = false;
			if (mounted.current) setConfirming(false);
		}
	};
	const reload = async () => {
		setEditing(false);
		setNotice(false);
		mutation.reset();
		await Promise.all([detail.refetch(), audit.refetch()]);
	};
	// A failed/refetching read must not leave a cached private body or draft on screen.
	const memory =
		!detail.isError && !detail.isFetching && detail.isFetchedAfterMount ? detail.data : undefined;
	return (
		<Card withBorder padding="md">
			<Stack>
				<Group justify="space-between">
					<Title order={4}>{t("memory.details")}</Title>
					<Button variant="subtle" onClick={onClose} disabled={mutation.isPending || confirming}>
						{t("memory.close")}
					</Button>
				</Group>
				{detail.isError ? (
					<Alert color="red" role="alert">
						{t("memory.loadError")}
					</Alert>
				) : !memory ? (
					<Text role="status">{t("memory.loading")}</Text>
				) : (
					<>
						<Group>
							<Text fw={600} style={{ overflowWrap: "anywhere" }}>
								{memory.key}
							</Text>
							<Badge>{t(`memory.status.${memory.effectiveStatus}`)}</Badge>
							<Text size="sm">{t("memory.version", { version: memory.version })}</Text>
						</Group>
						<Text size="sm">
							{t("memory.expiry")}: {memory.expiresAt ?? t("memory.never")}
						</Text>
						<Text size="sm" style={{ overflowWrap: "anywhere" }}>
							{t("memory.source")}: {memory.sourceNarratorId ?? t("memory.manualSource")}
							{memory.sourceMessageId ? ` / ${memory.sourceMessageId}` : ""}
						</Text>
						{editing ? (
							<MemoryForm
								key={`${memory.id}:${memory.version}`}
								initial={memory}
								pending={mutation.isPending}
								disabled={conflict}
								onCancel={() => setEditing(false)}
								onSave={({ content, expiresAt }) =>
									void run({
										type: "revise",
										id,
										data: { expectedVersion: memory.version, content, expiresAt },
									})
								}
							/>
						) : (
							<>
								<Text style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
									{memory.content}
								</Text>
								<Group>
									{memory.status === "candidate" && (
										<>
											<Button
												disabled={disabled}
												onClick={() =>
													void run({
														type: "decide",
														id,
														data: { expectedVersion: memory.version, action: "confirm" },
													})
												}
											>
												{t("memory.confirm")}
											</Button>
											<Button
												variant="light"
												disabled={disabled}
												onClick={() =>
													void run({
														type: "decide",
														id,
														data: { expectedVersion: memory.version, action: "reject" },
													})
												}
											>
												{t("memory.reject")}
											</Button>
										</>
									)}
									<Button variant="light" disabled={disabled} onClick={() => setEditing(true)}>
										{t("memory.edit")}
									</Button>
									{memory.status !== "archived" && (
										<Button
											variant="default"
											disabled={disabled}
											onClick={() =>
												void run({
													type: "decide",
													id,
													data: { expectedVersion: memory.version, action: "archive" },
												})
											}
										>
											{t("memory.archive")}
										</Button>
									)}
									<Button
										color="red"
										variant="subtle"
										disabled={disabled}
										onClick={() =>
											void run({ type: "forget", id, expectedVersion: memory.version })
										}
									>
										{t("memory.forget")}
									</Button>
								</Group>
							</>
						)}
					</>
				)}
				{mutation.error && (
					<Alert color="red" role="alert">
						{t(conflict ? "memory.conflict" : "memory.writeError")}
					</Alert>
				)}
				{notice && <Text role="status">{t("memory.saved")}</Text>}
				<Button
					variant="default"
					disabled={mutation.isPending || confirming || detail.isFetching}
					onClick={() => void reload()}
				>
					{t("memory.reload")}
				</Button>
				<Title order={5}>{t("memory.audit")}</Title>
				{audit.isError ? (
					<Alert color="red" role="alert">
						{t("memory.auditError")}
					</Alert>
				) : audit.isFetching || !audit.isFetchedAfterMount ? (
					<Text>{t("memory.loading")}</Text>
				) : (
					audit.data?.map((event) => (
						<Text size="sm" key={event.id} style={{ overflowWrap: "anywhere" }}>
							{t(`memory.action.${event.action}`)} ·{" "}
							{t("memory.version", { version: event.version })} · {event.actorUserId} (
							{t(`memory.actor.${event.actorKind}`)}) · {event.createdAt}
						</Text>
					))
				)}
			</Stack>
		</Card>
	);
}
