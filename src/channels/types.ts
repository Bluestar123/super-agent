export interface IncomingMessage {
    channelId: string;
    senderId: string;
    senderName: string;
    text: string;
    raw?: unknown;
}

export interface OutgoingMessage {
    channelId: string;
    recipientId: string;
    text: string;
}

// 回调注册方法
export interface ChannelDefinition {
    name: string;
    description: string;

    start(): Promise<void> | void;
    stop(): Promise<void> | void;
    send(message: OutgoingMessage): Promise<void>;
    // Channel 收到外部消息后调用这个 handler
    onMessage?: (handler: (msg: IncomingMessage) => void) => void;
}
