import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

export interface Clock {
  /** Get the current time. Without userId, returns real wall-clock time.
   *  With userId, returns the user's virtual time (if set), otherwise real time. */
  now(userId?: string): Date;
  /** Advance the virtual clock for a specific user. */
  advance(userId: string, ms: number): void;
  /** Set the virtual clock for a specific user to an absolute time. */
  setTime(userId: string, date: Date): void;
  /** Remove any per-user virtual clock override, reverting to real time. */
  resetUser(userId: string): void;
}

class RealClock implements Clock {
  now(): Date {
    return new Date();
  }
  advance(): void {}
  setTime(): void {}
  resetUser(): void {}
}

class VirtualClock implements Clock {
  private userTimes = new Map<string, Date>();

  now(userId?: string): Date {
    if (userId) {
      const t = this.userTimes.get(userId);
      return t ? new Date(t.getTime()) : new Date();
    }
    // No userId → real time (used by scheduler, webhooks, etc.)
    return new Date();
  }

  advance(userId: string, ms: number): void {
    const current = this.userTimes.get(userId) ?? new Date();
    this.userTimes.set(userId, new Date(current.getTime() + ms));
  }

  setTime(userId: string, date: Date): void {
    this.userTimes.set(userId, new Date(date.getTime()));
  }

  resetUser(userId: string): void {
    this.userTimes.delete(userId);
  }
}

export interface ClockPluginOptions {
  virtual?: boolean;
  initialTime?: Date;
}

export default fp(async function clockPlugin(fastify: FastifyInstance, opts: ClockPluginOptions) {
  const clock: Clock = opts.virtual
    ? new VirtualClock()
    : new RealClock();

  fastify.decorate("clock", clock);
});

declare module "fastify" {
  interface FastifyInstance {
    clock: Clock;
  }
}
