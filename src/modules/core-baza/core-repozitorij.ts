/**
 * ============================================================================
 * Rezora Core — jedini modul kroz koji gateway smije dirati Core bazu
 * ============================================================================
 *
 * ZAŠTO JE business_id OBAVEZAN U SVAKOJ FUNKCIJI
 *
 * Gateway se na Core Supabase bazu spaja SERVICE ROLE konekcijom. Service role
 * ZAOBILAZI Row Level Security — sve `is_business_member(business_id)` politike
 * iz migracija 0001 i 0012 za ovu konekciju jednostavno ne postoje. Baza nas
 * ovdje ne štiti ni od čega.
 *
 * To znači: jedini zid između dva biznisa je `where business_id = $1` u ovom
 * fajlu. Upit bez tog filtera nije "malo nesiguran" — on je curenje podataka:
 * poruke jednog salona završe u inboxu drugog. Zato:
 *
 *   1. SVAKA izvezena funkcija prima business_id kao IZRIČIT prvi argument.
 *      Nikad se ne izvodi iz sesije, globalne varijable ni iz payloada koji je
 *      stigao sa interneta.
 *   2. SVAKI upit ima `where business_id = $1`. Jedini izuzetak je
 *      `businessIdZaBroj` — funkcija koja business_id TEK RAZRJEŠAVA; ona je
 *      posebno ograđena (vidi komentar iznad nje).
 *   3. Zapisi u `messages` ne uzimaju conversation_id na riječ nego ga vežu
 *      preko `insert ... select from conversations where business_id = $1`,
 *      pa tuđi conversation_id fizički ne može proći.
 *   4. Nema nijedne funkcije koja vraća podatke bez business_id filtera
 *      ("vrati sve razgovore" ovdje ne postoji i ne smije nastati).
 *   5. Svi upiti su parametrizovani. Spajanje stringova u SQL je zabranjeno.
 *
 * Ugovor tabela: database/migrations/0012_conversations_and_messages.sql
 * (Rezora Core). Ovaj modul ne smije ići izvan tog ugovora.
 *
 * U logove ne idu telefoni ni sadržaj poruka — samo identifikatori.
 * ============================================================================
 */

import pg, { type QueryResultRow } from 'pg';
import { logger } from '../../lib/logger.js';
import { normalizePhone } from '../../lib/security.js';

const { Pool } = pg;

/**
 * Statusi isporuke koje Metin webhook zna poslati.
 * (Kanal je svuda ispisan kao literal 'whatsapp' unutar SQL-a — u upite se
 * namjerno ne ubacuje nijedna JS vrijednost, ni konstantna.)
 */
const STATUSI_ISPORUKE = ['sent', 'delivered', 'read', 'failed'] as const;
export type StatusIsporuke = (typeof STATUSI_ISPORUKE)[number];

// ---------------------------------------------------------------------------
// Izvršilac upita
//
// Sve funkcije idu kroz jedan izvršilac da bi (a) postojalo tačno jedno mjesto
// koje priča sa Core bazom i (b) testovi mogli pročitati tekst svakog upita.
// ---------------------------------------------------------------------------

export type IzvrsilacUpita = <T extends QueryResultRow>(
  tekst: string,
  vrijednosti: unknown[],
) => Promise<T[]>;

let corePool: pg.Pool | null = null;

function podrazumijevaniIzvrsilac(): IzvrsilacUpita {
  if (!corePool) {
    const url = process.env.CORE_DATABASE_URL;
    if (!url) {
      throw new Error(
        'CORE_DATABASE_URL nije postavljen — gateway ne zna na koju Core bazu da piše.',
      );
    }
    corePool = new Pool({
      connectionString: url,
      max: process.env.NODE_ENV === 'test' ? 2 : 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'rezora-gateway-core',
    });
  }
  const aktivniPool = corePool;
  return async <T extends QueryResultRow>(tekst: string, vrijednosti: unknown[]) => {
    const rezultat = await aktivniPool.query<T>(tekst, vrijednosti);
    return rezultat.rows;
  };
}

