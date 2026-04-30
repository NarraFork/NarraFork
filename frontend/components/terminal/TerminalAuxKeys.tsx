import { ActionIcon, Menu } from "@mantine/core";
import { IconDotsVertical, IconSwitchHorizontal } from "@tabler/icons-react";
import { useCallback, useEffect, useRef } from "react";

export interface Modifiers {
	ctrl: boolean;
	alt: boolean;
}

interface TerminalAuxKeysProps {
	onKey: (data: string) => void;
	mods: Modifiers;
	onToggleMod: (mod: keyof Modifiers) => void;
}

const ESC = "\x1b";

type AuxKey =
	| { kind: "key"; label: string; seq: string; repeat?: boolean }
	| { kind: "mod"; label: string; mod: "ctrl" | "alt" };

const COLS = 7;

const ROW1: AuxKey[] = [
	{ kind: "key", label: "Esc", seq: ESC },
	{ kind: "key", label: "Tab", seq: "\t" },
	{ kind: "key", label: "PgUp", seq: `${ESC}[5~` },
	{ kind: "key", label: "Home", seq: `${ESC}[H` },
	{ kind: "key", label: "↑", seq: `${ESC}[A`, repeat: true },
	{ kind: "key", label: "End", seq: `${ESC}[F` },
];

const ROW2: AuxKey[] = [
	{ kind: "mod", label: "Ctrl", mod: "ctrl" },
	{ kind: "mod", label: "Alt", mod: "alt" },
	{ kind: "key", label: "PgDn", seq: `${ESC}[6~` },
	{ kind: "key", label: "←", seq: `${ESC}[D`, repeat: true },
	{ kind: "key", label: "↓", seq: `${ESC}[B`, repeat: true },
	{ kind: "key", label: "→", seq: `${ESC}[C`, repeat: true },
];

const gridRow: React.CSSProperties = {
	display: "grid",
	gridTemplateColumns: `repeat(${COLS}, 1fr)`,
	gap: 2,
	padding: "3px 4px",
};

const cell: React.CSSProperties = {
	height: 30,
	width: "100%",
	fontSize: 12,
	fontFamily: "monospace",
};

/** ms before repeat starts / between repeats */
const REPEAT_DELAY = 400;
const REPEAT_INTERVAL = 80;

export function TerminalAuxKeys({ onKey, mods, onToggleMod }: TerminalAuxKeysProps) {
	const repeatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearRepeat = useCallback(() => {
		if (repeatTimer.current != null) {
			clearTimeout(repeatTimer.current);
			repeatTimer.current = null;
		}
	}, []);

	useEffect(() => clearRepeat, [clearRepeat]);

	const preventFocus = useCallback((e: React.MouseEvent | React.PointerEvent) => {
		e.preventDefault();
	}, []);

	const startRepeat = useCallback(
		(seq: string) => {
			clearRepeat();
			onKey(seq);
			repeatTimer.current = setTimeout(function tick() {
				onKey(seq);
				repeatTimer.current = setTimeout(tick, REPEAT_INTERVAL);
			}, REPEAT_DELAY);
		},
		[onKey, clearRepeat],
	);

	const renderKey = (k: AuxKey) => {
		if (k.kind === "mod") {
			const active = mods[k.mod];
			return (
				<ActionIcon
					key={k.label}
					variant={active ? "filled" : "subtle"}
					color={active ? "blue" : "gray"}
					size="sm"
					style={{ ...cell, fontWeight: active ? 700 : 400 }}
					onClick={() => onToggleMod(k.mod)}
				>
					{k.label}
				</ActionIcon>
			);
		}
		if (k.repeat) {
			return (
				<ActionIcon
					key={k.label}
					variant="subtle"
					color="gray"
					size="sm"
					style={cell}
					onPointerDown={(e) => {
						e.preventDefault();
						startRepeat(k.seq);
					}}
					onPointerUp={clearRepeat}
					onPointerLeave={clearRepeat}
					onPointerCancel={clearRepeat}
				>
					{k.label}
				</ActionIcon>
			);
		}
		return (
			<ActionIcon
				key={k.label}
				variant="subtle"
				color="gray"
				size="sm"
				style={cell}
				onClick={() => onKey(k.seq)}
			>
				{k.label}
			</ActionIcon>
		);
	};

	return (
		<div
			role="toolbar"
			onMouseDown={preventFocus}
			style={{
				flexShrink: 0,
				backgroundColor: "#15161e",
				borderTop: "1px solid #2a2b3d",
				zIndex: 1000,
			}}
		>
			<div style={gridRow}>
				{ROW1.map(renderKey)}
				<Menu shadow="md" width={160} position="top-end">
					<Menu.Target>
						<ActionIcon variant="subtle" color="gray" size="sm" style={cell}>
							<IconDotsVertical size={14} />
						</ActionIcon>
					</Menu.Target>
					<Menu.Dropdown>
						<Menu.Label>Menu</Menu.Label>
					</Menu.Dropdown>
				</Menu>
			</div>
			<div style={gridRow}>
				{ROW2.map(renderKey)}
				<ActionIcon variant="subtle" color="gray" size="sm" style={cell}>
					<IconSwitchHorizontal size={14} />
				</ActionIcon>
			</div>
		</div>
	);
}
