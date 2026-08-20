/**
 * `kontakt_brzina` u memoriji.
 *
 * Brojač brzine je jedina stvar koju orkestrator traži iz GATEWAY baze; sve
 * ostalo ide u Core bazu preko `postaviCoreIzvrsilac`. Za taj jedan upit nema
 * šava, pa ga test zamjenjuje mockom modula `infrastructure/database.js` — a
 * ovo je ono što tamo stoji.
 *
 * Pazi: bez ovoga testovi i dalje PROLAZE, jer `zabiljeziPoruku` hvata grešku
 * i propušta poruku. Prolaz bi tada značio „prigušenje se nikad nije ni
 * izvršilo", što je najgora vrsta zelenog testa.
 */

interface Red {
  minutaOd: number;
  minutaBroj: number;
  satOd: number;
  satBroj: number;
  upozorenU: number | null;
}

const redovi = new Map<string, Red>();

/** Briše sve brojače. Zove se u `beforeEach`. */
export function resetujBrzinu(): void {
  redovi.clear();
}

/** Koliko je poruka izbrojano za kontakt — za provjere u testu. */
export function brojac(channelId: string, kontakt: string): Red | null {
  return redovi.get(`${channelId}:${kontakt}`) ?? null;
}

/**
 * Prepoznaje upite iz `src/modules/zastita/brzina.ts` i ponaša se kao tabela.
 *
 * Prozori su fiksni, kao u SQL-u: kad prozor istekne, brojač kreće od jedan.
 */
export async function memorijskiQuery<T>(tekst: string, vrijednosti: unknown[] = []): Promise<T[]> {
  const sada = Date.now();

  if (tekst.includes('INSERT INTO kontakt_brzina')) {
    const [channelId, kontakt, granicaMinute, razmakMinuta] = vrijednosti as [
      string,
      string,
      number,
      string,
    ];
    const kljuc = `${channelId}:${kontakt}`;
    let red = redovi.get(kljuc);

    if (!red) {
      red = { minutaOd: sada, minutaBroj: 1, satOd: sada, satBroj: 1, upozorenU: null };
      redovi.set(kljuc, red);
      return [{ minuta_broj: 1, sat_broj: 1, treba_upozoriti: false } as T];
    }

    if (sada - red.minutaOd >= 60_000) {
      red.minutaOd = sada;
      red.minutaBroj = 1;
    } else {
      red.minutaBroj += 1;
    }

    if (sada - red.satOd >= 3_600_000) {
      red.satOd = sada;
      red.satBroj = 1;
    } else {
      red.satBroj += 1;
    }

    // Upozorenje se osvježava SAMO kad je poruka stvarno prigušena — inače bi
    // obična poruka pomjerila zadnji trenutak upozorenja i kupac ne bi dobio
    // nijedno.
    const razmak = Number(razmakMinuta) * 60_000;
    const prekoGranice = red.minutaBroj > Number(granicaMinute);
    const smijeUpozoriti =
      prekoGranice && (red.upozorenU === null || sada - red.upozorenU >= razmak);
    if (smijeUpozoriti) red.upozorenU = sada;

    return [
      { minuta_broj: red.minutaBroj, sat_broj: red.satBroj, treba_upozoriti: smijeUpozoriti } as T,
    ];
  }

  if (tekst.includes('DELETE FROM kontakt_brzina')) {
    redovi.clear();
    return [];
  }

  throw new Error(`Memorijska gateway baza ne poznaje ovaj upit:\n${tekst}`);
}
