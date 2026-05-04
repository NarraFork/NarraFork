export interface PixiMessageTheme {
	bodyBg: number;
	panelBg: number;
	panelBorder: number;
	text: number;
	dimmed: number;
	userBg: number;
	userBgAlpha: number;
	userBorder: number;
	assistantBg: number;
	assistantBorder: number;
	toolBg: number;
	toolBorder: number;
	systemBg: number;
	systemBorder: number;
	accent: number;
	green: number;
	yellow: number;
	red: number;
	blue: number;
	teal: number;
	indigo: number;
	pink: number;
	orange: number;
	violet: number;
	cyan: number;
	lime: number;
	grape: number;
	gray: number;
}

function cssColorToRgba(css: string): { hex: number; alpha: number } {
	if (!cssColorToRgba._ctx) {
		const c = document.createElement("canvas");
		c.width = 1;
		c.height = 1;
		cssColorToRgba._ctx = c.getContext("2d", { willReadFrequently: true });
	}
	const ctx = cssColorToRgba._ctx;
	if (!ctx) return { hex: 0xffffff, alpha: 1 };
	ctx.clearRect(0, 0, 1, 1);
	ctx.fillStyle = css.trim();
	ctx.fillRect(0, 0, 1, 1);
	const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
	return { hex: (r << 16) | (g << 8) | b, alpha: a / 255 };
}
cssColorToRgba._ctx = null as CanvasRenderingContext2D | null;

function cssColorToHex(css: string): number {
	return cssColorToRgba(css).hex;
}

function getVar(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function varToHex(name: string, fallback: number): number {
	const val = getVar(name);
	return val ? cssColorToHex(val) : fallback;
}

function varToRgba(
	name: string,
	fallback: { hex: number; alpha: number },
): { hex: number; alpha: number } {
	const val = getVar(name);
	return val ? cssColorToRgba(val) : fallback;
}

function isOledEnabled(): boolean {
	try {
		return localStorage.getItem("narrafork_oled") === "true";
	} catch {
		return false;
	}
}

let cached: { scheme: string; oled: boolean; theme: PixiMessageTheme } | null = null;

export function resolvePixiMessageTheme(): PixiMessageTheme {
	const scheme = document.documentElement.getAttribute("data-mantine-color-scheme") ?? "dark";
	const dark = scheme === "dark";
	const oled = isOledEnabled();
	if (cached && cached.scheme === scheme && cached.oled === oled) return cached.theme;

	const userBg = varToRgba("--mantine-color-indigo-light", {
		hex: dark ? 0x2b2d42 : 0xe7f0ff,
		alpha: 1,
	});

	let theme: PixiMessageTheme = {
		bodyBg: varToHex(
			dark ? "--mantine-color-dark-7" : "--mantine-color-gray-0",
			dark ? 0x1a1b1e : 0xf8f9fa,
		),
		panelBg: varToHex(
			dark ? "--mantine-color-dark-6" : "--mantine-color-white",
			dark ? 0x25262b : 0xffffff,
		),
		panelBorder: varToHex(
			dark ? "--mantine-color-dark-4" : "--mantine-color-gray-4",
			dark ? 0x495057 : 0xced4da,
		),
		text: varToHex(
			dark ? "--mantine-color-dark-0" : "--mantine-color-dark-9",
			dark ? 0xc1c2c5 : 0x212529,
		),
		dimmed: varToHex("--mantine-color-dimmed", 0x909296),
		userBg: userBg.hex,
		userBgAlpha: userBg.alpha,
		userBorder: varToHex("--mantine-color-indigo-5", 0x5c7cfa),
		assistantBg: varToHex(
			dark ? "--mantine-color-dark-7" : "--mantine-color-white",
			dark ? 0x1a1b1e : 0xffffff,
		),
		assistantBorder: varToHex(
			dark ? "--mantine-color-dark-5" : "--mantine-color-gray-3",
			dark ? 0x373a40 : 0xdee2e6,
		),
		toolBg: varToHex(
			dark ? "--mantine-color-dark-6" : "--mantine-color-gray-0",
			dark ? 0x25262b : 0xf8f9fa,
		),
		toolBorder: varToHex(
			dark ? "--mantine-color-dark-4" : "--mantine-color-gray-4",
			dark ? 0x495057 : 0xced4da,
		),
		systemBg: varToHex(
			dark ? "--mantine-color-dark-6" : "--mantine-color-gray-1",
			dark ? 0x25262b : 0xf1f3f5,
		),
		systemBorder: varToHex("--mantine-color-teal-5", 0x20c997),
		accent: varToHex("--mantine-color-indigo-5", 0x5c7cfa),
		green: varToHex("--mantine-color-green-5", 0x51cf66),
		yellow: varToHex("--mantine-color-yellow-5", 0xffd43b),
		red: varToHex("--mantine-color-red-5", 0xff6b6b),
		blue: varToHex("--mantine-color-blue-5", 0x339af0),
		teal: varToHex("--mantine-color-teal-5", 0x20c997),
		indigo: varToHex("--mantine-color-indigo-5", 0x5c7cfa),
		pink: varToHex("--mantine-color-pink-5", 0xf06595),
		orange: varToHex("--mantine-color-orange-5", 0xff922b),
		violet: varToHex("--mantine-color-violet-5", 0x845ef7),
		cyan: varToHex("--mantine-color-cyan-5", 0x22b8cf),
		lime: varToHex("--mantine-color-lime-5", 0x94d82d),
		grape: varToHex("--mantine-color-grape-5", 0xcc5de8),
		gray: varToHex("--mantine-color-gray-5", 0xadb5bd),
	};

	if (dark && oled) {
		theme = {
			...theme,
			bodyBg: 0x000000,
			panelBg: 0x000000,
			assistantBg: 0x000000,
			toolBg: 0x0a0a0a,
			systemBg: 0x0a0a0a,
		};
	}

	cached = { scheme, oled, theme };
	return theme;
}

export function invalidatePixiMessageThemeCache(): void {
	cached = null;
}
