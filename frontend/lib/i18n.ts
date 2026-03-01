import enChapters from "@frontend/locales/en/chapters.json";
import enCommon from "@frontend/locales/en/common.json";
import enContainers from "@frontend/locales/en/containers.json";
import enDashboard from "@frontend/locales/en/dashboard.json";
import enExplorations from "@frontend/locales/en/explorations.json";
import enGit from "@frontend/locales/en/git.json";
import enGraph from "@frontend/locales/en/graph.json";
import enNarrator from "@frontend/locales/en/narrator.json";
import enNarrators from "@frontend/locales/en/narrators.json";
import enNav from "@frontend/locales/en/nav.json";
import enProjects from "@frontend/locales/en/projects.json";
import enSearch from "@frontend/locales/en/search.json";
import enSettings from "@frontend/locales/en/settings.json";
import enTerminal from "@frontend/locales/en/terminal.json";
import zhChapters from "@frontend/locales/zh-CN/chapters.json";
import zhCommon from "@frontend/locales/zh-CN/common.json";
import zhContainers from "@frontend/locales/zh-CN/containers.json";
import zhDashboard from "@frontend/locales/zh-CN/dashboard.json";
import zhExplorations from "@frontend/locales/zh-CN/explorations.json";
import zhGit from "@frontend/locales/zh-CN/git.json";
import zhGraph from "@frontend/locales/zh-CN/graph.json";
import zhNarrator from "@frontend/locales/zh-CN/narrator.json";
import zhNarrators from "@frontend/locales/zh-CN/narrators.json";
import zhNav from "@frontend/locales/zh-CN/nav.json";
import zhProjects from "@frontend/locales/zh-CN/projects.json";
import zhSearch from "@frontend/locales/zh-CN/search.json";
import zhSettings from "@frontend/locales/zh-CN/settings.json";
import zhTerminal from "@frontend/locales/zh-CN/terminal.json";
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

const ns = [
	"common",
	"chapters",
	"containers",
	"dashboard",
	"explorations",
	"git",
	"graph",
	"narrator",
	"nav",
	"projects",
	"search",
	"narrators",
	"settings",
	"terminal",
] as const;

i18n
	.use(LanguageDetector)
	.use(initReactI18next)
	.init({
		resources: {
			en: {
				common: enCommon,
				chapters: enChapters,
				containers: enContainers,
				dashboard: enDashboard,
				explorations: enExplorations,
				git: enGit,
				graph: enGraph,
				narrator: enNarrator,
				nav: enNav,
				projects: enProjects,
				search: enSearch,
				narrators: enNarrators,
				settings: enSettings,
				terminal: enTerminal,
			},
			"zh-CN": {
				common: zhCommon,
				chapters: zhChapters,
				containers: zhContainers,
				dashboard: zhDashboard,
				explorations: zhExplorations,
				git: zhGit,
				graph: zhGraph,
				narrator: zhNarrator,
				nav: zhNav,
				projects: zhProjects,
				search: zhSearch,
				narrators: zhNarrators,
				settings: zhSettings,
				terminal: zhTerminal,
			},
		},
		fallbackLng: "en",
		defaultNS: "common",
		ns: [...ns],
		interpolation: {
			escapeValue: false,
		},
		detection: {
			order: ["localStorage", "navigator"],
			lookupLocalStorage: "narrafork_lang",
			caches: ["localStorage"],
		},
	});

i18n.on("languageChanged", (lng) => {
	document.documentElement.lang = lng;
});
document.documentElement.lang = i18n.language;

export default i18n;
