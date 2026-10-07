import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import type { SwitchWorkingDirectoryRequest } from "@shared/workspace-context";
import { useQuery } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSwitchWorkspaceContext, useWorkspaceContext } from "../../../hooks/useWorkspaceContext";
import { api } from "../../../lib/api";
import { DirectoryPicker } from "../../common/DirectoryPicker";

/** Remains outside the device menu so closing its dropdown cannot discard a switch. */
export function WorkspaceTargetPickerModal({
	narratorId,
	deviceId,
	deviceLabel,
	opened,
	onClose,
}: {
	narratorId: string;
	deviceId: string;
	deviceLabel: string;
	opened: boolean;
	onClose: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const { data: context } = useWorkspaceContext(narratorId);
	const switcher = useSwitchWorkspaceContext(narratorId);
	const remote = useQuery({
		queryKey: ["device", deviceId],
		queryFn: () => api.getDevice(deviceId),
		enabled: opened && deviceId !== "local",
	});
	const settings = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		enabled: opened && deviceId === "local",
	});
	const [cwd, setCwd] = useState("");
	const touched = useRef(false);
	const request = useRef<SwitchWorkingDirectoryRequest | undefined>(undefined);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	useEffect(() => {
		if (!opened) {
			touched.current = false;
			request.current = undefined;
			setCwd("");
			return;
		}
		if (touched.current) return;
		const initial =
			context?.deviceId === deviceId
				? context.cwd
				: deviceId === "local"
					? settings.data?.paths?.defaultProjectDir
					: remote.data?.defaultCwd;
		if (initial) {
			setCwd(initial);
			touched.current = true;
		}
	}, [opened, deviceId, context, settings.data, remote.data]);
	const submit = async () => {
		if (!context || !cwd.trim()) return;
		if (
			!request.current ||
			request.current.target.deviceId !== deviceId ||
			request.current.target.cwd !== cwd.trim()
		)
			request.current = {
				requestId: nanoid(),
				expectedRevision: context.revision,
				target: { deviceId, cwd: cwd.trim() },
			};
		try {
			await switcher.mutateAsync(request.current);
			if (alive.current) onClose();
		} catch {
			/* Surface the original request error; retry keeps its id. */
		}
	};
	return (
		<Modal opened={opened} onClose={onClose} title={t("workspaceSwitch")}>
			<Stack gap="sm">
				<Text size="xs" c="dimmed">
					{deviceLabel}
				</Text>
				{context && (
					<Text size="xs" c="dimmed">
						{t("executionTargetCwd", { cwd: context.cwd })}
					</Text>
				)}
				<DirectoryPicker
					deviceId={deviceId}
					deviceLabel={deviceLabel}
					value={cwd}
					onChange={(value) => {
						touched.current = true;
						setCwd(value);
					}}
					label={t("workspaceDirectory")}
					description={t("workspaceDirectoryConfirm")}
					disabled={switcher.isPending}
				/>
				{switcher.error && <Alert color="red">{switcher.error.message}</Alert>}
				{context?.capabilities.switchDirectory === false && (
					<Alert color="orange">{context.capabilities.reason ?? t("worktree.unsupported")}</Alert>
				)}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose} disabled={switcher.isPending}>
						{tc("cancel")}
					</Button>
					<Button
						onClick={() => void submit()}
						loading={switcher.isPending}
						disabled={
							!context?.capabilities.switchDirectory ||
							!cwd.trim() ||
							(deviceId !== "local" && remote.data?.status !== "online")
						}
					>
						{t("workspaceSwitch")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
