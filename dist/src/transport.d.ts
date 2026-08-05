export type TransportKind = "proxy" | "stdio";
type MessageListener = (message: unknown) => void;
type CloseListener = (error?: Error) => void;
export interface MessageTransport {
    readonly kind: TransportKind;
    start(): Promise<void>;
    send(message: unknown): Promise<void>;
    onMessage(listener: MessageListener): () => void;
    onClose(listener: CloseListener): () => void;
    close(): Promise<void>;
}
declare abstract class BaseTransport implements MessageTransport {
    abstract readonly kind: TransportKind;
    private readonly messageListeners;
    private readonly closeListeners;
    abstract start(): Promise<void>;
    abstract send(message: unknown): Promise<void>;
    abstract close(): Promise<void>;
    onMessage(listener: MessageListener): () => void;
    onClose(listener: CloseListener): () => void;
    protected emitMessage(message: unknown): void;
    protected emitClose(error?: Error): void;
}
export declare class StdioTransport extends BaseTransport {
    readonly kind: "stdio";
    private child?;
    private closing;
    start(): Promise<void>;
    send(message: unknown): Promise<void>;
    close(): Promise<void>;
}
export declare class ProxyTransport extends BaseTransport {
    readonly kind: "proxy";
    private child?;
    private socket?;
    private closing;
    start(): Promise<void>;
    send(message: unknown): Promise<void>;
    close(): Promise<void>;
}
export {};
