# Sigurnosna checklista prije produkcije

- promijeniti sve vrijednosti koje počinju sa `promijeni-`;
- rotirati postojeći OpenAI ključ ako je ikada dijeljen ili commitovan;
- nikada ne commitovati `.env`, `.wwebjs_auth` i `.wwebjs_cache`;
- koristiti HTTPS za platformu, n8n i QR komunikaciju;
- čuvati Meta tokene u managed secret storeu;
- koristiti poseban PostgreSQL application role, ne vlasnika baze;
- primijeniti i testirati Row-Level Security;
- ograničiti n8n credential pristup;
- verifikovati Meta `X-Hub-Signature-256` nad sirovim bodyjem;
- uključiti rate limit na javnim endpointima;
- definisati retention i brisanje PII podataka;
- šifrovati backup i testirati restore;
- postaviti monitoring inbox backloga, failed događaja i istečenih holdova;
- napraviti dependency, SAST, secret i tenant-isolation testove;
- za zdravstvene klijente provjeriti primjenjive privacy i regulatorne obaveze.

