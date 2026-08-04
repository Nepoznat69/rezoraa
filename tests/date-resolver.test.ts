import { describe, expect, it } from 'vitest';
import { resolveBosnianDate, resolveBosnianTime } from '../src/domain/date-resolver.js';

describe('bosanski izrazi datuma i vremena', () => {
  const reference = '2026-07-13T10:00:00.000Z';

  it('razumije sutra u poslovnoj vremenskoj zoni', () => {
    expect(resolveBosnianDate('sutra', '', reference, 'Europe/Sarajevo')).toBe('2026-07-14');
  });

  it('razumije prekosutra', () => {
    expect(resolveBosnianDate('prekosutra', '', reference, 'Europe/Sarajevo')).toBe('2026-07-15');
  });

  it('deterministički bira sljedeći petak', () => {
    expect(resolveBosnianDate('u petak', '', reference, 'Europe/Sarajevo')).toBe('2026-07-17');
  });

  it('normalizuje vrijeme', () => {
    expect(resolveBosnianTime('u 9:30', '')).toBe('09:30');
  });

  // Zivi kvar: kupac je napisao "sutra u 2", AI je ispravno protumacio 14:00,
  // a spajanje izraza i vremena u "2 14:00" vratilo je 02:00 — sat izvan
  // radnog vremena, pa je bot javio da termin nije slobodan iako je bio.
  it('vjeruje AI-jevom tumacenju sata, a ne goloj cifri iz izraza', () => {
    expect(resolveBosnianTime('2', '14:00')).toBe('14:00');
    expect(resolveBosnianTime('u 2', '14:00')).toBe('14:00');
    expect(resolveBosnianTime('oko 5', '17:00')).toBe('17:00');
  });

  it('pada natrag na izraz kad AI nije vratio sat', () => {
    expect(resolveBosnianTime('u 14:30', '')).toBe('14:30');
    expect(resolveBosnianTime('', 'nije vrijeme')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Padezi dana u sedmici.
//
// Zivi kvar: "u srijedu u 11" je vracalo "recite mi na koji dan", dok je
// "sutra u 11" radilo. Lista je imala samo nominativ, pa su srijeda, subota i
// nedjelja padale — a to je upravo onako kako ljudi govore. Petak i utorak su
// radili slucajno, jer im je akuzativ jednak nominativu.
// ---------------------------------------------------------------------------

describe('dani u sedmici u padezima', () => {
  // Utorak, 2026-08-04, u zoni salona.
  const utorak = '2026-08-04T09:00:00.000Z';
  const ZONA = 'Europe/Sarajevo';

  const slucajevi: Array<[string, string]> = [
    ['u srijedu', '2026-08-05'],
    ['u cetvrtak', '2026-08-06'],
    ['u petak', '2026-08-07'],
    ['u subotu', '2026-08-08'],
    ['u nedjelju', '2026-08-09'],
    ['u ponedjeljak', '2026-08-10'],
    // Isti dan kao danas znaci SLJEDECI takav dan, ne danas.
    ['u utorak', '2026-08-11'],
  ];

  for (const [izraz, ocekivano] of slucajevi) {
    it(`razumije "${izraz}"`, () => {
      expect(resolveBosnianDate(izraz, '', utorak, ZONA)).toBe(ocekivano);
    });
  }

  it('razumije i nominativ, kako ga AI ponekad vrati', () => {
    expect(resolveBosnianDate('srijeda', '', utorak, ZONA)).toBe('2026-08-05');
    expect(resolveBosnianDate('subota', '', utorak, ZONA)).toBe('2026-08-08');
  });

  it('sljedeci pomjera za sedmicu dalje', () => {
    expect(resolveBosnianDate('sljedecu srijedu', '', utorak, ZONA)).toBe('2026-08-12');
  });

  // "pet" je korijen koji bi se nasao u brojevima; oblici moraju biti puni.
  it('broj u poruci ne postaje dan u sedmici', () => {
    expect(resolveBosnianDate('za petnaest osoba', '', utorak, ZONA)).toBeNull();
  });
});
