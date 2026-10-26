export interface InstanceData {
    url: string;
    username?: string;
    password?: string;
    token?: string;
    /** Longest wait for one request, in ms. Unset (the app, the cron servers): no limit. */
    requestTimeoutMs?: number;
}

export class Instance {
    public readonly url: string;
    public readonly token: string | undefined;
    public readonly requestTimeoutMs: number | undefined;
    private username: string | undefined;
    private password: string | undefined;

    constructor(data: InstanceData) {
        this.url = data.url;
        this.username = data.username;
        this.password = data.password;
        this.token = data.token;
        this.requestTimeoutMs = data.requestTimeoutMs;
    }

    public get auth(): { username: string; password: string } | undefined {
        return this.username && this.password ? { username: this.username, password: this.password } : undefined;
    }
}