let izvrsilac: IzvrsilacUpita | null = null;

/**
 * Zamjenjuje izvršilac upita. Služi testovima i budućem spajanju na zajednički
 * Core pool. `null` vraća podrazumijevani (pravi) pool.
 */
export function postaviCoreIzvrsilac(zamjena: IzvrsilacUpita | null): void {
  izvrsilac = zamjena;
}

async function upit<T extends QueryResultRow>(tekst: string, vrijednosti: unknown[]): Promise<T[]> {
  const aktivni = izvrsilac ?? podrazumijevaniIzvrsilac();
  return aktivni<T>(tekst, vrijednosti);
}

/** Zatvara Core pool (uredno gašenje procesa). */
export async function zatvoriCoreVezu(): Promise<void> {
  if (!corePool) return;
  const stari = corePool;
  corePool = null;
  await stari.end();
}

// ---------------------------------------------------------------------------
// Provjere ulaza — prije nego ijedan upit krene
// ---------------------------------------------------------------------------

const UUID_OBLIK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * business_id mora biti stvaran UUID. Prazan string ili `undefined` koji se
 * provuče u upit bi u kombinaciji sa service role konekcijom bio katastrofa,
 * pa se ovdje ruši glasno i odmah.
 */
function obavezanBusinessId(businessId: string): string {
  if (typeof businessId !== 'string' || !UUID_OBLIK.test(businessId.trim())) {
    throw new Error('business_id je obavezan i mora biti UUID — upit se ne izvršava.');
  }
  return businessId.trim();
}

function obavezanUuid(vrijednost: string, naziv: string): string {
  if (typeof vrijednost !== 'string' || !UUID_OBLIK.test(vrijednost.trim())) {
    throw new Error(`${naziv} mora biti UUID.`);
  }
  return vrijednost.trim();
}

function obavezanTekst(vrijednost: string, naziv: string): string {
  const ocisceno = typeof vrijednost === 'string' ? vrijednost.trim() : '';
  if (!ocisceno) throw new Error(`${naziv} je obavezan.`);
  return ocisceno;
}

// ---------------------------------------------------------------------------
// 1. Prevod Metinog phone_number_id u business_id
//
// JEDINI upit u ovom fajlu bez `where business_id = $1` — i to zato što je on
// funkcija koja business_id tek proizvodi. Ograde:
//   * traži se isključivo provider = 'whatsapp' i tačan phone_number_id,
//   * vraća se samo kolona business_id (nikakav sadržaj tuđeg biznisa),
//   * ako baza ikako vrati više od jednog reda, ne bira se "prvi" nego se
//     odbija sve — dvosmislen broj znači da bi poruke jednog biznisa mogle
//     otići drugom. (Core ima unique indeks integrations_whatsapp_phone_unique,
//     ali se na njega ne oslanjamo slijepo.)
// ---------------------------------------------------------------------------

export async function businessIdZaBroj(phoneNumberId: string): Promise<string | null> {
  const broj = typeof phoneNumberId === 'string' ? phoneNumberId.trim() : '';
  if (!broj) return null;

  const redovi = await upit<{ business_id: string }>(
    `SELECT i.business_id
       FROM public.integrations i
      WHERE i.provider = 'whatsapp'
        AND i.config->>'phone_number_id' = $1
      LIMIT 2`,
    [broj],
  );

  if (redovi.length === 0) {
    logger.warn('Meta phone_number_id nije vezan ni za jedan biznis u Coreu.', {
      phone_number_id: broj,
    });
    return null;
  }
  if (redovi.length > 1) {
    logger.error('Isti Meta phone_number_id je vezan za više biznisa — obrada se prekida.', {
      phone_number_id: broj,
      broj_pogodaka: redovi.length,
    });
    return null;
  }
  return redovi[0].business_id;
}

// ---------------------------------------------------------------------------
// 2. Razgovor
// ---------------------------------------------------------------------------

