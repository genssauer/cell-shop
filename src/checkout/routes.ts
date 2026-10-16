import type { FastifyInstance } from "fastify";
import { errorResponseSchema } from "../infrastructure/errors.js";
import type { CreateOrder } from "./create-order.js";

const acceptedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["orderId", "status", "statusUrl"],
  properties: {
    orderId: { type: "string" },
    status: { type: "string", enum: ["PROCESSING", "COMPLETED", "FAILED"] },
    statusUrl: { type: "string" },
  },
};

export function registerCheckoutRoutes(app: FastifyInstance, createOrder: CreateOrder): void {
  app.post<{ Body: { items: Array<{ sku: string; quantity: number }> }; Headers: { "idempotency-key": string } }>("/checkout", {
    schema: {
      operationId: "createCheckout",
      summary: "Aceita um pedido e agenda o faturamento assíncrono.",
      headers: {
        type: "object",
        additionalProperties: true,
        required: ["idempotency-key"],
        properties: {
          "idempotency-key": { type: "string", minLength: 1, maxLength: 200 },
        },
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["sku", "quantity"],
              properties: {
                sku: { type: "string", minLength: 1, maxLength: 100 },
                quantity: { type: "integer", minimum: 1, maximum: 1_000_000 },
              },
            },
          },
        },
      },
      response: {
        202: acceptedSchema,
        400: errorResponseSchema(),
        409: errorResponseSchema(),
        422: errorResponseSchema(),
        503: errorResponseSchema(),
        500: errorResponseSchema(),
      },
    },
  }, async (request, reply) => {
    const result = await createOrder.execute(request.headers["idempotency-key"], request.body.items);
    return reply.code(202).send({
      orderId: result.orderId,
      status: result.status,
      statusUrl: result.statusUrl,
    });
  });
}
