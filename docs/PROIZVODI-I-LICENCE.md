# Proizvodi i licence

## Rezora QR Agent

Klijent dobija lokalni Windows program ili servis. Program čuva njegov QR session, šalje normalizovane poruke platformi i prima odgovor. Klijentov računar mora biti uključen.

Predloženi planovi:

- QR Starter — jedan broj, jedna lokacija, jedan uređaj;
- QR Professional — više lokacija i human handoff;
- QR Dedicated — izdvojena infrastruktura.

## Rezora Meta Cloud

Klijent se povezuje kroz Meta Embedded Signup i koristi službeni Cloud API. Nije potreban uključen lokalni računar.

Predloženi planovi:

- Cloud Starter — jedan WABA broj;
- Cloud Professional — više lokacija, templates i podsjetnici;
- Cloud Enterprise — više brojeva, napredni audit, SLA i izdvojena baza.

## Hybrid

Tenant može imati QR i Meta kanal, ali samo jedan kanal smije biti `primary_outbound` za određeni broj. Hybrid omogućava kontrolisanu migraciju bez gubitka klijenata, razgovora ili rezervacija.

## Licencni model u bazi

U produkcijskoj fazi dodati tabele:

```text
tenant_subscriptions
  tenant_id
  product_edition: qr_agent | meta_cloud | hybrid
  plan
  status
  licensed_devices
  message_limit
  ai_usage_limit
  valid_until

licensed_devices
  tenant_id
  channel_id
  device_fingerprint
  token_hash
  last_seen_at
  status
```

Backend, a ne desktop aplikacija ili n8n, mora provjeravati licencu.

