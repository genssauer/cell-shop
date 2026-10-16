import type { FastifyInstance } from "fastify";
import { errorResponseSchema } from "../infrastructure/errors.js";
import type { CatalogService } from "./service.js";

const productSchema = {
  type: "object",
  additionalProperties: false,
  required: ["productId", "sku", "name", "price", "availableQuantity", "priceAsOf"],
  properties: {
    productId: { type: "string" },
    sku: { type: "string" },
    name: { type: "string" },
    price: {
      type: "object",
      additionalProperties: false,
      required: ["currency", "amountCents"],
      properties: {
        currency: { type: "string", const: "BRL" },
        amountCents: { type: "integer", minimum: 0 },
      },
    },
    availableQuantity: { type: "integer", minimum: 0 },
    priceAsOf: { type: "string", format: "date-time" },
  },
};

export function registerCatalogRoutes(app: FastifyInstance, service: CatalogService): void {
  app.get("/products", {
    schema: {
      operationId: "listProducts",
      summary: "Lista produtos com preço válido e disponibilidade atual.",
      response: {
        200: {
          type: "object",
          additionalProperties: false,
          required: ["products", "asOf"],
          properties: {
            products: { type: "array", items: productSchema },
            asOf: { type: "string", format: "date-time" },
          },
        },
        503: errorResponseSchema(),
        500: errorResponseSchema(),
      },
    },
  }, async () => service.listProducts());
}
