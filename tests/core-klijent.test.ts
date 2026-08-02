/**
 * Testovi za src/modules/core-api/core-klijent.ts
 *
 * Klijent je jedini put do Coreovog internog API-ja, pa se ovdje provjerava i
 * ono što se šalje (zaglavlje x-internal-key, oblik tijela) i kako se tumači
 * ono što stigne nazad — posebno HTTP 409, koji NIJE greška nego ishod.
 *
 * `config` je mockan da testovi ne zavise od stvarnog .env fajla.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lazniKonfig = vi.hoisted(() => ({
  NODE_ENV: 'test',
  LOG_LEVEL: 'debug' as 'debug' | 'info' | 'warn' | 'error',
  CORE_BASE_URL: 'https://core.example.test/' as string | undefined,
  CORE_INTERNAL_API_KEY: 'tajni-interni-kljuc' as string | undefined,
}));

vi.mock('../src/config.js', () => ({ config: lazniKonfig }));

import {
  CoreNijePodesenError,
  ROK_MS,
  dohvatiKontekst,
  napraviTermin,
  otkaziTermin,
  pomjeriTermin,
  slobodniTermini,
  type RazlogTermina,
} from '../src/modules/core-api/core-klijent.js';

const BIZNIS = '11111111-1111-4111-8111-111111111111';
const USLUGA = '22222222-2222-4222-8222-222222222222';
const ZAPOSLENIK = '33333333-3333-4333-8333-333333333333';
const TERMIN = '44444444-4444-4444-8444-444444444444';
const TELEFON = '38762888817';

type FetchPotpis = (...argumenti: Parameters<typeof fetch>) => Promise<Response>;

const fetchMock = vi.fn<FetchPotpis>();

function odgovori(status: number, tijelo: unknown): void {
  fetchMock.mockResolvedValueOnce(
    new Response(tijelo === undefined ? '' : JSON.stringify(tijelo), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function prvaAdresa(): string {
  return String(fetchMock.mock.calls[0][0]);
}

function prvaZaglavlja(): Record<string, string> {
  const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

function prvoTijelo(): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

const NOVI_TERMIN = {
  businessId: BIZNIS,
  startAt: '2026-08-05T07:00:00.000Z',
  endAt: '2026-08-05T07:45:00.000Z',
  serviceId: USLUGA,
  staffMemberId: ZAPOSLENIK,
  klijent: { ime: 'Amina', telefon: TELEFON },
  biljeska: 'preko WhatsAppa',
  idempotencyKey: 'wamid.ABC',
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  lazniKonfig.CORE_BASE_URL = 'https://core.example.test/';
  lazniKonfig.CORE_INTERNAL_API_KEY = 'tajni-interni-kljuc';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Autentikacija zahtjeva
// ---------------------------------------------------------------------------

describe('svaki zahtjev nosi x-internal-key', () => {
  it('šalje ključ i pogađa {CORE_BASE_URL}/api/internal', async () => {
    odgovori(200, { business: { id: BIZNIS, name: 'Salon Ana' }, services: [], staff: [], working_hours: [] });

    await dohvatiKontekst(BIZNIS);

    expect(prvaZaglavlja()['x-internal-key']).toBe('tajni-interni-kljuc');
    expect(prvaAdresa()).toBe(
      `https://core.example.test/api/internal/context?business_id=${BIZNIS}`,
    );
  });

  it('šalje ključ i na POST rutama', async () => {
    odgovori(200, { ok: true, appointment_id: TERMIN, created: true });

    await napraviTermin(NOVI_TERMIN);

    expect(prvaZaglavlja()['x-internal-key']).toBe('tajni-interni-kljuc');
    expect(prvaZaglavlja()['content-type']).toBe('application/json');
  });

  it('baca jasnu grešku kad CORE_BASE_URL nije postavljen', async () => {
    lazniKonfig.CORE_BASE_URL = undefined;
    await expect(dohvatiKontekst(BIZNIS)).rejects.toBeInstanceOf(CoreNijePodesenError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('baca jasnu grešku kad CORE_INTERNAL_API_KEY nije postavljen', async () => {
    lazniKonfig.CORE_INTERNAL_API_KEY = undefined;
    await expect(napraviTermin(NOVI_TERMIN)).rejects.toThrow(/CORE_INTERNAL_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Uspješni odgovori
// ---------------------------------------------------------------------------

describe('dohvatiKontekst', () => {
  it('pretvara odgovor iz ugovora u domenski oblik', async () => {
    odgovori(200, {
      business: { id: BIZNIS, name: 'Salon Ana', vertical: 'hair_salon', timezone: 'Europe/Sarajevo' },
      services: [{ id: USLUGA, name: 'Šišanje', duration_minutes: 45, price_cents: 2500, active: true }],
      staff: [{ id: ZAPOSLENIK, full_name: 'Ana', title: 'Frizer', active: true }],
      working_hours: [{ staff_member_id: ZAPOSLENIK, weekday: 1, start_time: '09:00', end_time: '17:00' }],
    });

    const ishod = await dohvatiKontekst(BIZNIS);

    expect(ishod.ok).toBe(true);
    if (!ishod.ok) return;
    expect(ishod.kontekst.firma).toEqual({
      id: BIZNIS,
      naziv: 'Salon Ana',
      vertikala: 'hair_salon',
      vremenskaZona: 'Europe/Sarajevo',
    });
    expect(ishod.kontekst.usluge).toEqual([
      { id: USLUGA, naziv: 'Šišanje', trajanjeMinuta: 45, cijenaCenti: 2500, aktivna: true },
    ]);
    expect(ishod.kontekst.zaposlenici).toEqual([
      { id: ZAPOSLENIK, punoIme: 'Ana', titula: 'Frizer', aktivan: true },
    ]);
    expect(ishod.kontekst.radnoVrijeme).toEqual([
      { staffMemberId: ZAPOSLENIK, danUSedmici: 1, pocetak: '09:00', kraj: '17:00' },
    ]);
  });

  it('404 vraća nijeNadjeno, ne baca', async () => {
    odgovori(404, { error: 'not found' });
    const ishod = await dohvatiKontekst(BIZNIS);
    expect(ishod).toMatchObject({ ok: false, vrsta: 'nijeNadjeno', status: 404 });
  });

  it('odbija businessId koji nije UUID prije nego išta pošalje', async () => {
    const ishod = await dohvatiKontekst('nije-uuid');
    expect(ishod).toMatchObject({ ok: false, vrsta: 'ulaz' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('slobodniTermini', () => {
  it('šalje snake_case tijelo i vraća listu termina', async () => {
    odgovori(200, {
      date: '2026-08-05',
      slots: [
        { start_at: '2026-08-05T07:00:00.000Z', end_at: '2026-08-05T07:45:00.000Z', staff_member_id: ZAPOSLENIK },
      ],
    });

    const ishod = await slobodniTermini({
      businessId: BIZNIS,
      datum: '2026-08-05',
      serviceId: USLUGA,
      staffMemberId: ZAPOSLENIK,
      trajanjeMinuta: 45,
    });

    expect(prvaAdresa()).toBe('https://core.example.test/api/internal/availability');
    expect(prvoTijelo()).toEqual({
      business_id: BIZNIS,
      date: '2026-08-05',
      service_id: USLUGA,
      staff_member_id: ZAPOSLENIK,
      duration_minutes: 45,
    });
    expect(ishod.ok).toBe(true);
    if (!ishod.ok) return;
    expect(ishod.datum).toBe('2026-08-05');
    expect(ishod.termini).toHaveLength(1);
    expect(ishod.termini[0].staffMemberId).toBe(ZAPOSLENIK);
  });

  it('prazna lista termina je uspjeh, ne greška', async () => {
    odgovori(200, { date: '2026-08-05', slots: [] });
    const ishod = await slobodniTermini({ businessId: BIZNIS, datum: '2026-08-05' });
    expect(ishod).toEqual({ ok: true, datum: '2026-08-05', termini: [] });
  });
});

describe('napraviTermin — uspjeh', () => {
  it('vraća appointmentId i created, šalje ugovoreno tijelo', async () => {
    odgovori(200, { ok: true, appointment_id: TERMIN, created: true });

    const ishod = await napraviTermin(NOVI_TERMIN);

    expect(prvoTijelo()).toEqual({
      business_id: BIZNIS,
      start_at: '2026-08-05T07:00:00.000Z',
      end_at: '2026-08-05T07:45:00.000Z',
      client: { full_name: 'Amina', phone: TELEFON },
      idempotency_key: 'wamid.ABC',
      service_id: USLUGA,
      staff_member_id: ZAPOSLENIK,
      notes: 'preko WhatsAppa',
    });
    expect(ishod).toEqual({ ok: true, appointmentId: TERMIN, created: true });
  });

  it('created:false znači da je idempotency ključ već postojao', async () => {
    odgovori(200, { ok: true, appointment_id: TERMIN, created: false });
    const ishod = await napraviTermin(NOVI_TERMIN);
    expect(ishod).toEqual({ ok: true, appointmentId: TERMIN, created: false });
  });

  it('bez idempotencyKey ne šalje ništa', async () => {
    const ishod = await napraviTermin({ ...NOVI_TERMIN, idempotencyKey: '  ' });
    expect(ishod).toMatchObject({ ok: false, vrsta: 'ulaz' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HTTP 409 — očekivan ishod, nikad izuzetak
// ---------------------------------------------------------------------------

describe('HTTP 409 nije greška nego strukturiran razlog', () => {
  const razlozi: RazlogTermina[] = ['staffConflict', 'staffUnavailable', 'outsideHours', 'invalidTime'];

  for (const razlog of razlozi) {
    it(`napraviTermin vraća razlog ${razlog} i zabranjuje ponavljanje`, async () => {
      odgovori(409, { ok: false, reason: razlog });

      const ishod = await napraviTermin(NOVI_TERMIN);

      expect(ishod).toMatchObject({
        ok: false,
        vrsta: 'odbijeno',
        razlog,
        status: 409,
        ponoviti: false,
      });
      // Ključno: nijedan ponovljeni zahtjev poslije 409.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it('pomjeriTermin ima isti oblik konflikta kao kreiranje', async () => {
    odgovori(409, { ok: false, reason: 'staffConflict' });

    const ishod = await pomjeriTermin({
      businessId: BIZNIS,
      appointmentId: TERMIN,
      startAt: '2026-08-06T07:00:00.000Z',
      endAt: '2026-08-06T07:45:00.000Z',
    });

    expect(ishod).toMatchObject({ ok: false, vrsta: 'odbijeno', razlog: 'staffConflict', ponoviti: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('otkaziTermin vraća alreadyTerminal', async () => {
    odgovori(409, { ok: false, reason: 'alreadyTerminal' });

    const ishod = await otkaziTermin({ businessId: BIZNIS, appointmentId: TERMIN, razlog: 'customer' });

    expect(ishod).toMatchObject({ ok: false, vrsta: 'odbijeno', razlog: 'alreadyTerminal', ponoviti: false });
    expect(prvoTijelo()).toEqual({
      business_id: BIZNIS,
      appointment_id: TERMIN,
      reason: 'customer',
    });
  });

  it('nepoznat reason u 409 postaje "nepoznato", i dalje bez bacanja', async () => {
    odgovori(409, { ok: false, reason: 'nesto_novo_iz_corea' });
    const ishod = await napraviTermin(NOVI_TERMIN);
    expect(ishod).toMatchObject({ ok: false, vrsta: 'odbijeno', razlog: 'nepoznato', ponoviti: false });
  });

  it('otkaziTermin bez konflikta vraća ok', async () => {
    odgovori(200, { ok: true });
    const ishod = await otkaziTermin({ businessId: BIZNIS, appointmentId: TERMIN });
    expect(ishod).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Kvarovi
// ---------------------------------------------------------------------------

describe('kvarovi se vraćaju, ne ruše proces', () => {
  it('401 kaže da integracija nije podešena', async () => {
    odgovori(401, { error: 'unauthorized' });

    const ishod = await dohvatiKontekst(BIZNIS);

    expect(ishod).toMatchObject({ ok: false, vrsta: 'autorizacija', status: 401, ponoviti: false });
    if (ishod.ok) return;
    expect(ishod.poruka).toMatch(/nije podešena/i);
    expect(ishod.poruka).toMatch(/CORE_INTERNAL_API_KEY/);
  });

  it('503 kaže da interni API nije dostupan', async () => {
    odgovori(503, { error: 'unavailable' });
    const ishod = await napraviTermin(NOVI_TERMIN);
    expect(ishod).toMatchObject({ ok: false, vrsta: 'nedostupno', status: 503 });
    if (ishod.ok) return;
    expect(ishod.poruka).toMatch(/nije podešena|nije dostupan/i);
  });

  it('500 postaje server neuspjeh', async () => {
    odgovori(500, { error: 'boom' });
    const ishod = await napraviTermin(NOVI_TERMIN);
    expect(ishod).toMatchObject({ ok: false, vrsta: 'server', status: 500 });
  });

  it('mrežna greška je uhvaćena', async () => {
    fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND core.example.test'));

    const ishod = await napraviTermin(NOVI_TERMIN);

    expect(ishod).toMatchObject({ ok: false, vrsta: 'mreza', status: null });
    if (ishod.ok) return;
    expect(ishod.poruka).toMatch(/ENOTFOUND/);
  });

  it('odgovor koji nije JSON postaje neuspjeh "odgovor"', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502 Bad Gateway</html>', { status: 200 }));
    const ishod = await dohvatiKontekst(BIZNIS);
    expect(ishod).toMatchObject({ ok: false, vrsta: 'odgovor' });
  });

  it('istek roka od 15 s prekida zahtjev i vraća neuspjeh "istek"', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_adresa, init) =>
        new Promise<Response>((_rijesi, odbij) => {
          init?.signal?.addEventListener('abort', () => {
            const greska = new Error('The operation was aborted.');
            greska.name = 'AbortError';
            odbij(greska);
          });
        }),
    );

    const uToku = napraviTermin(NOVI_TERMIN);
    await vi.advanceTimersByTimeAsync(ROK_MS);
    const ishod = await uToku;

    expect(ishod).toMatchObject({ ok: false, vrsta: 'istek', status: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Privatnost logova
// ---------------------------------------------------------------------------

describe('logovi', () => {
  it('ne sadrže telefon ni bilješku klijenta', async () => {
    const linije: string[] = [];
    const hvatac = (...argumenti: unknown[]): void => {
      linije.push(argumenti.map((a) => String(a)).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(hvatac);
    vi.spyOn(console, 'warn').mockImplementation(hvatac);
    vi.spyOn(console, 'error').mockImplementation(hvatac);

    odgovori(409, { ok: false, reason: 'staffConflict' });
    await napraviTermin(NOVI_TERMIN);
    odgovori(401, {});
    await napraviTermin(NOVI_TERMIN);

    const sve = linije.join('\n');
    expect(sve).not.toContain(TELEFON);
    expect(sve).not.toContain('preko WhatsAppa');
    expect(sve).not.toContain('tajni-interni-kljuc');
  });
});
