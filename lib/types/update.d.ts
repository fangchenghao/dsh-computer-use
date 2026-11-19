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
    private intervalTimer;
    private scheduleGeneration;
    private running;
    /** Whether start() armed the background schedule, so configure() can re-arm it. */
    private started;
    /** Serializes registry checks so a manual click and a scheduled run never overlap. */
    private checking;
    /** Serializes installs so only one package-manager run can touch the profile at a time. */
    private installing;
    constructor(options: UpdateOptions);
    /** Current update state, safe to serialize into the Settings snapshot. */
    status(): UpdateStatus;
    /**
     * Apply live Settings changes. A toggle or interval change re-arms the
     * background schedule without touching any in-flight install.
     */
    configure(settings: {
        autoUpdate?: boolean;
        intervalHours?: number;
    }): void;
    /** Start the background check; the first check runs shortly after plugin startup. */
    start(): void;
    private armTimers;
    /** Stop the background timer. */
    dispose(): void;
    private clearTimers;
    /**
     * Read the newest published version without changing the installation.
     * Concurrent callers share the in-flight result, and a check never runs
     * while an install is editing the profile.
     */
    check(): Promise<UpdateStatus>;
    private performCheck;
    /**
     * Install a published version into the profile that owns this module.
     * An explicit version must be valid SemVer; concurrent calls share the
     * running install instead of starting a second package-manager run.
     */
    update(version?: string): Promise<UpdateStatus>;
    private performUpdate;
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