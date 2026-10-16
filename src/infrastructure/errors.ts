export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface ErrorResponse {
  code: string;
  message: string;
  requestId: string;
}

export function errorResponseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["code", "message", "requestId"],
    properties: {
      code: { type: "string" },
      message: { type: "string" },
      requestId: { type: "string" },
    },
  } as const;
}
