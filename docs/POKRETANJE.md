# Pokretanje Rezore

Podsjetnik za svakodnevni rad. Sve naredbe se pokreću iz foldera projekta.

## Tri stvari moraju raditi

| Šta | Čemu služi |
|---|---|
| PostgreSQL | baza |
| Node server | prima poruke i odgovara |
| Cloudflare tunel | daje javnu adresu koju Meta može dozvati |

## Redoslijed

**1. Baza**

```powershell
docker compose up -d postgres
```

Ako javi grešku o Dockeru, prvo pokreni Docker Desktop i sačekaj minut.

**2. Server** — ostaje otvoren, ne zatvarati prozor

```powershell
npm run dev:server
```

Kad se ispiše `Rezora platforma je pokrenuta`, radi. Provjera:
`http://localhost:3001/health/ready` treba vratiti `"status":"spreman"`.

**3. Tunel** — u drugom prozoru

```powershell
npm run tunel
```

Skript digne tunel, prijavi novu adresu Meti i upiše je u `PUBLIC_BASE_URL`.
Ništa se ne prepisuje ručno.

> Besplatna adresa se mijenja pri svakom pokretanju. Ako skript javi da server ne
> odgovara, pokreni ga ponovo — ponekad se Cloudflare adresa ne proširi.

> **Već spojeni klijenti prestaju raditi** kad se adresa promijeni, jer u svojim
> Meta aplikacijama imaju upisanu staru. Svakom treba prepisati novi Callback
> URL. Ovo nestaje tek kad se pređe na stalnu domenu.

## Dashboard

```text
<adresa-tunela>/dashboard
```

Korisničko ime `rezora`, lozinka iz `DASHBOARD_PASSWORD` u `.env`.

## Provjera da sve radi

U dashboardu kliknuti **Provjeri** pored bilo kojeg klijenta. Svih pet koraka
mora biti zeleno.

## Gašenje

Zatvoriti prozor sa serverom, pa:

```powershell
docker rm -f rezora-tunnel
docker compose stop postgres
```

Baza ostaje sačuvana.
