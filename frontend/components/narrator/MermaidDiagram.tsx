import { ActionIcon, Code, Group, Text, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconArrowsDiagonal,
	IconArrowsMaximize,
	IconArrowsMinimize,
	IconDownload,
} from "@tabler/icons-react";
import {
	type CSSProperties,
	memo,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { PANZOOM_TOOLTIP_Z, PanZoomStage } from "../common/PanZoomStage";
import classes from "./MarkdownContent.module.css";

/**
 * Lazily-loaded mermaid renderer. mermaid is a large dependency (~500KB+), so it
 * is only imported the first time a diagram actually needs to render — keeping it
 * out of the first-paint bundle. Modeled on MarkdownContent's loadMathPlugins.
 */

type MermaidApi = {
	initialize: (config: Record<string, unknown>) => void;
	render: (id: string, code: string, svgContainingElement?: Element) => Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidApi | null> | null = null;

function loadMermaid(): Promise<MermaidApi | null> {
	if (!mermaidPromise) {
		mermaidPromise = import("mermaid")
			.then((mod) => {
				const mermaid = mod.default as unknown as MermaidApi;
				// startOnLoad:false — we render programmatically. securityLevel:"strict"
				// escapes any HTML/JS embedded in the diagram source before producing SVG.
				mermaid.initialize({
					startOnLoad: false,
					theme: "dark",
					securityLevel: "strict",
				});
				return mermaid;
			})
			.catch(() => {
				mermaidPromise = null;
				return null;
			});
	}
	return mermaidPromise;
}

/**
 * A shared off-screen sandbox passed to `mermaid.render` as its
 * `svgContainingElement`. Without it, mermaid appends its temporary measuring
 * <div><svg width="100%"> straight to `document.body` in normal flow, which
 * briefly inflates page height and flashes the window scrollbar on every render.
 * Anchoring the temp elements inside this fixed, zero-size, hidden container
 * keeps all measurement work out of the document layout.
 */
let mermaidSandbox: HTMLDivElement | null = null;

function getMermaidSandbox(): HTMLDivElement {
	if (!mermaidSandbox?.isConnected) {
		const el = document.createElement("div");
		el.setAttribute("aria-hidden", "true");
		el.style.position = "fixed";
		el.style.top = "0";
		el.style.left = "0";
		el.style.width = "0";
		el.style.height = "0";
		el.style.overflow = "hidden";
		el.style.visibility = "hidden";
		el.style.pointerEvents = "none";
		document.body.appendChild(el);
		mermaidSandbox = el;
	}
	return mermaidSandbox;
}

/** Diagrams larger than this are not rendered (rendering would be slow/janky). */
const MERMAID_MAX_CHARS = 20_000;

/** In "fit" mode the diagram is capped to this height and scaled down to fit. */
const FIT_MAX_HEIGHT = 320;

/** PNG export renders at this pixel scale for crisp output on hi-dpi screens. */
const PNG_EXPORT_SCALE = 2;

/**
 * Read a mermaid <svg>'s intrinsic size from its viewBox (mermaid always emits a
 * viewBox). Falls back to width/height attributes if viewBox is missing.
 */
function readSvgIntrinsicSize(svg: SVGSVGElement): { width: number; height: number } | null {
	const vb = svg.viewBox?.baseVal;
	if (vb && vb.width > 0 && vb.height > 0) return { width: vb.width, height: vb.height };
	const w = Number.parseFloat(svg.getAttribute("width") ?? "");
	const h = Number.parseFloat(svg.getAttribute("height") ?? "");
	if (w > 0 && h > 0) return { width: w, height: h };
	return null;
}

/**
 * Imperatively size the injected <svg> per mode, overriding mermaid's own inline
 * `style="max-width:<natural>px"`. CSS can't reliably beat that inline style, so
 * we rewrite the element's inline width/height/max-* directly.
 *
 * Both modes fill the container width (so no diagram ever renders tiny — the
 * complaint that motivated this). The toggle is purely a HEIGHT control:
 * - "fit": full width, height capped at FIT_MAX_HEIGHT (compact scrollback).
 * - "actual": full width, height uncapped (the whole diagram, however tall).
 * For finer inspection the user opens the fullscreen pan/zoom view.
 */
function applySvgSize(host: HTMLDivElement | null, mode: SizeMode): void {
	const svg = host?.querySelector("svg") as SVGSVGElement | null;
	if (!svg) return;
	// mermaid emits width="100%" + inline `max-width:<naturalWidth>px`, which pins
	// the diagram to its intrinsic width (small for sparse/wide flowcharts). We
	// clear that px cap so `width:100%` truly fills the container and the diagram
	// scales UP to use the full bubble width.
	svg.style.width = "100%";
	svg.style.maxWidth = "none";
	svg.style.height = "auto";
	svg.style.maxHeight = mode === "fit" ? `${FIT_MAX_HEIGHT}px` : "none";
}

const containerStyle: CSSProperties = {
	position: "relative",
	width: "100%",
	maxWidth: "100%",
	overflowX: "auto",
	display: "flex",
	justifyContent: "center",
	padding: "var(--mantine-spacing-xs)",
};

const fallbackCodeStyle: CSSProperties = {
	maxWidth: "100%",
	whiteSpace: "pre-wrap",
	wordBreak: "break-word",
	overflowWrap: "break-word",
};

const toolbarStyle: CSSProperties = {
	position: "absolute",
	top: 4,
	right: 4,
	zIndex: 1,
};

type SizeMode = "fit" | "actual";

/**
 * Build a standalone PNG data blob from a rendered <svg> element.
 * The SVG is cloned, given an explicit size + background, serialized, drawn to a
 * scaled canvas, and exported as image/png. Returns null on failure.
 */
async function svgElementToPngBlob(svg: SVGSVGElement, background: string): Promise<Blob | null> {
	// Prefer the intrinsic viewBox size so the export is stable regardless of any
	// ancestor CSS transform (e.g. the fullscreen zoom) or fit-mode scaling.
	const viewBox = svg.viewBox?.baseVal;
	let width = viewBox?.width ? viewBox.width : 0;
	let height = viewBox?.height ? viewBox.height : 0;
	if (!width || !height) {
		const rect = svg.getBoundingClientRect();
		width = rect.width || svg.clientWidth || 0;
		height = rect.height || svg.clientHeight || 0;
	}
	width = Math.max(1, Math.ceil(width));
	height = Math.max(1, Math.ceil(height));

	const clone = svg.cloneNode(true) as SVGSVGElement;
	clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	clone.setAttribute("width", String(width));
	clone.setAttribute("height", String(height));

	const serialized = new XMLSerializer().serializeToString(clone);
	const svgBlob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
	const url = URL.createObjectURL(svgBlob);

	try {
		const image = new Image();
		image.decoding = "async";
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error("svg image load failed"));
			image.src = url;
		});

		const canvas = document.createElement("canvas");
		canvas.width = width * PNG_EXPORT_SCALE;
		canvas.height = height * PNG_EXPORT_SCALE;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.scale(PNG_EXPORT_SCALE, PNG_EXPORT_SCALE);
		ctx.fillStyle = background;
		ctx.fillRect(0, 0, width, height);
		ctx.drawImage(image, 0, 0, width, height);

		return await new Promise<Blob | null>((resolve) => {
			canvas.toBlob((blob) => resolve(blob), "image/png");
		});
	} finally {
		URL.revokeObjectURL(url);
	}
}

