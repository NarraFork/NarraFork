/** @jsxImportSource ./shim */

/**
 * `provider-settings` view: Cline sign-in, balance and model selection.
 *
 * ## What this page can and cannot do
 *
 * It runs in a sandboxed iframe with `connect-src 'none'`, so it cannot reach any HTTP
 * endpoint — not even the host's own admin API. Everything it does goes through
 * `commands.execute`, which the host routes to this plugin's backend.
 *
 * It never reads a credential. `status` reports whether one exists and who it belongs to; the
 * token itself is not part of any command's output. Values typed into the callback box travel
 * one way, into a command, and the box is cleared as soon as it is submitted.
 *
 * ## Why React and Mantine
 *
 * The panel does not bundle either. It reads them off `globalThis.__nfPluginRuntime`, a shared
 * runtime the host injects before this file runs (see `host-runtime.ts`). That is what makes
 * this page visually identical to the built-in Cline section — same components, same theme
 * object, same version — rather than an approximation of it. The plugin artifact stays a
 * couple of KB because the framework lives in the host's bundle.
 *
 * ## Interaction constraints worth knowing before editing
 *
 * - No `window.confirm` / `alert`: the sandbox lacks `allow-modals`, so the browser ignores
 *   them and returns `undefined`. Sign-out uses `ConfirmOverlay`.
 * - No Mantine `Modal`, `Select`, `Menu` or other portalled overlay: the panel is a
 *   fixed-height box with `overflow: hidden`, which clips them. Dialogs use `PanelOverlay`.
 * - No `window.open` or popup links: the sandbox lacks `allow-popups`. The authorization URL
 *   is shown as selectable text with a copy button.
 */

import {
	createRoot,
	hostTheme,
	MantineCore,
	React,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "./host-runtime";
import { ConfirmOverlay } from "./Overlay";
import {
	type BalanceOutput,
	errorMessage,
	isRecord,
	type PluginUiSdk,
	type PoolModel,
	type RecommendedOutput,
	runCommand,
	type StatusOutput,
} from "./panel-types";
import { activeLocale, onLocaleChange, t } from "./strings";

const {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Loader,
	MantineProvider,
	Paper,
	ScrollArea,
	Stack,
	Text,
	TextInput,
} = MantineCore;

/**
 * How often `status` is re-read while a browser sign-in is pending.
 *
 * Matches the built-in section's `refetchInterval` of 2s. Polling runs *only* while
 * `signInPending`, because that is the one state whose end is caused by something outside this
 * document (the browser hitting the loopback callback) and therefore cannot be observed any
 * other way. Every other transition here follows a click, which already refreshes.
 *
 * A steady 2s poll of an open settings page would otherwise be free-running traffic — which is
 * also why the `status` command never refreshes a token.
 */
const SIGN_IN_POLL_MS = 2_000;

/** Debounce before a typed query is sent, matching the built-in section's `useDebouncedValue`. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Shortest query that triggers a search.
 *
 * The built-in section uses the same threshold. One character matches most of a 300+ model pool,
 * so the result would be a truncated list that says nothing while costing a round trip.
 */
const MIN_SEARCH_LENGTH = 2;

type StatusTone = "neutral" | "good" | "bad";

function formatTimestamp(seconds?: number): string {
	if (!seconds) return "";
	const date = new Date(seconds < 10_000_000_000 ? seconds * 1000 : seconds);
	return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(activeLocale());
}

/**
 * Copy text to the clipboard, reporting whether it worked.
 *
 * Two mechanisms because the first is frequently unavailable here: `navigator.clipboard` is a
 * powerful-feature API, and this document has an opaque origin (`sandbox allow-scripts`
 * without `allow-same-origin`), so the property can be missing outright or reject. The
 * `execCommand` path is deprecated but still the only one that works in that case.
 *
 * Returning a boolean rather than throwing: the caller's fallback is to tell the user to copy
 * the text manually, which is a normal outcome here, not an error.
 */
async function copyText(value: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(value);
			return true;
		}
	} catch {
		// Fall through to the legacy path.
	}
	try {
		const scratch = document.createElement("textarea");
		scratch.style.position = "fixed";
		scratch.style.opacity = "0";
		scratch.value = value;
		document.body.appendChild(scratch);
		scratch.select();
		const copied = document.execCommand("copy");
		scratch.remove();
		return copied;
	} catch {
		return false;
	}
}

interface PoolRowProps {
	id: string;
	name?: string;
	contextLength?: number;
	enabled: boolean;
	pending: boolean;
	onSetEnabled: (id: string, enable: boolean) => void;
}

