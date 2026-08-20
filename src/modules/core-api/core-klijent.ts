/**
 * ============================================================================
 * Rezora Core — HTTP klijent prema Coreovom internom API-ju
 * ============================================================================
 *
 * Ugovor: docs/INTERNAL_API_CONTRACT.md (Rezora Core). Ovaj fajl ne smije ići
 * izvan tog ugovora niti ga jednostrano mijenjati.
 *
 * ZAŠTO API, A NE SQL
 * Razgovore i poruke gateway piše direktno u Core bazu (core-repozitorij.ts).
 * Termini su druga priča: kreiranje termina primjenjuje radno vrijeme,
 * dostupnost zaposlenika i pravila preklapanja. Ta pravila žive u Coreu.
 * Kopija tih pravila u gatewayu je garantovano razilaženje, pa booking ide
 * kroz ovaj klijent.
 *
 * PRAVILA OVOG MODULA
 *
 *   1. business_id je IZRIČIT argument svake funkcije. Nema sesije, ništa se
 *      ne izvodi iz konteksta.
 *   2. HTTP 409 NIJE greška nego očekivan ishod ("termin se ne može uzeti").
 *      Vraća se strukturiran razlog i NIKAD se ne baca. Isti zahtjev se poslije
 *      409 NE PONAVLJA — zato u ovom fajlu nema nijedne petlje ni retry logike.
 *   3. Mrežna greška, istek roka i neispravan odgovor se hvataju i vraćaju kao
 *      neuspjeh. Ovaj modul ne ruši proces.
 *   4. Jedini izuzetak od pravila 3 je nepostojeća konfiguracija
 *      (CORE_BASE_URL / CORE_INTERNAL_API_KEY): to nije stanje u radu nego
 *      pogrešno postavljen server, pa se baca `CoreNijePodesenError` glasno i
 *      odmah, umjesto da se tiho guta pri svakom razgovoru.
 *   5. Svi vremenski trenuci preko granice su UTC ISO stringovi.
 *   6. U logove NE IDU telefon ni sadržaj poruke — samo identifikatori,
 *      status i razlog.
 * ============================================================================
 */

import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

/** Rok za svaki poziv prema Coreu. */
export const ROK_MS = 15_000;

// ---------------------------------------------------------------------------
// Podešavanja
// ---------------------------------------------------------------------------

/**
 * Baca se kad integracija prema Coreu uopšte nije podešena. Posebna klasa
 * postoji da je pozivalac može razlikovati od stvarne greške u radu.
 */
export class CoreNijePodesenError extends Error {
  constructor(poruka: string) {
    super(poruka);
    this.name = 'CoreNijePodesenError';
  }
}

interface Podesavanja {
  osnovnaAdresa: string;
  kljuc: string;
}

function podesavanja(): Podesavanja {
  const adresa = config.CORE_BASE_URL?.trim();
  const kljuc = config.CORE_INTERNAL_API_KEY?.trim();

  if (!adresa) {
    throw new CoreNijePodesenError(
      'CORE_BASE_URL nije postavljen — gateway ne zna gdje je Rezora Core, booking je nemoguć.',
    );
  }
  if (!kljuc) {
    throw new CoreNijePodesenError(
      'CORE_INTERNAL_API_KEY nije postavljen — pozivi prema Coreu bi bili odbijeni sa 401.',
    );
  }
  try {
    void new URL(adresa);
  } catch {
    throw new CoreNijePodesenError('CORE_BASE_URL nije ispravan URL (očekuje se npr. https://core.rezora.ba).');
  }

  return { osnovnaAdresa: adresa.replace(/\/+$/, ''), kljuc };
}

// ---------------------------------------------------------------------------
// Ishodi
// ---------------------------------------------------------------------------

/** Razlozi zbog kojih Core odbija termin (HTTP 409 na /appointments i /reschedule). */
export const RAZLOZI_TERMINA = [
  'staffConflict',
  'staffUnavailable',
  'outsideHours',
  'invalidTime',
  // Kupac vec ima termin tog dana. Nije greska nego drugaciji tok razgovora:
  // ono sto trazi je pomjeranje postojeceg, a ne novi termin.
  'alreadyBookedThatDay',
  // Kupac je iscrpio ono sto smije zakazati sam (Core, migracija 0020). Nije
  // greska nego granica: ponavljanje istog zahtjeva nikad nece proci, pa se
  // kupcu kaze sta moze uraditi umjesto toga.
  'tooManyBookings',
] as const;
export type RazlogTermina = (typeof RAZLOZI_TERMINA)[number];

/** Razlog zbog kojeg Core odbija otkazivanje (HTTP 409 na /cancel). */
export const RAZLOZI_OTKAZIVANJA = ['alreadyTerminal'] as const;
export type RazlogOtkazivanja = (typeof RAZLOZI_OTKAZIVANJA)[number];

/** Razlog koji ugovor ne poznaje — Core je vratio 409 sa nepoznatim `reason`. */
export const NEPOZNAT_RAZLOG = 'nepoznato';
export type NepoznatRazlog = typeof NEPOZNAT_RAZLOG;

export type VrstaNeuspjeha =
  /** Ulaz iz gatewaya nije prošao provjeru — zahtjev nije ni poslan. */
  | 'ulaz'
  /** Core je vratio 401/403 — ključ ne valja, integracija nije podešena. */
  | 'autorizacija'
  /** Core je vratio 503 — interni API je isključen ili nije spreman. */
  | 'nedostupno'
  /** 404 — biznis ili termin ne postoji. */
  | 'nijeNadjeno'
  /** 409 — očekivano odbijanje, razlog je u polju `razlog`. */
  | 'odbijeno'
  /** 5xx ili neki drugi neočekivan status. */
  | 'server'
  /** Odgovor nije JSON ili nema oblik iz ugovora. */
  | 'odgovor'
  /** Istekao rok od 15 s. */
  | 'istek'
  /** fetch je pukao — DNS, konekcija, TLS. */
  | 'mreza';