interface MermaidDiagramProps {
	code: string;
	/** Initial size mode. Live-streamed diagrams pass "actual"; history passes "fit". */
	defaultSizeMode?: SizeMode;
}

export const MermaidDiagram = memo(function MermaidDiagram({
	code,
	defaultSizeMode = "fit",
}: MermaidDiagramProps) {
	const { t } = useTranslation("common");
	// useId yields a stable, unique id per instance; mermaid needs a DOM-id-safe value.
	const rawId = useId();
	const renderId = `mermaid-${rawId.replace(/[^a-zA-Z0-9-]/g, "")}`;
	const [svg, setSvg] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const [pending, setPending] = useState(true);
	const [sizeMode, setSizeMode] = useState<SizeMode>(defaultSizeMode);
	const [exportError, setExportError] = useState(false);
	const [fullscreen, { open: openFullscreen, close: closeFullscreen }] = useDisclosure(false);
	const lastCodeRef = useRef<string>("");
	const svgHostRef = useRef<HTMLDivElement>(null);
	const fullscreenHostRef = useRef<HTMLDivElement>(null);
	const exportErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const tooLarge = code.length > MERMAID_MAX_CHARS;

	/**
	 * Stable `dangerouslySetInnerHTML` payload.
	 *
	 * React compares this prop BY OBJECT IDENTITY, so a fresh `{__html: svg}`
	 * literal made it re-write `innerHTML` on every re-render — replacing the <svg>
	 * node and wiping the inline width/height `applySvgSize` had written. The
	 * visible symptom was that clicking the diagram (which opens fullscreen, hence
	 * a re-render) ALSO dropped the height cap, so the inline diagram jumped to its
	 * full size as if the size toggle had been pressed. Memoizing keeps the node —
	 * and its sizing — alive across re-renders.
	 */
	const svgHtml = useMemo(() => (svg ? { __html: svg } : null), [svg]);

	useEffect(() => {
		if (tooLarge) return;
		const trimmed = code.trim();
		if (!trimmed) {
			setPending(false);
			return;
		}
		// Skip re-render when the source is unchanged across re-mounts.
		lastCodeRef.current = trimmed;
		let cancelled = false;
		setPending(true);
		setFailed(false);

		loadMermaid()
			.then(async (mermaid) => {
				if (!mermaid) throw new Error("mermaid unavailable");
				// Pass an off-screen sandbox so mermaid's temporary measuring
				// elements never touch the document flow (avoids scrollbar flash).
				const { svg: rendered } = await mermaid.render(renderId, trimmed, getMermaidSandbox());
				if (cancelled || lastCodeRef.current !== trimmed) return;
				setSvg(rendered);
				setPending(false);
			})
			.catch(() => {
				if (cancelled) return;
				setSvg(null);
				setFailed(true);
				setPending(false);
			});

		return () => {
			cancelled = true;
		};
	}, [code, tooLarge, renderId]);

	// After the SVG is injected (or the mode toggles), rewrite its inline size so
	// mermaid's own `max-width` doesn't pin narrow diagrams tiny or break "actual".
	//
	// This only stays correct because `svgHtml` is memoized on `svg`: React re-applies
	// `dangerouslySetInnerHTML` whenever that prop object changes IDENTITY, replacing
	// the <svg> node and discarding the sizing written here. With a fresh literal the
	// node was rebuilt on re-renders this effect does not observe, so the sizing was
	// silently lost. `[svg, sizeMode]` covers every case in which the node can change.
	useEffect(() => {
		if (!svg) return;
		applySvgSize(svgHostRef.current, sizeMode);
	}, [svg, sizeMode]);

	// Size the fullscreen SVG to contain within the viewport as a starting point;
	// PanZoomStage then handles wheel/drag/pinch zoom from there. We MUST give the
	// svg explicit intrinsic pixel dimensions (from its viewBox): a mermaid svg has
	// only a viewBox, and `width:auto` inside a shrink-to-fit flex parent collapses
	// to 0 (blank screen). With explicit px + max-width/height the svg's aspect
	// ratio scales it down to fit the viewport.
	useEffect(() => {
		if (!fullscreen || !svg) return;
		const el = fullscreenHostRef.current?.querySelector("svg") as SVGSVGElement | null;
		if (!el) return;
		const size = readSvgIntrinsicSize(el);
		el.style.maxWidth = "92vw";
		el.style.maxHeight = "92vh";
		if (size) {
			el.style.width = `${Math.round(size.width)}px`;
			el.style.height = `${Math.round(size.height)}px`;
		}
	}, [fullscreen, svg]);

	// Flip the inline height cap. The new height is picked up by the host's own
	// ResizeObserver (the vlist's onUnknownHeight path), so no explicit
	// notification is needed — the diagram just has to actually change size.
	const toggleSizeMode = useCallback(() => {
		setSizeMode((mode) => (mode === "fit" ? "actual" : "fit"));
	}, []);

	const handleExportPng = useCallback(async () => {
		// Prefer the fullscreen SVG when the fullscreen view is mounted, else the
		// inline one. querySelector on a live host reflects the current transform-
		// free intrinsic size, which is what we want for export.
		const host = fullscreenHostRef.current ?? svgHostRef.current;
		const svgEl = host?.querySelector("svg");
		if (!svgEl) return;
		try {
			const background =
				getComputedStyle(document.documentElement).getPropertyValue("--mantine-color-body") ||
				"#1a1b1e";
			const blob = await svgElementToPngBlob(svgEl as SVGSVGElement, background.trim());
			if (!blob) throw new Error("png encode failed");
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `diagram-${Date.now()}.png`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		} catch {
			// Non-fatal: show a transient export-error message WITHOUT tearing down
			// the rendered diagram (setFailed would collapse it to raw source).
			setExportError(true);
			if (exportErrorTimer.current) clearTimeout(exportErrorTimer.current);
			exportErrorTimer.current = setTimeout(() => setExportError(false), 2500);
		}
	}, []);

	// Clear any pending export-error timer on unmount.
	useEffect(() => {
		return () => {
			if (exportErrorTimer.current) clearTimeout(exportErrorTimer.current);
		};
	}, []);

	// Empty / whitespace-only source → render nothing (avoids a stuck "rendering"
	// placeholder, since there is no diagram to produce and svg stays null).
	if (!code.trim()) return null;

	// Oversized or failed → fall back to the raw source as a plain code block.
	if (tooLarge || failed) {
		return (
			<div>
				{failed && (
					<Text size="xs" c="red" mb={4}>
						{t("mermaidRenderFailed")}
					</Text>
				)}
				<Code block fz="xs" style={fallbackCodeStyle}>
					{code}
				</Code>
			</div>
		);
	}

	if (pending || !svg || !svgHtml) {
		return (
			<Text size="xs" c="dimmed" fs="italic" p="xs">
				{t("mermaidRendering")}
			</Text>
		);
	}

	// Sizing is applied inline via applySvgSize; the host class only carries
	// layout (centering + no text selection).
	const hostClassName = `nf-mermaid ${classes.mermaidSvgHost}`;

	return (
		<>
			<div className={classes.mermaidContainer} style={containerStyle}>
				<Group gap={4} className={classes.mermaidToolbar} style={toolbarStyle}>
					<Tooltip
						label={sizeMode === "fit" ? t("mermaidSwitchToActual") : t("mermaidSwitchToFit")}
						withArrow
						position="bottom"
					>
						<ActionIcon
							size="sm"
							variant="filled"
							color="gray"
							data-nf-mermaid-size-toggle
							onClick={toggleSizeMode}
							aria-label={sizeMode === "fit" ? t("mermaidSwitchToActual") : t("mermaidSwitchToFit")}
						>
							{/* Icon reflects the ACTION: fit → maximize (grow to actual),
							    actual → minimize (shrink to fit). This makes the button's
							    current-vs-target state unambiguous. */}
							{sizeMode === "fit" ? (
								<IconArrowsMaximize size={14} />
							) : (
								<IconArrowsMinimize size={14} />
							)}
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("mermaidFullscreen")} withArrow position="bottom">
						<ActionIcon
							size="sm"
							variant="filled"
							color="gray"
							onClick={openFullscreen}
							aria-label={t("mermaidFullscreen")}
						>
							<IconArrowsDiagonal size={14} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("mermaidExportPng")} withArrow position="bottom">
						<ActionIcon
							size="sm"
							variant="filled"
							color="gray"
							onClick={handleExportPng}
							aria-label={t("mermaidExportPng")}
						>
							<IconDownload size={14} />
						</ActionIcon>
					</Tooltip>
				</Group>
				{exportError && (
					<Text size="xs" c="red" className={classes.mermaidExportError}>
						{t("mermaidExportFailed")}
					</Text>
				)}
				{/* Click anywhere on the diagram opens the fullscreen pan/zoom view.
				    Keyboard/a11y access is provided by the dedicated fullscreen
				    toolbar button above, so this div is a mouse/touch shortcut only. */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: mouse/touch shortcut; keyboard path is the fullscreen toolbar button */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard access is provided by the fullscreen toolbar button */}
				<div
					ref={svgHostRef}
					className={hostClassName}
					data-nf-mermaid-body
					style={{ cursor: "zoom-in" }}
					onClick={openFullscreen}
					// biome-ignore lint/security/noDangerouslySetInnerHtml: SVG produced by mermaid with securityLevel "strict"
					dangerouslySetInnerHTML={svgHtml}
				/>
			</div>

			{fullscreen &&
				createPortal(
					<PanZoomStage
						onClose={closeFullscreen}
						closeOnBackdropClick
						renderToolbarExtra={() => (
							<Tooltip label={t("mermaidExportPng")} withinPortal zIndex={PANZOOM_TOOLTIP_Z}>
								<ActionIcon
									variant="subtle"
									color="gray"
									onClick={handleExportPng}
									aria-label={t("mermaidExportPng")}
								>
									<IconDownload size={18} />
								</ActionIcon>
							</Tooltip>
						)}
					>
						<div
							ref={fullscreenHostRef}
							className="nf-mermaid"
							data-nf-mermaid-fullscreen
							style={{ display: "flex" }}
							// biome-ignore lint/security/noDangerouslySetInnerHtml: SVG produced by mermaid with securityLevel "strict"
							dangerouslySetInnerHTML={svgHtml}
						/>
					</PanZoomStage>,
					document.body,
				)}
		</>
	);
});