export async function nadjiIliNapraviRazgovor(
  businessId: string,
  kontakt: string,
  imeKontakta?: string,
): Promise<string> {
  const biznis = obavezanBusinessId(businessId);
  const adresa = normalizePhone(obavezanTekst(kontakt, 'kontakt'));
  if (!adresa) throw new Error('kontakt ne sadrži nijednu cifru.');
  const ime = imeKontakta?.trim() ? imeKontakta.trim() : null;

  const uneseni = await upit<{ id: string }>(
    `INSERT INTO public.conversations (business_id, channel, external_contact, contact_name)
     VALUES ($1, 'whatsapp'::public.integration_provider, $2, $3)
     ON CONFLICT (business_id, channel, external_contact)
     DO UPDATE SET contact_name = COALESCE(NULLIF(EXCLUDED.contact_name, ''), conversations.contact_name)
      WHERE conversations.business_id = $1
     RETURNING id`,
    [biznis, adresa, ime],
  );
  if (uneseni[0]) return uneseni[0].id;

  const postojeci = await upit<{ id: string }>(
    `SELECT id FROM public.conversations
      WHERE business_id = $1
        AND channel = 'whatsapp'::public.integration_provider
        AND external_contact = $2
      LIMIT 1`,
    [biznis, adresa],
  );
  if (!postojeci[0]) {
    throw new Error('Razgovor nije mogao biti kreiran ni pronađen u Core bazi.');
  }
  return postojeci[0].id;
}

// ---------------------------------------------------------------------------
// 3. i 4. Poruke
// ---------------------------------------------------------------------------

export interface ZapisPoruke {
  /** id reda u `messages` (postojećeg ako je poruka već bila zapisana). */
  id: string;
  /** true = Meta je ponovo isporučila isti webhook, nije upisan novi red. */
  duplikat: boolean;
}

export interface DolaznaPoruka {
  businessId: string;
  conversationId: string;
  externalMessageId: string;
  tekst: string;
  tipPoruke?: string;
}

export interface OdlaznaPoruka {
  businessId: string;
  conversationId: string;
  tekst: string;
  externalMessageId?: string;
}

/**
 * Upisuje poruku. Red se ne stvara direktno nego kroz `select` iz
 * `conversations` sa `business_id = $1`, pa conversation_id iz drugog biznisa
 * ne može biti povezan — nema reda za spajanje, nema ni inserta.
 */
