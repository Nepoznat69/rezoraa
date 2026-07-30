-- Omogućava da svaki klijent ima vlastitu Meta aplikaciju.
--
-- Do sada je platforma imala jedan globalni META_APP_SECRET i jedan token, jer
-- je radila samo nad vlastitim WhatsApp Business nalogom. Kada klijent donese
-- svoju Meta aplikaciju, svaka ima svoj app secret, svoj verify token i svoj
-- pristupni token, pa se ti podaci moraju voditi po kanalu.
--
-- Tajne se čuvaju šifrirane (AES-256-GCM); baza nikada ne vidi čist tekst.

BEGIN;

ALTER TABLE channels
  -- Nasumičan ključ u putanji webhooka. Po njemu se kanal pronađe PRIJE
  -- provjere potpisa, jer tek tada znamo kojim secretom provjeravamo.
  ADD COLUMN IF NOT EXISTS webhook_key text,
  ADD COLUMN IF NOT EXISTS app_secret_encrypted text,
  ADD COLUMN IF NOT EXISTS verify_token_encrypted text,
  ADD COLUMN IF NOT EXISTS access_token_encrypted text,
  -- Rezultat zadnje provjere veze koju pokreće dashboard.
  ADD COLUMN IF NOT EXISTS last_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_check_result jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS channels_webhook_key_unique
  ON channels (webhook_key)
  WHERE webhook_key IS NOT NULL;

COMMIT;
