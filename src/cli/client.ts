import type { AgentFactoryOperation } from "@/contracts/daemon-protocol.ts";
import {
	DAEMON_PROTOCOL_VERSION,
	type DaemonRequest,
	DaemonRequestSchema,
	parseDaemonResponse,
} from "@/contracts/daemon-protocol.ts";

export interface DaemonTransport {
	exchange(socketPath: string, requestBody: string): Promise<string>;
}

export class DaemonUnavailableError extends Error {
	public constructor(socketPath: string, options?: ErrorOptions) {
		super(
			`Agent Factory daemon is not running or is unreachable at its local socket (${socketPath})`,
			options,
		);
		this.name = "DaemonUnavailableError";
	}
}

export class BunUnixDaemonTransport implements DaemonTransport {
	public async exchange(socketPath: string, requestBody: string): Promise<string> {
		let response: Response;
		try {
			response = await fetch("http://localhost/v1/request", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: requestBody,
				unix: socketPath,
			});
		} catch (error) {
			throw new DaemonUnavailableError(socketPath, { cause: error });
		}
		const body = await response.text();
		if (!response.ok) {
			throw new Error(`Agent Factory daemon rejected the request with HTTP ${response.status}`);
		}
		return body;
	}
}

export class AgentFactoryDaemonClient {
	readonly #socketPath: string;
	readonly #transport: DaemonTransport;
	readonly #nextRequestId: () => string;

	public constructor(input: {
		readonly socketPath: string;
		readonly transport: DaemonTransport;
		readonly nextRequestId: () => string;
	}) {
		this.#socketPath = input.socketPath;
		this.#transport = input.transport;
		this.#nextRequestId = input.nextRequestId;
	}

	public async request(request: AgentFactoryOperation): Promise<unknown> {
		const envelope: DaemonRequest = DaemonRequestSchema.parse({
			protocolVersion: DAEMON_PROTOCOL_VERSION,
			requestId: this.#nextRequestId(),
			request,
		});
		const raw = await this.#transport.exchange(this.#socketPath, JSON.stringify(envelope));
		let decoded: unknown;
		try {
			decoded = JSON.parse(raw);
		} catch (error) {
			throw new Error("Agent Factory daemon returned invalid JSON", { cause: error });
		}
		const response = parseDaemonResponse(decoded);
		if (response.requestId !== envelope.requestId) {
			throw new Error("Agent Factory daemon response request ID did not match");
		}
		if (!response.ok) {
			throw new Error(`${response.error.code}: ${response.error.message}`);
		}
		return response.result;
	}
}