interface OsnovaNeuspjeha {
  ok: false;
  /** Poruka za log i za razvijača; NIJE tekst za krajnjeg korisnika. */
  poruka: string;
  /** HTTP status ako ga je uopšte bilo. */
  status: number | null;
  /** Smije li se identičan zahtjev ponoviti. Kod 409 je uvijek `false`. */
  ponoviti: boolean;
}

export interface OdbijenTermin extends OsnovaNeuspjeha {
  vrsta: 'odbijeno';
  razlog: RazlogTermina | NepoznatRazlog;
  ponoviti: false;
  /** Postojeci termin kad je razlog `alreadyBookedThatDay`; inace `null`. */
  postojeci: { appointmentId: string; pocetak: string } | null;
}

export interface OdbijenoOtkazivanje extends OsnovaNeuspjeha {
  vrsta: 'odbijeno';
  razlog: RazlogOtkazivanja | NepoznatRazlog;
  ponoviti: false;
}

export interface TehnickiNeuspjeh extends OsnovaNeuspjeha {
  vrsta: Exclude<VrstaNeuspjeha, 'odbijeno'>;
}

/** Neuspjeh poziva koji nema veze sa 409 (mreža, rok, auth, oblik odgovora). */
export type Neuspjeh = TehnickiNeuspjeh;

export type Ishod<T> = (T & { ok: true }) | TehnickiNeuspjeh;

export type IshodTermina =
  | { ok: true; appointmentId: string; kod: string; created: boolean }
  | OdbijenTermin
  | TehnickiNeuspjeh;

export type IshodOtkazivanja = { ok: true } | OdbijenoOtkazivanje | TehnickiNeuspjeh;

// ---------------------------------------------------------------------------
// Domenski tipovi (ono što gateway zaista koristi)
// ---------------------------------------------------------------------------

export interface PodaciFirme {
  id: string;
  naziv: string;
  vertikala: string;
  vremenskaZona: string;
}

export interface Usluga {
  id: string;
  naziv: string;
  trajanjeMinuta: number;
  cijenaCenti: number;
  aktivna: boolean;
}

export interface Zaposlenik {
  id: string;
  punoIme: string;
  titula: string | null;
  aktivan: boolean;
}

export interface RadnoVrijeme {
  staffMemberId: string;
  /** 0 = nedjelja, prema ugovoru. */
  danUSedmici: number;
  /** "09:00" u vremenskoj zoni firme. */
  pocetak: string;
  /** "17:00" u vremenskoj zoni firme. */
  kraj: string;
}

/**
 * Kako se asistent ponasa kod ovog klijenta.
 *
 * Ovo su ZELJE, ne garancije. Zastita od dvostrukog bukiranja, ponovljenih
 * poruka i razdvajanje klijenata su u kodu i u bazi i ovdje se ne mogu ugasiti
 * — postavka koju kupac moze iskljuciti nije zastita.
 */
export interface PostavkeAsistenta {
  ton: 'toplo' | 'sluzbeno' | 'kratko';
  oslovljavanje: 'vi' | 'ti';
  duzinaOdgovora: 'kratko' | 'standardno';
  smijeZakazati: boolean;
  smijePomjeriti: boolean;
  smijeOtkazati: boolean;
  predaja: 'na_zahtjev' | 'zahtjev_i_zalbe' | 'nikad';
  povratakMinuta: number;
  jednaRezervacijaDnevno: boolean;
  traziIme: boolean;
  najranijeMinuta: number;
  pozdrav: string;
  /** Pravila vlasnika, njegovim rijecima. Uputa o ponasanju, ne ovlastenje. */
  pravila: string[];
}

/** Isto sto i podrazumijevano u migraciji 0015. */
export const PODRAZUMIJEVANE_POSTAVKE: PostavkeAsistenta = {
  ton: 'toplo',
  oslovljavanje: 'vi',
  duzinaOdgovora: 'standardno',
  smijeZakazati: true,
  smijePomjeriti: true,
  smijeOtkazati: true,
  predaja: 'na_zahtjev',
  povratakMinuta: 30,
  jednaRezervacijaDnevno: true,
  traziIme: true,
  najranijeMinuta: 60,
  pozdrav: '',
  pravila: [],
};

/** Jedno pitanje i odgovor koje je salon upisao za asistenta. */
export interface StavkaZnanja {
  pitanje: string;
  odgovor: string;
}

export interface Kontekst {
  firma: PodaciFirme;
  usluge: Usluga[];
  zaposlenici: Zaposlenik[];
  radnoVrijeme: RadnoVrijeme[];
  znanje: StavkaZnanja[];
  postavke: PostavkeAsistenta;
}

export interface SlobodanTermin {
  /** UTC ISO. */
  startAt: string;
  /** UTC ISO. */
  endAt: string;
  staffMemberId: string;
}

export interface SlobodniTerminiOdgovor {
  /** "YYYY-MM-DD" kako ga je Core potvrdio. */
  datum: string;
  /** Prazna lista je validan odgovor, ne greška. */
  termini: SlobodanTermin[];
}