async function zapisiPoruku(
  biznis: string,
  razgovor: string,
  smjer: 'inbound' | 'outbound',
  externalMessageId: string | null,
  tekst: string,
  tipPoruke: string,
  status: 'received' | 'queued' | 'sent',
): Promise<ZapisPoruke> {
  const uneseni = await upit<{ id: string }>(
    `INSERT INTO public.messages
       (business_id, conversation_id, direction, external_message_id, body, message_type, status)
     SELECT r.business_id, r.id, $3, $4, $5, $6, $7
       FROM public.conversations r
      WHERE r.business_id = $1
        AND r.id = $2
     ON CONFLICT (business_id, external_message_id) WHERE external_message_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [biznis, razgovor, smjer, externalMessageId, tekst, tipPoruke, status],
  );

  if (uneseni[0]) {
    await upit(
      `UPDATE public.conversations
          SET last_message_at = now()
        WHERE business_id = $1
          AND id = $2`,
      [biznis, razgovor],
    );
    return { id: uneseni[0].id, duplikat: false };
  }

  // Nema novog reda: ili je isti webhook već obrađen, ili razgovor ne pripada
  // ovom biznisu. Provjeravamo prvo, jer se te dvije stvari nikako ne smiju
  // pomiješati.
  if (externalMessageId) {
    const postojeca = await upit<{ id: string }>(
      `SELECT id FROM public.messages
        WHERE business_id = $1
          AND external_message_id = $2
        LIMIT 1`,
      [biznis, externalMessageId],
    );
    if (postojeca[0]) {
      logger.debug('Poruka je već zapisana, webhook je ponovljen.', {
        business_id: biznis,
        conversation_id: razgovor,
      });
      return { id: postojeca[0].id, duplikat: true };
    }
  }

  logger.error('Razgovor ne pripada biznisu — poruka nije zapisana.', {
    business_id: biznis,
    conversation_id: razgovor,
  });
  throw new Error('Razgovor ne pripada tom biznisu — poruka nije zapisana.');
}

export async function zapisiDolaznuPoruku(unos: DolaznaPoruka): Promise<ZapisPoruke> {
  const biznis = obavezanBusinessId(unos.businessId);
  const razgovor = obavezanUuid(unos.conversationId, 'conversationId');
  const vanjskiId = obavezanTekst(unos.externalMessageId, 'externalMessageId');
  const tip = unos.tipPoruke?.trim() ? unos.tipPoruke.trim() : 'text';

  return zapisiPoruku(biznis, razgovor, 'inbound', vanjskiId, unos.tekst ?? '', tip, 'received');
}

export async function zapisiOdlaznuPoruku(unos: OdlaznaPoruka): Promise<ZapisPoruke> {
  const biznis = obavezanBusinessId(unos.businessId);
  const razgovor = obavezanUuid(unos.conversationId, 'conversationId');
  const vanjskiId = unos.externalMessageId?.trim() ? unos.externalMessageId.trim() : null;

  return zapisiPoruku(
    biznis,
    razgovor,
    'outbound',
    vanjskiId,
    unos.tekst ?? '',
    'text',
    vanjskiId ? 'sent' : 'queued',
  );
}

// ---------------------------------------------------------------------------
// 5. Status isporuke iz Metinog webhooka
// ---------------------------------------------------------------------------

export async function azurirajStatusPoruke(
  businessId: string,
  externalMessageId: string,
  status: string,
): Promise<boolean> {
  const biznis = obavezanBusinessId(businessId);
  const vanjskiId = obavezanTekst(externalMessageId, 'externalMessageId');
  if (!STATUSI_ISPORUKE.includes(status as StatusIsporuke)) {
    throw new Error(`Nepoznat status isporuke: ${String(status)}`);
  }

  // Meta zna isporučiti statuse van redoslijeda (npr. 'delivered' poslije
  // 'read'), pa se status nikad ne vraća unazad. 'failed' je jedini koji
  // uvijek prolazi.
  const redovi = await upit<{ id: string }>(
    `UPDATE public.messages
        SET status = $3,
            error_message = CASE
              WHEN $3 = 'failed' THEN COALESCE(error_message, 'Meta je prijavila neuspjelu isporuku.')
              ELSE error_message
            END
      WHERE business_id = $1
        AND external_message_id = $2
        AND ($3 = 'failed'
             OR COALESCE(array_position(ARRAY['received','queued','sent','delivered','read'], status), 0)
                < COALESCE(array_position(ARRAY['received','queued','sent','delivered','read'], $3), 0))
     RETURNING id`,
    [biznis, vanjskiId, status],
  );

  return redovi.length > 0;
}

// ---------------------------------------------------------------------------
// 6. Čovjek preuzima razgovor
// ---------------------------------------------------------------------------

export async function preuzeoCovjek(businessId: string, conversationId: string): Promise<boolean> {
  const biznis = obavezanBusinessId(businessId);
  const razgovor = obavezanUuid(conversationId, 'conversationId');

  const redovi = await upit<{ id: string }>(
    `UPDATE public.conversations
        SET status = 'human', updated_at = now()
      WHERE business_id = $1
        AND id = $2
        AND status <> 'human'
     RETURNING id`,
    [biznis, razgovor],
  );

  if (redovi.length > 0) {
    logger.info('Čovjek je preuzeo razgovor, asistent šuti.', {
      business_id: biznis,
      conversation_id: razgovor,
    });
  }
  return redovi.length > 0;
}

/**
 * Vraća razgovor asistentu kad predaja nije urodila plodom.
 *
 * Predaja čovjeku ušutkava asistenta trajno. U salonu u kojem niko ne gleda
 * Inbox to znači da kupac koji poslije napiše "može li rezervacija?" ne dobije
 * odgovor nikada. Tišina je gora od nesavršenog odgovora, pa se asistent vraća
 * ako se u zadanom roku nije javio nijedan čovjek.
 *
 * Ako je zaposlenik odgovorio (outbound poruka sa sent_by), razgovor ostaje
 * njegov — bez obzira na protelo vrijeme.
 */
export async function vratiBotaAkoNikoNijeOdgovorio(
  businessId: string,
  conversationId: string,
  minuta: number,
): Promise<boolean> {
  const biznis = obavezanBusinessId(businessId);
  const razgovor = obavezanUuid(conversationId, 'conversationId');
  if (!Number.isFinite(minuta) || minuta <= 0) return false;

  const redovi = await upit<{ id: string }>(
    `UPDATE public.conversations AS c
        SET status = 'bot', updated_at = now()
      WHERE c.business_id = $1
        AND c.id = $2
        AND c.status = 'human'
        AND c.updated_at < now() - ($3 || ' minutes')::interval
        AND NOT EXISTS (
              SELECT 1
                FROM public.messages AS m
               WHERE m.conversation_id = c.id
                 AND m.direction = 'outbound'
                 AND m.sent_by IS NOT NULL
                 AND m.created_at >= c.updated_at
            )
     RETURNING c.id`,
    [biznis, razgovor, String(Math.round(minuta))],
  );

  if (redovi.length > 0) {
    logger.info('Niko nije preuzeo razgovor u roku; asistent nastavlja.', {
      business_id: biznis,
      conversation_id: razgovor,
      minuta,
    });
  }
  return redovi.length > 0;
}

// ---------------------------------------------------------------------------
// 7. Čitanje razgovora
//
// Bez ovoga asistent nema pamćenje: svaka poruka bi mu izgledala kao prva, pa
// bi iznova pitao ono što je kupac već rekao. Bez statusa bi nastavio
// odgovarati i nakon što razgovor preuzme čovjek.
// ---------------------------------------------------------------------------

export interface StanjeRazgovora {
  id: string;
  status: 'bot' | 'human' | 'closed';
  contactName: string | null;
  clientId: string | null;
}

/** Vraća stanje razgovora ili null ako ne pripada tom biznisu. */
export async function stanjeRazgovora(
  businessId: string,
  conversationId: string,
): Promise<StanjeRazgovora | null> {
  const biznis = obavezanBusinessId(businessId);
  const razgovor = obavezanUuid(conversationId, 'conversationId');

  const redovi = await upit<{
    id: string;
    status: string;
    contact_name: string | null;
    client_id: string | null;
  }>(
    `SELECT id, status, contact_name, client_id
       FROM public.conversations
      WHERE business_id = $1 AND id = $2
      LIMIT 1`,
    [biznis, razgovor],
  );

  const red = redovi[0];
  if (!red) return null;

  const status = red.status === 'human' || red.status === 'closed' ? red.status : 'bot';
  return { id: red.id, status, contactName: red.contact_name, clientId: red.client_id };
}

export interface PorukaIzHistorije {
  direction: 'inbound' | 'outbound';
  body: string;
}

/**
 * Zadnjih `koliko` poruka razgovora, poredanih od najstarije prema najnovijoj —
 * u redoslijedu u kojem ih AI sloj očekuje.
 */
export async function historijaRazgovora(
  businessId: string,
  conversationId: string,
  koliko = 10,
): Promise<PorukaIzHistorije[]> {
  const biznis = obavezanBusinessId(businessId);
  const razgovor = obavezanUuid(conversationId, 'conversationId');
  const granica = Math.min(Math.max(Math.trunc(koliko), 1), 50);

  const redovi = await upit<{ direction: string; body: string }>(
    `SELECT direction, body
       FROM public.messages
      WHERE business_id = $1 AND conversation_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [biznis, razgovor, granica],
  );

  return redovi
    .map((r) => ({
      direction: r.direction === 'outbound' ? ('outbound' as const) : ('inbound' as const),
      body: r.body ?? '',
    }))
    .reverse();
}