/**
 * One pool search result: id, name and context size, then a compact +/− toggle.
 *
 * Mirrors the built-in Cline section's pool rows: an immediate per-row mutation, never a
 * checkbox draft. The row background marks an already-added model, like the built-in's
 * highlighted rows; `--mantine-color-default-hover` adapts to both colour schemes.
 */
function PoolRow({ id, name, contextLength, enabled, pending, onSetEnabled }: PoolRowProps) {
	return (
		<Group
			gap="xs"
			py={2}
			px="xs"
			wrap="nowrap"
			style={{
				borderRadius: 4,
				background: enabled ? "var(--mantine-color-default-hover)" : undefined,
			}}
		>
			<Text size="xs" ff="monospace" style={{ flex: 1, minWidth: 0 }} truncate>
				{id}
			</Text>
			{name && name !== id ? (
				<Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 0 }} truncate>
					{name}
				</Text>
			) : null}
			{contextLength ? (
				<Text size="xs" c="dimmed">
					{Math.round(contextLength / 1000)}k
				</Text>
			) : null}
			<ActionIcon
				size="xs"
				variant={enabled ? "filled" : "light"}
				color={enabled ? "red" : "blue"}
				disabled={pending}
				title={t(enabled ? "removeModel" : "addModel")}
				onClick={() => onSetEnabled(id, !enabled)}
			>
				{enabled ? "−" : "+"}
			</ActionIcon>
		</Group>
	);
}

interface RecommendedRowProps {
	id: string;
	name?: string;
	tags?: string[];
	enabled: boolean;
	pending: boolean;
	onSetEnabled: (id: string, enable: boolean) => void;
}

/**
 * One recommended/free model: name, tags and id, then an "Add" button that becomes an
 * "Added" badge — the built-in section's quick-add rows, same wording.
 */
function RecommendedRow({ id, name, tags, enabled, pending, onSetEnabled }: RecommendedRowProps) {
	return (
		<Group gap="xs" wrap="nowrap">
			<Text size="xs" style={{ flex: 1, minWidth: 0 }} truncate>
				{name || id}
				{tags?.length ? ` [${tags.join(", ")}]` : ""}
			</Text>
			<Text size="xs" c="dimmed" ff="monospace" style={{ flex: 1, minWidth: 0 }} truncate>
				{id}
			</Text>
			{enabled ? (
				<Badge size="xs" variant="light" color="blue">
					{t("added")}
				</Badge>
			) : (
				<Button
					size="compact-xs"
					variant="subtle"
					disabled={pending}
					onClick={() => onSetEnabled(id, true)}
				>
					{t("add")}
				</Button>
			)}
		</Group>
	);
}

