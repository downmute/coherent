export class ServiceError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode = 500,
    code = 'internal_error',
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class NoCapacityError extends ServiceError {
  constructor(message = 'No warm GPU worker is available.') {
    super(message, 503, 'no_capacity');
  }
}

export class ProvisioningTimeoutError extends ServiceError {
  constructor(message = 'Provisioning started but no warm worker became ready in time.') {
    super(message, 503, 'provisioning_timeout');
  }
}
