export declare const DEFAULT_APP_NAME: string;
export declare function escapeHtml(value: unknown): string;
export declare function appNameFromHost(hostHeader: string | null | undefined): string;
export declare function isInstallQuery(url: string | null | undefined): boolean;
export declare function isDocumentPath(pathname: string | null | undefined): boolean;
export declare function acceptsHtml(accept: string | null | undefined): boolean;
export declare function stripInstallParams(url: string | null | undefined): string;
export declare function renderInstallPageHtml(
  template: string,
  context?: { host?: string | null; url?: string | null },
): string;
export declare function renderWebManifest(hostHeader: string | null | undefined): string;
export declare function grokPwaHeadTags(appName?: string): Array<[string, string]>;
export declare function injectGrokPwaHead(html: string, appName?: string): string;
export declare function createHeadInjector(appName?: string): {
  push(chunk: Uint8Array | string): Uint8Array[];
  flush(): Uint8Array[];
};
