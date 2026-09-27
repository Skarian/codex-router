/** Read-only completion evidence. Snapshot order, never file order, establishes input attribution. */
export declare class DesktopCommentary {
    private readonly threadId;
    status: {
        state: "available" | "unavailable";
        reason?: string;
    };
    private identity?;
    private offset;
    private pending;
    private readonly completed;
    private readonly emitted;
    constructor(threadId: string);
    poll(path: string, turnId: string, eligible: readonly Record<string, any>[]): Promise<Array<{
        itemId: string;
        text: string;
    }>>;
}