// ---------------------------------------------------------------------------
// Oblik odgovora na žici (snake_case iz ugovora)
// ---------------------------------------------------------------------------

interface ZicaFirma {
  id?: unknown;
  name?: unknown;
  vertical?: unknown;
  timezone?: unknown;
}

interface ZicaUsluga {
  id?: unknown;
  name?: unknown;
  duration_minutes?: unknown;
  price_cents?: unknown;
  active?: unknown;
}

interface ZicaZaposlenik {
  id?: unknown;
  full_name?: unknown;
  title?: unknown;
  active?: unknown;
}

interface ZicaRadnoVrijeme {
  staff_member_id?: unknown;
  weekday?: unknown;
  start_time?: unknown;
  end_time?: unknown;
}

interface ZicaKontekst {
  business?: ZicaFirma;
  services?: unknown;
  staff?: unknown;
  working_hours?: unknown;
  knowledge?: unknown;
  assistant?: { settings?: unknown; rules?: unknown };
}

interface ZicaZnanje {
  question?: unknown;
  answer?: unknown;
}

interface ZicaTermin {
  start_at?: unknown;
  end_at?: unknown;
  staff_member_id?: unknown;
}

interface ZicaDostupnost {
  date?: unknown;
  slots?: unknown;
}

interface ZicaTerminOdgovor {
  reference?: unknown;
  ok?: unknown;
  appointment_id?: unknown;
  created?: unknown;
  reason?: unknown;
}

// ---------------------------------------------------------------------------
// Sitne provjere ulaza
// ---------------------------------------------------------------------------

const UUID_OBLIK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATUM_OBLIK = /^\d{4}-\d{2}-\d{2}$/;

function neuspjehUlaza(poruka: string): TehnickiNeuspjeh {
  return { ok: false, vrsta: 'ulaz', poruka, status: null, ponoviti: false };
}

function jeUuid(vrijednost: unknown): vrijednost is string {
  return typeof vrijednost === 'string' && UUID_OBLIK.test(vrijednost.trim());
}

function jeTekst(vrijednost: unknown): vrijednost is string {
  return typeof vrijednost === 'string' && vrijednost.trim() !== '';
}

