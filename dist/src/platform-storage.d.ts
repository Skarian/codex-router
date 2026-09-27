export declare const noFollowFlag: number;
/** Validate named existing inputs, never unrelated descendants. Missing paths
 * are left to callers' required-file/open checks. Trusted principals may create
 * private inherited files during operation without another permission process. */
export declare function validateExistingPrivatePaths(paths: readonly string[]): Promise<void>;
export declare function assertNativeStoragePath(path: string): void;
export declare function preparePrivateDirectory(path: string, create?: boolean): Promise<void>;
export declare function assertPrivatePath(path: string, directory: boolean): Promise<void>;
/** Windows cannot fsync directories through Node. File contents are still flushed
 * before atomic replacement; do not claim POSIX-equivalent power-loss durability. */
export declare function syncDirectory(path: string): Promise<void>;
