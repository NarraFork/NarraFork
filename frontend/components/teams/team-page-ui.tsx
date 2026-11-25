/**
 * Small pieces the redesigned team page repeats: the status dot of a row or of the header's
 * sentence (the session status colours), and a branch's `+added -removed` in tabular figures.
 */
import { Box, Text } from "@mantine/core";
import type { TeamWorkDiffStat } from "@shared/project-teams";
import type { CSSProperties } from "react";
import type { RowTone, StatusTone } from "./team-page-model";

/** 「等你处理」's amber: the page's only saturated colour. */
export const ATTENTION_COLOR = "var(--mantine-color-yellow-6)";
export const ATTENTION_TEXT =
	"light-dark(var(--mantine-color-yellow-9), var(--mantine-color-yellow-4))";
export const ATTENTION_BG =
	"light-dark(var(--mantine-color-yellow-0), color-mix(in srgb, var(--mantine-color-yellow-9) 14%, var(--mantine-color-body)))";
export const ATTENTION_BORDER =
	"light-dark(var(--mantine-color-yellow-3), color-mix(in srgb, var(--mantine-color-yellow-7) 45%, transparent))";

export const TABULAR: CSSProperties = { fontVariantNumeric: "tabular-nums" };
export const MONO: CSSProperties = {
	fontFamily: "var(--mantine-font-family-monospace)",
	fontVariantNumeric: "tabular-nums",
};

const TONE_COLOR: Record<RowTone, string | null> = {
	amber: ATTENTION_COLOR,
	green: "var(--mantine-color-green-6)",
	blue: "var(--mantine-color-blue-6)",
	gray: "var(--mantine-color-dark-2)",
	hollow: null,
};

export function StatusDot({ tone, size = 8 }: { tone: RowTone; size?: number }) {
	const color = TONE_COLOR[tone];
	return (
		<Box
			component="span"
			aria-hidden
			data-tone={tone}
			style={{
				display: "inline-block",
				flexShrink: 0,
				width: size,
				height: size,
				borderRadius: "50%",
				background: color ?? "transparent",
				border: color ? undefined : "1.5px solid var(--mantine-color-dimmed)",
				boxShadow:
					tone === "blue"
						? "0 0 0 3px color-mix(in srgb, var(--mantine-color-blue-6) 22%, transparent)"
						: undefined,
			}}
		/>
	);
}

/** The header sentence's dot. */
export function statusTone(tone: StatusTone): RowTone {
	return tone === "active" ? "blue" : tone === "paused" ? "amber" : "hollow";
}

/** `+12 -3` in the diff colours and tabular figures; nothing while unknown. */
export function DiffCount({
	stat,
	size = "xs",
}: {
	stat: Pick<TeamWorkDiffStat, "added" | "removed"> | null | undefined;
	size?: "xs" | "sm";
}) {
	if (!stat) return null;
	return (
		<Text
			component="span"
			size={size}
			style={{ ...MONO, whiteSpace: "nowrap" }}
			data-testid="diff-count"
		>
			<span style={{ color: "var(--mantine-color-green-6)" }}>+{stat.added}</span>{" "}
			<span style={{ color: "var(--mantine-color-red-6)" }}>-{stat.removed}</span>
		</Text>
	);
}
