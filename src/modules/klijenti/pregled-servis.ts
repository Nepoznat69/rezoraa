/**
 * ============================================================================
 * Operaterski pregled preko svih klijenata — SAMO ČITANJE iz Core baze
 * ============================================================================
 *
 * ZAŠTO OVDJE NEMA `business_id` FILTERA
 *
 * `core-repozitorij.ts` opslužuje razgovor jednog kupca sa jednim salonom, pa
 * tamo `where business_id = $1` mora stajati u svakom upitu — bez njega bi
 * poruke jednog salona završile kod drugog. Taj modul i dalje vrijedi kakav je.
 *
 * Ovaj modul ima drugu publiku: operatera Rezore, koji upravo TREBA vidjeti sve
 * salone odjednom (koliko je danas termina na cijeloj platformi, koji razgovori
 * čekaju čovjeka). Pregled po jednom salonu nije nedovoljan nego pogrešan —
 * operater ne zna unaprijed koji ga salon zanima. Zato upiti namjerno nemaju
 * `business_id` filter.
 *
 * Ograde koje to drže bezbjednim:
 *   1. Modul je ISKLJUČIVO čitajući. Nema INSERT, UPDATE ni DELETE — nijedna
 *      funkcija ovdje ne smije mijenjati Core bazu.
 *   2. Pristup ide samo kroz rute pod `/dashboard`, koje su iza basic auth
 *      prijave (vidi `dashboardAutorizovan` u `src/server.ts`). Ništa iz ovog
 *      modula nije dostupno nijednom kupcu ni klijentovoj aplikaciji.
 *   3. Svaki upit ima ORDER BY i LIMIT, pa jedan poziv ne može povući cijelu
 *      bazu. Granica je tvrdo ograničena na `MAKS_LIMIT`.
 *   4. Svi upiti su parametrizovani; spajanje stringova u SQL je zabranjeno.
 *      Period se bira iz zatvorene liste konstanti, nikad iz ulaza korisnika.
 *   5. Telefon se prema van vraća maskiran (`***8817`), a u logove ne ide ni
 *      telefon ni sadržaj poruke.
 *
 * Vremena se računaju i prikazuju u zoni Europe/Sarajevo, ne u UTC — operater
 * gleda kalendar salona, a ne serverski sat.
 * ============================================================================
 */

import { DateTime } from 'luxon';
import pg, { type QueryResultRow } from 'pg';
import { logger, maskPhone } from '../../lib/logger.js';

const { Pool } = pg;

/** Zona u kojoj rade svi saloni na platformi. */
const ZONA = 'Europe/Sarajevo';

/** Tvrda gornja granica broja redova po pozivu. */
export const MAKS_LIMIT = 200;

/** Koliko znakova zadnje poruke ide u tabelu prije skraćivanja. */
const DUZINA_ISJECKA = 90;

export const PERIODI = ['danas', 'sedmica', 'buduce', 'sve'] as const;
export type Period = (typeof PERIODI)[number];

export function jePeriod(vrijednost: unknown): vrijednost is Period {
  return typeof vrijednost === 'string' && (PERIODI as readonly string[]).includes(vrijednost);
}

// ---------------------------------------------------------------------------
// Izvršilac upita
//
// Namjerno vlastiti, čitajući pool: operaterski pregled se u `pg_stat_activity`
// vidi odvojeno od saobraćaja razgovora, pa spor izvještaj ne izgleda kao
// problem u obradi poruka. Testovi ga zamjenjuju lažnim izvršiocem.
// ---------------------------------------------------------------------------

export type IzvrsilacUpita = <T extends QueryResultRow>(
  tekst: string,
  vrijednosti: unknown[],
) => Promise<T[]>;

let pregledPool: pg.Pool | null = null;

function podrazumijevaniIzvrsilac(): IzvrsilacUpita {
  if (!pregledPool) {
    const url = process.env.CORE_DATABASE_URL;
    if (!url) {
      throw new Error(
        'CORE_DATABASE_URL nije postavljen — pregled ne zna iz koje Core baze da čita.',
      );
    }
    pregledPool = new Pool({
      connectionString: url,
      max: process.env.NODE_ENV === 'test' ? 1 : 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'rezora-gateway-pregled',
    });
  }
  const aktivniPool = pregledPool;
  return async <T extends QueryResultRow>(tekst: string, vrijednosti: unknown[]) => {
    const rezultat = await aktivniPool.query<T>(tekst, vrijednosti);
    return rezultat.rows;
  };
}

