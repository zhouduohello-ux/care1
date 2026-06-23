import fp from "fastify-plugin";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";

export default fp(async function rawBodyPlugin(fastify: FastifyInstance) {
  fastify.addHook("preParsing", async (_request: FastifyRequest, _reply, payload: unknown) => {
    const chunks: Buffer[] = [];
    for await (const chunk of payload as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    _request.rawBody = raw.toString("utf-8");
    return Readable.from([raw]);
  });
});

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}
