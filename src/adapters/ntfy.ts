import type {
	Notification,
	NotificationAdapter,
	NtfyHttpTransport,
} from "@/adapters/interfaces.ts";

export class FetchNtfyTransport implements NtfyHttpTransport {
	readonly #fetch: typeof fetch;

	public constructor(fetchImplementation: typeof fetch = fetch) {
		this.#fetch = fetchImplementation;
	}

	public async request(input: {
		readonly url: string;
		readonly headers: Readonly<Record<string, string>>;
		readonly body: string;
	}): Promise<{ readonly status: number; readonly body: string }> {
		const response = await this.#fetch(input.url, {
			method: "POST",
			headers: input.headers,
			body: input.body,
		});
		return { status: response.status, body: await response.text() };
	}
}

export class NtfyNotificationAdapter implements NotificationAdapter {
	readonly #baseUrl: string;
	readonly #transport: NtfyHttpTransport;

	public constructor(input: { readonly baseUrl: string; readonly transport: NtfyHttpTransport }) {
		const url = new URL(input.baseUrl);
		if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
			throw new Error("ntfy base URL must be an HTTPS URL without embedded credentials");
		}
		this.#baseUrl = url.toString().replace(/\/$/u, "");
		this.#transport = input.transport;
	}

	public async send(notification: Notification): Promise<void> {
		const response = await this.#transport.request({
			url: `${this.#baseUrl}/${encodeURIComponent(notification.topic)}`,
			headers: {
				"content-type": "text/plain; charset=utf-8",
				title: notification.title,
			},
			body: notification.body,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`ntfy notification failed with HTTP ${response.status}`);
		}
	}
}
