/**
 * Testovi za src/modules/channels/meta/prosljedjivanje.ts
 *
 * Kopija webhooka je usluga drugom sistemu, ne dio ugovora sa Metom. Zato se
 * ovdje najviše provjerava ono što NE smije: da ne baca, da ne mijenja tijelo
 * i da ne postoji kad adresa nije podešena.
 *
 * `config` je mockan da testovi ne zavise od stvarnog .env fajla.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lazniKonfig = vi.hoisted(() => ({
  NODE_ENV: 'test',
  LOG_LEVEL: 'error' as 'debug' | 'info' | 'warn' | 'error',
  META_WEBHOOK_FORWARD_URL: undefined as string | undefined,
}));

vi.mock('../src/config.js', () => ({ config: lazniKonfig }));

import { proslijediKopiju, ROK_MS } from '../src/modules/channels/meta/prosljedjivanje.js';

const CILJ = 'https://drugi-sistem.example.test/webhook/abc';
const POTPIS = 'sha256=0123456789abcdef';
const TIJELO = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }), 'utf8');

type FetchPotpis = (...argumenti: Parameters<typeof fetch>) => Promise<Response>;

let pozivi: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
  pozivi = [];
  lazniKonfig.META_WEBHOOK_FORWARD_URL = CILJ;
  const lazni: FetchPotpis = async (ulaz, init) => {
    pozivi.push({ url: String(ulaz), init: (init ?? {}) as RequestInit });
    return new Response('ok', { status: 200 });
  };
  vi.stubGlobal('fetch', lazni as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Dopušta da se pozadinski posao izvrši prije provjere. */
const pusti = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('prosljeđivanje Metinog webhooka', () => {
  it('ne šalje ništa kada adresa nije podešena', async () => {
    lazniKonfig.META_WEBHOOK_FORWARD_URL = undefined;
    proslijediKopiju(TIJELO, POTPIS);
    await pusti();
    expect(pozivi).toHaveLength(0);
  });

  it('šalje na podešenu adresu', async () => {
    proslijediKopiju(TIJELO, POTPIS);
    await pusti();
    expect(pozivi).toHaveLength(1);
    expect(pozivi[0].url).toBe(CILJ);
    expect(pozivi[0].init.method).toBe('POST');
  });

  it('prosljeđuje tijelo nepromijenjeno, bajt u bajt', async () => {
    proslijediKopiju(TIJELO, POTPIS);
    await pusti();
    // Ako se tijelo ikako dira, potpis prestaje vrijediti i primalac gubi
    // jedini način da provjeri odakle je poruka.
    expect(Buffer.from(pozivi[0].init.body as Uint8Array).equals(TIJELO)).toBe(true);
  });

  it('nosi Metin potpis dalje, da ga primalac može provjeriti', async () => {
    proslijediKopiju(TIJELO, POTPIS);
    await pusti();
    const zaglavlja = pozivi[0].init.headers as Record<string, string>;
    expect(zaglavlja['X-Hub-Signature-256']).toBe(POTPIS);
    expect(zaglavlja['Content-Type']).toBe('application/json');
  });

  it('ne vraća ništa što bi pozivalac mogao čekati', () => {
    // Namjerno `void`: kad bi vraćao Promise, neko bi ga prije ili kasnije
    // awaitao i time pad drugog sistema pretvorio u naše kašnjenje prema Meti.
    expect(proslijediKopiju(TIJELO, POTPIS)).toBeUndefined();
  });

  it('ne baca kada je drugi sistem nedostupan', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    expect(() => proslijediKopiju(TIJELO, POTPIS)).not.toThrow();
    await pusti();
  });

  it('ne baca kada drugi sistem vrati grešku', async () => {
    vi.stubGlobal('fetch', (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch);
    expect(() => proslijediKopiju(TIJELO, POTPIS)).not.toThrow();
    await pusti();
  });

  it('ima rok, da se veze ne gomilaju prema zamrznutom primaocu', () => {
    expect(ROK_MS).toBeGreaterThan(0);
    expect(ROK_MS).toBeLessThanOrEqual(30_000);
  });
});
