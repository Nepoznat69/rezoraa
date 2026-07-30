import { beforeAll, describe, expect, it } from 'vitest';

process.env.SECRETS_KEY = 'test-kljuc-koji-ima-najmanje-32-znaka-duzine';

let sifriraj: typeof import('../src/lib/tajne.js').sifriraj;
let desifriraj: typeof import('../src/lib/tajne.js').desifriraj;
let desifrirajOpcionalno: typeof import('../src/lib/tajne.js').desifrirajOpcionalno;
let noviWebhookKljuc: typeof import('../src/lib/tajne.js').noviWebhookKljuc;

beforeAll(async () => {
  const modul = await import('../src/lib/tajne.js');
  sifriraj = modul.sifriraj;
  desifriraj = modul.desifriraj;
  desifrirajOpcionalno = modul.desifrirajOpcionalno;
  noviWebhookKljuc = modul.noviWebhookKljuc;
});

describe('šifriranje tajni', () => {
  it('vraća original nakon šifriranja i dešifriranja', () => {
    const tajna = 'EAAxxxxxx-primjer-meta-tokena-1234567890';
    expect(desifriraj(sifriraj(tajna))).toBe(tajna);
  });

  it('daje različit zapis za istu tajnu', () => {
    const tajna = 'ista-tajna';
    expect(sifriraj(tajna)).not.toBe(sifriraj(tajna));
  });

  it('ne ostavlja čist tekst u zapisu', () => {
    const tajna = 'osjetljiva-vrijednost';
    expect(sifriraj(tajna)).not.toContain(tajna);
  });

  it('odbija izmijenjen zapis', () => {
    const zapis = sifriraj('tajna');
    const dijelovi = zapis.split('.');
    const izmijenjeniSifrat = Buffer.from('podmetnuta vrijednost', 'utf8').toString('base64url');
    const podmetnuto = [...dijelovi.slice(0, 4), izmijenjeniSifrat].join('.');
    expect(() => desifriraj(podmetnuto)).toThrow();
  });

  it('odbija zapis nepoznatog formata', () => {
    expect(() => desifriraj('obican-tekst')).toThrow(/format/i);
  });

  it('prazna vrijednost prolazi kao undefined', () => {
    expect(desifrirajOpcionalno(null)).toBeUndefined();
    expect(desifrirajOpcionalno('')).toBeUndefined();
  });

  it('webhook ključevi su jedinstveni i bez znakova koji smetaju u URL-u', () => {
    const kljuc = noviWebhookKljuc();
    expect(kljuc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(kljuc).not.toBe(noviWebhookKljuc());
  });

  it('podnosi tajne sa razmacima i posebnim znakovima', () => {
    const tajna = 'tajna sa razmacima, čćžšđ i simbolima !@#$%^&*()';
    expect(desifriraj(sifriraj(tajna))).toBe(tajna);
  });
});