let izvrsilac: IzvrsilacUpita | null = null;

/** Zamjenjuje izvršilac upita. `null` vraća podrazumijevani (pravi) pool. */
export function postaviPregledIzvrsilac(zamjena: IzvrsilacUpita | null): void {
  izvrsilac = zamjena;
}

async function upit<T extends QueryResultRow>(tekst: string, vrijednosti: unknown[]): Promise<T[]> {
  const aktivni = izvrsilac ?? podrazumijevaniIzvrsilac();
  return aktivni<T>(tekst, vrijednosti);
}

/** Zatvara pool pregleda (uredno gašenje procesa). */
export async function zatvoriPregledVezu(): Promise<void> {
  if (!pregledPool) return;
  const stari = pregledPool;
  pregledPool = null;
  await stari.end();
}

// ---------------------------------------------------------------------------
// Pomoćne funkcije
// ---------------------------------------------------------------------------

export function ogranicenLimit(zeljeni: unknown): number {
  const broj = typeof zeljeni === 'number' ? zeljeni : Number(zeljeni);
  if (!Number.isFinite(broj)) return 50;
  return Math.min(Math.max(Math.trunc(broj), 1), MAKS_LIMIT);
}

function uBroj(vrijednost: unknown): number {
  const broj = typeof vrijednost === 'number' ? vrijednost : Number(vrijednost);
  return Number.isFinite(broj) ? broj : 0;
}

/** Trenutak iz baze (Date ili ISO tekst) u čitljivo vrijeme zone Europe/Sarajevo. */
function uVrijemeSalona(vrijednost: unknown): { iso: string | null; prikaz: string } {
  const trenutak =
    vrijednost instanceof Date
      ? DateTime.fromJSDate(vrijednost, { zone: ZONA })
      : typeof vrijednost === 'string'
        ? DateTime.fromISO(vrijednost, { zone: ZONA })
        : null;

  if (!trenutak?.isValid) return { iso: null, prikaz: '—' };
  return { iso: trenutak.toISO(), prikaz: trenutak.toFormat('dd.MM.yyyy. HH:mm') };
}

function skrati(tekst: string | null): string {
  const ocisceno = (tekst ?? '').replace(/\s+/g, ' ').trim();
  if (!ocisceno) return '';
  return ocisceno.length > DUZINA_ISJECKA ? `${ocisceno.slice(0, DUZINA_ISJECKA)}…` : ocisceno;
}

// ---------------------------------------------------------------------------
// 1. Sažetak platforme
// ---------------------------------------------------------------------------

export interface Sazetak {
  danas: number;
  nadolazece: number;
  ukupnoRazgovora: number;
  razgovoriKodCovjeka: number;
  aktivnihKlijenata: number;
}

/**
 * Otkazani termini i nedolasci se ne broje — operatera zanima koliko posla
 * platforma stvarno nosi, ne koliko je redova u tabeli.
 */
const SAZETAK_UPIT = `
SELECT
  (SELECT count(*) FROM public.appointments a
    WHERE a.status NOT IN ('cancelled','no_show')
      AND a.start_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Sarajevo') AT TIME ZONE 'Europe/Sarajevo'
      AND a.start_at <  (date_trunc('day', now() AT TIME ZONE 'Europe/Sarajevo') + interval '1 day') AT TIME ZONE 'Europe/Sarajevo'
  ) AS danas,
  (SELECT count(*) FROM public.appointments a
    WHERE a.status NOT IN ('cancelled','no_show')
      AND a.start_at >= now()
  ) AS nadolazece,
  (SELECT count(*) FROM public.conversations) AS ukupno_razgovora,
  (SELECT count(*) FROM public.conversations WHERE status = 'human') AS kod_covjeka,
  (SELECT count(*) FROM public.businesses WHERE status = 'active') AS aktivnih_klijenata
LIMIT 1`;