// ---------------------------------------------------------------------------
// 8. Šta asistent čeka od kupca
//
// Otkazivanje se ne izvršava na prvu riječ: asistent kaže KOJI termin otkazuje
// i pita za potvrdu. Da bi sljedeću poruku razumio kao odgovor na to pitanje,
// mora zapamtiti šta je pitao.
//
// Zapis ima vrijeme jer potvrda koja stigne sat kasnije nije potvrda nego nova
// poruka — a „da" na staro pitanje ne smije otkazati termin.
// ---------------------------------------------------------------------------

export interface CekanaRadnja {
  vrsta: 'otkazivanje' | 'pomjeranje';
  /**
   * Termini na koje se pitanje odnosi.
   *
   * Vise od jednog kad kupac trazi da otkaze SVE — grupa se onda otkazuje
   * odjednom, jer je i zakazana odjednom. Ranije je "otkazujem oba" vracalo
   * pitanje "koji od njih mislite?" i kupac je ostajao u krugu.
   */
  appointmentIds: string[];
  kodovi: string[];
  /** UTC ISO trenutka kad je asistent pitao. */
  pitanoU: string;
  /** Novo vrijeme, samo kod pomjeranja. */
  novoVrijeme?: string;
}

/** Koliko dugo „da" vrijedi kao odgovor na pitanje asistenta. */
export const ROK_POTVRDE_MINUTA = 10;

