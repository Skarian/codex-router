import { type Server } from "node:http";
import { Gateway } from "./gateway.js";
export declare function createGatewayServer(gateway: Gateway): Server;
export declare function listenGateway(server: Server, port: number): Promise<void>;
export declare function closeGatewayServer(server: Server): Promise<void>;
