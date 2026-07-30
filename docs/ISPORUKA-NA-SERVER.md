# Isporuka na server

Vodič za postavljanje Rezore na Hetzner VPS. Radi se jednom; kasnije se
nadogradnje isporučuju u tri komande.

## Šta je potrebno prije početka

- Hetzner nalog sa uključenom 2FA
- Domena čiji DNS vodi Cloudflare
- SSH ključ na svom računaru

## 1. SSH ključ

Ako ga još nemaš, na svom računaru:

```powershell
ssh-keygen -t ed25519 -C "rezora"
```

Prihvati ponuđenu putanju i postavi lozinku. Javni dio ispiši sa:

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

Tu vrijednost ćeš zalijepiti u Hetzner. **Privatni ključ nikada ne dijeli.**

## 2. Server

Hetzner Console → projekat → **Add Server**:

| Postavka | Vrijednost |
|---|---|
| Lokacija | Nürnberg ili Helsinki |
| Slika | Ubuntu 24.04 |
| Tip | **CX22** (2 jezgra, 4 GB) |
| SSH ključ | zalijepi javni ključ iz koraka 1 |
| Ime | `rezora` |

Ne uzimaj backup opciju kod Hetznera; kopije baze rješavamo zasebno i jeftinije.

Zapiši IP adresu koju server dobije.

## 3. DNS

U Cloudflareu → `rezora.xyz` → **DNS** → **Add record**:

| Polje | Vrijednost |
|---|---|
| Type | `A` |
| Name | `api` |
| IPv4 | IP adresa servera |
| Proxy status | **DNS only** (siva ikona) |

> Siva ikona je obavezna. Ako je narandžasta, Cloudflare presreće promet i Caddy
> ne može pribaviti certifikat.

## 4. Osnovno osiguranje servera

Prijava:

```bash
ssh root@IP_ADRESA
```

Zatim:

```bash
apt update && apt upgrade -y
apt install -y ufw fail2ban git

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl enable --now fail2ban
```

Baza namjerno nije otvorena prema van — dostupna je samo aplikaciji unutar
Docker mreže.

## 5. Docker

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

## 6. Kod

```bash
git clone <adresa-repozitorija> /opt/rezora
cd /opt/rezora
```

Ako repozitorij još nije na GitHubu, prekopiraj folder sa svog računara:

```powershell
scp -r C:\Users\Administrator\Desktop\rezoraa root@IP_ADRESA:/opt/rezora
```

## 7. Tajne

```bash
cp .env.example .env
nano .env
```

Obavezno postaviti:

| Varijabla | Napomena |
|---|---|
| `POSTGRES_PASSWORD` | nova jaka lozinka, ne ona iz primjera |
| `DOMENA` | `api.rezora.xyz` |
| `PUBLIC_BASE_URL` | `https://api.rezora.xyz` |
| `SECRETS_KEY` | **prepiši postojeći sa razvojnog računara** |
| `DASHBOARD_PASSWORD` | nova jaka lozinka |
| `INTERNAL_API_KEY` | nova jaka lozinka |
| `META_*` | prepisati sa razvojnog računara |
| `OPENAI_API_KEY` | ako se koristi AI |

> `SECRETS_KEY` se **ne smije** generisati iznova. Njime su šifrirani tokeni
> klijenata; s novim ključem stari podaci postaju nečitljivi.

Zaključati fajl:

```bash
chmod 600 .env
```

## 8. Pokretanje

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec app npm run db:migrate:prod
```

Seed se pokreće samo ako se želi demo tenant:

```bash
docker compose -f docker-compose.prod.yml exec app npm run db:seed:prod
```

## 9. Provjera

```bash
curl https://api.rezora.xyz/health/live
```

Očekivano: `{"status":"živ", ...}`

Certifikat Caddy pribavi u roku od minute. Ako ne uspije, najčešći uzrok je
narandžasta ikona u Cloudflareu (korak 3) ili DNS koji se još nije proširio.

## 10. Prebacivanje klijenata

Adresa se sada više ne mijenja. Svakom već spojenom klijentu treba jednom
prepisati novi Callback URL iz dashboarda (**Webhook podaci**) u njegovu Meta
aplikaciju. Poslije toga se to više ne ponavlja.

## Nadogradnja

```bash
cd /opt/rezora
git pull
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec app npm run db:migrate:prod
```

## Kopije baze

Dnevna kopija u 3 ujutro:

```bash
mkdir -p /opt/rezora-kopije
crontab -e
```

Dodati red:

```cron
0 3 * * * docker exec rezora-postgres pg_dump -U rezora rezora | gzip > /opt/rezora-kopije/rezora-$(date +\%F).sql.gz && find /opt/rezora-kopije -name '*.sql.gz' -mtime +14 -delete
```

Kopije na samom serveru ne vrijede ako server nestane. Prebacivati ih redovno
drugdje (Backblaze, S3 ili vlastiti računar).

**`SECRETS_KEY` čuvati odvojeno, u password manageru.** Kopija baze bez tog
ključa ne vraća tokene klijenata.

## Nadzor

Besplatan UptimeRobot na `https://api.rezora.xyz/health/live`, provjera svakih
5 minuta, obavijest na e-poštu. Bez toga se za pad sazna od klijenta.

## Dnevnik i stanje

```bash
docker compose -f docker-compose.prod.yml logs -f app
docker compose -f docker-compose.prod.yml ps
```