export async function zapamtiCekanuRadnju(
  businessId: string,
  conversationId: string,
  radnja: CekanaRadnja | null,
): Promise<void> {
  const biznis = obavezanBusinessId(businessId);
  const razgovor = obavezanUuid(conversationId, 'conversationId');

  await upit(
    `UPDATE public.conversations
        SET pending_action = $3::jsonb
      WHERE business_id = $1 AND id = $2`,
    [biznis, razgovor, radnja ? JSON.stringify(radnja) : null],
  );
}

/** Vraća čekanu radnju samo ako još nije istekla; inače `null`. */
export async function cekanaRadnja(
  businessId: string,
  conversationId: string,
): Promise<CekanaRadnja | null> {
  const biznis = obavezanBusinessId(businessId);
  const razgovor = obavezanUuid(conversationId, 'conversationId');

  const redovi = await upit<{ pending_action: unknown }>(
    `SELECT pending_action
       FROM public.conversations
      WHERE business_id = $1 AND id = $2
      LIMIT 1`,
    [biznis, razgovor],
  );

  const sirovo = redovi[0]?.pending_action;
  if (!sirovo || typeof sirovo !== 'object') return null;

  const radnja = sirovo as Partial<CekanaRadnja>;
  const identifikatori = Array.isArray(radnja.appointmentIds)
    ? radnja.appointmentIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (
    (radnja.vrsta !== 'otkazivanje' && radnja.vrsta !== 'pomjeranje') ||
    identifikatori.length === 0 ||
    typeof radnja.pitanoU !== 'string'
  ) {
    return null;
  }

  const proteklo = Date.now() - new Date(radnja.pitanoU).getTime();
  if (!Number.isFinite(proteklo) || proteklo > ROK_POTVRDE_MINUTA * 60_000) return null;

  return {
    vrsta: radnja.vrsta,
    appointmentIds: identifikatori,
    kodovi: Array.isArray(radnja.kodovi)
      ? radnja.kodovi.filter((k): k is string => typeof k === 'string')
      : [],
    pitanoU: radnja.pitanoU,
    ...(typeof radnja.novoVrijeme === 'string' ? { novoVrijeme: radnja.novoVrijeme } : {}),
  };
}

// ---------------------------------------------------------------------------
// 9. Šta je razgovor već utvrdio
//
// Rezervacija se sklapa kroz nekoliko poruka: „sutra u 13", pa „za mene i
// ženu", pa „brijanje". Svaka poruka za sebe je nepotpuna, a asistent je svaku
// čitao kao da je prva — pa je kupac koji je već rekao 13:00 dvije poruke
// kasnije dobijao ponudu za 09:00.
//
// Historija razgovora ide modelu, ali ona je prijepis, ne odluka. Ovdje stoji
// odluka: šta je utvrđeno i kada.
// ---------------------------------------------------------------------------

