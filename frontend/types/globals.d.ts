declare const __APP_VERSION__: string;

interface LicenseEntry {
	name: string;
	version: string;
	license: string;
	author: string;
	repository: string;
	isDev: boolean;
	licenseText: string;
}
declare const __LICENSE_DATA__: LicenseEntry[];
