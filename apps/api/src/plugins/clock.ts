import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

export interface Clock {
  now(): Date;
  advance(ms: number): void;
  setTime(date: Date): void;
}

class RealClock implements Clock {
  now(): Date {
    return new Date();
  }
  advance(): void {}
  setTime(): void {}
}

class VirtualClock implements Clock {
  private current: Date;

  constructor(initial = new Date()) {
    this.current = new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  setTime(date: Date): void {
    this.current = new Date(date.getTime());
  }
}

export interface ClockPluginOptions {
  virtual?: boolean;
  initialTime?: Date;
}

export default fp(async function clockPlugin(fastify: FastifyInstance, opts: ClockPluginOptions) {
  const clock: Clock = opts.virtual
    ? new VirtualClock(opts.initialTime)
    : new RealClock();

  fastify.decorate("clock", clock);
});

declare module "fastify" {
  interface FastifyInstance {
    clock: Clock;
  }
}
