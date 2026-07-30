# n8n workflow paket

Workflowi su odvojeni po proizvodu:

```text
n8n/
  QR/     ulaz i QR-specifične operacije
  META/   događaji nakon sigurnog Meta gatewaya i template slanje
  CORE/   zajednička poslovna orkestracija i održavanje
```

## Obavezne n8n varijable

```text
CORE_API_URL=https://api.vasa-domena
CORE_INTERNAL_API_KEY=isti ključ kao INTERNAL_API_KEY u platformi
N8N_CORE_ORCHESTRATOR_URL=https://vas-n8n/webhook/rezora-core-obrada
```

Preporuka je koristiti n8n credentials umjesto slobodnih env vrijednosti za tajne. Nakon importa zamijenite env izraze odgovarajućim credentialom ako je n8n tako konfigurisan.

## Redoslijed importa

1. `CORE/01-core-obrada-poruke.json`
2. `QR/01-qr-ulaz.json`
3. `META/01-meta-ulaz-nakon-gatewaya.json`
4. `META/02-meta-template-slanje.json`
5. `CORE/02-istek-holdova.json`

Workflowi su namjerno importovani kao neaktivni. Prvo unesite URL-ove i ključeve, testirajte ih, zatim ih aktivirajte.

`restoran.json` je legacy proof-of-concept i ne treba ga aktivirati.