export async function sazetak(): Promise<Sazetak> {
  const redovi = await upit<{
    danas: string;
    nadolazece: string;
    ukupno_razgovora: string;
    kod_covjeka: string;
    aktivnih_klijenata: string;
  }>(SAZETAK_UPIT, []);

  const red = redovi[0];
  return {
    danas: uBroj(red?.danas),
    nadolazece: uBroj(red?.nadolazece),
    ukupnoRazgovora: uBroj(red?.ukupno_razgovora),
    razgovoriKodCovjeka: uBroj(red?.kod_covjeka),
    aktivnihKlijenata: uBroj(red?.aktivnih_klijenata),
  };
}

// ---------------------------------------------------------------------------
// 2. Rezervacije preko svih firmi
// ---------------------------------------------------------------------------

export interface RezervacijaRed {
  id: string;
  /** Kratak kod koji kupac vidi na WhatsAppu; po njemu se javlja. */
  kod: string;
  firma: string;
  kupac: string;
  usluga: string;
  radnik: string;
  pocetak: string | null;
  vrijeme: string;
  status: string;
}

/**
 * Uslov i redoslijed po periodu. Oboje je ovdje konstanta — nijedan dio ne
 * dolazi iz zahtjeva, pa u SQL ne ulazi nijedan korisnički string.
 *
 * Dnevne granice se računaju u zoni salona: `now() AT TIME ZONE 'Europe/Sarajevo'`
 * daje lokalni zidni sat, `date_trunc('day', …)` lokalnu ponoć, a povratni
 * `AT TIME ZONE` je vraća u timestamptz za poređenje sa `start_at`.
 *
 * Prošlost se sortira silazno (najnovije prvo), budućnost uzlazno (šta je
 * najbliže, to gore).
 */
const PERIOD_USLOV: Record<Period, { uslov: string; poredak: string }> = {
  danas: {
    uslov: `a.start_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Sarajevo') AT TIME ZONE 'Europe/Sarajevo'
        AND a.start_at <  (date_trunc('day', now() AT TIME ZONE 'Europe/Sarajevo') + interval '1 day') AT TIME ZONE 'Europe/Sarajevo'`,
    poredak: 'a.start_at ASC',
  },
  sedmica: {
    uslov: `a.start_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Sarajevo') AT TIME ZONE 'Europe/Sarajevo'
        AND a.start_at <  (date_trunc('day', now() AT TIME ZONE 'Europe/Sarajevo') + interval '7 days') AT TIME ZONE 'Europe/Sarajevo'`,
    poredak: 'a.start_at ASC',
  },
  buduce: {
    uslov: 'a.start_at >= now()',
    poredak: 'a.start_at ASC',
  },
  sve: {
    uslov: 'TRUE',
    poredak: 'a.start_at DESC',
  },
};

