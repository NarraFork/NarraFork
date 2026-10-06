declare module "lang-map" {
	export interface MapReturn {
		extensions: Record<string, string[]>;
		languages: Record<string, string[]>;
	}

	function map(): MapReturn;

	namespace map {
		function extensions(language: string): string[];
		function languages(extension: string): string[];
	}

	export = map;
}