/** Vraća normalizovan UTC ISO string ili `null` ako trenutak nije čitljiv. */
function utcIso(vrijednost: unknown): string | null {
  if (typeof vrijednost !== 'string' || vrijednost.trim() === '') return null;
  const ms = Date.parse(vrijednost);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Jedan jedini put do Corea
// ---------------------------------------------------------------------------

interface SiroviOdgovor {
  status: number;
  tijelo: unknown;
}

/**
 * Šalje zahtjev i vraća status + isparsirano tijelo, ili tehnički neuspjeh.
 * Nikad ne baca zbog mreže, roka ili neispravnog JSON-a.
 *
 * Ovdje NEMA ponavljanja zahtjeva: writeovi su idempotentni preko
 * `idempotency_key`, a 409 se po ugovoru ne smije ponoviti.
 */
async function posalji(
  putanja: string,
  metoda: 'GET' | 'POST',
  tijelo: Record<string, unknown> | null,
  businessId: string,
): Promise<SiroviOdgovor | TehnickiNeuspjeh> {
  const { osnovnaAdresa, kljuc } = podesavanja();
  const adresa = `${osnovnaAdresa}/api/internal${putanja}`;

  const kontroler = new AbortController();
  let istekaoRok = false;
  const tajmer = setTimeout(() => {
    istekaoRok = true;
    kontroler.abort();
  }, ROK_MS);

  let odgovor: Response;
  try {
    odgovor = await fetch(adresa, {
      method: metoda,
      headers: {
        'x-internal-key': kljuc,
        accept: 'application/json',
        ...(tijelo === null ? {} : { 'content-type': 'application/json' }),
      },
      ...(tijelo === null ? {} : { body: JSON.stringify(tijelo) }),
      signal: kontroler.signal,
    });
  } catch (greska) {
    if (istekaoRok) {
      logger.warn('Core interni API nije odgovorio u roku.', {
        business_id: businessId,
        putanja,
        rok_ms: ROK_MS,
      });
      return {
        ok: false,
        vrsta: 'istek',
        poruka: `Rezora Core nije odgovorio u roku od ${ROK_MS} ms (${metoda} ${putanja}).`,
        status: null,
        ponoviti: true,
      };
    }
    const opis = greska instanceof Error ? greska.message : 'nepoznata mrežna greška';
    logger.error('Poziv prema Core internom API-ju nije uspio.', {
      business_id: businessId,
      putanja,
      razlog: opis,
    });
    return {
      ok: false,
      vrsta: 'mreza',
      poruka: `Rezora Core nije dostupan (${metoda} ${putanja}): ${opis}`,
      status: null,
      ponoviti: true,
    };
  } finally {
    clearTimeout(tajmer);
  }

  let sirovoTijelo = '';
  try {
    sirovoTijelo = await odgovor.text();
  } catch (greska) {
    const opis = greska instanceof Error ? greska.message : 'prekinuto čitanje';
    return {
      ok: false,
      vrsta: 'mreza',
      poruka: `Odgovor Corea nije pročitan do kraja (${metoda} ${putanja}): ${opis}`,
      status: odgovor.status,
      ponoviti: true,
    };
  }

  const tehnicki = statusUNeuspjeh(odgovor.status, putanja, businessId);
  if (tehnicki) return tehnicki;

  let tijeloJson: unknown = null;
  if (sirovoTijelo.trim() !== '') {
    try {
      tijeloJson = JSON.parse(sirovoTijelo) as unknown;
    } catch {
      return {
        ok: false,
        vrsta: 'odgovor',
        poruka: `Core je na ${metoda} ${putanja} vratio odgovor koji nije JSON.`,
        status: odgovor.status,
        ponoviti: false,
      };
    }
  }

  return { status: odgovor.status, tijelo: tijeloJson };
}

/**
 * Statusi koji se nikad ne pretvaraju u podatke. 409 namjerno NIJE ovdje —
 * njega obrađuje svaka operacija posebno, jer je razlog dio ishoda.
 */
function statusUNeuspjeh(
  status: number,
  putanja: string,
  businessId: string,
): TehnickiNeuspjeh | null {
  if (status === 401 || status === 403) {
    logger.error('Core je odbio interni ključ — integracija nije podešena.', {
      business_id: businessId,
      putanja,
      status,
    });
    return {
      ok: false,
      vrsta: 'autorizacija',
      poruka:
        'Rezora Core je odbio x-internal-key (HTTP ' +
        String(status) +
        '). Integracija nije podešena: CORE_INTERNAL_API_KEY u gatewayu i u Coreu moraju biti ista vrijednost.',
      status,
      ponoviti: false,
    };
  }

  if (status === 503) {
    logger.error('Coreov interni API je nedostupan.', { business_id: businessId, putanja, status });
    return {
      ok: false,
      vrsta: 'nedostupno',
      poruka:
        'Rezora Core javlja da interni API nije dostupan (HTTP 503). Integracija nije podešena ili Core još nije spreman.',
      status,
      ponoviti: true,
    };
  }

  if (status === 404) {
    return {
      ok: false,
      vrsta: 'nijeNadjeno',
      poruka: `Core nije našao traženi zapis (HTTP 404 na ${putanja}).`,
      status,
      ponoviti: false,
    };
  }

  if (status === 409) return null;

  if (status < 200 || status > 299) {
    logger.error('Core je vratio neočekivan status.', { business_id: businessId, putanja, status });
    return {
      ok: false,
      vrsta: 'server',
      poruka: `Core je na ${putanja} vratio neočekivan status ${String(status)}.`,
      status,
      ponoviti: status >= 500,
    };
  }

  return null;
}

function jeNeuspjeh(vrijednost: SiroviOdgovor | TehnickiNeuspjeh): vrijednost is TehnickiNeuspjeh {
  return 'ok' in vrijednost && vrijednost.ok === false;
}

function neispravanOblik(putanja: string, status: number): TehnickiNeuspjeh {
  return {
    ok: false,
    vrsta: 'odgovor',
    poruka: `Odgovor Corea na ${putanja} ne odgovara internom ugovoru.`,
    status,
    ponoviti: false,
  };
}

function objekat(vrijednost: unknown): Record<string, unknown> | null {
  return typeof vrijednost === 'object' && vrijednost !== null && !Array.isArray(vrijednost)
    ? (vrijednost as Record<string, unknown>)
    : null;
}

/** Iz 409 tijela vadi `reason`; sve što nije u ugovoru postaje `nepoznato`. */
function procitajRazlog<T extends string>(tijelo: unknown, dozvoljeni: readonly T[]): T | NepoznatRazlog {
  const tijeloObjekat = objekat(tijelo);
  const razlog = tijeloObjekat?.reason;
  if (typeof razlog === 'string') {
    const pogodak = dozvoljeni.find((kandidat) => kandidat === razlog);
    if (pogodak) return pogodak;
  }
  return NEPOZNAT_RAZLOG;
}

// ---------------------------------------------------------------------------
// 1. Kontekst biznisa — usluge, zaposlenici, radno vrijeme, podaci firme
// ---------------------------------------------------------------------------

export async function dohvatiKontekst(businessId: string): Promise<Ishod<{ kontekst: Kontekst }>> {
  if (!jeUuid(businessId)) {
    return neuspjehUlaza('businessId mora biti UUID — zahtjev prema Coreu nije poslan.');
  }
  const biznis = businessId.trim();

  const odgovor = await posalji(
    `/context?business_id=${encodeURIComponent(biznis)}`,
    'GET',
    null,
    biznis,
  );
  if (jeNeuspjeh(odgovor)) return odgovor;

  const tijelo = objekat(odgovor.tijelo) as ZicaKontekst | null;
  const firma = tijelo?.business;
  if (!tijelo || !firma || !jeTekst(firma.id)) {
    return neispravanOblik('/context', odgovor.status);
  }

  const kontekst: Kontekst = {
    firma: {
      id: firma.id.trim(),
      naziv: jeTekst(firma.name) ? firma.name : '',
      vertikala: jeTekst(firma.vertical) ? firma.vertical : '',
      vremenskaZona: jeTekst(firma.timezone) ? firma.timezone : 'UTC',
    },
    usluge: nizOd<ZicaUsluga, Usluga>(tijelo.services, (red) =>
      jeTekst(red.id) && typeof red.duration_minutes === 'number'
        ? {
            id: red.id.trim(),
            naziv: jeTekst(red.name) ? red.name : '',
            trajanjeMinuta: red.duration_minutes,
            cijenaCenti: typeof red.price_cents === 'number' ? red.price_cents : 0,
            aktivna: red.active !== false,
          }
        : null,
    ),
    zaposlenici: nizOd<ZicaZaposlenik, Zaposlenik>(tijelo.staff, (red) =>
      jeTekst(red.id)
        ? {
            id: red.id.trim(),
            punoIme: jeTekst(red.full_name) ? red.full_name : '',
            titula: jeTekst(red.title) ? red.title : null,
            aktivan: red.active !== false,
          }
        : null,
    ),
    // Stariji Core ne salje postavke; tada vrijedi podrazumijevano i asistent
    // radi tacno kao i do sada.
    postavke: postavkeIzOdgovora(tijelo.assistant),
    // Baza znanja je dodatak, ne uslov. Stariji Core je ne šalje i tada asistent
    // radi kao i do sada — samo bez odgovora na "imate li parking".
    znanje: nizOd<ZicaZnanje, StavkaZnanja>(tijelo.knowledge, (red) =>
      jeTekst(red.question) && jeTekst(red.answer) && red.question.trim() && red.answer.trim()
        ? { pitanje: red.question.trim(), odgovor: red.answer.trim() }
        : null,
    ),
    radnoVrijeme: nizOd<ZicaRadnoVrijeme, RadnoVrijeme>(tijelo.working_hours, (red) =>
      jeTekst(red.staff_member_id) &&
      typeof red.weekday === 'number' &&
      jeTekst(red.start_time) &&
      jeTekst(red.end_time)
        ? {
            staffMemberId: red.staff_member_id.trim(),
            danUSedmici: red.weekday,
            pocetak: red.start_time,
            kraj: red.end_time,
          }
        : null,
    ),
  };

  return { ok: true, kontekst };
}

/**
 * Postavke sa zice u nas oblik, polje po polje.
 *
 * Svaka vrijednost se provjerava prema dozvoljenoj listi. Nepoznata vrijednost
 * pada na podrazumijevanu umjesto da se proslijedi dalje — model ne smije
 * dobiti ton koji ne postoji.
 */
function postavkeIzOdgovora(sirovo: unknown): PostavkeAsistenta {
  const omot = objekat(sirovo);
  const red = objekat(omot?.settings);
  const pravila = Array.isArray(omot?.rules)
    ? (omot.rules as unknown[]).filter(jeTekst).map((r) => r.trim()).filter(Boolean)
    : [];

  if (!red) return { ...PODRAZUMIJEVANE_POSTAVKE, pravila };

  const izbor = <T extends string>(vrijednost: unknown, dozvoljeni: readonly T[], zadano: T): T =>
    jeTekst(vrijednost) && (dozvoljeni as readonly string[]).includes(vrijednost)
      ? (vrijednost as T)
      : zadano;
  const broj = (vrijednost: unknown, zadano: number): number =>
    typeof vrijednost === 'number' && Number.isFinite(vrijednost) ? vrijednost : zadano;
  const daNe = (vrijednost: unknown, zadano: boolean): boolean =>
    typeof vrijednost === 'boolean' ? vrijednost : zadano;

  const z = PODRAZUMIJEVANE_POSTAVKE;
  return {
    ton: izbor(red.tone, ['toplo', 'sluzbeno', 'kratko'] as const, z.ton),
    oslovljavanje: izbor(red.address_form, ['vi', 'ti'] as const, z.oslovljavanje),
    duzinaOdgovora: izbor(red.answer_length, ['kratko', 'standardno'] as const, z.duzinaOdgovora),
    smijeZakazati: daNe(red.can_book, z.smijeZakazati),
    smijePomjeriti: daNe(red.can_reschedule, z.smijePomjeriti),
    smijeOtkazati: daNe(red.can_cancel, z.smijeOtkazati),
    predaja: izbor(red.handoff_mode, ['na_zahtjev', 'zahtjev_i_zalbe', 'nikad'] as const, z.predaja),
    povratakMinuta: broj(red.handoff_return_minutes, z.povratakMinuta),
    jednaRezervacijaDnevno: daNe(red.one_booking_per_day, z.jednaRezervacijaDnevno),
    traziIme: daNe(red.require_name, z.traziIme),
    najranijeMinuta: broj(red.min_advance_minutes, z.najranijeMinuta),
    pozdrav: jeTekst(red.welcome_message) ? red.welcome_message.trim() : z.pozdrav,
    pravila,
  };
}

function nizOd<Z, T>(sirovi: unknown, pretvori: (red: Z) => T | null): T[] {
  if (!Array.isArray(sirovi)) return [];
  const rezultat: T[] = [];
  for (const stavka of sirovi) {
    const red = objekat(stavka);
    if (!red) continue;
    const pretvoreno = pretvori(red as Z);
    if (pretvoreno !== null) rezultat.push(pretvoreno);
  }
  return rezultat;
}

// ---------------------------------------------------------------------------
// 2. Slobodni termini
// ---------------------------------------------------------------------------

export interface SlobodniTerminiUpit {
  businessId: string;
  /** "YYYY-MM-DD" u vremenskoj zoni firme; Core ga razrješava. */
  datum: string;
  serviceId?: string;
  staffMemberId?: string;
  /** Bez ovoga Core uzima trajanje usluge, pa 30 minuta. */
  trajanjeMinuta?: number;
}

export async function slobodniTermini(
  upit: SlobodniTerminiUpit,
): Promise<Ishod<SlobodniTerminiOdgovor>> {
  if (!jeUuid(upit.businessId)) {
    return neuspjehUlaza('businessId mora biti UUID — zahtjev prema Coreu nije poslan.');
  }
  if (typeof upit.datum !== 'string' || !DATUM_OBLIK.test(upit.datum.trim())) {
    return neuspjehUlaza('datum mora biti u obliku YYYY-MM-DD.');
  }
  if (upit.serviceId !== undefined && !jeUuid(upit.serviceId)) {
    return neuspjehUlaza('serviceId mora biti UUID ako je zadan.');
  }
  if (upit.staffMemberId !== undefined && !jeUuid(upit.staffMemberId)) {
    return neuspjehUlaza('staffMemberId mora biti UUID ako je zadan.');
  }
  if (
    upit.trajanjeMinuta !== undefined &&
    (!Number.isInteger(upit.trajanjeMinuta) || upit.trajanjeMinuta <= 0)
  ) {
    return neuspjehUlaza('trajanjeMinuta mora biti pozitivan cijeli broj ako je zadano.');
  }

  const biznis = upit.businessId.trim();
  const tijelo: Record<string, unknown> = {
    business_id: biznis,
    date: upit.datum.trim(),
  };
  if (upit.serviceId !== undefined) tijelo.service_id = upit.serviceId.trim();
  if (upit.staffMemberId !== undefined) tijelo.staff_member_id = upit.staffMemberId.trim();
  if (upit.trajanjeMinuta !== undefined) tijelo.duration_minutes = upit.trajanjeMinuta;

  const odgovor = await posalji('/availability', 'POST', tijelo, biznis);
  if (jeNeuspjeh(odgovor)) return odgovor;

  const podaci = objekat(odgovor.tijelo) as ZicaDostupnost | null;
  if (!podaci || !Array.isArray(podaci.slots)) {
    return neispravanOblik('/availability', odgovor.status);
  }

  const termini = nizOd<ZicaTermin, SlobodanTermin>(podaci.slots, (red) => {
    const pocetak = utcIso(red.start_at);
    const kraj = utcIso(red.end_at);
    if (!pocetak || !kraj || !jeTekst(red.staff_member_id)) return null;
    return { startAt: pocetak, endAt: kraj, staffMemberId: red.staff_member_id.trim() };
  });

  return {
    ok: true,
    datum: jeTekst(podaci.date) ? podaci.date : upit.datum.trim(),
    termini,
  };
}

// ---------------------------------------------------------------------------
// 3. Kreiranje termina
// ---------------------------------------------------------------------------

export interface KlijentTermina {
  /** Smije biti prazno — Core tada koristi telefon. */
  ime: string;
  telefon: string;
}

export interface NoviTermin {
  businessId: string;
  /** UTC ISO. */
  startAt: string;
  /** UTC ISO. */
  endAt: string;
  serviceId?: string;
  staffMemberId?: string;
  klijent: KlijentTermina;
  biljeska?: string;
  /** ID dolazne poruke; Meta ponavlja webhookove, pa je ovo obavezno. */
  idempotencyKey: string;
}

export async function napraviTermin(unos: NoviTermin): Promise<IshodTermina> {
  if (!jeUuid(unos.businessId)) {
    return neuspjehUlaza('businessId mora biti UUID — zahtjev prema Coreu nije poslan.');
  }
  const pocetak = utcIso(unos.startAt);
  const kraj = utcIso(unos.endAt);
  if (!pocetak) return neuspjehUlaza('startAt mora biti čitljiv ISO trenutak.');
  if (!kraj) return neuspjehUlaza('endAt mora biti čitljiv ISO trenutak.');
  if (unos.serviceId !== undefined && !jeUuid(unos.serviceId)) {
    return neuspjehUlaza('serviceId mora biti UUID ako je zadan.');
  }
  if (unos.staffMemberId !== undefined && !jeUuid(unos.staffMemberId)) {
    return neuspjehUlaza('staffMemberId mora biti UUID ako je zadan.');
  }
  if (!jeTekst(unos.klijent?.telefon)) {
    return neuspjehUlaza('klijent.telefon je obavezan.');
  }
  if (!jeTekst(unos.idempotencyKey)) {
    return neuspjehUlaza('idempotencyKey je obavezan — bez njega bi ponovljeni webhook napravio drugi termin.');
  }

  const biznis = unos.businessId.trim();
  const tijelo: Record<string, unknown> = {
    business_id: biznis,
    start_at: pocetak,
    end_at: kraj,
    client: {
      full_name: typeof unos.klijent.ime === 'string' ? unos.klijent.ime.trim() : '',
      phone: unos.klijent.telefon.trim(),
    },
    idempotency_key: unos.idempotencyKey.trim(),
  };
  if (unos.serviceId !== undefined) tijelo.service_id = unos.serviceId.trim();
  if (unos.staffMemberId !== undefined) tijelo.staff_member_id = unos.staffMemberId.trim();
  if (unos.biljeska !== undefined) tijelo.notes = unos.biljeska;

  const odgovor = await posalji('/appointments', 'POST', tijelo, biznis);
  if (jeNeuspjeh(odgovor)) return odgovor;

  return terminIzOdgovora(odgovor, '/appointments', biznis);
}

// ---------------------------------------------------------------------------
// 4. Otkazivanje
// ---------------------------------------------------------------------------

export interface OtkazivanjeTermina {
  businessId: string;
  appointmentId: string;
  razlog?: string;
}

export async function otkaziTermin(unos: OtkazivanjeTermina): Promise<IshodOtkazivanja> {
  if (!jeUuid(unos.businessId)) {
    return neuspjehUlaza('businessId mora biti UUID — zahtjev prema Coreu nije poslan.');
  }
  if (!jeUuid(unos.appointmentId)) {
    return neuspjehUlaza('appointmentId mora biti UUID.');
  }

  const biznis = unos.businessId.trim();
  const tijelo: Record<string, unknown> = {
    business_id: biznis,
    appointment_id: unos.appointmentId.trim(),
  };
  if (jeTekst(unos.razlog)) tijelo.reason = unos.razlog.trim();

  const odgovor = await posalji('/appointments/cancel', 'POST', tijelo, biznis);
  if (jeNeuspjeh(odgovor)) return odgovor;

  if (odgovor.status === 409) {
    const razlog = procitajRazlog(odgovor.tijelo, RAZLOZI_OTKAZIVANJA);
    logger.info('Core je odbio otkazivanje termina.', {
      business_id: biznis,
      appointment_id: unos.appointmentId.trim(),
      razlog,
    });
    return {
      ok: false,
      vrsta: 'odbijeno',
      razlog,
      poruka: `Core je odbio otkazivanje: ${razlog}.`,
      status: 409,
      ponoviti: false,
    };
  }

  const tijeloOdgovora = objekat(odgovor.tijelo);
  if (tijeloOdgovora && tijeloOdgovora.ok === false) {
    return neispravanOblik('/appointments/cancel', odgovor.status);
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 5. Pomjeranje termina
// ---------------------------------------------------------------------------

export interface PomjeranjeTermina {
  businessId: string;
  appointmentId: string;
  /** UTC ISO. */
  startAt: string;
  /** UTC ISO. */
  endAt: string;
}

export async function pomjeriTermin(unos: PomjeranjeTermina): Promise<IshodTermina> {
  if (!jeUuid(unos.businessId)) {
    return neuspjehUlaza('businessId mora biti UUID — zahtjev prema Coreu nije poslan.');
  }
  if (!jeUuid(unos.appointmentId)) {
    return neuspjehUlaza('appointmentId mora biti UUID.');
  }
  const pocetak = utcIso(unos.startAt);
  const kraj = utcIso(unos.endAt);
  if (!pocetak) return neuspjehUlaza('startAt mora biti čitljiv ISO trenutak.');
  if (!kraj) return neuspjehUlaza('endAt mora biti čitljiv ISO trenutak.');

  const biznis = unos.businessId.trim();
  const odgovor = await posalji(
    '/appointments/reschedule',
    'POST',
    {
      business_id: biznis,
      appointment_id: unos.appointmentId.trim(),
      start_at: pocetak,
      end_at: kraj,
    },
    biznis,
  );
  if (jeNeuspjeh(odgovor)) return odgovor;

  return terminIzOdgovora(odgovor, '/appointments/reschedule', biznis, unos.appointmentId.trim());
}

// ---------------------------------------------------------------------------
// Zajedničko čitanje odgovora na /appointments i /appointments/reschedule
//
// 409 se ovdje pretvara u ishod, a ne u izuzetak: slot je zauzet, to je
// normalan tok razgovora. Pozivalac na osnovu `razlog` bira riječi za klijenta
// i NE SMIJE poslati isti zahtjev ponovo (`ponoviti: false`).
// ---------------------------------------------------------------------------

function terminIzOdgovora(
  odgovor: SiroviOdgovor,
  putanja: string,
  businessId: string,
  poznatAppointmentId?: string,
): IshodTermina {
  if (odgovor.status === 409) {
    const razlog = procitajRazlog(odgovor.tijelo, RAZLOZI_TERMINA);
    logger.info('Core je odbio termin.', { business_id: businessId, putanja, razlog });

    // Kod `alreadyBookedThatDay` Core kaze i KOJI termin kupac vec ima, da mu
    // asistent moze reci kada je, umjesto golog "ne moze".
    const tijelo409 = objekat(odgovor.tijelo);
    const pocetak = utcIso(tijelo409?.start_at);
    const id = tijelo409?.appointment_id;
    const postojeci =
      jeUuid(id) && pocetak ? { appointmentId: id.trim(), pocetak } : null;

    return {
      ok: false,
      vrsta: 'odbijeno',
      razlog,
      poruka: `Core je odbio termin: ${razlog}.`,
      status: 409,
      ponoviti: false,
      postojeci,
    };
  }

  const tijelo = objekat(odgovor.tijelo) as ZicaTerminOdgovor | null;
  if (!tijelo || tijelo.ok !== true) {
    return neispravanOblik(putanja, odgovor.status);
  }

  const appointmentId = jeTekst(tijelo.appointment_id)
    ? tijelo.appointment_id.trim()
    : poznatAppointmentId;
  if (!appointmentId) {
    return neispravanOblik(putanja, odgovor.status);
  }

  return {
    ok: true,
    appointmentId,
    kod: jeTekst(tijelo.reference) ? tijelo.reference.trim() : '',
    created: tijelo.created === true,
  };
}

// ---------------------------------------------------------------------------
// Nadolazeći termini kupca
//
// Kupac na WhatsAppu kaže "pomjeri mi termin". Identifikator termina ne zna i
// nikad ga neće otkucati — jedino što imamo je broj s kojeg piše. Ovo taj broj
// pretvara u njegove buduće termine, pa pomjeranje i otkazivanje prestaju biti
// slijepa ulica koja završi predajom čovjeku.
//
// Filtriranje po statusu i vremenu radi Core; gateway ne ponavlja ta pravila
// da se ne raziđu od onih koje primjenjuje ekran za rezervacije.
// ---------------------------------------------------------------------------

export interface TerminKupca {
  appointmentId: string;
  /** Kratak kod koji kupac moze procitati i izgovoriti; UUID ne moze. */
  kod: string;
  /** Za koga je termin, kad nije za onoga ko pise. Prazno = za njega. */
  ime: string;
  pocetak: string;
  kraj: string;
  usluga: string;
  zaposlenik: string;
}

interface ZicaTerminKupca {
  id?: unknown;
  reference?: unknown;
  guest_name?: unknown;
  start_at?: unknown;
  end_at?: unknown;
  service_name?: unknown;
  staff_name?: unknown;
}

export async function nadolazeciTermini(
  businessId: string,
  telefon: string,
): Promise<Ishod<{ termini: TerminKupca[] }>> {
  if (!jeUuid(businessId)) {
    return neuspjehUlaza('businessId mora biti UUID — zahtjev prema Coreu nije poslan.');
  }
  const broj = telefon.trim();
  if (!broj) {
    return neuspjehUlaza('Telefon je prazan — zahtjev prema Coreu nije poslan.');
  }
  const biznis = businessId.trim();

  const putanja =
    `/appointments?business_id=${encodeURIComponent(biznis)}` +
    `&phone=${encodeURIComponent(broj)}`;
  const odgovor = await posalji(putanja, 'GET', null, biznis);
  if (jeNeuspjeh(odgovor)) return odgovor;

  const tijelo = objekat(odgovor.tijelo);
  if (!tijelo || !Array.isArray(tijelo.appointments)) {
    return neispravanOblik('/appointments', odgovor.status);
  }

  const termini = nizOd<ZicaTerminKupca, TerminKupca>(tijelo.appointments, (red) => {
    if (!jeUuid(red.id)) return null;
    const pocetak = utcIso(red.start_at);
    const kraj = utcIso(red.end_at);
    if (!pocetak || !kraj) return null;
    return {
      appointmentId: red.id.trim(),
      kod: jeTekst(red.reference) ? red.reference.trim() : '',
      ime: jeTekst(red.guest_name) ? red.guest_name.trim() : '',
      pocetak,
      kraj,
      usluga: jeTekst(red.service_name) ? red.service_name : '',
      zaposlenik: jeTekst(red.staff_name) ? red.staff_name : '',
    };
  });

  return { ok: true, termini };
}

// ---------------------------------------------------------------------------
// Grupna rezervacija
//
// Jedna posjeta sa više usluga, ili više ljudi u jednom razgovoru. Vrijeme i
// raspored odlučuje Core: trajanja su njegova, a i provjera da svi stanu.
//
// Djelimična grupa ne postoji kao ishod — Core vrati ili sve ili ništa.
// ---------------------------------------------------------------------------

export interface UcesnikGrupe {
  /** Prazno = onaj ko piše. Inače "sestra", "kćerka", ime. */
  ime: string;
  serviceIds: string[];
  staffMemberId?: string;
}

export interface ZakazanClanGrupe {
  appointmentId: string;
  kod: string;
  ime: string;
  pocetak: string;
  kraj: string;
  serviceIds: string[];
}

interface ZicaClanGrupe {
  appointment_id?: unknown;
  reference?: unknown;
  guest_name?: unknown;
  start_at?: unknown;
  end_at?: unknown;
  service_ids?: unknown;
}

export async function napraviGrupu(unos: {
  businessId: string;
  startAt: string;
  klijent: { ime: string; telefon: string };
  ucesnici: UcesnikGrupe[];
}): Promise<Ishod<{ groupId: string; termini: ZakazanClanGrupe[] }> | OdbijenTermin> {
  if (!jeUuid(unos.businessId)) {
    return neuspjehUlaza('businessId mora biti UUID — zahtjev prema Coreu nije poslan.');
  }
  if (unos.ucesnici.length === 0) {
    return neuspjehUlaza('Grupa bez učesnika — zahtjev prema Coreu nije poslan.');
  }

  const biznis = unos.businessId.trim();
  const odgovor = await posalji(
    '/appointments/group',
    'POST',
    {
      business_id: biznis,
      start_at: unos.startAt,
      client: { full_name: unos.klijent.ime, phone: unos.klijent.telefon },
      participants: unos.ucesnici.map((u) => ({
        name: u.ime,
        service_ids: u.serviceIds,
        ...(u.staffMemberId ? { staff_member_id: u.staffMemberId } : {}),
      })),
    },
    biznis,
  );
  if (jeNeuspjeh(odgovor)) return odgovor;

  if (odgovor.status === 409) {
    const razlog = procitajRazlog(odgovor.tijelo, RAZLOZI_TERMINA);
    logger.info('Core je odbio grupu.', { business_id: biznis, razlog });
    return {
      ok: false,
      vrsta: 'odbijeno',
      razlog,
      poruka: `Core je odbio grupu: ${razlog}.`,
      status: 409,
      ponoviti: false,
      postojeci: null,
    };
  }

  const tijelo = objekat(odgovor.tijelo);
  if (!tijelo || tijelo.ok !== true || !jeTekst(tijelo.group_id)) {
    return neispravanOblik('/appointments/group', odgovor.status);
  }

  const termini = nizOd<ZicaClanGrupe, ZakazanClanGrupe>(tijelo.appointments, (red) => {
    if (!jeUuid(red.appointment_id)) return null;
    const pocetak = utcIso(red.start_at);
    const kraj = utcIso(red.end_at);
    if (!pocetak || !kraj) return null;
    return {
      appointmentId: red.appointment_id.trim(),
      kod: jeTekst(red.reference) ? red.reference.trim() : '',
      ime: jeTekst(red.guest_name) ? red.guest_name.trim() : '',
      pocetak,
      kraj,
      serviceIds: Array.isArray(red.service_ids) ? red.service_ids.filter(jeTekst) : [],
    };
  });

  if (termini.length === 0) return neispravanOblik('/appointments/group', odgovor.status);
  return { ok: true, groupId: tijelo.group_id.trim(), termini };
}
