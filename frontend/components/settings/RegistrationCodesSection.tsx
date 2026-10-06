import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Code,
	Group,
	Modal,
	NumberInput,
	Paper,
	Select,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { IconBan, IconCheck, IconCopy, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CreatedRegistrationCode, RegistrationCode } from "../../lib/api";
import { api } from "../../lib/api";
import { formatLocaleDate } from "../../lib/intl-format";
import { CopyButton } from "../common/CopyButton";
import { useConfirmDialog } from "../common/confirm-dialog-context";

const DEFAULT_EXPIRY_HOURS = 168;

const STATUS_COLORS: Record<RegistrationCode["status"], string> = {
	active: "teal",
	used: "gray",
	revoked: "red",
	expired: "yellow",
};

/**
 * Issue and manage single-use registration codes.
 *
 * A code lets one person self-register (choosing their own password) even while
 * public registration is closed. The plaintext is shown once, right after
 * creation — the server only keeps its hash, so it cannot be displayed again.
 */
export function RegistrationCodesSection() {
	const { t } = useTranslation("common");
	const qc = useQueryClient();
	const confirm = useConfirmDialog();

	const [formOpen, setFormOpen] = useState(false);
	const [note, setNote] = useState("");
	const [role, setRole] = useState<"admin" | "user">("user");
	const [boundUsername, setBoundUsername] = useState("");
	const [expiresInHours, setExpiresInHours] = useState<number>(DEFAULT_EXPIRY_HOURS);
	const [issued, setIssued] = useState<CreatedRegistrationCode | null>(null);

	const { data } = useQuery({
		queryKey: ["admin", "registrationCodes"],
		queryFn: api.listRegistrationCodes,
	});

	const invalidate = () => qc.invalidateQueries({ queryKey: ["admin", "registrationCodes"] });

	const createCode = useMutation({
		mutationFn: api.createRegistrationCode,
		onSuccess: (created) => {
			setIssued(created);
			setFormOpen(false);
			setNote("");
			setBoundUsername("");
			invalidate();
		},
	});
	const revokeCode = useMutation({ mutationFn: api.revokeRegistrationCode, onSuccess: invalidate });
	const deleteCode = useMutation({ mutationFn: api.deleteRegistrationCode, onSuccess: invalidate });

	const codes = data?.codes ?? [];

	return (
		<Paper withBorder p="md">
			<Stack>
				<Group justify="space-between">
					<Title order={4}>{t("registrationCodes")}</Title>
					<Button
						size="compact-sm"
						leftSection={<IconPlus size={14} />}
						onClick={() => setFormOpen(true)}
					>
						{t("issueRegistrationCode")}
					</Button>
				</Group>
				<Text size="sm" c="dimmed">
					{t("registrationCodesDescription")}
				</Text>

				{codes.length === 0 ? (
					<Text c="dimmed">{t("noRegistrationCodes")}</Text>
				) : (
					<Table>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>{t("codeNote")}</Table.Th>
								<Table.Th>{t("role")}</Table.Th>
								<Table.Th>{t("codeStatusColumn")}</Table.Th>
								<Table.Th>{t("codeExpiresAt")}</Table.Th>
								<Table.Th>{t("codeUsedBy")}</Table.Th>
								<Table.Th>{t("actions")}</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{codes.map((code) => (
								<Table.Tr key={code.id}>
									<Table.Td>
										<Text size="sm">{code.note || "—"}</Text>
										{code.boundUsername && (
											<Text size="xs" c="dimmed">
												{t("boundToUsername", { username: code.boundUsername })}
											</Text>
										)}
									</Table.Td>
									<Table.Td>
										<Badge color={code.role === "admin" ? "indigo" : "gray"}>{code.role}</Badge>
									</Table.Td>
									<Table.Td>
										<Badge color={STATUS_COLORS[code.status]}>
											{t(`codeStatus_${code.status}`)}
										</Badge>
									</Table.Td>
									<Table.Td>
										<Text size="sm">{formatLocaleDate(code.expiresAt)}</Text>
									</Table.Td>
									<Table.Td>
										<Text size="sm">{code.usedByUsername || "—"}</Text>
									</Table.Td>
									<Table.Td>
										<Group gap="xs">
											{code.status === "active" && (
												<ActionIcon
													color="orange"
													variant="subtle"
													title={t("revokeCode")}
													loading={revokeCode.isPending}
													onClick={() => revokeCode.mutate(code.id)}
												>
													<IconBan size={16} />
												</ActionIcon>
											)}
											<ActionIcon
												color="red"
												variant="subtle"
												title={t("delete")}
												loading={deleteCode.isPending}
												onClick={async () => {
													if (await confirm({ message: t("confirmDeleteRegistrationCode") })) {
														deleteCode.mutate(code.id);
													}
												}}
											>
												<IconTrash size={16} />
											</ActionIcon>
										</Group>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				)}
			</Stack>

			<Modal
				opened={formOpen}
				onClose={() => setFormOpen(false)}
				title={t("issueRegistrationCode")}
			>
				<Stack>
					<TextInput
						label={t("codeNote")}
						description={t("codeNoteHint")}
						value={note}
						onChange={(e) => setNote(e.currentTarget.value)}
					/>
					<Select
						label={t("role")}
						value={role}
						data={[
							{ value: "user", label: t("roleUser") },
							{ value: "admin", label: t("roleAdmin") },
						]}
						onChange={(value) => setRole(value === "admin" ? "admin" : "user")}
						allowDeselect={false}
					/>
					<TextInput
						label={t("bindUsernameOptional")}
						description={t("bindUsernameHint")}
						value={boundUsername}
						onChange={(e) => setBoundUsername(e.currentTarget.value)}
					/>
					<NumberInput
						label={t("expiresInHours")}
						min={1}
						max={8760}
						value={expiresInHours}
						onChange={(value) =>
							setExpiresInHours(typeof value === "number" ? value : DEFAULT_EXPIRY_HOURS)
						}
					/>
					{createCode.isError && <Alert color="red">{(createCode.error as Error).message}</Alert>}
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setFormOpen(false)}>
							{t("cancel")}
						</Button>
						<Button
							loading={createCode.isPending}
							onClick={() =>
								createCode.mutate({
									note: note.trim() || undefined,
									role,
									username: boundUsername.trim() || undefined,
									expiresInHours,
								})
							}
						>
							{t("create")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			<Modal opened={!!issued} onClose={() => setIssued(null)} title={t("registrationCodeIssued")}>
				<Stack>
					<Alert color="yellow">{t("registrationCodeShownOnce")}</Alert>
					<Code block>{issued?.code}</Code>
					<Group justify="flex-end">
						{issued && (
							<CopyButton value={issued.code}>
								{({ copied, copy }) => (
									<Button
										variant="light"
										leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
										onClick={copy}
									>
										{copied ? t("copied") : t("copy")}
									</Button>
								)}
							</CopyButton>
						)}
						<Button onClick={() => setIssued(null)}>{t("codeIssuedDone")}</Button>
					</Group>
				</Stack>
			</Modal>
		</Paper>
	);
}
