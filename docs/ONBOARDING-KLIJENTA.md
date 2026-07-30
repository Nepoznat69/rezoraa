# Onboarding novog klijenta

Vodič za Rezora tim. Postupak traje oko 30 minuta i radi se **zajedno sa
klijentom**, jer se koristi njegov Facebook nalog.

## Zašto ovako

Klijent pravi vlastiti Business Manager i vlastitu Meta aplikaciju. Rezora dobija
samo četiri podatka i nikada ne postaje vlasnik njegovih naloga.

Dvije koristi:

- **Nije potrebna verifikacija Rezorinog poslovnog subjekta.** Klijentova
  aplikacija ima Standard Access nad vlastitim WhatsApp nalogom, što je dovoljno.
- **Svaki klijent ima vlastite limite poruka.** Limiti se računaju po Business
  Portfoliju. Da su svi klijenti pod Rezorinim nalogom, dijelili bi istih 250
  razgovora dnevno. Ovako svaki ima svojih 250.

Jedan lični Facebook profil može napraviti **najviše dva** Business Managera, pa
Rezora ne može praviti naloge umjesto klijenata.

## Šta klijent priprema

- Lični Facebook nalog sa uključenom dvofaktorskom prijavom
- Broj telefona koji **nije** aktivan ni u jednoj WhatsApp aplikaciji
- Osnovne podatke firme (naziv, adresa, web ako postoji)

> Ako klijent želi zadržati broj u WhatsApp Business aplikaciji (Coexistence), to
> zahtijeva Tech Provider status i trenutno nije moguće. Broj se mora osloboditi.

## Koraci sa klijentom

### 1. Business Manager

`business.facebook.com` → napraviti portfolio na klijentovo ime i popuniti
podatke firme.

### 2. Meta aplikacija

`developers.facebook.com` → **My Apps** → **Create App** → tip **Business** →
povezati na portfolio iz koraka 1 → dodati proizvod **WhatsApp**.

### 3. WhatsApp nalog i broj

U aplikaciji: **WhatsApp → API Setup** → napraviti WhatsApp Business Account i
dodati klijentov broj. Broj se potvrđuje SMS-om ili pozivom.

Zapisati **WABA ID** i **Phone Number ID**.

### 4. Trajni token

**Business Settings → Users → System Users** → dodati sistemskog korisnika sa
ulogom Admin → **Add Assets** → dodijeliti mu WhatsApp nalog → **Generate New
Token**.

Odabrati aplikaciju iz koraka 2 i dozvole:

- `whatsapp_business_management`
- `whatsapp_business_messaging`

Token sistemskog korisnika **ne ističe**. Token iz App Dashboarda traje 24 sata i
nije upotrebljiv.

### 5. App Secret

**Settings → Basic → App Secret → Show**.

### 6. Unos u Rezoru

Otvoriti `/dashboard`, popuniti formu sa četiri podatka:

| Polje | Odakle |
|---|---|
| WABA ID | korak 3 |
| Phone Number ID | korak 3 |
| Pristupni token | korak 4 |
| App Secret | korak 5 |

Nakon spremanja dashboard ispisuje **Callback URL** i **Verify token**.

### 7. Webhook u klijentovoj aplikaciji

**WhatsApp → Configuration → Webhook → Edit** → unijeti Callback URL i Verify
token iz koraka 6 → **Verify and save** → pretplatiti se na polje `messages`.

### 8. Podaci firme — bez ovoga je broj blokiran

**Meta Business Suite → Settings → Business Info** → popuniti obavezno:

- **Legal Name**
- **Country**
- **Website**

Dok su ta tri polja prazna, Meta drži broj u stanju `BLOCKED` i **nijedna poruka
ne prolazi**. Ovo nema veze sa verifikacijom poslovnog subjekta i rješava se
odmah, u par minuta.

### 9. Način plaćanja

**Business Settings → Payments** → dodati karticu.

Bez toga Meta blokira **razgovore koje pokreće firma** (podsjetnici, potvrde,
kampanje). Odgovaranje na poruke koje je kupac prvi poslao radi i bez toga.

### 10. Provjera

U dashboardu kliknuti **Provjeri** pored klijenta:

```
✓ Kanal u bazi
✓ Pristupni token
✓ Dozvole tokena
✓ WhatsApp broj
✓ Može li slati poruke
✓ Pretplata na dolazne poruke
✓ Aplikacija spojena na WhatsApp nalog
```

Ako nešto nije zeleno, u detalju piše tačan razlog i šta popraviti.

Zatim poslati probnu poruku na klijentov broj i potvrditi da Rezora odgovori.

> **Zadnji korak je najpodmukliji.** Meta šalje dolazne poruke samo aplikaciji
> koja je pretplaćena na WhatsApp nalog. Kod test brojeva je to unaprijed
> Metina vlastita aplikacija, pa poruke tiho odlaze njoj i nigdje se ne javlja
> greška — verifikacija webhooka prođe, a poruke ne stižu.
>
> Rezora to radi automatski pri dodavanju klijenta. Ako ipak zakaže, u dnevniku
> stoji upozorenje, a pretplata se može ponoviti pozivom
> `POST /dashboard/api/klijenti/<channel_id>/pretplata`.

## Kada nešto ne radi

| Poruka | Uzrok |
|---|---|
| Token ne vrijedi | Istekao token iz App Dashboarda; napraviti System User token |
| Nedostaje dozvola | Token nema `whatsapp_business_management` ili `whatsapp_business_messaging` |
| Broj nije CONNECTED | Broj nije potvrđen ili je još u WhatsApp aplikaciji |
| Meta odbija webhook | Callback URL ili Verify token pogrešno prepisani |
| Poruke ne stižu | Polje `messages` nije pretplaćeno |

## Sigurnost

- Token i app secret se u bazi čuvaju **šifrirani** (AES-256-GCM), ključem iz
  `SECRETS_KEY`. Bez tog ključa dump baze ne otkriva tajne klijenata.
- Svaki klijent ima **vlastitu webhook adresu** sa nasumičnim ključem. Potpis se
  provjerava njegovim app secretom, pa tajna jednog klijenta ne otvara webhook
  drugog.
- Dashboard je zaštićen prijavom (`DASHBOARD_PASSWORD`), korisničko ime `rezora`.
- `SECRETS_KEY` se ne smije mijenjati nakon što su klijenti uneseni; postojeće
  tajne se time gube.