function ClinePanel({ sdk }: { sdk: PluginUiSdk }) {
	const [status, setStatus] = useState<StatusOutput | undefined>();
	const [loadError, setLoadError] = useState<string | undefined>();
	const [message, setMessage] = useState<{ text: string; tone: StatusTone } | undefined>();
	const [busy, setBusy] = useState(false);
	/** Models with an add/remove currently in flight; their controls stay disabled meanwhile. */
	const [pendingModels, setPendingModels] = useState<ReadonlySet<string>>(() => new Set());
	const [pasteUrl, setPasteUrl] = useState("");
	const [balance, setBalance] = useState<{ text: string; tone: "normal" | "bad" } | undefined>();
	const [balanceLoading, setBalanceLoading] = useState(false);
	const [recommended, setRecommended] = useState<RecommendedOutput | undefined>();
	const [recommendedError, setRecommendedError] = useState<string | undefined>();
	const [recommendedLoading, setRecommendedLoading] = useState(true);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResult, setSearchResult] = useState<
		{ models: PoolModel[]; total: number } | undefined
	>();
	const [searchError, setSearchError] = useState<string | undefined>();
	const [searching, setSearching] = useState(false);
	const [confirmingLogout, setConfirmingLogout] = useState(false);

	/*
	 * Re-render when the host language changes.
	 *
	 * `t()` resolves against the host's current locale on every call, so a re-render is all that
	 * is needed — but something has to cause one. Colours need no equivalent: the host rewrites
	 * the `--nf-*` variables and the browser repaints on its own. Text is the asymmetric case,
	 * because a string already committed to the DOM stays until React replaces it.
	 */
	const [, bumpLocale] = useState(0);
	useEffect(() => onLocaleChange(() => bumpLocale((value) => value + 1)), []);

	/**
	 * True once the panel has unmounted.
	 *
	 * Every command here is a round trip through the host to the plugin backend, so any of them
	 * can still be in flight when the host closes the view. Most are started from click handlers
	 * rather than effects, so they have no effect scope to be cancelled by — a ref set by a
	 * teardown effect is the one thing all of them can consult before touching state.
	 */
	const unmounted = useRef(false);
	useEffect(() => {
		return () => {
			unmounted.current = true;
		};
	}, []);

	/**
	 * The latest status, readable from callbacks without depending on them.
	 *
	 * `setModelEnabled` computes the next enabled list from here; closing over `status`
	 * would make its identity change on every poll tick and re-arm every effect that
	 * uses it.
	 */
	const statusRef = useRef<StatusOutput | undefined>();
	/** Whether the balance has been auto-loaded for the current sign-in. */
	const balanceLoadedRef = useRef(false);
	/** The pending sign-in poll and search debounce timers, for `pagehide` cleanup. */
	const pollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();
	/**
	 * Monotonic id of the newest search, so a slow earlier response cannot overwrite a newer one.
	 *
	 * Typing produces overlapping requests whose completion order is not guaranteed; without this
	 * the visible results can end up belonging to a prefix of what the box now says.
	 */
	const searchGenerationRef = useRef(0);

	const command = useCallback(
		(commandId: string, input?: Record<string, unknown>) => runCommand(sdk, commandId, input),
		[sdk],
	);

	/** Re-read the account snapshot. */
	const refresh = useCallback(async (): Promise<StatusOutput | undefined> => {
		const output = (await command("status")) as StatusOutput | undefined;
		if (!output || typeof output.authenticated !== "boolean") {
			throw new Error(t("noAccountInfo"));
		}
		if (unmounted.current) return output;
		statusRef.current = output;
		setStatus(output);
		setLoadError(undefined);

		// A sign-out invalidates the balance shown for the previous account, and a fresh sign-in
		// must be allowed to auto-load one again. Clearing the cached text too: showing the
		// previous account's dollars after a sign-out would be wrong, not merely stale.
		if (!output.authenticated) {
			balanceLoadedRef.current = false;
			setBalance(undefined);
		}

		// Lets the host and any e2e test observe that the view reached a usable state.
		sdk.notify("cline-external.settings.ready", {
			authenticated: output.authenticated,
			enabledModelCount: output.enabledModelCount,
			browserAuth: output.browserAuth,
		});
		return output;
	}, [command, sdk]);

	/**
	 * Run a mutating action, then reload.
	 *
	 * Every failure lands in one place: a command that rejected silently would leave the panel
	 * showing stale state with no indication that anything went wrong.
	 */
	const run = useCallback(
		(label: string, action: () => Promise<unknown>) => {
			if (busy) return;
			setBusy(true);
			setMessage({ text: `${label}…`, tone: "neutral" });
			action()
				.then(async () => {
					await refresh();
					if (unmounted.current) return;
					setMessage({ text: t("actionDone", { action: label }), tone: "good" });
				})
				.catch((error: unknown) => {
					if (unmounted.current) return;
					setMessage({
						text: t("actionFailed", { action: label, reason: errorMessage(error) }),
						tone: "bad",
					});
				})
				.finally(() => {
					if (unmounted.current) return;
					setBusy(false);
				});
		},
		[busy, refresh],
	);

	// Initial load. A failure here is reported in place of the page rather than as a status
	// line, because there is nothing else to show.
	useEffect(() => {
		let cancelled = false;
		refresh().catch((error: unknown) => {
			if (cancelled) return;
			setLoadError(t("loadFailed", { reason: errorMessage(error) }));
		});
		return () => {
			cancelled = true;
		};
		// Intentionally once on mount: every later refresh is driven by an action or the poll.
	}, [refresh]);

	/*
	 * Keep the sign-in poll running exactly while it is needed.
	 *
	 * The poll re-arms from this effect rather than from inside itself: it starts when
	 * `signInPending` appears, stops on the tick that observes it ended, and pauses while an
	 * action is in flight — a refresh re-renders the controls under a click in progress, and
	 * the action refreshes when it settles anyway.
	 */
	const [pollTick, setPollTick] = useState(0);
	useEffect(() => {
		if (!status?.signInPending || busy) return;
		const timer = setTimeout(() => {
			pollTimerRef.current = undefined;
			refresh()
				.catch(() => {
					// A failed poll is not worth reporting: the flow may still complete, and replacing
					// the "waiting for callback" hint with a transport error would be actively
					// misleading. Reschedule so a blip does not end polling.
				})
				.finally(() => {
					// Re-arm on EVERY settled tick, success included: the effect's other deps
					// (signInPending, busy, refresh) do not change while the flow is still
					// pending, so only this tick bump schedules the next poll. Arming only
					// on failure made one successful-but-still-pending tick end the poll —
					// the browser round-trip almost always outlives the first interval.
					if (!unmounted.current) setPollTick((value) => value + 1);
				});
		}, SIGN_IN_POLL_MS);
		pollTimerRef.current = timer;
		return () => clearTimeout(timer);
	}, [status?.signInPending, busy, refresh, pollTick]);

	// The host disposes the iframe when the panel closes or its session is rebuilt. Timers in a
	// document being torn down would otherwise keep issuing `commands.execute` against a dead
	// session — the requests fail, but they are pure noise and keep this document alive longer
	// than the host intends.
	useEffect(() => {
		const clear = () => {
			if (pollTimerRef.current !== undefined) clearTimeout(pollTimerRef.current);
			if (searchTimerRef.current !== undefined) clearTimeout(searchTimerRef.current);
			pollTimerRef.current = undefined;
			searchTimerRef.current = undefined;
		};
		globalThis.addEventListener("pagehide", clear);
		return () => globalThis.removeEventListener("pagehide", clear);
	}, []);

	/**
	 * Fetch the balance and show it.
	 *
	 * Not routed through `run()`: it renders into its own area and must not disable the page, so
	 * that the auto-load on sign-in cannot make every other control briefly unusable.
	 */
	const loadBalance = useCallback(() => {
		setBalanceLoading(true);
		command("balance")
			.then((result) => {
				if (unmounted.current) return;
				const micro = isRecord(result) ? (result as BalanceOutput).balance : undefined;
				// The API reports micro-dollars (1/1,000,000 USD).
				setBalance(
					typeof micro === "number"
						? {
								text: t("balance", { amount: `$${(micro / 1_000_000).toFixed(2)}` }),
								tone: "normal",
							}
						: { text: t("noBalance"), tone: "normal" },
				);
			})
			.catch((error: unknown) => {
				if (unmounted.current) return;
				setBalance({ text: t("balanceFailed", { reason: errorMessage(error) }), tone: "bad" });
			})
			.finally(() => {
				if (unmounted.current) return;
				setBalanceLoading(false);
			});
	}, [command]);

	// Auto-loaded once per sign-in, like the built-in section, which queries it as soon as
	// `authenticated` turns true. Guarded by a ref rather than "is the box empty", because this
	// effect re-runs on every status change — including each 2s sign-in poll — and re-fetching
	// there would turn one balance call into a stream of them.
	useEffect(() => {
		if (!status?.authenticated || balanceLoadedRef.current) return;
		balanceLoadedRef.current = true;
		loadBalance();
	}, [status?.authenticated, loadBalance]);

	// Recommended and free models, loaded once on mount. The list costs an upstream call and
	// outlives every refresh, so neither a poll tick nor an action's reload may re-fetch it.
	useEffect(() => {
		setRecommendedLoading(true);
		command("recommended-models")
			.then((result) => {
				if (unmounted.current) return;
				setRecommended(isRecord(result) ? (result as RecommendedOutput) : {});
			})
			.catch((error: unknown) => {
				if (unmounted.current) return;
				setRecommendedError(t("recommendationsFailed", { reason: errorMessage(error) }));
			})
			.finally(() => {
				if (unmounted.current) return;
				setRecommendedLoading(false);
			});
	}, [command]);

	/*
	 * Typing searches on its own, like the built-in section.
	 *
	 * The debounce lives in an effect keyed by the query, so each keystroke replaces the pending
	 * timer rather than stacking another one. Below `MIN_SEARCH_LENGTH` the results are cleared
	 * instead of searched.
	 */
	useEffect(() => {
		const query = searchQuery.trim();
		if (query.length < MIN_SEARCH_LENGTH) {
			setSearching(false);
			setSearchError(undefined);
			setSearchResult(undefined);
			return;
		}
		setSearching(true);
		setSearchError(undefined);
		const timer = setTimeout(() => {
			searchTimerRef.current = undefined;
			// Each run claims the newest generation; a response from an older one is discarded.
			searchGenerationRef.current += 1;
			const generation = searchGenerationRef.current;
			command("models.search", { query, limit: 50 })
				.then((result) => {
					if (unmounted.current || generation !== searchGenerationRef.current) return;
					const models =
						isRecord(result) && Array.isArray(result.models)
							? (result.models as PoolModel[]).filter((model) => model?.id)
							: [];
					const total =
						isRecord(result) && typeof result.total === "number" ? result.total : models.length;
					setSearchResult({ models, total });
					setSearching(false);
				})
				.catch((error: unknown) => {
					if (unmounted.current || generation !== searchGenerationRef.current) return;
					setSearchError(t("actionFailed", { action: t("search"), reason: errorMessage(error) }));
					setSearching(false);
				});
		}, SEARCH_DEBOUNCE_MS);
		searchTimerRef.current = timer;
		return () => clearTimeout(timer);
	}, [searchQuery, command]);

	/**
	 * Tell the host the provider's model set changed, so its model lists refetch.
	 *
	 * The typed `provider.modelsChanged` request is the current contract: it resolves only
	 * after the host has dropped its derived caches, and a host too old to know it answers
	 * with an error, which downgrades permanently to the legacy invalidation notification
	 * that hosts before it already handle. Either way the server-side catalog refresh has
	 * already happened inside `config.setEnabledModels` — this is purely about the host's
	 * frontend caches.
	 */
	const modelsChangedLegacyRef = useRef(false);
	const notifyModelsChanged = useCallback(async (): Promise<void> => {
		if (!modelsChangedLegacyRef.current) {
			try {
				await sdk.request("provider.modelsChanged");
				return;
			} catch {
				modelsChangedLegacyRef.current = true;
			}
		}
		sdk.notify("providerSettings.catalogInvalidated", { providerId: "cline" });
	}, [sdk]);

	/**
	 * Add or remove one model, effective immediately.
	 *
	 * Not routed through `run()`: that wrapper disables every button on the page for the
	 * duration, which is right for sign-in but wrong for a click-per-model gesture — the
	 * built-in Cline section adds/removes per row without freezing the rest. Only one
	 * mutation may be in flight at a time: the write replaces the whole enabled list (the
	 * only mutation command), and a second click computed from the pre-mutation list would
	 * silently drop the first one's model.
	 */
	const setModelEnabled = useCallback(
		(id: string, enable: boolean) => {
			if (busy || pendingModels.size > 0) return;
			const current = statusRef.current?.enabledModels ?? [];
			if (enable === current.includes(id)) return;
			const next = enable ? [...current, id] : current.filter((model) => model !== id);
			setPendingModels(new Set([id]));
			const label = t(enable ? "actionAddModel" : "actionRemoveModel");
			command("config.setEnabledModels", { models: next })
				.then(async () => {
					// The backend applies the write and refreshes the provider catalog before this
					// command resolves; only then is the host's side told to drop derived caches.
					await notifyModelsChanged();
					await refresh();
				})
				.catch((error: unknown) => {
					if (unmounted.current) return;
					setMessage({
						text: t("actionFailed", { action: label, reason: errorMessage(error) }),
						tone: "bad",
					});
				})
				.finally(() => {
					if (unmounted.current) return;
					setPendingModels(new Set());
				});
		},
		[busy, pendingModels, command, refresh, notifyModelsChanged],
	);

	/** The saved enabled list, for row `+`/`−` and "Added" states. */
	const enabledSet = useMemo(() => new Set(status?.enabledModels ?? []), [status?.enabledModels]);

	const handleCopyAuthorizeUrl = useCallback((url: string) => {
		// Not routed through `run()`: copying touches no backend, and `run()` would refresh and
		// disable every button for a local clipboard write.
		void copyText(url).then((copied) => {
			if (unmounted.current) return;
			setMessage({
				text: copied ? t("urlCopied") : t("urlCopyFailed"),
				tone: copied ? "good" : "bad",
			});
		});
	}, []);

	const handleImportCallback = useCallback(() => {
		const callbackUrl = pasteUrl.trim();
		if (!callbackUrl) {
			setMessage({ text: t("nothingToImport"), tone: "bad" });
			return;
		}
		// Cleared before the request: this box is the only place a credential exists in this
		// document, and it should not outlive the submission.
		setPasteUrl("");
		run(t("actionImport"), () => command("auth.callback", { callbackUrl }));
	}, [pasteUrl, run, command]);

	if (loadError && !status) {
		return (
			<Alert color="red" variant="light" title={t("runtimeMissingTitle")}>
				{loadError}
			</Alert>
		);
	}
	if (!status) {
		return (
			<Group justify="center" p="lg">
				<Loader size="sm" />
			</Group>
		);
	}

	const facts = [
		status.email && status.email !== status.displayName ? status.email : undefined,
		status.expiresAt
			? `${t(status.expired ? "tokenExpired" : "tokenValid")} · ${formatTimestamp(status.expiresAt)}`
			: undefined,
		t("modelsEnabled", { count: status.enabledModelCount }),
		status.poolModelCount ? t("modelsInPool", { count: status.poolModelCount }) : undefined,
	].filter((value): value is string => Boolean(value));

	const recommendedGroups: Array<[string, PoolModel[] | undefined]> = [
		[t("recommended"), recommended?.recommended],
		[t("free"), recommended?.free],
	];
	const recommendedEmpty =
		!recommendedLoading &&
		!recommendedError &&
		recommendedGroups.every(([, entries]) => !entries || entries.length === 0);

	const trimmedQuery = searchQuery.trim();

	return (
		<Stack gap="md">
			<Text fw={600} size="sm">
				{t("title")}
			</Text>

			{/* Account card: identity, session facts, balance and the sign-out action. */}
			<Paper withBorder radius="md" p="sm">
				<Stack gap="xs">
					{status.credentialError ? (
						<Alert color="red" variant="light">
							{t("credentialsUnreadable", { reason: status.credentialError })}
						</Alert>
					) : null}
					{!status.authenticated && !status.credentialError ? (
						<Text size="sm" c="yellow">
							{t("notSignedIn")}
						</Text>
					) : null}
					{status.authenticated ? (
						<>
							<Text size="sm">{status.displayName || status.email || t("signedIn")}</Text>
							{facts.length > 0 ? (
								<Text size="xs" c="dimmed" ff="monospace">
									{facts.join("  ·  ")}
								</Text>
							) : null}
							<Group gap="xs" align="center">
								{balance ? (
									<Badge size="sm" variant="light" color={balance.tone === "bad" ? "red" : "teal"}>
										{balance.text}
									</Badge>
								) : null}
								<Button
									size="compact-xs"
									variant="subtle"
									disabled={busy || balanceLoading}
									loading={balanceLoading}
									onClick={loadBalance}
								>
									{t("refreshBalance")}
								</Button>
							</Group>
							<Box>
								<Button
									size="xs"
									variant="light"
									color="red"
									disabled={busy}
									onClick={() => setConfirmingLogout(true)}
								>
									{t("signOut")}
								</Button>
							</Box>
						</>
					) : (
						<Stack gap="xs">
							{status.browserAuth === "available" || status.browserAuth === "port_busy" ? (
								<Box>
									<Button
										size="xs"
										variant="light"
										disabled={busy}
										onClick={() =>
											run(t("actionBrowserSignIn"), async () => {
												const result = await command("auth.browser");
												const url = isRecord(result) ? result.authorizeUrl : undefined;
												if (typeof url !== "string") {
													throw new Error("No authorization URL returned");
												}
												// Nothing to do with the URL here: `run` refreshes when this resolves,
												// and the box is rendered from `status.authorizeUrl` below. Rendering it
												// from the response directly put it on screen for the few milliseconds
												// until that refresh re-rendered, so the URL the whole flow depends on
												// flashed and vanished.
											})
										}
									>
										{t("signInBrowser")}
									</Button>
								</Box>
							) : null}
							{status.browserAuth === "port_busy" ? (
								<Text size="xs" c="yellow">
									{t("portBusy")}
								</Text>
							) : null}
							{status.browserAuth === "unsupported" ? (
								<Text size="xs" c="yellow">
									{t("browserUnsupported")}
								</Text>
							) : null}
						</Stack>
					)}
				</Stack>
			</Paper>

			{/* Pending sign-in: the authorization URL, its copy action and the cancel button. */}
			{status.signInPending ? (
				<Stack gap={4}>
					<Text size="xs" c="dimmed">
						{t("waitingCallback")}
					</Text>
					{status.authorizeUrl ? (
						<Paper withBorder radius="md" p="sm">
							<Stack gap="xs">
								<Text size="xs">{t("openToAuthorize")}</Text>
								{/* Selectable text rather than a link: the iframe sandbox has no
								    `allow-popups`, so navigation out of the panel is blocked. */}
								<Text
									size="xs"
									ff="monospace"
									c="green"
									style={{ wordBreak: "break-all", userSelect: "all" }}
								>
									{status.authorizeUrl}
								</Text>
								<Group gap="xs">
									<Button
										size="compact-xs"
										variant="light"
										onClick={() => handleCopyAuthorizeUrl(status.authorizeUrl ?? "")}
									>
										{t("copyUrl")}
									</Button>
									<Button
										size="compact-xs"
										variant="light"
										color="red"
										disabled={busy}
										onClick={() => run(t("actionCancelSignIn"), () => command("auth.cancel"))}
									>
										{t("cancelSignIn")}
									</Button>
								</Group>
							</Stack>
						</Paper>
					) : (
						<Box>
							<Button
								size="compact-xs"
								variant="light"
								color="red"
								disabled={busy}
								onClick={() => run(t("actionCancelSignIn"), () => command("auth.cancel"))}
							>
								{t("cancelSignIn")}
							</Button>
						</Box>
					)}
				</Stack>
			) : null}

			{/* Paste callback URL: the path that does not depend on a bindable port. */}
			{!status.authenticated ? (
				<Stack gap={4}>
					<Text size="xs" c="dimmed">
						{t("pastePrompt")}
					</Text>
					<Group gap="xs" align="flex-end" wrap="nowrap">
						<TextInput
							size="xs"
							placeholder="http://localhost:19876/auth/callback?code=…"
							value={pasteUrl}
							onChange={(event: { currentTarget: { value: string } }) =>
								setPasteUrl(event.currentTarget.value)
							}
							style={{ flex: 1 }}
							styles={{ input: { fontFamily: "monospace" } }}
						/>
						<Button size="xs" variant="light" disabled={busy} onClick={handleImportCallback}>
							{t("importCallback")}
						</Button>
					</Group>
				</Stack>
			) : null}

			<Divider />

			{/* Recommended and free models, quick-added one click at a time. */}
			<Stack gap="xs">
				<Text size="xs" fw={600} c="dimmed">
					{t("recommendedAndFree")}
				</Text>
				{recommendedLoading ? (
					<Group gap="xs">
						<Loader size="xs" />
						<Text size="xs" c="dimmed">
							{t("loading")}
						</Text>
					</Group>
				) : null}
				{recommendedError ? (
					<Text size="xs" c="red">
						{recommendedError}
					</Text>
				) : null}
				{recommendedGroups.map(([label, entries]) =>
					entries && entries.length > 0 ? (
						<Stack key={label} gap={2}>
							<Text size="xs" c="dimmed">
								{label}
							</Text>
							{entries.map((entry) => {
								const model = entry as { id: string; name?: string; tags?: string[] };
								if (!model.id) return null;
								return (
									<RecommendedRow
										key={model.id}
										id={model.id}
										name={model.name}
										tags={model.tags}
										enabled={enabledSet.has(model.id)}
										pending={pendingModels.has(model.id)}
										onSetEnabled={setModelEnabled}
									/>
								);
							})}
						</Stack>
					) : null,
				)}
				{recommendedEmpty ? (
					<Text size="xs" c="dimmed">
						{t("noRecommendations")}
					</Text>
				) : null}
			</Stack>

			{/* Model pool: refresh, then debounced search. */}
			<Stack gap="xs">
				<Group gap="xs">
					<Text size="sm" fw={600}>
						{t("models")}
					</Text>
					<Button
						size="compact-xs"
						variant="light"
						disabled={busy}
						onClick={() => run(t("actionRefreshPool"), () => command("models.refresh"))}
					>
						{t("refreshPool")}
					</Button>
					{status.poolModelCount ? (
						<Text size="xs" c="dimmed">
							{t("modelsInPool", { count: status.poolModelCount })}
						</Text>
					) : null}
				</Group>
				<Text size="xs" c="dimmed">
					{t("modelsDesc")}
				</Text>
				<Text size="xs" fw={600} c="dimmed">
					{t("searchPool")}
				</Text>
				<TextInput
					size="xs"
					placeholder={t("searchPlaceholder")}
					value={searchQuery}
					onChange={(event: { currentTarget: { value: string } }) =>
						setSearchQuery(event.currentTarget.value)
					}
					styles={{ input: { fontFamily: "monospace" } }}
				/>
				{trimmedQuery.length > 0 && trimmedQuery.length < MIN_SEARCH_LENGTH ? (
					<Text size="xs" c="dimmed">
						{t("minChars", { count: MIN_SEARCH_LENGTH })}
					</Text>
				) : null}
				{searching ? (
					<Text size="xs" c="dimmed">
						{t("searching")}
					</Text>
				) : null}
				{searchError ? (
					<Text size="xs" c="red">
						{searchError}
					</Text>
				) : null}
				{searchResult && !searching ? (
					<Stack gap={2}>
						{searchResult.models.length === 0 ? (
							<Text size="xs" c="dimmed">
								{t("noMatches")}
							</Text>
						) : (
							<>
								<Text size="xs" c="dimmed">
									{searchResult.total > searchResult.models.length
										? t("shownOfRefine", {
												shown: searchResult.models.length,
												total: searchResult.total,
											})
										: t("shownOf", {
												shown: searchResult.models.length,
												total: searchResult.total,
											})}
								</Text>
								<ScrollArea.Autosize mah={260}>
									<Stack gap={2}>
										{searchResult.models.map((model) => (
											<PoolRow
												key={model.id}
												id={model.id}
												name={model.name}
												contextLength={model.contextLength}
												enabled={enabledSet.has(model.id)}
												pending={pendingModels.has(model.id)}
												onSetEnabled={setModelEnabled}
											/>
										))}
									</Stack>
								</ScrollArea.Autosize>
							</>
						)}
					</Stack>
				) : null}
			</Stack>

			{/* Added models are intentionally NOT listed here: they appear in the host's own
	    model list below this view, which is where hiding, context windows and testing live. */}

			{message ? (
				<Text
					size="xs"
					c={message.tone === "bad" ? "red" : message.tone === "good" ? "green" : "dimmed"}
				>
					{message.text}
				</Text>
			) : null}

			{confirmingLogout ? (
				<ConfirmOverlay
					message={t("signOutConfirm")}
					confirmLabel={t("signOut")}
					loading={busy}
					onCancel={() => setConfirmingLogout(false)}
					onConfirm={() => {
						setConfirmingLogout(false);
						run(t("actionSignOut"), () => command("auth.logout"));
					}}
				/>
			) : null}
		</Stack>
	);
}
interface PanelBoundaryState {
	message?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: the host's React is untyped at this boundary
const HostComponent: any = React.Component;

/**
 * Stop a render-time throw from blanking the panel.
 *
 * React unmounts the whole tree when a render throws and nothing catches it, so without this
 * a single bad response shape or an incompatible Mantine prop turns the panel into an empty
 * box with only a console trace — inside an iframe, where nobody is looking at the console.
 */
class PanelErrorBoundary extends HostComponent {
	state: PanelBoundaryState = {};

