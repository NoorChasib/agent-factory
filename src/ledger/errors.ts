export class LedgerError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "LedgerError";
	}
}

export class LedgerMigrationError extends LedgerError {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "LedgerMigrationError";
	}
}

export class LedgerOwnershipError extends LedgerError {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "LedgerOwnershipError";
	}
}

export class LedgerRevisionConflictError extends LedgerError {
	public readonly expectedRevision: number;
	public readonly currentRevision: number;

	public constructor(expectedRevision: number, currentRevision: number) {
		super(`ledger revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
		this.name = "LedgerRevisionConflictError";
		this.expectedRevision = expectedRevision;
		this.currentRevision = currentRevision;
	}
}

export class LedgerCorruptionError extends LedgerError {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "LedgerCorruptionError";
	}
}
