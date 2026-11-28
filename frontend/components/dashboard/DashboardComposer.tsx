import { ActionIcon, Box, Button, Group, Select, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { composerDocumentText, parseComposerDocument } from "@shared/composer-document";
import {
	IconAdjustmentsHorizontal,
	IconDevices,
	IconFolder,
	IconPaperclip,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useCreateNarrator } from "../../hooks/useNarrator";
import {
	useNarratorPermissionsCapability,
	useNarratorPlanModeCapability,
} from "../../hooks/usePlatform";
import { useProjectDirStatus } from "../../hooks/useProjectDirStatus";
import { addRecentTab } from "../../hooks/useRecentTabs";
import { useRuntimeSettings } from "../../hooks/useRuntimeSettings";
import { useWorkspaceDevices } from "../../hooks/useWorkspaceContext";
import { api, isAbortError } from "../../lib/api";
import { getAuthSnapshot } from "../../lib/api/client";
import { REMOTE_BUILD } from "../../lib/build-target";
import { FOLLOW_DEFAULT_MODEL } from "../../lib/constants";
import {
	subscribeDashboardComposerFocus,
	takeDashboardComposerFocusRequest,
} from "../../lib/dashboard-composer-focus";
import { getRecentTabsScope, type RecentTabsScope } from "../../lib/recent-tabs-owner";
import { DeviceDirectoryModal } from "../common/DeviceDirectoryPicker";
import { deviceSelectData, LOCAL_DEVICE } from "../common/device-directory-options";
import {
	CreateNarratorLazyModal,
	preloadCreateNarratorModal,
} from "../narrator/CreateNarratorLazyModal";
import type { CreateNarratorResult } from "../narrator/CreateNarratorModal";
import { hasSendableComposerContent } from "../narrator/composer/composer-send-gate";
import { trimFileReferenceInput } from "../narrator/composer/file-reference-input";
import {
	NarratorComposer,
	type NarratorComposerHandle,
} from "../narrator/composer/NarratorComposer";
import { DropOverlay } from "../narrator/interaction/DropOverlay";
import { PermissionModePickerMenu } from "../narrator/interaction/PermissionModePickerMenu";
import { UploadProgressBar } from "../narrator/interaction/UploadProgressBar";
import { useComposerAttachments } from "../narrator/interaction/use-composer-attachments";
import { useComposerFileIngest } from "../narrator/interaction/use-composer-file-ingest";
import { displayReasoningEffort } from "../narrator/interaction/use-model-selection";
import {
	type NarratorSendingState,
	snapshotComposerFiles,
} from "../narrator/interaction/use-narrator-send";
import { ModelPickerMenu } from "../narrator/model/ModelPickerMenu";
import { ReasoningEffortPickerMenu } from "../narrator/model/ReasoningEffortPickerMenu";
import { useDraftReasoningEffort } from "../narrator/model/use-draft-reasoning-effort";
import { directoryLabel } from "./dashboard-sessions";

/**
 * Local key for the dashboard composer's draft, input history and staged
 * attachments. It names no narrator: the composer runs in draft mode, so nothing
 * is ever sent to the server under it.
 */
export const DASHBOARD_COMPOSER_KEY = "dashboard-composer";
const COMPOSER_PREFS_KEY = "narrafork_dashboard_composer";

interface ComposerPrefs {
	cwd?: string;
	/** Execution device for the session created here; absent = this server. */
	deviceId?: string;
	model?: string;
	/** Explicit thinking tier for sessions created here; absent = instance default. */
	reasoningEffort?: string | null;
	/** Explicit permission mode; absent = instance default. */
	permissionMode?: string | null;
	/** Explicit plan-mode start; absent = instance default. */
	startInPlanMode?: boolean | null;
}

function readPrefs(): ComposerPrefs {
	try {
		const raw = localStorage.getItem(COMPOSER_PREFS_KEY);
		const parsed = raw ? JSON.parse(raw) : null;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writePrefs(prefs: ComposerPrefs) {
	try {
		localStorage.setItem(COMPOSER_PREFS_KEY, JSON.stringify(prefs));
	} catch {
		// Private mode / blocked storage: the selection just isn't remembered.
	}
}

/**
 * The dashboard's entry point: the narrator composer (slash commands, skills,
 * pasted images and files, input history) without a session behind it. Sending
 * creates a standalone session in the chosen directory with the chosen model,
 * delivers the message as its first turn, and opens it.
 */
export function DashboardComposer() {
	const { t } = useTranslation("dashboard");
	const { t: tc } = useTranslation("common");
	const { t: tn } = useTranslation("narrator");
	const { t: tns } = useTranslation("narrators");
	const navigate = useNavigate();
	const createNarrator = useCreateNarrator();
	const { data: currentUser } = useCurrentUser();
	const currentUserId = currentUser?.id ? String(currentUser.id) : null;
	const projectDir = useProjectDirStatus();

	const [prefs] = useState(readPrefs);
	// `null` = never chosen on this device: follow the instance default directory.
	const [chosenCwd, setChosenCwd] = useState<string | null>(prefs.cwd || null);
	// `local` = this server. A remote id makes `cwd` a path on THAT machine, so the local
	// picker (favorites, drives, mkdir) does not apply there.
	const [chosenDeviceId, setChosenDeviceId] = useState<string>(prefs.deviceId || LOCAL_DEVICE);
	const [model, setModel] = useState(prefs.model || FOLLOW_DEFAULT_MODEL);
	// Same "null = follow the instance default" rule for the create-time session
	// options, so an untouched composer behaves exactly like a session created
	// without them (the server then applies its own defaults).
	const [reasoningEffortOverride, setReasoningEffortOverride] = useState<string | null>(
		prefs.reasoningEffort ?? null,
	);
	const [permissionModeOverride, setPermissionModeOverride] = useState<string | null>(
		prefs.permissionMode ?? null,
	);
	const [startInPlanModeOverride, setStartInPlanModeOverride] = useState<boolean | null>(
		prefs.startInPlanMode ?? null,
	);
	// Share the bounded instance-default projection with the draft model controls.
	const { data: settingsData } = useRuntimeSettings();
	const draftReasoning = useDraftReasoningEffort(model);
	// Show what the created session will actually get: the user's choice clamped
	// onto the selected model's tiers, or the instance default when untouched.
	const reasoningEffort = reasoningEffortOverride
		? displayReasoningEffort(reasoningEffortOverride, draftReasoning.options)
		: draftReasoning.defaultEffort;
	const permissionModesCapability = useNarratorPermissionsCapability();
	const availablePermissionModes = permissionModesCapability.supported
		? permissionModesCapability.modes
		: [];
	const permissionModesUnavailableReason = permissionModesCapability.supported
		? undefined
		: (permissionModesCapability.reason ?? tn("permissionModesUnavailable"));
	const permissionMode =
		permissionModeOverride ?? settingsData?.agent?.defaultPermissionMode ?? "default";
	const permissionModeKnown =
		permissionModeOverride != null || settingsData?.agent?.defaultPermissionMode != null;
	const planModeCapability = useNarratorPlanModeCapability();
	const startInPlanMode =
		startInPlanModeOverride ?? settingsData?.agent?.defaultStartInPlanMode ?? false;
	// Only send the plan-mode flag once we know what the toggle is showing. Before
	// settings land the local `false` could silently override an instance default of
	// `true`; omitting the field lets the server apply that default instead.
	const startInPlanModeKnown =
		startInPlanModeOverride != null || settingsData?.agent?.defaultStartInPlanMode != null;
	// Persisted selections, merged so saving one field never drops the others.
	const prefsRef = useRef<ComposerPrefs>(prefs);
	const savePrefs = (patch: ComposerPrefs) => {
		prefsRef.current = { ...prefsRef.current, ...patch };
		writePrefs(prefsRef.current);
	};
	const [browseOpen, setBrowseOpen] = useState(false);
	const isRemoteDevice = chosenDeviceId !== LOCAL_DEVICE;
	// A remote session runs in a directory on THAT machine: this server's default project
	// directory must never be offered as its working directory.
	const cwd = isRemoteDevice ? (chosenCwd ?? "") : (chosenCwd ?? projectDir.usablePath ?? "");
	// Nothing chosen and the default is unset or gone, or a remote device without a
	// directory yet: the server would refuse the session, so ask instead of failing.
	const directoryRequired = isRemoteDevice ? !cwd.trim() : !chosenCwd && projectDir.needsChoice;
	// Resolved on mount, not on demand: the device selector IS the affordance that makes
	// a remote target discoverable here, so it must know the devices before the first
	// click. The list is small and device connectivity changes slowly.
	const devicesQuery = useWorkspaceDevices(null, !REMOTE_BUILD);
	const remoteDevices = (devicesQuery.data?.devices ?? []).filter(
		(device) => device.id !== LOCAL_DEVICE,
	);
	const selectedDevice = remoteDevices.find((device) => device.id === chosenDeviceId);
	// Keep the menu when a remembered remote id has left the list. Hiding it then
	// leaves the warning with no control that can choose this server. Wait for a
	// resolved list, so a request still in flight does not look like "local only".
	const deviceSelectionAvailable =
		!REMOTE_BUILD &&
		(remoteDevices.length > 0 || (devicesQuery.isSuccess === true && isRemoteDevice));
	// A persisted device that is gone or offline must never silently become the local
	// one: that would create the session on the wrong machine, in a directory this server
	// happens to have. Block the send and say so instead.
	const deviceUnavailable =
		isRemoteDevice && devicesQuery.isSuccess === true && !selectedDevice?.online;
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const advancedScope = useRef<RecentTabsScope | null>(null);
	const [hasText, setHasText] = useState(false);
	const [sendingState, setSendingState] = useState<NarratorSendingState | null>(null);
	const composerRef = useRef<NarratorComposerHandle>(null);
	// The sidebar's "New session" asks for the cursor here, before or after this mounts.
	useEffect(() => {
		const take = () => {
			if (takeDashboardComposerFocusRequest()) composerRef.current?.focus();
		};
		take();
		return subscribeDashboardComposerFocus(take);
	}, []);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const sendingRef = useRef(false);
	const sendAbortRef = useRef<AbortController | null>(null);
	// A session created by a send whose message then failed. Retrying reuses it
	// instead of leaving an empty session behind per attempt.
	const pendingSessionRef = useRef<{
		session: CreateNarratorResult;
		authGeneration: number;
	} | null>(null);

	const {
		attachedImages,
		attachedTextFiles,
		attachedMedia,
		attachedMediaRef,
		attachmentsHydrating,
		attachmentsRestoreFailed,
		retryAttachmentRestore,
		restoredAttachmentResources,
		isDragging,
		setIsDragging,
		dragCounterRef,
		updateAttachedImages,
		updateAttachedTextFiles,
		updateAttachedMedia,
		reconcileDocumentAssets,
		clearAttachedFilesAndDraft,
	} = useComposerAttachments({
		narratorId: DASHBOARD_COMPOSER_KEY,
		currentUserId,
		sendingRef,
		t: tn,
	});
	const { handleFileInputChange, handleComposerPasteImages, dropZoneProps, ingestingRef } =
		useComposerFileIngest({
			narratorId: DASHBOARD_COMPOSER_KEY,
			sendingRef,
			updateAttachedImages,
			updateAttachedTextFiles,
			updateAttachedMedia,
			attachedMediaRef,
			setIsDragging,
			dragCounterRef,
			captureInsertion: (origin) => composerRef.current?.captureAttachmentInsertion(origin),
			onAcceptedFiles: (files, bookmark) =>
				composerRef.current?.insertAcceptedFiles(files, bookmark) ?? false,
			t: tn,
		});
	const hasAttachments =
		attachedImages.length + attachedTextFiles.length + attachedMedia.length > 0;

	// Every option below is a create-time one, so changing it invalidates a session
	// left behind by a failed send — that session already carries the old value.
	const selectCwd = (path: string) => {
		pendingSessionRef.current = null;
		setChosenCwd(path);
		savePrefs({ cwd: path });
	};
	/**
	 * Switching the execution device resets the directory.
	 *
	 * A local path does not exist on another machine and a remote path does not exist
	 * here, so carrying the value across the switch would pre-fill a directory the create
	 * request must then reject. Remote devices pre-fill their own declared directory.
	 */
	const selectDevice = (nextDeviceId: string) => {
		if (nextDeviceId === chosenDeviceId) return;
		pendingSessionRef.current = null;
		const nextCwd =
			nextDeviceId === LOCAL_DEVICE
				? (projectDir.usablePath ?? "")
				: (remoteDevices.find((device) => device.id === nextDeviceId)?.defaultCwd?.trim() ?? "");
		setChosenDeviceId(nextDeviceId);
		setChosenCwd(nextCwd || null);
		savePrefs({ deviceId: nextDeviceId, cwd: nextCwd });
	};
	const selectModel = (value: string) => {
		pendingSessionRef.current = null;
		setModel(value);
		savePrefs({ model: value });
	};
	const selectReasoningEffort = (value: string) => {
		pendingSessionRef.current = null;
		setReasoningEffortOverride(value);
		savePrefs({ reasoningEffort: value });
	};
	// Without this, a pick would be a one-way door on this device: nothing in the
	// menu would restore "follow the instance default".
	const followDefaultReasoningEffort = () => {
		pendingSessionRef.current = null;
		setReasoningEffortOverride(null);
		savePrefs({ reasoningEffort: null });
	};
	const selectPermissionMode = (value: string) => {
		pendingSessionRef.current = null;
		setPermissionModeOverride(value);
		savePrefs({ permissionMode: value });
	};
	const followDefaultPermissionMode = () => {
		pendingSessionRef.current = null;
		setPermissionModeOverride(null);
		savePrefs({ permissionMode: null });
	};
	const togglePlanMode = () => {
		const next = !startInPlanMode;
		pendingSessionRef.current = null;
		setStartInPlanModeOverride(next);
		savePrefs({ startInPlanMode: next });
	};

	const openDirectoryChooser = () => setBrowseOpen(true);

	const openSession = (session: CreateNarratorResult, scope: RecentTabsScope | null) => {
		void addRecentTab(
			{
				type: "narrator",
				id: session.id,
				title: session.title,
				subtitle: session.cwd,
				status: session.status,
			},
			scope,
		);
		navigate({ to: "/narrators/$narratorId", params: { narratorId: session.id } });
	};

	const send = async () => {
		const composer = composerRef.current;
		if (!composer || sendingRef.current || ingestingRef.current) return;
		// A missing directory is recovered by the chooser. An unavailable device is
		// not: that dialog cannot switch devices, and a device that is gone has
		// nothing to list. Neither may fall through to a session on this server.
		if (deviceUnavailable) return;
		if (directoryRequired) {
			openDirectoryChooser();
			return;
		}
		const rawText = composer.getText();
		const liveDocument = composer.getDocument();
		const document = liveDocument ? parseComposerDocument(liveDocument) : undefined;
		const { text, fileReferences, composerDocument } = document
			? { ...composerDocumentText(document), composerDocument: document }
			: {
					...trimFileReferenceInput({
						text: rawText,
						fileReferences: composer.getFileReferences(),
					}),
					composerDocument: undefined,
				};
		const files = snapshotComposerFiles(
			composerDocument,
			attachedImages,
			attachedTextFiles,
			attachedMedia,
		);
		if (!files || composer.hasMissingAssets()) {
			notifications.show({
				color: "red",
				title: tn("sendFailed"),
				message: tn("composerMissingAssets"),
			});
			return;
		}
		if (
			!hasSendableComposerContent({
				text: rawText,
				imageCount: files.images.length,
				textFileCount: files.textFiles.length,
				mediaCount: files.media.length,
				fileReferenceCount: fileReferences.length,
			})
		)
			return;

		const recentTabsScope = getRecentTabsScope();
		const { generation: authGeneration } = getAuthSnapshot();
		sendingRef.current = true;
		const attachmentCount = files.images.length + files.textFiles.length + files.media.length;
		const abort = new AbortController();
		sendAbortRef.current = abort;
		setSendingState({
			attachmentCount,
			progress: attachmentCount > 0 ? 0 : null,
			canCancel: attachmentCount > 0,
		});
		let lastPercent = -1;
		try {
			let session =
				pendingSessionRef.current?.authGeneration === authGeneration
					? pendingSessionRef.current.session
					: undefined;
			if (!session) {
				// Unchosen → the server uses the default project directory, which exists
				// (`directoryRequired` stops the send otherwise). A remote device always
				// carries its own explicit directory and is named as the execution target.
				const data = await createNarrator.mutateAsync({
					...(chosenCwd ? { cwd: chosenCwd } : {}),
					...(isRemoteDevice ? { deviceId: chosenDeviceId } : {}),
					model,
					// Only an explicit pick is sent: the server keeps the narrator on the
					// instance defaults when the field is absent (a null reasoningEffort is
					// exactly "follow the global default", re-clamped per model per turn).
					...(reasoningEffortOverride ? { reasoningEffort: reasoningEffortOverride } : {}),
					// Sent when the menu's value is known, so what it shows is what the
					// session gets; that value is the instance default until the user
					// touches it. Before settings land, omitting lets the server decide
					// rather than freezing this device's placeholder over a real default.
					...(permissionModeKnown ? { permissionMode } : {}),
					...(startInPlanModeKnown ? { startInPlanMode } : {}),
				});
				session = {
					id: data.id,
					title: data.title || tns("newNarrator"),
					cwd: data.cwd || cwd,
					status: data.status || "idle",
				};
				if (getAuthSnapshot().generation !== authGeneration) return;
				pendingSessionRef.current = { session, authGeneration };
			}
			const args: Parameters<typeof api.sendNarratorMessage> = [
				session.id,
				text,
				files.images.length > 0 ? files.images : undefined,
				files.textFiles.length > 0 ? files.textFiles : undefined,
				undefined,
				(fraction) => {
					// Same throttle as the narrator page: re-render on whole-percent steps only.
					const percent = Math.min(100, Math.max(0, Math.round(fraction * 100)));
					if (percent === lastPercent) return;
					lastPercent = percent;
					setSendingState((state) => (state ? { ...state, progress: fraction } : state));
				},
				abort.signal,
			];
			if (fileReferences.length > 0) args[7] = fileReferences;
			if (composerDocument) args[10] = { composerDocument };
			if (files.media.length) args[11] = files.media;
			await api.sendNarratorMessage(...args);
			if (getAuthSnapshot().generation !== authGeneration) return;
			composer.noteSent(text, fileReferences, composerDocument);
			composer.clearTextAndDraft();
			clearAttachedFilesAndDraft();
			pendingSessionRef.current = null;
			openSession(session, recentTabsScope);
		} catch (error) {
			if (isAbortError(error)) {
				notifications.show({ message: tn("sendCancelled"), color: "gray", autoClose: 2000 });
			} else if (pendingSessionRef.current) {
				// Creation errors are toasted by the global mutation handler.
				notifications.show({
					color: "red",
					title: t("composer.sendFailed"),
					message: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			sendingRef.current = false;
			sendAbortRef.current = null;
			setSendingState(null);
		}
	};

	const sending = sendingState != null;

	return (
		<Box {...dropZoneProps} style={{ position: "relative" }}>
			<DropOverlay visible={isDragging} />
			<UploadProgressBar
				sendingState={sendingState}
				cancelSending={() => sendAbortRef.current?.abort()}
			/>
			<Box>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					style={{ display: "none" }}
					onChange={handleFileInputChange}
					disabled={sending}
				/>
				<NarratorComposer
					ref={composerRef}
					narratorId={DASHBOARD_COMPOSER_KEY}
					// Slash commands resolve project skills from a directory on THIS server:
					// a remote session's path matches nothing here, so it is not offered.
					draft={{ cwd: isRemoteDevice ? null : cwd || null }}
					adaptive={false}
					sendingRef={sendingRef}
					sending={sending}
					permEnterActive={false}
					hasAttachments={hasAttachments}
					enterMode="turn"
					ctrlEnterMode="turn"
					onSendWithMode={() => send()}
					onTextFlagsChange={setHasText}
					onPasteImages={handleComposerPasteImages}
					attachedImages={attachedImages}
					attachedTextFiles={attachedTextFiles}
					attachedMedia={attachedMedia}
					attachmentsHydrating={attachmentsHydrating}
					attachmentsRestoreFailed={attachmentsRestoreFailed}
					onRetryAttachments={retryAttachmentRestore}
					restoredAttachmentResources={restoredAttachmentResources}
					onDocumentAssetsChange={reconcileDocumentAssets}
					onAttachmentsChange={(images, textFiles, media) => {
						updateAttachedImages(images);
						updateAttachedTextFiles(textFiles);
						updateAttachedMedia(media);
					}}
					controls={
						<Tooltip label={tn("attachFile")}>
							<ActionIcon
								aria-label={tn("attachFile")}
								variant="subtle"
								color="gray"
								disabled={sending}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => {
									composerRef.current?.captureAttachmentSelection();
									fileInputRef.current?.click();
								}}
							>
								<IconPaperclip size={18} />
							</ActionIcon>
						</Tooltip>
					}
					actions={
						<Button
							onClick={() => void send()}
							loading={sending}
							disabled={directoryRequired || deviceUnavailable || (!hasText && !hasAttachments)}
						>
							{t("composer.start")}
						</Button>
					}
				/>
			</Box>

			<Group gap="xs" mt="xs" wrap="wrap">
				{/* Device first, as in the create-session dialog: it decides what the
				    directory below even means. Hidden when there is nothing to choose
				    between, so a single-machine instance is unchanged. */}
				{deviceSelectionAvailable && (
					<Box style={{ minWidth: 0, maxWidth: 200 }}>
						<Select
							size="xs"
							aria-label={tns("executionDevice")}
							data={deviceSelectData(remoteDevices, {
								local: tns("executionDeviceLocal"),
								offline: tns("executionDeviceOffline"),
							})}
							value={chosenDeviceId}
							onChange={(value) => selectDevice(value ?? LOCAL_DEVICE)}
							allowDeselect={false}
							comboboxProps={{ withinPortal: true, position: "bottom-start", zIndex: 320 }}
						/>
					</Box>
				)}
				<Tooltip label={cwd || t("composer.chooseDirectory")}>
					<Button
						variant={directoryRequired ? "light" : "default"}
						color={directoryRequired ? "orange" : undefined}
						size="xs"
						leftSection={isRemoteDevice ? <IconDevices size={14} /> : <IconFolder size={14} />}
						onClick={openDirectoryChooser}
						styles={{ label: { maxWidth: 260 } }}
					>
						<Text span size="xs" truncate>
							{cwd
								? isRemoteDevice
									? `${selectedDevice?.name ?? chosenDeviceId} · ${directoryLabel(cwd)}`
									: directoryLabel(cwd)
								: t("composer.chooseDirectory")}
						</Text>
					</Button>
				</Tooltip>
				<Box style={{ minWidth: 0, maxWidth: 280 }}>
					<ModelPickerMenu value={model} onChange={selectModel} />
				</Box>
				{draftReasoning.supported && (
					<Box style={{ minWidth: 0 }}>
						<ReasoningEffortPickerMenu
							value={reasoningEffort}
							options={draftReasoning.options}
							onChange={selectReasoningEffort}
							onFollowDefault={reasoningEffortOverride ? followDefaultReasoningEffort : undefined}
						/>
					</Box>
				)}
				<Box style={{ minWidth: 0 }}>
					<PermissionModePickerMenu
						value={permissionMode}
						availableModes={availablePermissionModes}
						unavailableReason={permissionModesUnavailableReason}
						onChange={selectPermissionMode}
						onFollowDefault={permissionModeOverride ? followDefaultPermissionMode : undefined}
						planMode={{
							active: startInPlanMode,
							supported: planModeCapability.supported,
							unsupportedReason: planModeCapability.reason ?? tn("planModeUnavailable"),
							onToggle: togglePlanMode,
						}}
					/>
				</Box>
				<Tooltip label={t("composer.advanced")}>
					<ActionIcon
						variant="subtle"
						color="gray"
						aria-label={t("composer.advanced")}
						onPointerEnter={preloadCreateNarratorModal}
						onFocus={preloadCreateNarratorModal}
						onPointerDown={preloadCreateNarratorModal}
						onClick={() => {
							advancedScope.current = getRecentTabsScope();
							setAdvancedOpen(true);
						}}
					>
						<IconAdjustmentsHorizontal size={16} />
					</ActionIcon>
				</Tooltip>
			</Group>

			{directoryRequired && (
				<Text size="xs" c="orange" mt={6}>
					{isRemoteDevice ? tns("workingDirectoryRemoteRequired") : t("composer.directoryRequired")}
				</Text>
			)}

			{deviceUnavailable && (
				<Text size="xs" c="orange" mt={6}>
					{t("composer.deviceUnavailable", { device: selectedDevice?.name ?? chosenDeviceId })}
				</Text>
			)}

			<DeviceDirectoryModal
				opened={browseOpen}
				onClose={() => setBrowseOpen(false)}
				title={
					isRemoteDevice
						? tns("browseRemoteDirectoryTitle", {
								device: selectedDevice?.name ?? chosenDeviceId,
							})
						: tc("selectDirectory")
				}
				deviceId={chosenDeviceId}
				deviceLabel={selectedDevice?.name ?? chosenDeviceId}
				initialPath={cwd || undefined}
				onCancel={() => setBrowseOpen(false)}
				// A device that is gone has no filesystem to list: the composer already
				// says so, and the dialog stays a no-op instead of firing a doomed request.
				listDirectory={
					isRemoteDevice && selectedDevice
						? (path, opts) =>
								api.browseWorkspaceDirectory(chosenDeviceId, path, {
									showHidden: opts.showHidden,
								})
						: undefined
				}
				queryKey={["dashboardDeviceBrowse", chosenDeviceId]}
				onSelect={(path) => {
					selectCwd(path);
					setBrowseOpen(false);
				}}
			/>

			<CreateNarratorLazyModal
				opened={advancedOpen}
				onClose={() => setAdvancedOpen(false)}
				initialCwd={cwd || undefined}
				initialDeviceId={isRemoteDevice ? chosenDeviceId : undefined}
				onCreated={(session) => openSession(session, advancedScope.current)}
			/>
		</Box>
	);
}
