import type { RecentTabFolderColor, RecentTabFolderIcon } from "@shared/recent-tabs";
import {
	IconBolt,
	IconBook,
	IconBookmark,
	IconBriefcase,
	IconBug,
	IconBulb,
	IconCode,
	IconFlag,
	IconFlame,
	IconFlask,
	IconFolder,
	IconHeart,
	IconHome,
	IconLock,
	IconMusic,
	IconPalette,
	IconRocket,
	IconStar,
	IconTerminal,
	IconWorld,
	type TablerIcon,
} from "@tabler/icons-react";

/** Icon key (persisted on the folder) → Tabler component. Keys come from `@shared/recent-tabs`. */
export const FOLDER_ICON_COMPONENTS: Record<RecentTabFolderIcon, TablerIcon> = {
	folder: IconFolder,
	star: IconStar,
	heart: IconHeart,
	flag: IconFlag,
	bookmark: IconBookmark,
	bolt: IconBolt,
	flame: IconFlame,
	rocket: IconRocket,
	bug: IconBug,
	code: IconCode,
	terminal: IconTerminal,
	book: IconBook,
	bulb: IconBulb,
	briefcase: IconBriefcase,
	home: IconHome,
	flask: IconFlask,
	palette: IconPalette,
	music: IconMusic,
	world: IconWorld,
	lock: IconLock,
};

export function folderIconComponent(icon: RecentTabFolderIcon | undefined): TablerIcon {
	return (icon && FOLDER_ICON_COMPONENTS[icon]) || IconFolder;
}

/** CSS colour for a folder's accent, or undefined for the default (inherits text colour). */
export function folderColorVar(color: RecentTabFolderColor | undefined): string | undefined {
	return color ? `var(--mantine-color-${color}-5)` : undefined;
}