export interface PoznatiPodaci {
  date?: string;
  start_time?: string;
  service?: string;
  customer_name?: string;
  /** UTC ISO trenutka zadnjeg upisa. Stariji kontekst se ne vraća u igru. */
  upisanoU: string;
}

/**
 * Koliko dugo ono što je kupac rekao vrijedi kao kontekst.
 *
 * Pola sata je granica poslije koje „sutra u 13" vjerovatno pripada nekom
 * ranijem razgovoru, a ne ovom — a tiho dopunjavanje starim podatkom je gore
 * od pitanja.
 */
export const ROK_POZNATIH_PODATAKA_MINUTA = 30;

export async function zapamtiPoznatePodatke(
  businessId: string,
  conversationId: string,
  podaci: PoznatiPodaci | null,
): Promise<void> {
  const biznis = obavezanBusinessId(businessId);
  const razgovor = obavezanUuid(conversationId, 'conversationId');

  await upit(
    `UPDATE public.conversations
        SET known_slots = $3::jsonb
      WHERE business_id = $1 AND id = $2`,
    [biznis, razgovor, podaci ? JSON.stringify(podaci) : null],
  );
}

/** Vraća utvrđene podatke samo ako još nisu istekli; inače `null`. */
export async function poznatiPodaci(
  businessId: string,
  conversationId: string,
): Promise<PoznatiPodaci | null> {
  const biznis = obavezanBusinessId(businessId);
  const razgovor = obavezanUuid(conversationId, 'conversationId');

  const redovi = await upit<{ known_slots: unknown }>(
    `SELECT known_slots
       FROM public.conversations
      WHERE business_id = $1 AND id = $2
      LIMIT 1`,
    [biznis, razgovor],
  );

  const sirovo = redovi[0]?.known_slots;
  if (!sirovo || typeof sirovo !== 'object') return null;

  const podaci = sirovo as Partial<PoznatiPodaci>;
  if (typeof podaci.upisanoU !== 'string') return null;

  const proteklo = Date.now() - new Date(podaci.upisanoU).getTime();
  if (!Number.isFinite(proteklo) || proteklo > ROK_POZNATIH_PODATAKA_MINUTA * 60_000) {
    return null;
  }

  const tekst = (vrijednost: unknown): string | undefined =>
    typeof vrijednost === 'string' && vrijednost.trim() ? vrijednost.trim() : undefined;

  return {
    ...(tekst(podaci.date) ? { date: tekst(podaci.date) } : {}),
    ...(tekst(podaci.start_time) ? { start_time: tekst(podaci.start_time) } : {}),
    ...(tekst(podaci.service) ? { service: tekst(podaci.service) } : {}),
    ...(tekst(podaci.customer_name) ? { customer_name: tekst(podaci.customer_name) } : {}),
    upisanoU: podaci.upisanoU,
  };
}

// ---------------------------------------------------------------------------
// 10. Šta asistent pamti o kontaktu koji pretjeruje
//
// Brojanje brzine je u gateway bazi i preživi pad Corea. Ovo je druga stvar:
// odluka o kupcu, koju vlasnik mora VIDJETI u Inboxu i moći poništiti. Blokada
// koju salon ne vidi ne razlikuje se od kupca koji je prestao pisati.
//
// Ugovor tabele: database/migrations/0021_conversation_abuse_state.sql (Core).
// ---------------------------------------------------------------------------

/** Koliko strikeova prije nego asistent zašuti. */
export const STRIKEOVA_DO_BLOKADE = 3;

/**
 * Koliko dugo traje blokada, po redu.
 *
 * Prva je kratka jer je najvjerovatnije greška — nervozan kupac kojem je hitno
 * nije napadač. Ko se vrati poslije nje, vraća se namjerno, pa druga traje
 * duže. Duže od dana se ne ide bez čovjeka: to više nije prigušenje nego odluka
 * da se neko ne uslužuje, a nju donosi vlasnik, ne brojač.
 */