export async function rezervacije(opcije: {
  period?: unknown;
  limit?: unknown;
} = {}): Promise<RezervacijaRed[]> {
  const period: Period = jePeriod(opcije.period) ? opcije.period : 'danas';
  const granica = ogranicenLimit(opcije.limit);
  const { uslov, poredak } = PERIOD_USLOV[period];

  const redovi = await upit<{
    id: string;
    kod: string | null;
    firma: string | null;
    kupac: string | null;
    gost: string | null;
    usluge: string | null;
    radnik: string | null;
    start_at: Date | string | null;
    status: string | null;
  }>(
    `SELECT a.id,
            a.reference AS kod,
            b.name AS firma,
            k.full_name AS kupac,
            a.guest_name AS gost,
            -- Sve usluge posjete, redom kojim ih je kupac rekao. Ranije se
            -- prikazivala samo prva, pa je "sisanje + brijanje" izgledalo kao
            -- obicno sisanje i raspored radnika nije imao smisla.
            (SELECT string_agg(su.name, ' + ' ORDER BY x.position)
               FROM public.appointment_services x
               JOIN public.services su ON su.id = x.service_id
              WHERE x.appointment_id = a.id) AS usluge,
            r.full_name AS radnik,
            a.start_at,
            a.status::text AS status
       FROM public.appointments a
       JOIN public.businesses b ON b.id = a.business_id
       LEFT JOIN public.clients k ON k.id = a.client_id
       LEFT JOIN public.staff_members r ON r.id = a.staff_member_id
      WHERE ${uslov}
      ORDER BY ${poredak}
      LIMIT $1`,
    [granica],
  );

  logger.debug('Operaterski pregled rezervacija je pročitan.', {
    period,
    limit: granica,
    redova: redovi.length,
  });

  return redovi.map((red) => {
    const vrijeme = uVrijemeSalona(red.start_at);
    const gost = red.gost?.trim();
    const kupac = red.kupac?.trim();
    return {
      id: red.id,
      kod: red.kod?.trim() || '—',
      firma: red.firma?.trim() || 'Nepoznata firma',
      // Termin za gosta pise na gosta, uz onoga ko ga je rezervisao. Bez toga
      // su dva termina jedne grupe izgledala kao dva termina iste osobe.
      //
      // Kad je gost isti kao onaj ko rezervise — a to je slucaj za prvog clana
      // grupe — ime ide jednom. "Adna (rez. Adna)" nikome ne kaze nista.
      kupac: gost && gost.toLocaleLowerCase('bs') !== (kupac ?? '').toLocaleLowerCase('bs')
        ? `${gost}${kupac ? ` (rez. ${kupac})` : ''}`
        : gost || kupac || 'Nepoznat kupac',
      usluga: red.usluge?.trim() || '—',
      radnik: red.radnik?.trim() || '—',
      pocetak: vrijeme.iso,
      vrijeme: vrijeme.prikaz,
      status: red.status?.trim() || 'scheduled',
    };
  });
}

// ---------------------------------------------------------------------------
// 3. Razgovori preko svih firmi
// ---------------------------------------------------------------------------

export interface RazgovorRed {
  id: string;
  firma: string;
  /** Uvijek maskiran broj (`***8817`), uz ime iz profila ako ga kanal nudi. */
  kontakt: string;
  status: string;
  zadnjaPoruka: string;
  zadnjiSmjer: 'inbound' | 'outbound' | null;
  zadnjeVrijeme: string | null;
  vrijeme: string;
}

export async function razgovori(opcije: { limit?: unknown } = {}): Promise<RazgovorRed[]> {
  const granica = ogranicenLimit(opcije.limit);

  const redovi = await upit<{
    id: string;
    firma: string | null;
    external_contact: string | null;
    contact_name: string | null;
    status: string | null;
    last_message_at: Date | string | null;
    zadnja_poruka: string | null;
    zadnji_smjer: string | null;
  }>(
    `SELECT r.id,
            b.name AS firma,
            r.external_contact,
            r.contact_name,
            r.status,
            r.last_message_at,
            p.body AS zadnja_poruka,
            p.direction AS zadnji_smjer
       FROM public.conversations r
       JOIN public.businesses b ON b.id = r.business_id
       LEFT JOIN LATERAL (
         SELECT m.body, m.direction
           FROM public.messages m
          WHERE m.conversation_id = r.id
          ORDER BY m.created_at DESC
          LIMIT 1
       ) p ON TRUE
      ORDER BY r.last_message_at DESC NULLS LAST, r.created_at DESC
      LIMIT $1`,
    [granica],
  );

  // U log ide samo koliko ih je — ni broj ni sadržaj poruke.
  logger.debug('Operaterski pregled razgovora je pročitan.', {
    limit: granica,
    redova: redovi.length,
  });

  return redovi.map((red) => {
    const vrijeme = uVrijemeSalona(red.last_message_at);
    const maskirano = red.external_contact ? maskPhone(red.external_contact) : '***';
    const ime = red.contact_name?.trim();
    const smjer = red.zadnji_smjer === 'outbound' ? 'outbound' : red.zadnji_smjer === 'inbound' ? 'inbound' : null;

    return {
      id: red.id,
      firma: red.firma?.trim() || 'Nepoznata firma',
      kontakt: ime ? `${ime} (${maskirano})` : maskirano,
      status: red.status?.trim() || 'bot',
      zadnjaPoruka: skrati(red.zadnja_poruka),
      zadnjiSmjer: smjer,
      zadnjeVrijeme: vrijeme.iso,
      vrijeme: vrijeme.prikaz,
    };
  });
}
