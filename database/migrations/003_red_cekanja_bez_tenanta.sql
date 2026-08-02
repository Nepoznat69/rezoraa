-- Oslobađa red čekanja od lokalnih tenanata.
--
-- Gateway više nije sistem evidencije: termini, usluge i klijenti su u Rezora
-- Coreu. Lokalna baza služi samo kao red čekanja za dolazne poruke i kao mjesto
-- gdje stoje WhatsApp pristupi samog gatewaya.
--
-- Kolona `inbound_events.tenant_id` je istorijsko ime; u njoj od prelaska stoji
-- `business_id` iz Corea. Njen strani ključ pokazuje na lokalnu `tenants`, koja
-- se više ne puni — pa bi svaki upis pucao. Ključ se uklanja; ime kolone ostaje
-- da se ne lomi postojeći kod i indeks jedinstvenosti.
--
-- Tabele lokalnog bookinga se NE brišu u ovoj migraciji. Podaci u njima su
-- jedini trag ranijih razgovora i termina; brisanje ide zasebno, tek kad se
-- potvrdi da ništa od toga ne treba.

BEGIN;

ALTER TABLE inbound_events
  DROP CONSTRAINT IF EXISTS inbound_events_tenant_id_fkey;

COMMENT ON COLUMN inbound_events.tenant_id IS
  'business_id iz Rezora Corea. Ime kolone je istorijsko; strani ključ je uklonjen migracijom 003.';

-- Isti razlog za tabelu poruka koju webhook i dalje dodiruje pri statusima.
ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_tenant_id_fkey;

COMMIT;
