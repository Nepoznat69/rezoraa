/**
 * ============================================================================
 * Salon u kutiji — okruženje za testiranje orkestratora razgovora
 * ============================================================================
 *
 * ZAŠTO POSTOJI
 *   `orchestrator.ts` je jedini modul koji odlučuje šta se stvarno desi kad
 *   kupac nešto napiše. Sve oko njega je testirano — repozitorij, poruke,
 *   činjenice, datumi — a on sam nije bio, pa se svaka popravka provjeravala
 *   ručnim pisanjem na WhatsApp. Tako se greška nađe jednom, ali se ne zadrži:
 *   sljedeća izmjena je može tiho vratiti i niko to ne vidi do sljedećeg kupca.
 *
 * ŠTA SE OVDJE ZAMJENJUJE, A ŠTA NE
 *   Zamjenjuje se sve što ide van procesa:
 *     * Core baza      → `postaviCoreIzvrsilac`, izvršilac koji drži redove u
 *                        memoriji i odgovara na tačan tekst upita iz
 *                        `core-repozitorij.ts`;
 *     * Coreov API     → lažni `fetch` koji servira `/context`,
 *                        `/availability`, `/appointments*`;
 *     * AI sloj        → unaprijed pripremljen `AiExtraction` po poruci.
 *
 *   NE zamjenjuje se ništa iz `orchestrator.ts`. On se u testu vrti cijel, sa
 *   svojim pravim odlukama — inače test ne bi ni imao smisla.
 *
 * ZAŠTO SE AI NE ZOVE
 *   Greške koje su nas dovele dovde nisu greške razumijevanja nego
 *   odlučivanja: izvlačenje je bilo tačno, a orkestrator je s tačnim podacima
 *   uradio pogrešnu stvar. Lažni ekstraktor to izoluje, a testovi ostaju
 *   deterministični, besplatni i pokretljivi bez API ključa. Provjera da sam
 *   prompt i dalje daje očekivano izvlačenje je drugo pitanje i traži drugi
 *   fajl, sa pravim modelom i ručnim pokretanjem.
 *
 * VRIJEME
 *   Sat mora biti prikovan (`vi.setSystemTime`), inače „sutra" znači nešto
 *   drugo svaki dan i test pada jednom mjesečno bez razloga koji iko može
 *   pročitati. `SADA` ispod je taj trenutak.
 * ============================================================================
 */

import { DateTime } from 'luxon';
import type { AiExtractor } from '../../src/modules/ai/extractor.js';
import type { AiExtraction, NormalizedMessage } from '../../src/domain/schemas.js';
import {
  postaviCoreIzvrsilac,
  type IzvrsilacUpita,
} from '../../src/modules/core-baza/core-repozitorij.js';
import { ocistiKesKonteksta } from '../../src/modules/core-kontekst/kontekst.js';
import {
  ConversationOrchestrator,
  type OrchestrationResult,
} from '../../src/modules/conversations/orchestrator.js';

// ---------------------------------------------------------------------------
// Prikovano vrijeme
// ---------------------------------------------------------------------------

/**
 * Ponedjeljak, 10. 8. 2026, 10:00 po Sarajevu (08:00 UTC).
 *
 * Ponedjeljak zato što je `weekday = 1` i radno vrijeme vrijedi, a 10:00 zato
 * što ostavlja pola radnog dana i naprijed i nazad — pa test ne pada na tome
 * što je „danas popodne" već prošlo.
 */
export const SADA = '2026-08-10T08:00:00.000Z';
export const ZONA = 'Europe/Sarajevo';

/** Isti dan po lokalnoj zoni, u obliku koji Core očekuje. */
export const DANAS = '2026-08-10';
export const SUTRA = '2026-08-11';

// ---------------------------------------------------------------------------
// Opis salona
// ---------------------------------------------------------------------------

export interface OpisUsluge {
  naziv: string;
  minuta: number;
  cijenaCenti?: number;
}

export interface OpisRadnogVremena {
  /** 1 = ponedjeljak … 0 = nedjelja, kao u internom ugovoru. */
  dani: number[];
  pocetak: string;
  kraj: string;
}

export interface OpisSalona {
  naziv?: string;
  vertikala?: string;
  usluge?: OpisUsluge[];
  zaposlenici?: string[];
  radnoVrijeme?: OpisRadnogVremena;
  znanje?: Array<{ pitanje: string; odgovor: string }>;
  /** Red iz `assistant_settings` onako kako ga Core šalje (snake_case). */
  postavke?: Record<string, unknown>;
  pravila?: string[];
}

