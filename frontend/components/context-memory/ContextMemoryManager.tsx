import {
	Alert,
	Badge,
	Button,
	Card,
	Group,
	NativeSelect,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useContextMemories, useContextMemoryMutation } from "../../hooks/useContextMemories";
import { ApiError } from "../../lib/api";
import type { MemoryDraft, MemoryScope } from "../../lib/api/context-memory";
import { MemoryDetailPanel } from "./MemoryDetailPanel";
import { MemoryForm } from "./MemoryForm";

export function ContextMemoryManager({ userId }: { userId: string }) {
	return userId ? <MemoryScopes key={userId} userId={userId} /> : null;
}
function MemoryScopes({ userId }: { userId: string }) {
	const { t } = useTranslation("settings");
	const [kind, setKind] = useState<MemoryScope["kind"]>("user");
	const [scopeId, setScopeId] = useState("");
	const [scope, setScope] = useState<MemoryScope>({ kind: "user" });
	return (
		<Stack>
			<Title order={3}>{t("memorySection")}</Title>
			<Text size="sm" c="dimmed">
				{t("memory.description")}
			</Text>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (kind === "user") setScope({ kind });
					else if (scopeId.trim()) setScope({ kind, id: scopeId.trim() });
				}}
			>
				<Stack gap="sm">
					<NativeSelect
						name="scope"
						label={t("memory.scope")}
						value={kind}
						onChange={(event) => setKind(event.currentTarget.value as MemoryScope["kind"])}
						data={["user", "project", "session"].map((value) => ({
							value,
							label: t(`memory.scope_${value}`),
						}))}
					/>
					{kind !== "user" && (
						<TextInput
							name="scopeId"
							label={t("memory.scopeId")}
							description={t("memory.scopeIdHint")}
							required
							maxLength={128}
							value={scopeId}
							onChange={(event) => setScopeId(event.currentTarget.value)}
						/>
					)}
					<Button type="submit" variant="default" disabled={kind !== "user" && !scopeId.trim()}>
						{t("memory.loadScope")}
					</Button>
				</Stack>
			</form>
			<MemoryList key={JSON.stringify(scope)} userId={userId} scope={scope} />
		</Stack>
	);
}
function MemoryList({ userId, scope }: { userId: string; scope: MemoryScope }) {
	const { t } = useTranslation("settings");
	const [cursor, setCursor] = useState<string>();
	const [selected, setSelected] = useState<string>();
	const [creating, setCreating] = useState(false);
	const query = useContextMemories(userId, scope, cursor);
	const create = useContextMemoryMutation(userId);
	const busy = useRef(false);
	const save = async (data: MemoryDraft & { key: string }) => {
		if (busy.current) return;
		busy.current = true;
		try {
			await create.mutateAsync({ type: "propose", data: { ...data, scope } });
			setCreating(false);
			setCursor(undefined);
		} catch {
			/* Keep the draft and show the error. */
		} finally {
			busy.current = false;
		}
	};
	const page =
		!query.isError && !query.isFetching && query.isFetchedAfterMount ? query.data : undefined;
	return (
		<Stack>
			<Group justify="space-between">
				<Text fw={600}>
					{t(`memory.scope_${scope.kind}`)}
					{scope.kind !== "user" ? `: ${scope.id}` : ""}
				</Text>
				<Button
					onClick={() => {
						setSelected(undefined);
						create.reset();
						setCreating(true);
					}}
				>
					{t("memory.new")}
				</Button>
			</Group>
			{creating && (
				<Card withBorder padding="md">
					<Stack>
						<Text size="sm">{t("memory.candidateHint")}</Text>
						<MemoryForm
							pending={create.isPending}
							onSave={(draft) => void save(draft)}
							onCancel={() => setCreating(false)}
						/>
						{create.error && (
							<Alert color="red" role="alert">
								{t(
									create.error instanceof ApiError && create.error.status === 409
										? "memory.keyConflict"
										: "memory.writeError",
								)}
							</Alert>
						)}
					</Stack>
				</Card>
			)}
			{query.isError ? (
				<Alert color="red" role="alert">
					{t("memory.listError")}
					<Button variant="subtle" onClick={() => void query.refetch()}>
						{t("memory.retry")}
					</Button>
				</Alert>
			) : !page ? (
				<Text role="status">{t("memory.loading")}</Text>
			) : (
				<>
					{page.items.length === 0 && <Text c="dimmed">{t("memory.empty")}</Text>}
					{page.items.map((memory) => (
						<Card withBorder padding="md" key={memory.id}>
							<Stack gap="xs">
								<Group justify="space-between">
									<Text fw={600} style={{ overflowWrap: "anywhere" }}>
										{memory.key}
									</Text>
									<Badge>{t(`memory.status.${memory.effectiveStatus}`)}</Badge>
								</Group>
								<Text size="sm" style={{ overflowWrap: "anywhere" }}>
									{memory.excerpt}
								</Text>
								<Text size="xs" c="dimmed">
									{t("memory.version", { version: memory.version })} · {memory.updatedAt}
								</Text>
								<Button
									variant="light"
									onClick={() => {
										setCreating(false);
										setSelected(memory.id);
									}}
								>
									{t("memory.review")}
								</Button>
							</Stack>
						</Card>
					))}
					<Group>
						<Button
							variant="default"
							disabled={!cursor}
							onClick={() => {
								setCursor(undefined);
								setSelected(undefined);
							}}
						>
							{t("memory.firstPage")}
						</Button>
						<Button
							variant="default"
							disabled={!page.nextCursor}
							onClick={() => {
								setCursor(page.nextCursor ?? undefined);
								setSelected(undefined);
							}}
						>
							{t("memory.nextPage")}
						</Button>
					</Group>
				</>
			)}
			{selected && (
				<MemoryDetailPanel
					key={selected}
					userId={userId}
					id={selected}
					onClose={() => setSelected(undefined)}
				/>
			)}
		</Stack>
	);
}
