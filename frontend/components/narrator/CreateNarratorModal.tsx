import {
	ActionIcon,
	Button,
	Checkbox,
	Group,
	Modal,
	Select,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { IconFolder, IconStar, IconStarFilled, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useCreateFavoriteDirectory,
	useDeleteFavoriteDirectory,
	useFavoriteDirectories,
} from "../../hooks/useFavoriteDirectories";
import { useAllModels } from "../../hooks/useModels";
import { useCreateNarrator } from "../../hooks/useNarrator";
import { usePlatform } from "../../hooks/usePlatform";
import { FOLLOW_DEFAULT_MODEL } from "../../lib/constants";
import { DirectoryPicker } from "../common/DirectoryPicker";

export interface CreateNarratorResult {
	id: string;
	title: string;
	cwd?: string;
	status: string;
}

interface CreateNarratorModalProps {
	opened: boolean;
	onClose: () => void;
	onCreated?: (narrator: CreateNarratorResult) => void;
}

export function CreateNarratorModal({ opened, onClose, onCreated }: CreateNarratorModalProps) {
	const { t } = useTranslation("narrators");
	const platform = usePlatform();
	const createNarrator = useCreateNarrator();
	const { groupedModels } = useAllModels();
	const { data: favorites } = useFavoriteDirectories();
	const addFavorite = useCreateFavoriteDirectory();
	const removeFavorite = useDeleteFavoriteDirectory();

	const [cwd, setCwd] = useState("");
	const [selectedModel, setSelectedModel] = useState("");
	const [startInPlanMode, setStartInPlanMode] = useState(false);

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const isFavorited = favorites?.some((f: any) => f.path === cwd);

	const handleCreate = () => {
		createNarrator.mutate(
			{
				...(cwd ? { cwd } : {}),
				model: selectedModel || FOLLOW_DEFAULT_MODEL,
				...(startInPlanMode ? { permissionMode: "plan" as const } : {}),
			},
			{
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				onSuccess: (data: any) => {
					handleClose();
					onCreated?.({
						id: data.id,
						title: data.title || t("newNarrator"),
						cwd: data.cwd || cwd,
						status: data.status || "idle",
					});
				},
			},
		);
	};

	const handleClose = () => {
		onClose();
		setCwd("");
		setSelectedModel("");
		setStartInPlanMode(false);
	};

	return (
		<Modal opened={opened} onClose={handleClose} title={t("newNarratorModal")}>
			<Stack>
				<Text size="sm" c="dimmed">
					{t("newNarratorDescription")}
				</Text>

				<DirectoryPicker
					label={t("workingDirectory")}
					description={t("workingDirectoryHint")}
					placeholder={
						platform === "windows" ? "E:\\Code\\my-project" : "/home/user/projects/my-project"
					}
					leftSection={<IconFolder size={16} />}
					value={cwd}
					onChange={setCwd}
					rightSectionExtra={
						cwd ? (
							isFavorited ? (
								<IconStarFilled size={16} style={{ color: "var(--mantine-color-yellow-5)" }} />
							) : (
								<Tooltip label={t("addToFavorites")}>
									<ActionIcon
										variant="subtle"
										size="sm"
										onClick={() => addFavorite.mutate({ path: cwd })}
									>
										<IconStar size={16} />
									</ActionIcon>
								</Tooltip>
							)
						) : null
					}
				/>

				{favorites?.length ? (
					<Stack gap="xs">
						<Text size="xs" fw={500} c="dimmed">
							{t("favoriteDirectories")}
						</Text>
						{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
						{favorites.map((fav: any) => (
							<Group key={fav.id} gap="xs" wrap="nowrap">
								<Button
									variant={cwd === fav.path ? "light" : "subtle"}
									size="xs"
									style={{ flex: 1, justifyContent: "flex-start" }}
									onClick={() => setCwd(fav.path)}
								>
									<Text size="xs" truncate>
										{fav.label || fav.path}
									</Text>
								</Button>
								<ActionIcon
									variant="subtle"
									color="red"
									size="xs"
									onClick={() => removeFavorite.mutate(fav.id)}
								>
									<IconX size={14} />
								</ActionIcon>
							</Group>
						))}
					</Stack>
				) : null}

				<Select
					label={t("model")}
					description={t("modelHint")}
					data={groupedModels}
					searchable
					value={selectedModel || FOLLOW_DEFAULT_MODEL}
					onChange={(v) => setSelectedModel(v ?? "")}
					maxDropdownHeight={320}
					comboboxProps={{
						withinPortal: true,
						position: "bottom-start",
						zIndex: 320,
					}}
				/>

				<Checkbox
					label={t("startInPlanMode")}
					description={t("startInPlanModeHint")}
					checked={startInPlanMode}
					onChange={(e) => setStartInPlanMode(e.currentTarget.checked)}
				/>

				<Button onClick={handleCreate} loading={createNarrator.isPending}>
					{t("createNarrator")}
				</Button>
			</Stack>
		</Modal>
	);
}
