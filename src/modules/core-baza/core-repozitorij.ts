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
        SET status = 'human'
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
