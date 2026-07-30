import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { config } from '../config.js';

/**
 * Šifriranje tajni koje se čuvaju u bazi (Meta tokeni, app secreti).
 *
 * Baza nikada ne vidi čist tekst. Ključ dolazi iz SECRETS_KEY u okruženju, pa
 * krađa dumpa baze sama po sebi ne otkriva tokene klijenata.
 *
 * Format zapisa: v1.<so>.<iv>.<oznaka>.<šifrat>, sve u base64url.
 * Verzija je tu da se format kasnije može promijeniti bez gubitka starih zapisa.
 */

const VERZIJA = 'v1';
const DUZINA_KLJUCA = 32;
const DUZINA_IV = 12;
const DUZINA_SOLI = 16;

function masterKljuc(): string {
  const kljuc = config.SECRETS_KEY;
  if (!kljuc || kljuc.length < 32) {
    throw new Error(
      'SECRETS_KEY nije postavljen ili je kraći od 32 znaka. ' +
        'Bez njega se tajne klijenata ne mogu sigurno čuvati.',
    );
  }
  return kljuc;
}

function izvediKljuc(so: Buffer): Buffer {
  return scryptSync(masterKljuc(), so, DUZINA_KLJUCA);
}

export function sifriraj(cistTekst: string): string {
  if (!cistTekst) throw new Error('Prazna vrijednost se ne šifrira.');
  const so = randomBytes(DUZINA_SOLI);
  const iv = randomBytes(DUZINA_IV);
  const cipher = createCipheriv('aes-256-gcm', izvediKljuc(so), iv);
  const sifrat = Buffer.concat([cipher.update(cistTekst, 'utf8'), cipher.final()]);
  const oznaka = cipher.getAuthTag();

  return [
    VERZIJA,
    so.toString('base64url'),
    iv.toString('base64url'),
    oznaka.toString('base64url'),
    sifrat.toString('base64url'),
  ].join('.');
}

export function desifriraj(zapis: string): string {
  const dijelovi = zapis.split('.');
  if (dijelovi.length !== 5 || dijelovi[0] !== VERZIJA) {
    throw new Error('Šifrirani zapis nema očekivani format.');
  }
  const [, so, iv, oznaka, sifrat] = dijelovi;

  const decipher = createDecipheriv(
    'aes-256-gcm',
    izvediKljuc(Buffer.from(so, 'base64url')),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(oznaka, 'base64url'));

  // Ako je zapis mijenjan ili je ključ pogrešan, final() baca grešku.
  return Buffer.concat([
    decipher.update(Buffer.from(sifrat, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Vraća tajnu ili undefined ako kolona nije popunjena. */
export function desifrirajOpcionalno(zapis: string | null | undefined): string | undefined {
  if (!zapis) return undefined;
  return desifriraj(zapis);
}

/** Nasumičan ključ za putanju webhooka pojedinog kanala. */
export function noviWebhookKljuc(): string {
  return randomBytes(24).toString('base64url');
}
