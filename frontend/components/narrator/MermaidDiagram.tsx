import { Code, Text } from "@mantine/core";
import { type CSSProperties, memo, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Lazily-loaded mermaid renderer. mermaid is a large dependency (~500KB+), so it
 * is only imported the first time a diagram actually needs to render — keeping it
 * out of the first-paint bundle. Modeled on MarkdownContent's loadMathPlugins.
 */

type MermaidApi = {
	initialize: (config: Record<string, unknown>) => void;
	render: (id: string, code: string) => Promise<{ svg: string }>;
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

/** Diagrams larger than this are not rendered (rendering would be slow/janky). */
const MERMAID_MAX_CHARS = 20_000;

const containerStyle: CSSProperties = {
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

interface MermaidDiagramProps {
	code: string;
}

export const MermaidDiagram = memo(function MermaidDiagram({ code }: MermaidDiagramProps) {
	const { t } = useTranslation("common");
	// useId yields a stable, unique id per instance; mermaid needs a DOM-id-safe value.
	const rawId = useId();
	const renderId = `mermaid-${rawId.replace(/[^a-zA-Z0-9-]/g, "")}`;
	const [svg, setSvg] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const [pending, setPending] = useState(true);
	const lastCodeRef = useRef<string>("");

	const tooLarge = code.length > MERMAID_MAX_CHARS;

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
				const { svg: rendered } = await mermaid.render(renderId, trimmed);
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

	if (pending || !svg) {
		return (
			<Text size="xs" c="dimmed" fs="italic" p="xs">
				{t("mermaidRendering")}
			</Text>
		);
	}

	return (
		<div
			className="nf-mermaid"
			style={containerStyle}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: SVG produced by mermaid with securityLevel "strict"
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
});