const PODRAZUMIJEVANO_RADNO_VRIJEME: OpisRadnogVremena = {
  dani: [1, 2, 3, 4, 5],
  pocetak: '09:00',
  kraj: '17:00',
};

// ---------------------------------------------------------------------------
// Redovi u memoriji — ono što bi inače bila Core baza
// ---------------------------------------------------------------------------

interface RedRazgovora {
  id: string;
  businessId: string;
  kontakt: string;
  imeKontakta: string | null;
  status: 'bot' | 'human' | 'closed';
  clientId: string | null;
  pendingAction: unknown;
  knownSlots: unknown;
  strikes: number;
  /** ms; null = nije blokiran. */
  blokiranDo: number | null;
  razlogBlokade: string | null;
  /** ms; mijenja se pri predaji čovjeku, kao `updated_at` u bazi. */
  azuriranU: number;
}

interface RedPoruke {
  id: string;
  businessId: string;
  conversationId: string;
  smjer: 'inbound' | 'outbound';
  vanjskiId: string | null;
  tekst: string;
  /** Redoslijed upisa; zamjenjuje `created_at` u sortiranju. */
  redoslijed: number;
  /** Ne-null znači da je odgovorio čovjek, ne asistent. */
  poslao: string | null;
}

export interface ZakazanTermin {
  id: string;
  reference: string;
  startAt: string;
  endAt: string;
  serviceId: string | null;
  staffMemberId: string | null;
  imeGosta: string;
  telefon: string;
  status: 'scheduled' | 'cancelled';
  groupId: string | null;
}

export interface ZabiljezenZahtjev {
  metoda: string;
  putanja: string;
  tijelo: unknown;
}

// ---------------------------------------------------------------------------
// Sitni alati
// ---------------------------------------------------------------------------

let brojac = 0;

/** Stabilan, čitljiv UUID — po jedan za svaki red, bez slučajnosti u testu. */
function uuid(prefiks: number): string {
  brojac += 1;
  const rep = String(brojac).padStart(12, '0');
  return `${String(prefiks).repeat(8)}-0000-4000-8000-${rep}`;
}

function normalizuj(broj: string): string {
  return broj.replace(/\D/g, '');
}

/** Lokalno „YYYY-MM-DD HH:mm" u zoni salona → UTC ISO. */
function uUtc(datum: string, vrijeme: string): string {
  const t = DateTime.fromISO(`${datum}T${vrijeme}`, { zone: ZONA });
  return t.toUTC().toISO() ?? '';
}

function danUSedmici(datum: string): number {
  const t = DateTime.fromISO(datum, { zone: ZONA });
  // Luxon: 1=ponedjeljak … 7=nedjelja. Ugovor: 0=nedjelja.
  return t.weekday === 7 ? 0 : t.weekday;
}

function preklapaSe(aPocetak: string, aKraj: string, bPocetak: string, bKraj: string): boolean {
  return new Date(aPocetak) < new Date(bKraj) && new Date(bPocetak) < new Date(aKraj);
}

/** Šest znakova bez 0/O/1/I/L, kao `0016` u Coreu. */
function kod(redni: number): string {
  const azbuka = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let ostatak = redni + 1;
  let tekst = '';
  while (tekst.length < 6) {
    tekst = azbuka[ostatak % azbuka.length] + tekst;
    ostatak = Math.floor(ostatak / azbuka.length) + 7;
  }
  return tekst;
}

// ---------------------------------------------------------------------------
// Prazno izvlačenje — polazna tačka za svaku poruku
// ---------------------------------------------------------------------------

export const PRAZNO_IZVLACENJE: AiExtraction = {
  intent: 'unknown',
  customer_name: '',
  customer_phone: '',
  business_id: '',
  location: '',
  service: '',
  resource: '',
  employee: '',
  date: '',
  date_expression: '',
  end_date: '',
  start_time: '',
  start_time_expression: '',
  end_time: '',
  duration_minutes: 0,
  party_size: 0,
  side_answer: '',
  participants: [],
  quantity: 0,
  room_type: '',
  notes: '',
  booking_id: '',
  missing_fields: [],
  ready_for_availability_check: false,
  confidence: 0.9,
  ambiguities: [],
  reply: '',
};

// ---------------------------------------------------------------------------
// Razgovor
// ---------------------------------------------------------------------------

