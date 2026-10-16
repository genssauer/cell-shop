import type { FastifyInstance } from "fastify";
import { errorResponseSchema } from "../infrastructure/errors.js";
import type { GetOrderStatus } from "./get-status.js";

export function registerOrderRoutes(app: FastifyInstance, getOrderStatus: GetOrderStatus): void {
  app.get<{ Params: { orderId: string } }>("/orders/:orderId/status", {
    schema: {
      operationId: "getOrderStatus",
      summary: "Consulta o estado público do pedido.",
      params: {
        type: "object",
        additionalProperties: false,
        required: ["orderId"],
        properties: { orderId: { type: "string", minLength: 1 } },
      },
      response: {
        200: {
          type: "object",
          additionalProperties: false,
          required: ["orderId", "status", "updatedAt"],
          properties: {
            orderId: { type: "string" },
            status: { type: "string", enum: ["PROCESSING", "COMPLETED", "FAILED"] },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        404: errorResponseSchema(),
        500: errorResponseSchema(),
      },
    },
  }, async (request) => getOrderStatus.execute(request.params.orderId));
}
