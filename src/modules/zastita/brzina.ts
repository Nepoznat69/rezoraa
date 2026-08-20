/**
 * ============================================================================
 * Brzina pisanja po kontaktu
 * ============================================================================
 *
 * ŠTA ŠTITI
 *   Naš trošak. Svaka poruka koja prođe dalje plaća se dvaput: Meti po
 *   razgovoru i OpenAI-ju po pozivu. Granica rezervacija (Core, 0020) štiti
 *   salonov raspored i to je druga stvar — ovdje se ne odlučuje ništa o
 *   terminima.
 *
 * GDJE STOJI U TOKU
 *   POSLIJE deduplikacije po `wamid`, PRIJE poziva AI sloju.
 *
 *   Poslije dedupe zato što Meta sama ponavlja isporuku istog webhooka; kad bi
 *   se brojalo prije, njena ponavljanja bi trošila kupčev budžet i uredan kupac
 *   bi dobio prigušenje za poruke koje nije poslao.
 *
 *   Prije AI-ja zato što je AI ono što se plaća. Brojač poslije njega bi
 *   uredno mjerio trošak koji je već napravljen.
 *
 * ŠTA RADI KAD BAZA NE ODGOVORI
 *   Propušta. Pokvaren brojač ne smije ušutkati stvarne kupce — prigušenje je
 *   zaštita od pretjerivanja, a ne sigurnosna granica.
 * ============================================================================
 */

import { logger } from '../../lib/logger.js';
import { normalizePhone } from '../../lib/security.js';
import { query } from '../../infrastructure/database.js';

/**
 * Koliko poruka u minuti je normalno.
 *
 * Dvanaest je namjerno visoko: ljudi pišu u kratkim porukama ("sutra", "u 13",
 * "moze", "hvala") i uredan kupac lako pošalje šest u minuti. Granica koja
 * hvata njega ne vrijedi ništa, jer će je vlasnik ugasiti prvog dana.
 */
export const GRANICA_MINUTE = 12;

/** Koliko u satu. Hvata strpljivog, kojeg minutna granica nikad ne vidi. */
export const GRANICA_SATA = 60;

/** Koliko rijetko se prigušenom kontaktu kaže da je prigušen. */
export const RAZMAK_UPOZORENJA_MINUTA = 10;

export type IshodBrzine =
  /** Sve u redu, poruka ide dalje. */
  | { vrsta: 'prolaz' }
  /** Preko minutne granice: kupcu se JEDNOM kaže, pa tišina. */
  | { vrsta: 'prigusen'; upozori: boolean }
  /** Preko satne granice: tišina i strike. */
  | { vrsta: 'previse' };

/**
 * Broji poruku i kaže smije li ići dalje.
 *
 * Jedan upit, atomično: `on conflict do update` i pomjera prozor i povećava
 * brojač, pa dva istovremena webhooka ne mogu pročitati isti broj i oba proći.
 */
export async function zabiljeziPoruku(
  channelId: string,
  kontakt: string,
  granicaMinute = GRANICA_MINUTE,
  granicaSata = GRANICA_SATA,
): Promise<IshodBrzine> {
  const broj = normalizePhone(kontakt);
  if (!broj) return { vrsta: 'prolaz' };

  try {
    // Novi minutni broj se u upitu pojavljuje dvaput jer o njemu ovise DVIJE
    // stvari: povećanje brojača i to smije li se poslati upozorenje. Bez drugog
    // uslova bi `upozoren_u` osvježavala svaka obična poruka — pa bi u trenutku
    // kad prigušenje konačno okine ispalo da je upozorenje upravo poslano, i
    // kupac ne bi dobio nijedno.
    const redovi = await query<{
      minuta_broj: number;
      sat_broj: number;
      treba_upozoriti: boolean;
    }>(
      `WITH novo AS (
         INSERT INTO kontakt_brzina (channel_id, kontakt, minuta_od, minuta_broj, sat_od, sat_broj, upozoren_u)
         VALUES ($1, $2, now(), 1, now(), 1, NULL)
         ON CONFLICT (channel_id, kontakt) DO UPDATE
            SET minuta_od   = CASE WHEN kontakt_brzina.minuta_od < now() - interval '1 minute'
                                   THEN now() ELSE kontakt_brzina.minuta_od END,
                minuta_broj = CASE WHEN kontakt_brzina.minuta_od < now() - interval '1 minute'
                                   THEN 1 ELSE kontakt_brzina.minuta_broj + 1 END,
                sat_od      = CASE WHEN kontakt_brzina.sat_od < now() - interval '1 hour'
                                   THEN now() ELSE kontakt_brzina.sat_od END,
                sat_broj    = CASE WHEN kontakt_brzina.sat_od < now() - interval '1 hour'
                                   THEN 1 ELSE kontakt_brzina.sat_broj + 1 END,
                upozoren_u  = CASE
                    WHEN (CASE WHEN kontakt_brzina.minuta_od < now() - interval '1 minute'
                               THEN 1 ELSE kontakt_brzina.minuta_broj + 1 END) > $3
                     AND (kontakt_brzina.upozoren_u IS NULL
                          OR kontakt_brzina.upozoren_u < now() - ($4 || ' minutes')::interval)
                    THEN now()
                    ELSE kontakt_brzina.upozoren_u
                  END
         RETURNING minuta_broj, sat_broj, upozoren_u
       )
       SELECT minuta_broj,
              sat_broj,
              (upozoren_u IS NOT NULL AND upozoren_u >= now() - interval '2 seconds')
                AS treba_upozoriti
         FROM novo`,
      [channelId, broj, granicaMinute, String(RAZMAK_UPOZORENJA_MINUTA)],
    );

    const red = redovi[0];
    if (!red) return { vrsta: 'prolaz' };

    if (red.sat_broj > granicaSata) return { vrsta: 'previse' };
    if (red.minuta_broj > granicaMinute) {
      return { vrsta: 'prigusen', upozori: red.treba_upozoriti === true };
    }
    return { vrsta: 'prolaz' };
  } catch (greska) {
    // U log ne ide broj telefona — samo kanal i opis greške.
    logger.warn('Brojač brzine nije pročitan; poruka se propušta.', {
      channel_id: channelId,
      greska: greska instanceof Error ? greska.message : String(greska),
    });
    return { vrsta: 'prolaz' };
  }
}

/** Briše redove kontakata koji satima nisu pisali. Zove ga periodični posao. */
export async function ocistiStareBrojace(starijeOdSati = 24): Promise<number> {
  const redovi = await query<{ id: string }>(
    `DELETE FROM kontakt_brzina
      WHERE sat_od < now() - ($1 || ' hours')::interval
     RETURNING kontakt AS id`,
    [String(Math.max(1, Math.trunc(starijeOdSati)))],
  );
  return redovi.length;
}