export interface Razgovor {
  telefon: string;
  /**
   * Šalje poruku kroz cijeli orkestrator.
   *
   * `izvlacenje` je ono što bi model vratio na taj tekst — piše se samo ono
   * što je bitno za test, ostalo dopunjava `PRAZNO_IZVLACENJE`.
   */
  posalji(tekst: string, izvlacenje?: Partial<AiExtraction>): Promise<OrchestrationResult>;
  /** Zadnji odgovor koji je asistent poslao kupcu. */
  zadnjiOdgovor(): string;
  /** Svi odgovori asistenta, od najstarijeg. */
  odgovori(): string[];
  /** Sve poruke razgovora, u oba smjera — ono što vlasnik vidi u Inboxu. */
  poruke(): Array<{ smjer: 'inbound' | 'outbound'; tekst: string }>;
  /** Šta je zapisano kao „utvrđeno" (`known_slots`). */
  poznatiPodaci(): unknown;
  /** Šta asistent trenutno čeka da mu kupac potvrdi (`pending_action`). */
  cekanaRadnja(): unknown;
  /** Ručno starenje konteksta — pomjera `upisanoU` unazad za dati broj minuta. */
  ostariKontekst(minuta: number): void;
  /** Čovjek preuzima razgovor iz Inboxa. */
  covjekPreuzima(): void;
  /** Koliko je prekršaja zabilježeno. */
  strikeovi(): number;
  /** Šuti li asistent za ovaj kontakt. */
  blokiran(): boolean;
}

// ---------------------------------------------------------------------------
// Salon
// ---------------------------------------------------------------------------

export interface Salon {
  businessId: string;
  razgovor(telefon: string): Razgovor;
  /** Svi termini koje je Core „napravio", uključujući otkazane. */
  termini(): ZakazanTermin[];
  /** Samo aktivni. */
  aktivniTermini(): ZakazanTermin[];
  uslugaId(naziv: string): string;
  zaposlenikId(ime: string): string;
  /** Ubacuje termin koji je već postojao prije razgovora. */
  dodajTermin(unos: {
    datum: string;
    vrijeme: string;
    usluga?: string;
    zaposlenik?: string;
    telefon: string;
    imeGosta?: string;
  }): ZakazanTermin;
  /** Sljedeći pokušaj zakazivanja Core odbija s datim razlogom (HTTP 409). */
  odbijSljedeciTermin(razlog: string): void;
  /** Core prestaje odgovarati — svaki poziv puca kao mrežna greška. */
  oboriCore(): void;
  podigniCore(): void;
  /** Svi zahtjevi koji su otišli prema Coreu, redom. */
  zahtjevi(): ZabiljezenZahtjev[];
  /** Vraća pravi `fetch` i izvršilac. Zove se u `afterEach`. */
  ocisti(): void;
}

