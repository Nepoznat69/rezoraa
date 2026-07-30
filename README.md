# Rezora univerzalni WhatsApp agent

Rezora je multi-tenant platforma za WhatsApp komunikaciju, rezervacije, termine, upite i human handoff. Podržava dva odvojena proizvoda koji koriste istu sigurnu poslovnu jezgru:

- **Rezora QR Agent** — lokalni program zasnovan na `whatsapp-web.js` i QR sesiji.
- **Rezora Meta Cloud** — službena integracija sa Meta WhatsApp Cloud API-jem.

Korisnici komuniciraju kroz WhatsApp. Zaposlenici koriste budući web/PWA dashboard, dok platforma, PostgreSQL i n8n upravljaju poslovnim procesima.

## Najvažnija arhitektonska granica

AI samo razumije poruku i vraća strukturirane podatke. AI nema pristup bazi, n8n alatima, Google Sheetsu, Meta API-ju niti booking operacijama.

Backend ponovo izračunava obavezna polja i deterministički odlučuje da li će:

- provjeriti dostupnost;
- napraviti hold;
- potvrditi rezervaciju;
- pomjeriti termin;
- otkazati rezervaciju;
- otvoriti human handoff.

## Podržani modeli djelatnosti

| Model | Primjeri |
|---|---|
| `appointment` | frizer, doktor, terapeut, konsultant |
| `resource_appointment` | autoservis, masaža, ordinacija |
| `capacity_slot` | grupni trening, događaj, restoran |
| `table_allocation` | restoran i kafić |
| `accommodation` | hotel, hostel, apartman |
| `multi_resource` | zaposlenik + prostorija + oprema |
| `service_request` | turistička agencija, ponuda, složeni zahtjev |

## Implementirane sigurnosne i poslovne kontrole

- `tenant_id` na svim poslovnim zapisima;
- PostgreSQL Row-Level Security politike;
- GiST overlap constraint za ekskluzivne zaposlenike i resurse;
- transakcijsko zaključavanje pooled kapaciteta;
- idempotency po WhatsApp message/event ID-u;
- trajni inbound inbox za Meta webhookove;
- redoslijed obrade po razgovoru;
- privremeni holdovi sa automatskim istekom;
- historija booking događaja i audit log;
- Meta webhook HMAC provjera;
- odvojeni QR agent token;
- izostavljanje telefona i sadržaja poruke iz standardnih logova;
- retry i backoff za QR i Meta poruke.

## Brzo lokalno pokretanje

Potrebni su Node.js 20+, Docker i Docker Compose.

1. Kopirajte vrijednosti iz `.env.example` u `.env`. Ako već imate `.env` sa `OPENAI_API_KEY`, nemojte ga prepisati; samo dodajte nove varijable.

2. Pokrenite PostgreSQL:

```powershell
docker compose up -d postgres
```

3. Instalirajte zavisnosti:

```powershell
npm install
```

4. Kreirajte bazu i demo tenant:

```powershell
npm run db:migrate
npm run db:seed
```

5. Pokrenite platformu:

```powershell
npm run dev:server
```

6. U drugom terminalu pokrenite QR proizvod:

```powershell
npm run dev:qr
```

Postojeća `.wwebjs_auth/session-test-bot` sesija ostaje kompatibilna kada su `QR_CLIENT_ID=test-bot` i `QR_AUTH_PATH=.wwebjs_auth`.

## n8n način rada

Preporučeni produkcijski tok je:

```text
QR Agent ili Meta gateway
  -> kanal-specifični n8n workflow
  -> CORE API /api/v1/internal/orchestrate
  -> deterministički booking engine
  -> PostgreSQL
```

Za Meta kanal javni webhook ostaje u Node gatewayu zbog provjere sirovog HMAC potpisa i brzog HTTP 200 odgovora. Nakon toga se poruka trajno sprema i može se poslati u n8n.

Postavite:

```env
ORCHESTRATION_MODE=n8n
N8N_META_INBOUND_URL=https://vas-n8n/webhook/rezora-meta-ulaz
QR_INBOUND_URL=https://vas-n8n/webhook/rezora-qr-ulaz
```

Workflowi za import nalaze se u `n8n/QR`, `n8n/META` i `n8n/CORE`.

## Meta Cloud konfiguracija

Za Meta proizvod su potrebni:

- `META_VERIFY_TOKEN`
- `META_APP_SECRET`
- `META_ACCESS_TOKEN` ili tenant-specifična env varijabla navedena u `channels.secret_env_key`
- `META_GRAPH_VERSION`, eksplicitno postavljena na trenutno podržanu verziju
- WABA ID i `phone_number_id` uneseni u tabelu `channels`

Meta callback URL:

```text
https://vasa-domena/api/v1/meta/webhook
```

API verzija namjerno nema hardkodirani trajni default. Prije produkcijskog pokretanja mora se unijeti aktuelna podržana verzija Mete.

