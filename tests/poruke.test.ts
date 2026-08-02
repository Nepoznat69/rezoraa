/**
 * Testovi za src/modules/conversations/poruke.ts
 *
 * Core na HTTP 409 vraća `staffConflict`, `outsideHours`, `staffUnavailable` i
 * `invalidTime`. To su interni pojmovi iz ugovora i korisnik ih NIKADA ne smije
 * vidjeti. Ovdje se provjerava da svaki razlog postane rečenica na bosanskom i
 * da uz odbijanje ide ponuda već poznatih slobodnih termina — jer se isti
 * termin poslije 409 ne smije ponovo tražiti.
 */

import { describe, expect, it } from 'vitest';
import {
  RAZLOZI_TERMINA,
  type SlobodanTermin,
} from '../src/modules/core-api/core-klijent.js';
import {
  nabrojTermine,
  opisTermina,
  ponudaAlternativa,
  porukaZaOdbijenTermin,
  porukaZaOdbijenoOtkazivanje,
  porukaZaPomjerenTermin,
  porukaZaPotvrdjenTermin,
  porukaZaZauzetTermin,
  sat,
} from '../src/modules/conversations/poruke.js';

const ZONA = 'Europe/Sarajevo';
const ZAPOSLENIK = '33333333-3333-4333-8333-333333333333';

function termin(startAt: string, endAt: string): SlobodanTermin {
  return { startAt, endAt, staffMemberId: ZAPOSLENIK };
}

const SLOBODNI: SlobodanTermin[] = [
  termin('2026-08-05T07:00:00.000Z', '2026-08-05T07:45:00.000Z'),
  termin('2026-08-05T08:15:00.000Z', '2026-08-05T09:00:00.000Z'),
  termin('2026-08-05T11:00:00.000Z', '2026-08-05T11:45:00.000Z'),
  termin('2026-08-05T13:00:00.000Z', '2026-08-05T13:45:00.000Z'),
];

describe('vrijeme u vremenskoj zoni biznisa', () => {
  it('UTC trenutak prikazuje kao lokalni sat', () => {
    expect(sat('2026-08-05T07:00:00.000Z', ZONA)).toBe('09:00');
  });

  it('uz sat piše i dan, da se termin ne pomiješa', () => {
    expect(opisTermina('2026-08-05T07:00:00.000Z', ZONA)).toBe('u srijedu, 05.08. u 09:00');
  });

  it('nečitljiv trenutak ne ruši poruku', () => {
    expect(sat('nije-datum', ZONA)).toBe('');
    expect(opisTermina('nije-datum', ZONA)).toBe('');
  });

  it('nabraja najviše tri termina i ne ponavlja isti sat', () => {
    expect(nabrojTermine(SLOBODNI, ZONA)).toBe('09:00, 10:15 i 13:00');
    expect(nabrojTermine([SLOBODNI[0], SLOBODNI[0]], ZONA)).toBe('09:00');
    expect(nabrojTermine([], ZONA)).toBe('');
  });

  it('bez ijednog slobodnog termina predlaže drugi dan', () => {
    expect(ponudaAlternativa([], ZONA)).toContain('drugi dan');
  });
});

describe('409 iz Corea postaje ljudska poruka', () => {
  it('staffConflict kaže da je termin zauzet i nudi alternative', () => {
    const poruka = porukaZaOdbijenTermin('staffConflict', SLOBODNI, ZONA);

    expect(poruka).toContain('zauzet');
    expect(poruka).toContain('09:00');
    expect(poruka).toContain('10:15');
    expect(poruka).toContain('13:00');
  });

  it('staffConflict bez alternativa traži drugi dan', () => {
    const poruka = porukaZaOdbijenTermin('staffConflict', [], ZONA);

    expect(poruka).toContain('zauzet');
    expect(poruka).toContain('drugi dan');
  });

  it('outsideHours govori o radnom vremenu', () => {
    const poruka = porukaZaOdbijenTermin('outsideHours', SLOBODNI, ZONA);

    expect(poruka).toContain('izvan našeg radnog vremena');
    expect(poruka).toContain('09:00');
  });

  it('staffUnavailable govori da radnik nije dostupan', () => {
    const poruka = porukaZaOdbijenTermin('staffUnavailable', SLOBODNI, ZONA);

    expect(poruka).toContain('Radnik');
    expect(poruka).toContain('nije dostupan');
  });

  it('invalidTime traži jasan dan i sat, bez nuđenja termina', () => {
    const poruka = porukaZaOdbijenTermin('invalidTime', SLOBODNI, ZONA);

    expect(poruka).toContain('dan i sat');
    expect(poruka).not.toContain('09:00');
  });

  it('razlog koji ugovor ne poznaje ne ostaje bez odgovora', () => {
    const poruka = porukaZaOdbijenTermin('nepoznato', SLOBODNI, ZONA);

    expect(poruka.length).toBeGreaterThan(10);
    expect(poruka).toContain('09:00');
  });

  it('nijedna poruka ne propušta tehnički pojam iz ugovora', () => {
    const razlozi = [...RAZLOZI_TERMINA, 'nepoznato'] as const;

    for (const razlog of razlozi) {
      for (const alternative of [SLOBODNI, []]) {
        const poruka = porukaZaOdbijenTermin(razlog, alternative, ZONA);
        expect(poruka.trim()).not.toBe('');
        for (const tehnicki of RAZLOZI_TERMINA) {
          expect(poruka).not.toContain(tehnicki);
        }
        expect(poruka).not.toContain('409');
      }
    }
  });

  it('otkazivanje već završenog termina se objašnjava, ne prijavljuje', () => {
    const poruka = porukaZaOdbijenoOtkazivanje('alreadyTerminal');

    expect(poruka).toContain('već otkazan');
    expect(poruka).not.toContain('alreadyTerminal');
  });

  it('nepoznat razlog otkazivanja vodi na zaposlenika', () => {
    const poruka = porukaZaOdbijenoOtkazivanje('nepoznato');

    expect(poruka).toContain('zaposleniku');
    expect(poruka).not.toContain('nepoznato');
  });
});

describe('poruke o uspjehu', () => {
  it('traženi sat koji nije slobodan ne zvuči kao greška', () => {
    const poruka = porukaZaZauzetTermin(SLOBODNI, ZONA);

    expect(poruka).toContain('nije slobodan');
    expect(poruka).toContain('09:00');
  });

  it('potvrda zakazanog termina sadrži vrijeme i uslugu', () => {
    const poruka = porukaZaPotvrdjenTermin('2026-08-05T07:00:00.000Z', ZONA, 'Šišanje');

    expect(poruka).toContain('09:00');
    expect(poruka).toContain('Šišanje');
  });

  it('potvrda bez naziva usluge ne ostavlja praznu zagradu', () => {
    const poruka = porukaZaPotvrdjenTermin('2026-08-05T07:00:00.000Z', ZONA, '   ');

    expect(poruka).not.toContain('()');
  });

  it('pomjeranje potvrđuje novo vrijeme', () => {
    const poruka = porukaZaPomjerenTermin('2026-08-05T11:00:00.000Z', ZONA);

    expect(poruka).toContain('pomjeren');
    expect(poruka).toContain('13:00');
  });
});
