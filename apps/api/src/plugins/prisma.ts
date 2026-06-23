import fp from "fastify-plugin";
import { PrismaClient } from "@carememory/db";
import type { FastifyInstance } from "fastify";

const prisma = new PrismaClient();

export default fp(async function prismaPlugin(fastify: FastifyInstance) {
  fastify.decorate("prisma", prisma);

  fastify.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}
