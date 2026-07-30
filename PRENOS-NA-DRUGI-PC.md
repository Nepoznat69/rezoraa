# Prenos Rezora projekta na drugi računar

Ovaj vodič služi da druga pouzdana osoba preuzme projekt i nastavi Meta WhatsApp
Coexistence povezivanje na kojem smo stali.

## Trenutni status

- Backend je Node.js/TypeScript aplikacija.
- PostgreSQL radi kroz Docker Compose.
- Meta webhook i `messages` pretplata su podešeni i potvrđeni.
- **Meta Cloud API je pušten u rad.** Broj `+387 62 971 250` šalje i prima
  poruke; testirana je dolazna poruka i automatski odgovor.
- Koristi se trajni System User token, ne Embedded Signup.
- n8n nije potreban; `ORCHESTRATION_MODE=backend` ostaje uključen.

## Šta se prenosi preko privatnog Gita

Git sadrži izvorni kod, migracije baze, testove i dokumentaciju. Namjerno ne sadrži:

- `.env` i Meta/OpenAI tokene;
- `node_modules`;
- lokalnu PostgreSQL bazu;
- `.wwebjs_auth` WhatsApp Web sesiju;
- privremeni Cloudflare tunnel URL.

Nikada ne dodavati `.env` u Git. Za nastavak iste Meta aplikacije vlasnik treba
prenijeti `.env` prijatelju odvojeno, npr. kroz password manager ili šifrirani
arhiv čiju lozinku šalje drugim kanalom.

## 1. Potrebni programi

Na drugom računaru instalirati:

- Git;
- Node.js 20 ili noviji;
- Docker Desktop i pokrenuti Docker Engine.

## 2. Preuzimanje projekta

Tek nakon što vlasnik pošalje stvarni privatni GitHub URL:

```powershell
git clone <PRIVATE_REPO_URL>
cd rezora-whatsapp-agent
```

`<PRIVATE_REPO_URL>` je oznaka, nije naredba ni stvarna adresa.

## 3. Tajne postavke

Za potpuno novu praznu konfiguraciju:

```powershell
Copy-Item .env.example .env
```

Za nastavak ovog konkretnog Meta povezivanja, sigurnije je da vlasnik odvojeno
prenese postojeći `.env`. Prijatelj ga stavlja u glavni folder projekta. Tokeni
se ne šalju u chat, e-mail ili GitHub.

## 4. Instalacija i pokretanje

Sve naredbe pokretati iz foldera `rezora-whatsapp-agent`:

```powershell
npm ci
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run check
npm run dev:server
```

Server treba odgovoriti na:

```text
http://localhost:3001/health/live
```

Port je 3001, a ne 3000, jer je 3000 na razvojnom računaru bio zauzet. Vrijednost
se čita iz `PORT` u `.env`.

## 5. Novi privremeni HTTPS tunnel

Na drugom računaru stari `trycloudflare.com` URL neće važiti. U drugom terminalu
pokrenuti:

```powershell
npm run tunel
```

Skript `scripts/tunel.mjs` sam obavi cijeli posao: ugasi stari tunel, digne novi,
pročita novu adresu, provjeri da server kroz nju odgovara i **sam prijavi novu
adresu Meti** preko Graph API-ja. Ručno prepisivanje u App Dashboardu više nije
potrebno.

Na kraju ispiše aktivnu adresu i potvrdu da je webhook `active` i da je polje
`messages` uključeno.

## 6. Meta pristup za prijatelja

Ne dijeliti Facebook lozinku. Vlasnik treba dodati prijateljev Facebook račun
u Meta App Roles i, ako je potrebno, u odgovarajući Meta Business Portfolio.

Embedded Signup se **ne koristi**. On služi za onboarding tuđih firmi i traži
Advanced Access, App Review i Tech Provider status. Pošto Rezora radi nad
vlastitim WhatsApp Business nalogom, dovoljan je Standard Access koji aplikacija
već ima.

## 7. Meta kanal u bazi

Migracije i seed kreiraju samo demo QR kanal. Meta kanal se mora upisati ručno,
inače webhook odbacuje dolazne poruke uz poruku o nepoznatom Phone Number ID-u:

```sql
INSERT INTO channels (
  tenant_id, type, name, phone_number, external_account_id,
  external_phone_number_id, primary_outbound, status
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'whatsapp_cloud',
  'Rezora Meta Cloud kanal',
  '+38762971250',
  '1744676103334360',
  '1275838885604904',
  true,
  'active'
);
```

## Važne napomene

- Dok se testira, neka bude pokrenut samo jedan Rezora backend za isti webhook.
- Privremeni Cloudflare URL se mijenja nakon ponovnog pokretanja containera, ali
  `npm run tunel` sam uskladi Metu, pa to nije problem u radu.
- Za produkciju će se koristiti stalna domena i server koji radi 24/7.
- `META_ACCESS_TOKEN` je **System User token koji ne ističe**. Ne treba ga
  obnavljati. Za produkciju ga prebaciti u secrets manager.
- Broj `+387 62 971 250` je već registrovan na Cloud API (`platform_type`
  `CLOUD_API`, status `CONNECTED`). Ne pokretati migraciju niti ga uklanjati.
