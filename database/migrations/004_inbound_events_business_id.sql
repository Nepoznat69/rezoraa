-- Kolona reda čekanja dobija istinito ime.
--
-- Migracija 003 je skinula strani ključ prema lokalnoj `tenants`, ali je ime
-- kolone ostavila. Time je nastala tiha zamka: kolona se zove `tenant_id`, a u
-- njoj stoji `business_id` iz Rezora Corea. Svako ko kasnije čita ovaj kod
-- pomislio bi da ima posla s lokalnim tenantom.
--
-- Preimenovanje je namjerno "glasno": svaki zaostali upit nad
-- `inbound_events.tenant_id` sada puca odmah, umjesto da tiho radi nad
-- vrijednošću koja više ne znači isto.
--
-- Uz to se gasi RLS politika `tenant_isolation`. Ona se oslanjala na
-- `app.tenant_id`, postavku koju je postavljao obrisani sloj za razgovore —
-- pa je danas nikad ne bi ispunio nijedan upit. Uključen RLS bez ijedne
-- politike znači "nijedan red" za svaku rolu bez BYPASSRLS: aplikacija se
-- povezuje kao vlasnik tabele pa to danas ne boli, ali bi prvi radnik pokrenut
-- pod običnom rolom vidio prazan red i obrada bi tiho stala.
--
-- Idempotentna: sve provjere su uslovne, pa ponovno pokretanje ne pada.

BEGIN;

-- Ponavlja se iz 003 radi baza koje su preskočile tu migraciju.
ALTER TABLE inbound_events
  DROP CONSTRAINT IF EXISTS inbound_events_tenant_id_fkey;

DROP POLICY IF EXISTS tenant_isolation ON inbound_events;
ALTER TABLE inbound_events DISABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'inbound_events' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE inbound_events RENAME COLUMN tenant_id TO business_id;
  END IF;

  -- Ime jedinstvenog ograničenja je izvedeno iz starog imena kolone.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'inbound_events'::regclass
       AND conname = 'inbound_events_tenant_id_channel_id_event_id_key'
  ) THEN
    ALTER TABLE inbound_events
      RENAME CONSTRAINT inbound_events_tenant_id_channel_id_event_id_key
                     TO inbound_events_business_id_channel_id_event_id_key;
  END IF;
END;
$$;

COMMENT ON COLUMN inbound_events.business_id IS
  'business_id iz Rezora Corea. Gateway nema vlastite tenante.';

COMMIT;
