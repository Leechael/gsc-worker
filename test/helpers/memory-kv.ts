import type { KvNamespaceLike } from '../../src/lib/google-oauth/store.js';

/** In-memory stand-in for a Workers KV namespace (TTL recorded, not enforced). */
export class MemoryKv implements KvNamespaceLike {
  readonly data = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.data.set(key, value);
    // Like Workers KV, a write without an expiration clears the previous one.
    if (options?.expirationTtl !== undefined) this.ttls.set(key, options.expirationTtl);
    else this.ttls.delete(key);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
    this.ttls.delete(key);
  }
}
