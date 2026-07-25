import { describe, it, expect, vi } from 'vitest';

/**
 * The desktop build proxies NPool so bulk `query()` goes through the native Rust
 * socket bridge instead of WebKitGTK's WebSockets.
 *
 * A previous version of that proxy replaced `nostr.relay()` / `nostr.group()`
 * with a hand-rolled object exposing only `query`/`close`. That silently deleted
 * `req()` from every caller, which broke NIP-46 (bunker) signing: NConnectSigner
 * holds a live kind-24133 subscription on `pool.group(...)` to receive the remote
 * signer's replies, so every sign and NIP-44 decrypt died with
 * "this.relay.req is not a function" — taking bookmark decryption and the backup
 * restore flow with it. Nothing in the suite noticed, because the shim only
 * exists on the Tauri path.
 *
 * These tests pin the contract the shim must satisfy: override `query`, preserve
 * everything else, keep `this` bound.
 */

/** The shim's shape, extracted so it can be tested without a real NPool. */
function makeRelayShim<T extends object>(
  underlying: T,
  nativeQuery: (filters: unknown[], opts?: unknown) => Promise<unknown[]>,
): T {
  return new Proxy(underlying, {
    get(t, prop) {
      if (prop === 'query') return nativeQuery;
      // Target as receiver, NOT the proxy: private `#fields` are keyed to the
      // real instance, so forwarding the proxy makes getters that read one throw.
      const value = Reflect.get(t, prop);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
}

/** Stand-in for NRelay1: has req/query/close and reads a private field. */
class FakeRelay {
  #url: string;
  constructor(url: string) { this.#url = url; }
  async *req(filters: unknown[]) {
    // Touching a private field proves `this` survived the proxy.
    yield ['EVENT', this.#url, { id: 'e1', filters }] as const;
    yield ['EOSE', this.#url] as const;
  }
  async query() { return [{ id: 'from-pool' }]; }
  async close() { return 'closed-' + this.#url; }
  get url() { return this.#url; }
}

describe('desktop relay shim', () => {
  it('routes query() through the native bridge, not the pool', async () => {
    const relay = new FakeRelay('wss://r.example');
    const native = vi.fn(async () => [{ id: 'from-native' }]);
    const shim = makeRelayShim(relay, native);

    await expect(shim.query()).resolves.toEqual([{ id: 'from-native' }]);
    expect(native).toHaveBeenCalledTimes(1);
  });

  it('PRESERVES req() — the NIP-46 regression', async () => {
    const relay = new FakeRelay('wss://bunker.example');
    const shim = makeRelayShim(relay, async () => []);

    // The exact call shape NConnectSigner uses for its kind-24133 subscription.
    expect(typeof shim.req).toBe('function');

    const seen: string[] = [];
    for await (const msg of shim.req([{ kinds: [24133] }])) {
      seen.push(msg[0]);
      if (msg[0] === 'EOSE') break;
    }
    expect(seen).toEqual(['EVENT', 'EOSE']);
  });

  it('keeps methods bound so private fields still resolve', async () => {
    const relay = new FakeRelay('wss://bound.example');
    const shim = makeRelayShim(relay, async () => []);

    // Destructuring drops the receiver — an unbound method would throw on #url.
    const { close } = shim;
    await expect(close()).resolves.toBe('closed-wss://bound.example');
  });

  it('passes through non-function properties untouched', () => {
    const relay = new FakeRelay('wss://props.example');
    const shim = makeRelayShim(relay, async () => []);
    expect(shim.url).toBe('wss://props.example');
  });

  it('exposes every method the underlying relay has', () => {
    const relay = new FakeRelay('wss://surface.example');
    const shim = makeRelayShim(relay, async () => []);

    // The original bug was a MISSING method, so assert on the whole surface
    // rather than spot-checking the ones we happen to remember.
    for (const name of ['req', 'query', 'close'] as const) {
      expect(typeof shim[name]).toBe('function');
    }
  });
});
