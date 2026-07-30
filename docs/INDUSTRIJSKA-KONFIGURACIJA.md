# Industrijska konfiguracija

Univerzalnost se postiže konfiguracijom usluge, a ne kopiranjem workflowa za svaku djelatnost.

## Salon

- model: `appointment`
- zaposlenik: frizer/kozmetičar
- trajanje: po usluzi
- opcionalni buffer za čišćenje

## Klinika ili ordinacija

- model: `multi_resource`
- zaposlenik: doktor/terapeut
- resurs: ordinacija ili uređaj
- ručna potvrda i stroži pristup podacima

Sistem ne treba davati medicinsku dijagnozu. AI služi samo za administrativno razumijevanje poruke.

## Hotel i apartman

- model: `accommodation`
- resurs: konkretna soba ili jedinica
- period: check-in do check-out
- konfiguracija: `check_in_time`, `check_out_time`

## Restoran

- model: `table_allocation` ili `capacity_slot`
- količina: broj osoba
- resurs: stol ili zona

## Autoservis

- model: `resource_appointment`
- zaposlenik: mehaničar
- resurs: dizalica ili servisno mjesto
- trajanje: prema vrsti zahvata

## Turistička ili konsultantska agencija

- model: `service_request` za složene ponude
- model: `appointment` za konsultacije
- human handoff nakon prikupljanja zahtjeva

Za svakog novog klijenta unose se tenant, politika rezervacije, lokacije, usluge, zaposlenici, resursi, radno vrijeme i izuzeci. Core workflow se ne kopira.