export function napraviSalon(opis: OpisSalona = {}): Salon {
  const businessId = uuid(1);
  // Jedan kanal po salonu, kao u stvarnosti. Nov kanal po poruci bi značio nov
  // brojač brzine po poruci — prigušenje se tada nikad ne bi okinulo.
  const channelId = uuid(9);
  const radnoVrijeme = opis.radnoVrijeme ?? PODRAZUMIJEVANO_RADNO_VRIJEME;

  const usluge = (opis.usluge ?? [{ naziv: 'šišanje', minuta: 30 }]).map((u) => ({
    id: uuid(2),
    naziv: u.naziv,
    minuta: u.minuta,
    cijenaCenti: u.cijenaCenti ?? 2000,
  }));

  const zaposlenici = (opis.zaposlenici ?? ['Emir']).map((ime) => ({ id: uuid(3), ime }));

  const razgovori: RedRazgovora[] = [];
  const poruke: RedPoruke[] = [];
  const termini: ZakazanTermin[] = [];
  const zahtjevi: ZabiljezenZahtjev[] = [];

  let redoslijedPoruka = 0;
  let odbijanje: string | null = null;
  let coreRadi = true;

  const praviFetch = globalThis.fetch;

  // -------------------------------------------------------------------------
  // Core baza u memoriji
  // -------------------------------------------------------------------------

  const izvrsilac: IzvrsilacUpita = async <T>(tekst: string, v: unknown[]): Promise<T[]> => {
    const red = (o: unknown): T[] => [o as T];
    const prazno: T[] = [];

    // --- conversations: nađi ili napravi ---
    if (tekst.includes('INSERT INTO public.conversations')) {
      const [biznis, kontakt, ime] = v as [string, string, string | null];
      let postojeci = razgovori.find((r) => r.businessId === biznis && r.kontakt === kontakt);
      if (!postojeci) {
        postojeci = {
          id: uuid(4),
          businessId: biznis,
          kontakt,
          imeKontakta: ime,
          status: 'bot',
          clientId: null,
          pendingAction: null,
          knownSlots: null,
          strikes: 0,
          blokiranDo: null,
          razlogBlokade: null,
          azuriranU: Date.now(),
        };
        razgovori.push(postojeci);
      } else if (ime) {
        postojeci.imeKontakta = ime;
      }
      return red({ id: postojeci.id });
    }

    if (tekst.includes('SELECT id FROM public.conversations')) {
      const [biznis, kontakt] = v as [string, string];
      const nadjen = razgovori.find((r) => r.businessId === biznis && r.kontakt === kontakt);
      return nadjen ? red({ id: nadjen.id }) : prazno;
    }

    // --- messages: upis (s dedupliciranjem po vanjskom id-u) ---
    if (tekst.includes('INSERT INTO public.messages')) {
      const [biznis, razgovor, smjer, vanjskiId, body] = v as [
        string,
        string,
        'inbound' | 'outbound',
        string | null,
        string,
      ];
      const pripada = razgovori.some((r) => r.id === razgovor && r.businessId === biznis);
      if (!pripada) return prazno;
      if (vanjskiId && poruke.some((p) => p.businessId === biznis && p.vanjskiId === vanjskiId)) {
        return prazno; // ON CONFLICT DO NOTHING
      }
      redoslijedPoruka += 1;
      const nova: RedPoruke = {
        id: uuid(5),
        businessId: biznis,
        conversationId: razgovor,
        smjer,
        vanjskiId,
        tekst: body,
        redoslijed: redoslijedPoruka,
        poslao: null,
      };
      poruke.push(nova);
      return red({ id: nova.id });
    }

    if (tekst.includes('SELECT id FROM public.messages')) {
      const [biznis, vanjskiId] = v as [string, string];
      const nadjena = poruke.find((p) => p.businessId === biznis && p.vanjskiId === vanjskiId);
      return nadjena ? red({ id: nadjena.id }) : prazno;
    }

    if (tekst.includes('SELECT direction, body')) {
      const [biznis, razgovor, granica] = v as [string, string, number];
      return poruke
        .filter((p) => p.businessId === biznis && p.conversationId === razgovor)
        .sort((a, b) => b.redoslijed - a.redoslijed)
        .slice(0, granica)
        .map((p) => ({ direction: p.smjer, body: p.tekst })) as T[];
    }

    // --- stanje razgovora ---
    if (tekst.includes('SELECT id, status, contact_name, client_id')) {
      const [biznis, razgovor] = v as [string, string];
      const r = razgovori.find((x) => x.id === razgovor && x.businessId === biznis);
      return r
        ? red({ id: r.id, status: r.status, contact_name: r.imeKontakta, client_id: r.clientId })
        : prazno;
    }

    if (tekst.includes("SET status = 'human'")) {
      const [biznis, razgovor] = v as [string, string];
      const r = razgovori.find((x) => x.id === razgovor && x.businessId === biznis);
      if (!r || r.status === 'human') return prazno;
      r.status = 'human';
      r.azuriranU = Date.now();
      return red({ id: r.id });
    }

    if (tekst.includes("SET status = 'bot'")) {
      const [biznis, razgovor, minuta] = v as [string, string, string];
      const r = razgovori.find((x) => x.id === razgovor && x.businessId === biznis);
      if (!r || r.status !== 'human') return prazno;
      if (Date.now() - r.azuriranU < Number(minuta) * 60_000) return prazno;
      const covjekOdgovorio = poruke.some(
        (p) =>
          p.conversationId === r.id &&
          p.smjer === 'outbound' &&
          p.poslao !== null &&
          p.redoslijed > 0,
      );
      if (covjekOdgovorio) return prazno;
      r.status = 'bot';
      r.azuriranU = Date.now();
      return red({ id: r.id });
    }

    // --- čekana radnja i poznati podaci ---
    if (tekst.includes('SET pending_action')) {
      const [biznis, razgovor, vrijednost] = v as [string, string, string | null];
      const r = razgovori.find((x) => x.id === razgovor && x.businessId === biznis);
      if (r) r.pendingAction = vrijednost ? JSON.parse(vrijednost) : null;
      return prazno;
    }

    if (tekst.includes('SELECT pending_action')) {
      const [biznis, razgovor] = v as [string, string];
      const r = razgovori.find((x) => x.id === razgovor && x.businessId === biznis);
      return r ? red({ pending_action: r.pendingAction }) : prazno;
    }

    if (tekst.includes('SET known_slots')) {
      const [biznis, razgovor, vrijednost] = v as [string, string, string | null];
      const r = razgovori.find((x) => x.id === razgovor && x.businessId === biznis);
      if (r) r.knownSlots = vrijednost ? JSON.parse(vrijednost) : null;
      return prazno;
    }

    if (tekst.includes('SELECT known_slots')) {
      const [biznis, razgovor] = v as [string, string];
      const r = razgovori.find((x) => x.id === razgovor && x.businessId === biznis);
      return r ? red({ known_slots: r.knownSlots }) : prazno;
    }

    // --- zaštita: strikeovi i blokada (migracija 0021) ---
    if (tekst.includes('SELECT strikes, blocked_until, blocked_reason')) {
      const [biznis, razgovor] = v as [string, string];
      const r = razgovori.find((x) => x.id === razgovor && x.businessId === biznis);
      if (!r) return prazno;
      return red({
        strikes: r.strikes,
        blocked_until: r.blokiranDo ? new Date(r.blokiranDo).toISOString() : null,
        blocked_reason: r.razlogBlokade,
      });
    }

    if (tekst.includes('SET strikes = strikes + 1')) {
      const [biznis, razgovor, doBlokade, prvo, drugo, trece, opis] = v as [
        string,
        string,
        number,
        number,
        number,
        number,
        string,
      ];
      const r = razgovori.find((x) => x.id === razgovor && x.businessId === biznis);
      if (!r) return prazno;
      r.strikes += 1;
      if (r.strikes >= doBlokade) {
        const minuta =
          r.strikes >= doBlokade + 2 ? trece : r.strikes >= doBlokade + 1 ? drugo : prvo;
        r.blokiranDo = Date.now() + minuta * 60_000;
        r.razlogBlokade = opis;
      }
      return red({ blocked_until: r.blokiranDo ? new Date(r.blokiranDo).toISOString() : null });
    }

    if (tekst.includes('SET last_message_at')) return prazno;

    throw new Error(`Lažna Core baza ne poznaje ovaj upit:\n${tekst}`);
  };

  // -------------------------------------------------------------------------
  // Coreov interni API
  // -------------------------------------------------------------------------

  function kontekstOdgovor(): unknown {
    return {
      business: {
        id: businessId,
        name: opis.naziv ?? 'Salon Test',
        vertical: opis.vertikala ?? 'hair_salon',
        timezone: ZONA,
      },
      services: usluge.map((u) => ({
        id: u.id,
        name: u.naziv,
        duration_minutes: u.minuta,
        price_cents: u.cijenaCenti,
        active: true,
      })),
      staff: zaposlenici.map((z) => ({ id: z.id, full_name: z.ime, title: null, active: true })),
      working_hours: zaposlenici.flatMap((z) =>
        radnoVrijeme.dani.map((dan) => ({
          staff_member_id: z.id,
          weekday: dan,
          start_time: radnoVrijeme.pocetak,
          end_time: radnoVrijeme.kraj,
        })),
      ),
      knowledge: (opis.znanje ?? []).map((s) => ({ question: s.pitanje, answer: s.odgovor })),
      assistant: { settings: opis.postavke ?? null, rules: (opis.pravila ?? []).map((r) => r) },
      staff_services: [],
    };
  }

  /**
   * Slobodni termini po istim pravilima koja primjenjuje Core: mreža od 15
   * minuta, unutar radnog bloka, bez preklapanja s aktivnim terminom.
   */
  function dostupnost(tijelo: Record<string, unknown>): unknown {
    const datum = String(tijelo.date);
    const dan = danUSedmici(datum);
    if (!radnoVrijeme.dani.includes(dan)) return { date: datum, slots: [] };

    const usluga = usluge.find((u) => u.id === tijelo.service_id);
    const trajanje =
      typeof tijelo.duration_minutes === 'number' && tijelo.duration_minutes > 0
        ? tijelo.duration_minutes
        : (usluga?.minuta ?? 30);

    const trazeni = typeof tijelo.staff_member_id === 'string' ? tijelo.staff_member_id : null;
    const kandidati = trazeni ? zaposlenici.filter((z) => z.id === trazeni) : zaposlenici;

    const slots: Array<{ start_at: string; end_at: string; staff_member_id: string }> = [];
    for (const z of kandidati) {
      let t = DateTime.fromISO(`${datum}T${radnoVrijeme.pocetak}`, { zone: ZONA });
      const kraj = DateTime.fromISO(`${datum}T${radnoVrijeme.kraj}`, { zone: ZONA });
      while (t.plus({ minutes: trajanje }) <= kraj) {
        const pocetakIso = t.toUTC().toISO() ?? '';
        const krajIso = t.plus({ minutes: trajanje }).toUTC().toISO() ?? '';
        const zauzeto = termini.some(
          (a) =>
            a.status === 'scheduled' &&
            a.staffMemberId === z.id &&
            preklapaSe(pocetakIso, krajIso, a.startAt, a.endAt),
        );
        if (!zauzeto) slots.push({ start_at: pocetakIso, end_at: krajIso, staff_member_id: z.id });
        t = t.plus({ minutes: 15 });
      }
    }
    slots.sort((a, b) => a.start_at.localeCompare(b.start_at));
    return { date: datum, slots };
  }

  function slobodanZaposlenik(startAt: string, endAt: string, trazeni: string | null): string | null {
    const kandidati = trazeni ? zaposlenici.filter((z) => z.id === trazeni) : zaposlenici;
    for (const z of kandidati) {
      const zauzet = termini.some(
        (a) =>
          a.status === 'scheduled' &&
          a.staffMemberId === z.id &&
          preklapaSe(startAt, endAt, a.startAt, a.endAt),
      );
      if (!zauzet) return z.id;
    }
    return null;
  }

  function upisiTermin(unos: {
    startAt: string;
    endAt: string;
    serviceId: string | null;
    staffMemberId: string | null;
    imeGosta: string;
    telefon: string;
    groupId?: string | null;
  }): ZakazanTermin {
    const zapis: ZakazanTermin = {
      id: uuid(6),
      reference: kod(termini.length),
      startAt: unos.startAt,
      endAt: unos.endAt,
      serviceId: unos.serviceId,
      staffMemberId: unos.staffMemberId,
      imeGosta: unos.imeGosta,
      telefon: normalizuj(unos.telefon),
      status: 'scheduled',
      groupId: unos.groupId ?? null,
    };
    termini.push(zapis);
    return zapis;
  }

  function napraviTerminOdgovor(tijelo: Record<string, unknown>): { status: number; telo: unknown } {
    if (odbijanje) {
      const razlog = odbijanje;
      odbijanje = null;
      return { status: 409, telo: { ok: false, reason: razlog } };
    }

    const startAt = String(tijelo.start_at);
    const endAt = String(tijelo.end_at);
    const serviceId = typeof tijelo.service_id === 'string' ? tijelo.service_id : null;
    const klijent = (tijelo.client ?? {}) as { full_name?: string; phone?: string };
    const telefon = normalizuj(String(klijent.phone ?? ''));

    // Ista deduplikacija koju Core radi: isti kupac, isti trenutak, ista usluga.
    const isti = termini.find(
      (a) =>
        a.status === 'scheduled' &&
        a.telefon === telefon &&
        a.startAt === startAt &&
        a.serviceId === serviceId,
    );
    if (isti) {
      return {
        status: 200,
        telo: { ok: true, appointment_id: isti.id, reference: isti.reference, created: false },
      };
    }

    const trazeni = typeof tijelo.staff_member_id === 'string' ? tijelo.staff_member_id : null;
    const zaposlenik = slobodanZaposlenik(startAt, endAt, trazeni);
    if (!zaposlenik) return { status: 409, telo: { ok: false, reason: 'staffConflict' } };

    const zapis = upisiTermin({
      startAt,
      endAt,
      serviceId,
      staffMemberId: zaposlenik,
      imeGosta: String(klijent.full_name ?? ''),
      telefon,
    });
    return {
      status: 200,
      telo: { ok: true, appointment_id: zapis.id, reference: zapis.reference, created: true },
    };
  }

  function grupaOdgovor(tijelo: Record<string, unknown>): { status: number; telo: unknown } {
    if (odbijanje) {
      const razlog = odbijanje;
      odbijanje = null;
      return { status: 409, telo: { ok: false, reason: razlog } };
    }

    const klijent = (tijelo.client ?? {}) as { full_name?: string; phone?: string };
    const ucesnici = (tijelo.participants ?? []) as Array<{
      name?: string;
      service_ids?: string[];
      staff_member_id?: string;
    }>;

    const groupId = uuid(7);
    const napravljeni: unknown[] = [];
    let pocetak = DateTime.fromISO(String(tijelo.start_at), { zone: 'utc' });

    // Svako svoje vrijeme kod svog zaposlenika; grupa je sve ili ništa.
    const nacrt: Array<{ start: string; kraj: string; ucesnik: (typeof ucesnici)[number] }> = [];
    for (const u of ucesnici) {
      const minuta = (u.service_ids ?? []).reduce(
        (zbir, id) => zbir + (usluge.find((s) => s.id === id)?.minuta ?? 30),
        0,
      );
      const kraj = pocetak.plus({ minutes: minuta || 30 });
      nacrt.push({ start: pocetak.toISO() ?? '', kraj: kraj.toISO() ?? '', ucesnik: u });
      pocetak = kraj;
    }

    for (const stavka of nacrt) {
      if (!slobodanZaposlenik(stavka.start, stavka.kraj, stavka.ucesnik.staff_member_id ?? null)) {
        return { status: 409, telo: { ok: false, reason: 'staffConflict' } };
      }
    }

    for (const stavka of nacrt) {
      const zaposlenik = slobodanZaposlenik(
        stavka.start,
        stavka.kraj,
        stavka.ucesnik.staff_member_id ?? null,
      );
      const zapis = upisiTermin({
        startAt: stavka.start,
        endAt: stavka.kraj,
        serviceId: stavka.ucesnik.service_ids?.[0] ?? null,
        staffMemberId: zaposlenik,
        imeGosta: stavka.ucesnik.name ?? String(klijent.full_name ?? ''),
        telefon: String(klijent.phone ?? ''),
        groupId,
      });
      napravljeni.push({
        appointment_id: zapis.id,
        reference: zapis.reference,
        guest_name: zapis.imeGosta,
        start_at: zapis.startAt,
        end_at: zapis.endAt,
        service_ids: stavka.ucesnik.service_ids ?? [],
      });
    }

    return { status: 200, telo: { ok: true, group_id: groupId, appointments: napravljeni } };
  }

  const lazniFetch = (async (ulaz: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!coreRadi) throw new TypeError('fetch failed');

    const adresa = new URL(String(ulaz));
    const putanja = adresa.pathname.replace('/api/internal', '');
    const metoda = init?.method ?? 'GET';
    const tijelo =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : ({} as Record<string, unknown>);

    zahtjevi.push({ metoda, putanja, tijelo });

    const odgovori = (status: number, telo: unknown): Response =>
      new Response(JSON.stringify(telo), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (putanja === '/context') return odgovori(200, kontekstOdgovor());
    if (putanja === '/availability') return odgovori(200, dostupnost(tijelo));

    if (putanja === '/appointments' && metoda === 'POST') {
      const { status, telo } = napraviTerminOdgovor(tijelo);
      return odgovori(status, telo);
    }

    if (putanja === '/appointments' && metoda === 'GET') {
      const telefon = normalizuj(adresa.searchParams.get('phone') ?? '');
      const sada = Date.now();
      const moji = termini
        .filter(
          (a) => a.status === 'scheduled' && a.telefon === telefon && new Date(a.startAt).getTime() >= sada,
        )
        .sort((a, b) => a.startAt.localeCompare(b.startAt))
        .map((a) => ({
          id: a.id,
          reference: a.reference,
          guest_name: a.imeGosta,
          start_at: a.startAt,
          end_at: a.endAt,
          service_name: usluge.find((u) => u.id === a.serviceId)?.naziv ?? '',
          staff_name: zaposlenici.find((z) => z.id === a.staffMemberId)?.ime ?? '',
        }));
      return odgovori(200, { appointments: moji });
    }

    if (putanja === '/appointments/cancel') {
      const zapis = termini.find((a) => a.id === tijelo.appointment_id);
      if (!zapis || zapis.status !== 'scheduled') {
        return odgovori(409, { ok: false, reason: 'alreadyTerminal' });
      }
      zapis.status = 'cancelled';
      return odgovori(200, { ok: true });
    }

    if (putanja === '/appointments/reschedule') {
      const zapis = termini.find((a) => a.id === tijelo.appointment_id);
      if (!zapis) return odgovori(409, { ok: false, reason: 'alreadyTerminal' });
      const startAt = String(tijelo.start_at);
      const endAt = String(tijelo.end_at);
      const sudar = termini.some(
        (a) =>
          a.id !== zapis.id &&
          a.status === 'scheduled' &&
          a.staffMemberId === zapis.staffMemberId &&
          preklapaSe(startAt, endAt, a.startAt, a.endAt),
      );
      if (sudar) return odgovori(409, { ok: false, reason: 'staffConflict' });
      zapis.startAt = startAt;
      zapis.endAt = endAt;
      return odgovori(200, {
        ok: true,
        appointment_id: zapis.id,
        reference: zapis.reference,
        created: false,
      });
    }

    if (putanja === '/appointments/group') {
      const { status, telo } = grupaOdgovor(tijelo);
      return odgovori(status, telo);
    }

    throw new Error(`Lažni Core ne poznaje putanju: ${metoda} ${putanja}`);
  }) as typeof fetch;

  postaviCoreIzvrsilac(izvrsilac);
  globalThis.fetch = lazniFetch;
  ocistiKesKonteksta();

  // -------------------------------------------------------------------------
  // Javni dio
  // -------------------------------------------------------------------------

  function razgovorZa(telefon: string): Razgovor {
    const kontakt = normalizuj(telefon);
    let brojPoruka = 0;

    const mojRazgovor = (): RedRazgovora | undefined =>
      razgovori.find((r) => r.businessId === businessId && r.kontakt === kontakt);

    return {
      telefon,

      async posalji(tekst, izvlacenje = {}) {
        brojPoruka += 1;
        const potpuno: AiExtraction = { ...PRAZNO_IZVLACENJE, ...izvlacenje };

        const lazniAi = {
          extract: async () => potpuno,
        } as unknown as AiExtractor;

        const poruka: NormalizedMessage = {
          event_id: `event-${kontakt}-${brojPoruka}`,
          business_id: businessId,
          channel_id: channelId,
          channel_type: 'whatsapp_cloud',
          external_message_id: `wamid.${kontakt}.${brojPoruka}`,
          customer_external_id: kontakt,
          customer_phone: telefon,
          message_type: 'text',
          text: tekst,
          received_at: new Date().toISOString(),
          metadata: {},
        };

        return new ConversationOrchestrator(lazniAi).process(poruka);
      },

      odgovori() {
        const r = mojRazgovor();
        if (!r) return [];
        return poruke
          .filter((p) => p.conversationId === r.id && p.smjer === 'outbound')
          .sort((a, b) => a.redoslijed - b.redoslijed)
          .map((p) => p.tekst);
      },

      poruke() {
        const r = mojRazgovor();
        if (!r) return [];
        return poruke
          .filter((p) => p.conversationId === r.id)
          .sort((a, b) => a.redoslijed - b.redoslijed)
          .map((p) => ({ smjer: p.smjer, tekst: p.tekst }));
      },

      zadnjiOdgovor() {
        const svi = this.odgovori();
        return svi[svi.length - 1] ?? '';
      },

      poznatiPodaci() {
        return mojRazgovor()?.knownSlots ?? null;
      },

      cekanaRadnja() {
        return mojRazgovor()?.pendingAction ?? null;
      },

      ostariKontekst(minuta) {
        const r = mojRazgovor();
        if (!r || !r.knownSlots || typeof r.knownSlots !== 'object') return;
        const podaci = r.knownSlots as { upisanoU?: string };
        if (typeof podaci.upisanoU !== 'string') return;
        podaci.upisanoU = new Date(new Date(podaci.upisanoU).getTime() - minuta * 60_000).toISOString();
      },

      covjekPreuzima() {
        const r = mojRazgovor();
        if (r) {
          r.status = 'human';
          r.azuriranU = Date.now();
        }
      },

      strikeovi() {
        return mojRazgovor()?.strikes ?? 0;
      },

      blokiran() {
        const doKada = mojRazgovor()?.blokiranDo ?? null;
        return doKada !== null && doKada > Date.now();
      },
    };
  }

  return {
    businessId,
    razgovor: razgovorZa,
    termini: () => termini.map((t) => ({ ...t })),
    aktivniTermini: () => termini.filter((t) => t.status === 'scheduled').map((t) => ({ ...t })),
    uslugaId(naziv) {
      const nadjena = usluge.find((u) => u.naziv === naziv);
      if (!nadjena) throw new Error(`Salon nema uslugu „${naziv}".`);
      return nadjena.id;
    },
    zaposlenikId(ime) {
      const nadjen = zaposlenici.find((z) => z.ime === ime);
      if (!nadjen) throw new Error(`Salon nema zaposlenika „${ime}".`);
      return nadjen.id;
    },
    dodajTermin(unos) {
      const usluga = unos.usluga ? usluge.find((u) => u.naziv === unos.usluga) : usluge[0];
      const zaposlenik = unos.zaposlenik
        ? zaposlenici.find((z) => z.ime === unos.zaposlenik)
        : zaposlenici[0];
      const startAt = uUtc(unos.datum, unos.vrijeme);
      const endAt =
        DateTime.fromISO(startAt).plus({ minutes: usluga?.minuta ?? 30 }).toUTC().toISO() ?? '';
      return upisiTermin({
        startAt,
        endAt,
        serviceId: usluga?.id ?? null,
        staffMemberId: zaposlenik?.id ?? null,
        imeGosta: unos.imeGosta ?? '',
        telefon: unos.telefon,
      });
    },
    odbijSljedeciTermin(razlog) {
      odbijanje = razlog;
    },
    oboriCore() {
      coreRadi = false;
      ocistiKesKonteksta();
    },
    podigniCore() {
      coreRadi = true;
    },
    zahtjevi: () => zahtjevi.map((z) => ({ ...z })),
    ocisti() {
      postaviCoreIzvrsilac(null);
      globalThis.fetch = praviFetch;
      ocistiKesKonteksta();
    },
  };
}