	static getDerivedStateFromError(error: unknown): PanelBoundaryState {
		return { message: errorMessage(error) };
	}

	render(): unknown {
		const { message } = this.state as PanelBoundaryState;
		if (message) {
			return (
				<Alert color="red" variant="light" title={t("runtimeMissingTitle")}>
					{message}
				</Alert>
			);
		}
		return (this.props as { children?: unknown }).children;
	}
}

/**
 * Report the content height to the host, so the iframe can escape its fixed-height box.
 *
 * The host cannot measure this document itself (the sandbox has no `allow-same-origin`),
 * so the panel observes its own size and pushes it through `panel.setHeight`. Surfaces
 * whose containers cannot grow answer NOT_SUPPORTED, and older hosts that predate the
 * method answer METHOD_NOT_FOUND — either way the reporter shuts down instead of paying
 * for an observer and a rejected request on every layout change.
 */
function startHeightReporting(sdk: PluginUiSdk): void {
	let supported = true;
	let inFlight = false;
	let lastReported = 0;
	const report = () => {
		if (!supported || inFlight) return;
		const height = Math.ceil(document.documentElement.scrollHeight);
		if (height <= 0 || height === lastReported) return;
		inFlight = true;
		sdk
			.request("panel.setHeight", { height })
			.then(() => {
				lastReported = height;
			})
			.catch((error: unknown) => {
				const code = (error as { code?: string } | null)?.code;
				if (code === "NOT_SUPPORTED" || code === "METHOD_NOT_FOUND") supported = false;
			})
			.finally(() => {
				inFlight = false;
				// A resize during the round trip left a newer height unsent.
				const current = Math.ceil(document.documentElement.scrollHeight);
				if (current > 0 && current !== lastReported) report();
			});
	};
	const observer = new ResizeObserver(report);
	observer.observe(document.body);
	report();
}

/**
 * Mount the panel.
 *
 * `position: relative` on the root is load-bearing: `PanelOverlay` positions itself against
 * this element, so without it a dialog would escape to the document and be clipped by the
 * frame.
 */
export function mount(sdk: PluginUiSdk): void {
	const root = document.body;
	// The host shell owns a fixed loading splash. Remove the shell body before mounting this
	// document-owned UI; appending beneath it leaves a fully working panel permanently obscured.
	root.replaceChildren();
	const container = document.createElement("div");
	container.style.position = "relative";
	container.style.minHeight = "100%";
	container.style.padding = "12px";
	container.style.boxSizing = "border-box";
	root.style.margin = "0";
	root.appendChild(container);

	createRoot(container).render(
		<MantineProvider theme={hostTheme}>
			<Box>
				<PanelErrorBoundary>
					<ClinePanel sdk={sdk} />
				</PanelErrorBoundary>
			</Box>
		</MantineProvider>,
	);
	startHeightReporting(sdk);
}