### Embedded Signup se ne koristi

Ruta `/meta/onboarding` postoji, ali nije put u rad. Embedded Signup služi
posrednicima za onboarding **tuđih** firmi i zahtijeva Advanced Access, App Review
i Tech Provider status. Za rad nad vlastitim WhatsApp Business nalogom dovoljan je
Standard Access, a broj se registruje direktno u WhatsApp Manageru.

### Token

Preporučeni token je **System User token**, koji ne ističe. Kreira se u Meta
Business Settings, a može i preko Graph API-ja
(`POST /{system-user-id}/access_tokens` uz `appsecret_proof`). Token dobiven iz
App Dashboarda traje samo 24 sata i nije za trajan rad.

## Produkcija

```powershell
docker compose -f docker-compose.prod.yml up -d --build
```

Podiže aplikaciju, PostgreSQL i Caddy koji sam pribavlja HTTPS certifikat. Baza
u toj postavci **nije** otvorena prema internetu — dostupna je samo aplikaciji.

Cijeli postupak postavljanja servera opisan je u
[docs/ISPORUKA-NA-SERVER.md](docs/ISPORUKA-NA-SERVER.md).

### Interni dashboard

```text
/dashboard
```

Web stranica za Rezora tim: dodavanje klijenta i provjera veze kod Mete korak po
korak. Zaštićena je prijavom — korisničko ime `rezora`, lozinka iz
`DASHBOARD_PASSWORD`. Bez te varijable dashboard vraća 503.

Klijent donosi vlastitu Meta aplikaciju, a Rezora prima četiri podatka: WABA ID,
Phone Number ID, pristupni token i app secret. Postupak je opisan u
[docs/ONBOARDING-KLIJENTA.md](docs/ONBOARDING-KLIJENTA.md).

Zašto ovako: klijentova aplikacija ima Standard Access nad vlastitim WhatsApp
nalogom, pa verifikacija Rezorinog poslovnog subjekta nije potrebna. Uz to,
limiti poruka se računaju po Business Portfoliju, pa svaki klijent ima vlastitih
250 razgovora dnevno umjesto da svi dijele jedan limit.

### Tajne klijenata

Tokeni i app secreti se u bazi čuvaju šifrirani (AES-256-GCM). Ključ je
`SECRETS_KEY` u okruženju, najmanje 32 znaka. **Ne mijenjati ga nakon unosa
klijenata** — postojeće tajne se time gube.

Svaki klijent dobija vlastitu webhook adresu oblika
`/api/v1/meta/webhook/<ključ>`. Potpis se provjerava app secretom tog kanala, pa
tajna jednog klijenta ne otvara webhook drugog.

### Dodavanje novog klijenta iz komandne linije

```powershell
npm run klijent:dodaj -- klijenti/naziv-klijenta.json
```

Skript u jednoj transakciji kreira tenant, politiku rezervacija, lokaciju, radno
vrijeme, usluge, zaposlenike, pitanja i Meta Cloud kanal. Prije upisa provjerava
kod Mete da `phone_number_id` stvarno postoji i da je broj u statusu `CONNECTED`.

Polazna tačka je `klijenti/primjer.json`. Kopirajte ga, izmijenite i pokrenite.
Stvarni fajlovi klijenata se ne dodaju u Git; primjer se zadržava.

Zaštite:

- isti `slug` ne može se dodati dvaput;
- isti `phone_number_id` ne može pripadati dvama klijentima;
- greška u bilo kojem koraku poništava cijeli upis.

Za klijenta sa vlastitim tokenom postavite `meta.secret_env_key` na naziv env
varijable u kojoj token stoji; tada se koristi taj token umjesto globalnog.

Provjera bez kontaktiranja Mete radi se zastavicom `--bez-provjere`.

### Razvojni HTTPS tunel

```powershell
npm run tunel
```

Skript digne Cloudflare tunel, provjeri da server odgovara kroz njega i sam
prijavi novu adresu Meti. Besplatna `trycloudflare` adresa se mijenja pri svakom
pokretanju, ali ručno usklađivanje više nije potrebno.

## Provjera kvaliteta

```powershell
npm run build
npm test
```

Testovi pokrivaju bosanske relativne datume, backend obavezna polja, AI schemu i Meta webhook potpis. Za produkciju treba dodati integration testove nad stvarnim PostgreSQL kontejnerom i Meta testnim WABA nalogom.

## Status starog workflowa

`n8n/restoran.json` je stari proof-of-concept i nije dio nove arhitekture. Ne treba ga aktivirati zajedno sa novim workflowima.

## Važna produkcijska napomena

QR proizvod koristi nezvanični WhatsApp Web kanal i treba se prodavati kao početni/legacy paket bez istog SLA-a kao Meta Cloud. Meta Cloud je preporučeni produkcijski proizvod.

