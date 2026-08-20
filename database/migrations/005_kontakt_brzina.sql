-- Koliko brzo jedan broj piše.
--
-- ZAŠTO OVDJE, A NE U CORE BAZI
--   Ovo štiti NAŠ trošak: svaka poruka koja prođje dalje plaća se dvaput —
--   jednom Meti po razgovoru, jednom OpenAI-ju po pozivu. Zaštita od troška
--   mora raditi i onda kad Rezora Core ne odgovara, a upravo tada je gateway i
--   najranjiviji: kontekst ne stiže, ali poruke stižu.
--
--   Granica REZERVACIJA je druga stvar i stoji u Coreu (migracija 0020), jer
--   ona štiti salonov raspored, a raspored živi tamo.
--
-- ZAŠTO U BAZI, A NE U MEMORIJI
--   Brojač u memoriji se nuli na svaki restart i deploy, pa ga onaj ko šalje
--   poruke u petlji ionako preživi. Uz to gateway može raditi u više procesa;
--   memorijski brojač bi tada brojao svaki svoje.
--
-- ZAŠTO (channel_id, kontakt), A NE SAMO BROJ
--   Isti čovjek može biti kupac dva salona. Njegova žurba kod jednog ne smije
--   ušutkati njegov razgovor kod drugog.
--
-- DVA PROZORA
--   Minuta hvata naglu bujicu, sat hvata strpljivog. Sam prozor od minute je
--   premalo: ko šalje po deset poruka svake minute cijeli dan nikad ne pređe
--   minutnu granicu, a potroši više od onoga ko pošalje pedeset odjednom.
--
--   Prozori su fiksni, ne klizni. Na granici prozora to dopušta kratak dvostruki
--   nalet — svjesna zamjena: klizni prozor traži red po poruci i čišćenje, a
--   ovdje je jedan red po kontaktu i jedan upit po poruci.
--
-- Idempotentna: sve provjere su uslovne.

BEGIN;

CREATE TABLE IF NOT EXISTS kontakt_brzina (
  channel_id   uuid        NOT NULL,
  -- Normalizovan broj (samo cifre), isti oblik koji koristi `conversations`.
  kontakt      text        NOT NULL,

  minuta_od    timestamptz NOT NULL DEFAULT now(),
  minuta_broj  integer     NOT NULL DEFAULT 0,
  sat_od       timestamptz NOT NULL DEFAULT now(),
  sat_broj     integer     NOT NULL DEFAULT 0,

  -- Kad je kontaktu zadnji put rečeno da je prigušen.
  --
  -- Bez ovoga bi svaka prigušena poruka dobila odgovor — a svaki odgovor je
  -- plaćena Meta poruka. Prigušenje koje odgovara na svaku poruku košta nas
  -- isto koliko i da nema prigušenja.
  upozoren_u   timestamptz,

  PRIMARY KEY (channel_id, kontakt)
);

-- Redovi kontakata koji su davno prestali pisati; služi periodičnom čišćenju.
CREATE INDEX IF NOT EXISTS idx_kontakt_brzina_sat_od
  ON kontakt_brzina (sat_od);

COMMIT;
