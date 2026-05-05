import "server-only";

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

export function errorToResponse(error: unknown) {
  if (isHttpError(error)) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
      { status: error.status },
    );
  }
  const message =
    error instanceof Error ? error.message : "Internal Server Error";
  return Response.json(
    { error: { code: "internal_error", message } },
    { status: 500 },
  );
}
