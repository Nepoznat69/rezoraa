/**
 * ============================================================================
 * Kopija Metinog webhooka drugom sistemu
 * ============================================================================
 *
 * ZAŠTO POSTOJI
 *   Jedna Metina aplikacija ima tačno JEDNU callback adresu za
 *   `whatsapp_business_account`. Kad istu WhatsApp liniju treba i gateway i
 *   neki drugi tok — recimo n8n na drugom serveru — jedan od njih mora primati
 *   i prosljeđivati. Inače se biraju, i onaj drugi tiho prestane raditi.
 *
 *   Prima gateway, jer on radi ono što se ne smije propustiti: provjeru
 *   potpisa, deduplikaciju po `event_id` i trajni zapis u inbox. Kopija odlazi
 *   tek NAKON što je potpis potvrđen — nepotvrđen zahtjev se ne prosljeđuje
 *   nikome, jer bismo inače postali pojačalo za tuđe lažne poruke.
 *
 * ZAŠTO SE NE ČEKA ODGOVOR
 *   Meta očekuje brz `200`. Kad bi se čekao sistem na drugom kraju, njegova
 *   sporost ili pad postali bi NAŠ ispad: Meta bi ponavljala isporuku, a kod
 *   nas bi se ista poruka obrađivala iznova.
 *
 *   Zato je ovo „pošalji i zaboravi". Neuspjeh se zapiše i tu se završava.
 *   Kopija je usluga drugom sistemu, ne dio našeg ugovora sa Metom.
 *
 * ŠTA SE ŠALJE
 *   Sirovo tijelo, bajt u bajt, zajedno sa zaglavljem `X-Hub-Signature-256`.
 *   Primalac time može sam provjeriti potpis istim app secretom — kopija nije
 *   „vjeruj nam na riječ" nego provjerljiv original.
 *
 *   Tijelo se NE parsira i NE mijenja. Čim bismo ga dirali, potpis bi prestao
 *   vrijediti i primalac bi ostao bez ijednog načina da provjeri odakle je.
 *
 * ŠTA SE NE ZAPISUJE
 *   Ni sadržaj poruke ni broj telefona. U dnevnik idu samo status i razlog
 *   neuspjeha, isto pravilo kao svuda u gatewayu.
 * ============================================================================
 */

import { config } from '../../../config.js';
import { logger } from '../../../lib/logger.js';

/**
 * Koliko se čeka drugi sistem prije nego se odustane.
 *
 * Deset sekundi je dugo za HTTP, ali ovo ne blokira odgovor Meti — teče u
 * pozadini. Rok postoji da se veze ne gomilaju ako je primalac zamrznut a ne
 * srušen; bez njega bi svaka poruka ostavila viseću konekciju.
 */
export const ROK_MS = 10_000;

/**
 * Šalje kopiju i odmah se vraća.
 *
 * Namjerno ne vraća `Promise`: pozivalac ne smije doći u iskušenje da je
 * čeka. Sve greške su progutane unutra, pa nema ni odbijenog obećanja koje bi
 * srušilo proces.
 */
export function proslijediKopiju(tijelo: Buffer, potpis: string): void {
  const cilj = config.META_WEBHOOK_FORWARD_URL;
  if (!cilj) return;
  void posalji(cilj, tijelo, potpis);
}

async function posalji(cilj: string, tijelo: Buffer, potpis: string): Promise<void> {
  const prekid = new AbortController();
  const tajmer = setTimeout(() => prekid.abort(), ROK_MS);
  try {
    const odgovor = await fetch(cilj, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': potpis,
      },
      // Uint8Array a ne Buffer: isto je u izvršavanju, ali `fetch` u tipovima
      // ne poznaje Nodeov Buffer. Sadržaj se ne dira.
      body: new Uint8Array(tijelo),
      signal: prekid.signal,
    });
    if (!odgovor.ok) {
      logger.warn('Kopija Metinog webhooka nije prihvaćena.', { status: odgovor.status });
    }
  } catch (greska) {
    logger.warn('Kopija Metinog webhooka nije isporučena.', {
      greska: greska instanceof Error ? greska.message : String(greska),
    });
  } finally {
    clearTimeout(tajmer);
  }
}
