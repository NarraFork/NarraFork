import type { ITheme } from "@xterm/xterm";

export interface TerminalThemeDefinition {
	key: string;
	label: string;
	theme: ITheme;
}

const tokyoNight: ITheme = {
	background: "#1a1b26",
	foreground: "#c0caf5",
	cursor: "#c0caf5",
	cursorAccent: "#1a1b26",
	selectionBackground: "#33467c",
	selectionForeground: "#c0caf5",
	black: "#15161e",
	red: "#f7768e",
	green: "#9ece6a",
	yellow: "#e0af68",
	blue: "#7aa2f7",
	magenta: "#bb9af7",
	cyan: "#7dcfff",
	white: "#a9b1d6",
	brightBlack: "#414868",
	brightRed: "#f7768e",
	brightGreen: "#9ece6a",
	brightYellow: "#e0af68",
	brightBlue: "#7aa2f7",
	brightMagenta: "#bb9af7",
	brightCyan: "#7dcfff",
	brightWhite: "#c0caf5",
};

const tokyoNightLight: ITheme = {
	background: "#d5d6db",
	foreground: "#343b58",
	cursor: "#343b58",
	cursorAccent: "#d5d6db",
	selectionBackground: "#99a7df",
	black: "#0f0f14",
	red: "#8c4351",
	green: "#485e30",
	yellow: "#8f5e15",
	blue: "#34548a",
	magenta: "#5a4a78",
	cyan: "#0f4b6e",
	white: "#343b58",
	brightBlack: "#9699a3",
	brightRed: "#8c4351",
	brightGreen: "#485e30",
	brightYellow: "#8f5e15",
	brightBlue: "#34548a",
	brightMagenta: "#5a4a78",
	brightCyan: "#0f4b6e",
	brightWhite: "#343b58",
};

const catppuccinMocha: ITheme = {
	background: "#1e1e2e",
	foreground: "#cdd6f4",
	cursor: "#f5e0dc",
	cursorAccent: "#1e1e2e",
	selectionBackground: "#585b70",
	black: "#45475a",
	red: "#f38ba8",
	green: "#a6e3a1",
	yellow: "#f9e2af",
	blue: "#89b4fa",
	magenta: "#f5c2e7",
	cyan: "#94e2d5",
	white: "#bac2de",
	brightBlack: "#585b70",
	brightRed: "#f38ba8",
	brightGreen: "#a6e3a1",
	brightYellow: "#f9e2af",
	brightBlue: "#89b4fa",
	brightMagenta: "#f5c2e7",
	brightCyan: "#94e2d5",
	brightWhite: "#a6adc8",
};

const dracula: ITheme = {
	background: "#282a36",
	foreground: "#f8f8f2",
	cursor: "#f8f8f2",
	cursorAccent: "#282a36",
	selectionBackground: "#44475a",
	black: "#21222c",
	red: "#ff5555",
	green: "#50fa7b",
	yellow: "#f1fa8c",
	blue: "#bd93f9",
	magenta: "#ff79c6",
	cyan: "#8be9fd",
	white: "#f8f8f2",
	brightBlack: "#6272a4",
	brightRed: "#ff6e6e",
	brightGreen: "#69ff94",
	brightYellow: "#ffffa5",
	brightBlue: "#d6acff",
	brightMagenta: "#ff92df",
	brightCyan: "#a4ffff",
	brightWhite: "#ffffff",
};

const nord: ITheme = {
	background: "#2e3440",
	foreground: "#d8dee9",
	cursor: "#d8dee9",
	cursorAccent: "#2e3440",
	selectionBackground: "#434c5e",
	black: "#3b4252",
	red: "#bf616a",
	green: "#a3be8c",
	yellow: "#ebcb8b",
	blue: "#81a1c1",
	magenta: "#b48ead",
	cyan: "#88c0d0",
	white: "#e5e9f0",
	brightBlack: "#4c566a",
	brightRed: "#bf616a",
	brightGreen: "#a3be8c",
	brightYellow: "#ebcb8b",
	brightBlue: "#81a1c1",
	brightMagenta: "#b48ead",
	brightCyan: "#8fbcbb",
	brightWhite: "#eceff4",
};

const solarizedDark: ITheme = {
	background: "#002b36",
	foreground: "#839496",
	cursor: "#839496",
	cursorAccent: "#002b36",
	selectionBackground: "#073642",
	black: "#073642",
	red: "#dc322f",
	green: "#859900",
	yellow: "#b58900",
	blue: "#268bd2",
	magenta: "#d33682",
	cyan: "#2aa198",
	white: "#eee8d5",
	brightBlack: "#586e75",
	brightRed: "#cb4b16",
	brightGreen: "#586e75",
	brightYellow: "#657b83",
	brightBlue: "#839496",
	brightMagenta: "#6c71c4",
	brightCyan: "#93a1a1",
	brightWhite: "#fdf6e3",
};

/** All available terminal themes */
export const TERMINAL_THEMES: TerminalThemeDefinition[] = [
	{ key: "tokyoNight", label: "Tokyo Night", theme: tokyoNight },
	{ key: "tokyoNightLight", label: "Tokyo Night Light", theme: tokyoNightLight },
	{ key: "catppuccin", label: "Catppuccin Mocha", theme: catppuccinMocha },
	{ key: "dracula", label: "Dracula", theme: dracula },
	{ key: "nord", label: "Nord", theme: nord },
	{ key: "solarized", label: "Solarized Dark", theme: solarizedDark },
];

/** Map of theme key → ITheme for quick lookup */
export const THEME_MAP = new Map(TERMINAL_THEMES.map((t) => [t.key, t.theme]));

/** Get theme by key, with auto mode support */
export function getTerminalTheme(key: string, colorScheme?: "light" | "dark"): ITheme {
	if (key === "auto") {
		return colorScheme === "light" ? tokyoNightLight : tokyoNight;
	}
	return THEME_MAP.get(key) ?? tokyoNight;
}