export const TRAJANJE_BLOKADE_MINUTA = [30, 180, 1440] as const;

export interface StanjeZastite {
  strikes: number;
  /** UTC ISO do kada asistent šuti, ili null. */
  blokiranDo: string | null;
  razlog: string | null;
}

/** Je li razgovor trenutno ušutkan i zašto. */
export async function stanjeZastite(
  businessId: string,
  conversationId: string,
): Promise<StanjeZastite | null> {
  const biznis = obavezanBusinessId(businessId);
  const razgovor = obavezanUuid(conversationId, 'conversationId');

  const redovi = await upit<{
    strikes: number | null;
    blocked_until: string | null;
    blocked_reason: string | null;
  }>(
    `SELECT strikes, blocked_until, blocked_reason
       FROM public.conversations
      WHERE business_id = $1 AND id = $2
      LIMIT 1`,
    [biznis, razgovor],
  );

  const red = redovi[0];
  if (!red) return null;

  // Istekla blokada se ovdje tretira kao da je nema. Redovi se ne čiste da bi
  // vlasnik u Inboxu i dalje vidio da je nekad postojala.
  const doKada = red.blocked_until ? new Date(red.blocked_until) : null;
  const vazi = doKada !== null && Number.isFinite(doKada.getTime()) && doKada.getTime() > Date.now();

  return {
    strikes: typeof red.strikes === 'number' ? red.strikes : 0,
    blokiranDo: vazi && red.blocked_until ? new Date(red.blocked_until).toISOString() : null,
    razlog: vazi ? red.blocked_reason : null,
  };
}

/**
 * Bilježi prekršaj i, ako ih se nakupilo dovoljno, ušutkava asistenta.
 *
 * Blokada se postavlja istim upitom koji povećava brojač, pa dvije poruke u
 * istom trenutku ne mogu obje pročitati „dva strikea" i obje dodati treći.
 *
 * Vraća do kada je ušutkan, ili null ako još nije.
 */
export async function dodajStrike(
  businessId: string,
  conversationId: string,
  razlog: string,
): Promise<string | null> {
  const biznis = obavezanBusinessId(businessId);
  const razgovor = obavezanUuid(conversationId, 'conversationId');
  const opis = razlog.trim().slice(0, 200);

  // Trajanje raste sa svakim ponavljanjem. Cijela odluka je u jednom UPDATE-u
  // jer se `strikes` u istom izrazu i cita i pise — dvije poruke u istom
  // trenutku ne mogu obje vidjeti „dva strikea" i obje dodati treci.
  const redovi = await upit<{ blocked_until: string | null }>(
    `UPDATE public.conversations
        SET strikes = strikes + 1,
            blocked_until = CASE
              WHEN strikes + 1 >= $3
              THEN now() + ((CASE
                     WHEN strikes + 1 >= $3 + 2 THEN $6
                     WHEN strikes + 1 >= $3 + 1 THEN $5
                     ELSE $4
                   END)::text || ' minutes')::interval
              ELSE blocked_until
            END,
            blocked_reason = CASE WHEN strikes + 1 >= $3 THEN $7 ELSE blocked_reason END,
            updated_at = now()
      WHERE business_id = $1 AND id = $2
     RETURNING blocked_until`,
    [
      biznis,
      razgovor,
      STRIKEOVA_DO_BLOKADE,
      TRAJANJE_BLOKADE_MINUTA[0],
      TRAJANJE_BLOKADE_MINUTA[1],
      TRAJANJE_BLOKADE_MINUTA[2],
      opis,
    ],
  );

  const doKada = redovi[0]?.blocked_until ?? null;
  if (doKada) {
    logger.info('Asistent je ušutkan za ovaj kontakt.', {
      business_id: biznis,
      conversation_id: razgovor,
      razlog: opis,
    });
  }
  return doKada ? new Date(doKada).toISOString() : null;
}
