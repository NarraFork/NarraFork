/**
 * The quick switcher (design §6.10, D35): Mod-K on an outline surface, type a title, an alias or
 * some text, Enter focuses there.
 *
 * Results: the current space first — this tab's own index of the live page, instant, then the
 * server's search of the current space's other pages — then the other spaces the person can read
 * (`quick-switcher-index.ts`). A block of the page on screen is focused in place through the
 * editing surface; any other block (another page, another space) is a navigation of the surface's
 * host (`onNavigate`): a dock panel switches in place, the outline page changes its URL.
 *
 * Drawn inside the surface (not a portal), so it stays in its dock panel or detached window.
 */
import { Loader, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import {
	forwardRef,
	type KeyboardEvent,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useOutlineSearch } from "../../hooks/useOutline";
import { type EditSurface, recentFocus } from "./edit-surface";
import classes from "./Outline.module.css";
import {
	type LocalSource,
	LocalSwitcherIndex,
	mergeSwitcherHits,
	type SwitcherHit,
	serverHit,
} from "./quick-switcher-index";

/** Wait this long after the last keystroke before asking the server. */
const SERVER_DEBOUNCE_MS = 120;
/** The local index is parsed in idle slices of this length once the page is live. */
const WARM_SLICE_MS = 6;
/** Until the page is live, look again this often. */
const WARM_DELAY_MS = 400;

export interface QuickSwitcherProps {
	spaceId: string;
	/** The live editing surface on screen (its page is the local index), if any. */
	surface: EditSurface | null;
	onClose: () => void;
	/** Go to a hit: the caller focuses in place or navigates. */
	onPick: (hit: SwitcherHit) => void;
}

/** One index per live page client, rebuilt lazily when the page changed. */
const indexes = new WeakMap<object, { index: LocalSwitcherIndex; source: LocalSource }>();

function localIndexOf(surface: EditSurface): { index: LocalSwitcherIndex; source: LocalSource } {
	const client = surface.client;
	let entry = indexes.get(client);
	if (!entry) {
		const index = new LocalSwitcherIndex();
		// Only the client and the page id: the index lives as long as the client (shared by every
		// surface of the page) and must not keep a destroyed surface alive.
		const pageId = surface.pageId;
		const source: LocalSource = {
			pageId,
			ids: () => client.visible.subtree(pageId),
			textOf: (id) => client.textOf(id),
		};
		client.on((event) => {
			if (event === "sync") index.invalidate();
		});
		entry = { index, source };
		indexes.set(client, entry);
	}
	return entry;
}

/** The local index of a surface (tests read its timings). */
export function quickSwitcherIndexOf(surface: EditSurface): LocalSwitcherIndex {
	return localIndexOf(surface).index;
}

export function QuickSwitcher({ spaceId, surface, onClose, onPick }: QuickSwitcherProps) {
	const { t } = useTranslation("outline");
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const [debounced] = useDebouncedValue(query, SERVER_DEBOUNCE_MS);
	const input = useRef<HTMLInputElement | null>(null);
	const trimmed = debounced.trim();
	const here = useOutlineSearch(trimmed, spaceId, trimmed.length > 0);
	const everywhere = useOutlineSearch(trimmed, null, trimmed.length > 0);

	useEffect(() => {
		input.current?.focus();
	}, []);

	const local = useMemo(() => {
		if (!surface) return [];
		const { index, source } = localIndexOf(surface);
		return index.search(source, spaceId, query, recentFocus());
	}, [surface, spaceId, query]);

	const hits = useMemo(() => {
		const server: SwitcherHit[] = [];
		if (trimmed && trimmed === query.trim()) {
			for (const h of here.data?.hits ?? []) server.push(serverHit(h, trimmed));
			for (const h of everywhere.data?.hits ?? []) server.push(serverHit(h, trimmed));
		}
		return mergeSwitcherHits(local, server, spaceId);
	}, [local, here.data, everywhere.data, trimmed, query, spaceId]);

	useEffect(() => {
		setActive((i) => Math.min(i, Math.max(0, hits.length - 1)));
	}, [hits.length]);

	const searching =
		query.trim().length > 0 &&
		(query.trim() !== trimmed || here.isFetching || everywhere.isFetching);

	const choose = (i: number) => {
		const hit = hits[i];
		if (!hit) return;
		onPick(hit);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.nativeEvent.isComposing || e.keyCode === 229) return;
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			onClose();
		} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const n = hits.length;
			if (n) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
		} else if (e.key === "Enter") {
			e.preventDefault();
			e.stopPropagation();
			choose(active);
		}
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the backdrop closes on a click outside
		<div
			className={classes.switcher}
			data-testid="outline-switcher"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) {
					e.preventDefault();
					onClose();
				}
			}}
		>
			<div className={classes.switcherBox} role="dialog" aria-label={t("switcher.label")}>
				<TextInput
					ref={input}
					value={query}
					onChange={(e) => {
						setQuery(e.currentTarget.value);
						setActive(0);
					}}
					onKeyDown={onKeyDown}
					placeholder={t("switcher.placeholder")}
					aria-label={t("switcher.label")}
					leftSection={<IconSearch size={16} />}
					rightSection={searching ? <Loader size={14} /> : null}
					variant="unstyled"
					px="sm"
					data-testid="outline-switcher-input"
				/>
				<div className={classes.switcherList} role="listbox">
					{hits.length === 0 && (
						<Text size="sm" c="dimmed" px="sm" py={6}>
							{query.trim()
								? searching
									? t("switcher.searching")
									: t("switcher.empty")
								: t("switcher.noRecent")}
						</Text>
					)}
					{hits.map((hit, i) => (
						// biome-ignore lint/a11y/useKeyWithClickEvents: keys are the input's (arrows, Enter)
						<div
							key={`${hit.spaceId}/${hit.blockId}`}
							role="option"
							tabIndex={-1}
							aria-selected={i === active}
							className={classes.switcherRow}
							data-active={i === active || undefined}
							data-block={hit.blockId}
							data-via={hit.via}
							data-local={hit.local || undefined}
							onMouseDown={(e) => e.preventDefault()}
							onMouseEnter={() => setActive(i)}
							onClick={() => choose(i)}
						>
							<span className={classes.switcherTitle}>{hit.label || "…"}</span>
							<span className={classes.switcherMeta}>{t(`switcher.via.${hit.via}`)}</span>
							<span className={classes.switcherMeta}>
								{hit.local
									? t("switcher.thisPage")
									: hit.spaceId !== spaceId
										? t("switcher.otherSpace")
										: (hit.path[0] ?? "")}
							</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

/**
 * Index the live page in idle time (small slices), so the first Mod-K does not parse 2000
 * blocks in one task.
 */
function useWarmIndex(surface: EditSurface | null): void {
	useEffect(() => {
		if (!surface) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let idle: number | undefined;
		const later = (delay: number) => {
			if (stopped) return;
			if (delay === 0 && typeof requestIdleCallback === "function") {
				idle = requestIdleCallback(step, { timeout: 1000 });
			} else timer = setTimeout(step, delay);
		};
		const step = (deadline?: IdleDeadline) => {
			if (stopped || surface.isDestroyed) return;
			if (!surface.client.ready) return later(WARM_DELAY_MS);
			const { index, source } = localIndexOf(surface);
			// Within the idle period the browser gives (a timed-out callback: one short slice).
			const budget = Math.min(WARM_SLICE_MS, deadline?.timeRemaining() ?? WARM_SLICE_MS);
			if (!index.warm(source, budget)) later(0);
		};
		later(0);
		return () => {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			if (idle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
		};
	}, [surface]);
}

/** Opens the switcher from outside (Mod-K, the toolbar's button). */
export interface QuickSwitcherHandle {
	open: () => void;
}

/**
 * The switcher's own open state: opening and closing it re-renders only it, not the surface
 * around it (closing happens in the same task as the focus it chose).
 */
export const QuickSwitcherHost = forwardRef<
	QuickSwitcherHandle,
	Omit<QuickSwitcherProps, "onClose"> & { onClosed: () => void }
>(function QuickSwitcherHost({ onPick, onClosed, ...rest }, ref) {
	const [open, setOpen] = useState(false);
	useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);
	useWarmIndex(rest.surface);
	if (!open) return null;
	return (
		<QuickSwitcher
			{...rest}
			onClose={() => {
				setOpen(false);
				onClosed();
			}}
			onPick={(hit) => {
				setOpen(false);
				onPick(hit);
			}}
		/>
	);
});
