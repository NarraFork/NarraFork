import {
	type Icon,
	IconBan,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconClock,
	IconCode,
	IconEye,
	IconGitFork,
	IconHistory,
	IconListCheck,
	IconLoader2,
	IconMap,
	IconMessageQuestion,
	IconPencil,
	IconRobot,
	IconSearch,
	IconShare,
	IconTargetArrow,
	IconTerminal2,
	IconWand,
	IconWorldSearch,
	IconWorldWww,
	IconX,
} from "@tabler/icons-react";
import { Assets, type Container, Sprite, Texture } from "pixi.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCategory } from "../tool-display";

function hexColor(color: number): string {
	return `#${color.toString(16).padStart(6, "0")}`;
}

function iconForCategory(category?: ToolCategory): Icon {
	switch (category) {
		case "read":
			return IconEye;
		case "file":
			return IconPencil;
		case "bash":
			return IconTerminal2;
		case "search":
			return IconSearch;
		case "webSearch":
			return IconWorldSearch;
		case "webFetch":
			return IconWorldWww;
		case "todo":
			return IconListCheck;
		case "goal":
			return IconTargetArrow;
		case "taskOutput":
			return IconRobot;
		case "agent":
			return IconGitFork;
		case "await":
			return IconClock;
		case "send":
		case "ask":
			return IconMessageQuestion;
		case "plan":
			return IconMap;
		case "terminal":
			return IconTerminal2;
		case "share":
			return IconShare;
		case "recall":
			return IconHistory;
		case "skill":
			return IconWand;
		case "browser":
			return IconWorldWww;
		default:
			return IconCode;
	}
}

function iconForStatus(status?: string): Icon {
	switch (status) {
		case "completed":
		case "success":
			return IconCheck;
		case "running":
		case "initializing":
			return IconLoader2;
		case "pending":
		case "awaiting_permission":
			return IconClock;
		case "fail":
		case "failed":
		case "error":
			return IconX;
		case "cancelled":
			return IconBan;
		default:
			return IconClock;
	}
}

const textureCache = new Map<string, Texture>();
const loadingCache = new Set<string>();
const loadListeners = new Set<() => void>();

function notifyIconLoaded(): void {
	for (const listener of loadListeners) listener();
}

export function subscribePixiTablerIconLoads(listener: () => void): () => void {
	loadListeners.add(listener);
	return () => loadListeners.delete(listener);
}

function textureForIcon(
	IconComponent: Icon,
	cacheName: string,
	color: number,
	size: number,
): Texture {
	const dpr = Math.max(1, Math.ceil(window.devicePixelRatio || 1));
	const rasterSize = Math.max(size, size * dpr);
	const key = `${cacheName}:${color}:${size}:${dpr}`;
	const cached = textureCache.get(key);
	if (cached) return cached;
	if (!loadingCache.has(key)) {
		loadingCache.add(key);
		const svg = renderToStaticMarkup(
			createElement(IconComponent, {
				size: rasterSize,
				stroke: 2,
				color: hexColor(color),
			}),
		);
		const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
		Assets.load<Texture>(url)
			.then((texture) => {
				textureCache.set(key, texture);
				notifyIconLoaded();
			})
			.catch(() => {
				loadingCache.delete(key);
			});
	}
	return Texture.EMPTY;
}

export function getPixiToolCategoryIcon(
	category: ToolCategory | undefined,
	color: number,
	size: number,
): Texture {
	return textureForIcon(
		iconForCategory(category),
		`category:${category ?? "generic"}`,
		color,
		size,
	);
}

export function getPixiToolStatusIcon(
	status: string | undefined,
	color: number,
	size: number,
): Texture {
	return textureForIcon(iconForStatus(status), `status:${status ?? "unknown"}`, color, size);
}

export function getPixiToolChevronIcon(opened: boolean, color: number, size: number): Texture {
	return textureForIcon(
		opened ? IconChevronDown : IconChevronRight,
		`chevron:${opened}`,
		color,
		size,
	);
}

export class IconSpritePool {
	private pool: Sprite[] = [];
	private cursor = 0;

	constructor(private container: Container) {}

	reset(): void {
		this.cursor = 0;
	}

	acquire(texture: Texture, x: number, y: number, size: number, alpha = 1): Sprite {
		let sprite: Sprite;
		if (this.cursor < this.pool.length) {
			sprite = this.pool[this.cursor];
		} else {
			sprite = new Sprite(texture);
			this.pool.push(sprite);
			this.container.addChild(sprite);
		}
		this.cursor++;
		sprite.texture = texture;
		sprite.visible = true;
		sprite.alpha = alpha;
		sprite.position.set(x, y);
		sprite.width = size;
		sprite.height = size;
		return sprite;
	}

	releaseUnused(): void {
		for (let i = this.cursor; i < this.pool.length; i++) {
			this.pool[i].visible = false;
		}
	}
}

export function destroyPixiTablerIconCache(): void {
	for (const texture of textureCache.values()) {
		texture.destroy(true);
	}
	textureCache.clear();
	loadingCache.clear();
}
