/** Registry update check and profile-level self-update for this Bundle. */
/** One comparable SemVer release, including its prerelease identifiers. */
interface ParsedVersion {
    major: number;
    minor: number;
    patch: number;
    prerelease: string[];
}
/** Parse a SemVer string, or return undefined when the input is not a release. */
export declare function parseVersion(value: string): ParsedVersion | undefined;
/** Compare two SemVer releases; a prerelease sorts before its release. */
export declare function compareVersions(left: string, right: string): number;
/** Whether a release is a patch update of the same line, which is safe to install unattended. */
export declare function isPatchUpdate(current: string, next: string): boolean;
/**
 * Walk up from an installed module file until a directory holds both a
 * `package.json` with `dsh.profile` and a `node_modules` directory.
 */
export declare function findProfileDir(moduleUrl: string): string | undefined;
/** Update state exposed to Settings and logs. */
export interface UpdateStatus {
    current: string;
    latest?: string;
    available: boolean;
    checkedAt?: string;
    installing: boolean;
    updatedTo?: string;
    restartRequired: boolean;
    error?: string;
}
/** Injected process boundary so tests never spawn a package manager. */
export interface UpdateRunner {
    (command: string, args: string[], options: {
        cwd: string;
        timeoutMs: number;
        env: NodeJS.ProcessEnv;
    }): Promise<{
        code: number;
        output: string;
    }>;
}
/** Everything the updater needs from the host. */
export interface UpdateOptions {
    packageName: string;
    currentVersion: string;
    profileDir: string;
    intervalHours?: number;
    autoUpdate?: boolean;
    registry?: string;
    logger?: {
        info: (message: string) => void;
        warn: (message: string) => void;
    };
    runner?: UpdateRunner;
    fetchImpl?: typeof fetch;
    now?: () => number;
}
/** Locate the package manager DSH itself uses for profile installs. */
export declare function discoverPackageManager(argv: string[], execPath: string, platform?: NodeJS.Platform): {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
} | undefined;
/** Check the registry, and update the installed Bundle when a newer release exists. */
export declare class ComputerUseUpdater {
    private readonly options;
    private readonly runner;
    private readonly fetchImpl;
    private readonly now;
    private readonly statePath;
    private state;
    private timer;
    private running;
    constructor(options: UpdateOptions);
    /** Current update state, safe to serialize into the Settings snapshot. */
    status(): UpdateStatus;
    /** Start the background check; the first check runs shortly after plugin startup. */
    start(): void;
    /** Stop the background timer. */
    dispose(): void;
    /** Read the newest published version without changing the installation. */
    check(): Promise<UpdateStatus>;
    /** Install a published version into the profile that owns this module. */
    update(version?: string): Promise<UpdateStatus>;
    private runScheduledCheck;
    private readState;
    private writeState;
    private log;
}
/** Resolve the profile directory and installed version of the current module when possible. */
export declare function locateInstallation(moduleUrl: string): {
    profileDir: string;
    version: string;
} | undefined;
export {};
//# sourceMappingURL=update.d.ts.map