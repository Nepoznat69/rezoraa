import { randomBytes } from 'node:crypto';

/** Interni dashboard za Rezora tim. Jedna stranica, bez vanjskih zavisnosti. */
export function renderDashboard(): { html: string; nonce: string } {
  const nonce = randomBytes(18).toString('base64url');

  return {
    nonce,
    html: `<!doctype html>
<html lang="bs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rezora — klijenti</title>
<style nonce="${nonce}">
  :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f3f7f5; color: #183128; }
  header { background: #158057; color: white; padding: 18px 24px; }
  header b { letter-spacing: .06em; }
  main { max-width: 1080px; margin: 0 auto; padding: 24px; display: grid; gap: 24px; }
  .kartica { background: white; border-radius: 16px; padding: 24px; box-shadow: 0 10px 34px rgba(20,55,42,.09); }
  h2 { margin: 0 0 6px; font-size: 20px; }
  .opis { margin: 0 0 18px; color: #5c7268; font-size: 14px; line-height: 1.55; }
  label { display: block; font-size: 13px; font-weight: 650; margin: 12px 0 5px; }
  input { width: 100%; padding: 11px 13px; border: 1px solid #cfdcd6; border-radius: 9px; font-size: 15px; font-family: inherit; }
  input:focus { outline: 2px solid #1fae73; border-color: transparent; }
  .red { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  button { margin-top: 18px; padding: 13px 20px; border: 0; border-radius: 10px; background: #1fae73; color: white; font-size: 16px; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: .5; cursor: wait; }
  button.sporedno { margin: 0; padding: 7px 13px; font-size: 13px; background: #e8f2ee; color: #1a5c44; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 11px 8px; border-bottom: 1px solid #eaf1ee; vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #7b9189; }
  .poruka { margin-top: 16px; padding: 13px 15px; border-radius: 10px; font-size: 14px; line-height: 1.55; white-space: pre-wrap; }
  .ok { background: #e7f7ef; color: #14603f; }
  .greska { background: #fdecec; color: #8d2020; }
  .korak { display: flex; gap: 10px; padding: 9px 0; border-bottom: 1px solid #eaf1ee; font-size: 14px; }
  .korak:last-child { border-bottom: 0; }
  .znak { flex: 0 0 20px; font-weight: 700; }
  .zeleno { color: #17915f; }
  .crveno { color: #c0392b; }
  code { background: #f0f5f3; padding: 3px 7px; border-radius: 6px; font-size: 12.5px; word-break: break-all; }
  .prazno { color: #7b9189; font-style: italic; padding: 16px 0; }

  /* Super admin pregled preko svih salona */
  .brojke { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 12px; }
  .brojka { background: #f6faf8; border: 1px solid #e4efea; border-radius: 12px; padding: 14px 16px; }
  .brojka b { display: block; font-size: 27px; line-height: 1.2; color: #14603f; font-variant-numeric: tabular-nums; }
  .brojka span { display: block; margin-top: 3px; font-size: 12.5px; color: #5c7268; }
  .filteri { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 14px; }
  .filteri button { margin: 0; padding: 7px 14px; font-size: 13px; background: #e8f2ee; color: #1a5c44; }
  .filteri button[aria-pressed="true"] { background: #1fae73; color: white; }
  .tabela-omot { overflow-x: auto; }
  .znacka { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 12px; font-weight: 650; white-space: nowrap; background: #eef3f1; color: #45594f; }
  .znacka.z-zakazano { background: #e6eefb; color: #23508f; }
  .znacka.z-potvrdeno { background: #e2f6ec; color: #14603f; }
  .znacka.z-utoku { background: #fdf1dc; color: #8a5c11; }
  .znacka.z-zavrseno { background: #eaeef0; color: #46585f; }
  .znacka.z-otkazano { background: #fdecec; color: #8d2020; }
  .znacka.z-nedosao { background: #f6e6f2; color: #7a2a63; }
  .znacka.z-bot { background: #e2f6ec; color: #14603f; }
  .znacka.z-covjek { background: #fdf1dc; color: #8a5c11; }
  .znacka.z-zatvoreno { background: #eaeef0; color: #46585f; }
  .tiho { color: #7b9189; font-size: 12.5px; }
  .zaglavlje { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
</style>
</head>
<body>
<header><b>REZORA</b> — interni pregled klijenata</header>
<main>

  <section class="kartica">
    <div class="zaglavlje">
      <h2>Sažetak platforme</h2>
      <button id="osvjezi" class="sporedno" type="button">Osvježi</button>
    </div>
    <p class="opis">
      Brojevi sa svih salona zajedno, čitani uživo iz Rezora Core baze.
      Vremena su u zoni Europe/Sarajevo.
    </p>
    <div class="brojke" id="brojke">
      <div class="brojka"><b>—</b><span>Termini danas</span></div>
      <div class="brojka"><b>—</b><span>Nadolazeći termini</span></div>
      <div class="brojka"><b>—</b><span>Razgovora ukupno</span></div>
      <div class="brojka"><b>—</b><span>Kod čovjeka</span></div>
      <div class="brojka"><b>—</b><span>Aktivnih klijenata</span></div>
    </div>
    <div id="sazetakPoruka"></div>
  </section>

  <section class="kartica">
    <h2>Rezervacije</h2>
    <p class="opis">Termini svih salona na jednom mjestu. Salon u svom kalendaru vidi samo svoje — ovdje se vidi cijela platforma.</p>
    <div class="filteri" id="filteri">
      <button type="button" data-period="danas" aria-pressed="true">Danas</button>
      <button type="button" data-period="sedmica" aria-pressed="false">Sedmica</button>
      <button type="button" data-period="buduce" aria-pressed="false">Buduće</button>
      <button type="button" data-period="sve" aria-pressed="false">Sve</button>
    </div>
    <div class="tabela-omot">
      <table>
        <thead><tr><th>Broj</th><th>Firma</th><th>Za koga</th><th>Usluga</th><th>Radnik</th><th>Vrijeme</th><th>Status</th></tr></thead>
        <tbody id="rezervacije"><tr><td colspan="6" class="prazno">Učitavanje…</td></tr></tbody>
      </table>
    </div>
  </section>

  <section class="kartica">
    <h2>Razgovori</h2>
    <p class="opis">Zadnje što se desilo u inboxu svakog salona. Brojevi su namjerno maskirani — za cijeli broj se ide u Core.</p>
    <div class="tabela-omot">
      <table>
        <thead><tr><th>Firma</th><th>Kontakt</th><th>Zadnja poruka</th><th>Status</th><th>Vrijeme</th></tr></thead>
        <tbody id="razgovori"><tr><td colspan="5" class="prazno">Učitavanje…</td></tr></tbody>
      </table>
    </div>
  </section>

  <section class="kartica">
    <h2>Dodaj klijenta</h2>
    <p class="opis">
      Klijent pravi svoj Facebook Business Manager i svoju Meta aplikaciju, a ovdje
      se unose četiri podatka koja nam preda. Tako klijent zadržava vlastite limite
      poruka i ne ovisi o Rezorinoj verifikaciji.
    </p>
    <form id="forma">
      <div class="red">
        <div><label>Naziv firme</label><input name="naziv" required placeholder="Frizerski salon Ana"></div>
        <div><label>Oznaka (slug)</label><input name="slug" required pattern="[a-z0-9\\-]+" placeholder="salon-ana"></div>
      </div>
      <div class="red">
        <div><label>WhatsApp broj</label><input name="broj" required placeholder="+387 61 000 000"></div>
        <div><label>Phone Number ID</label><input name="phone_number_id" required pattern="\\d+" placeholder="1275838885604904"></div>
      </div>
      <div class="red">
        <div><label>WABA ID</label><input name="waba_id" required pattern="\\d+" placeholder="1744676103334360"></div>
        <div><label>App Secret</label><input name="app_secret" required type="password" placeholder="iz Meta aplikacije klijenta"></div>
      </div>
      <label>Pristupni token (System User, trajni)</label>
      <input name="access_token" required type="password" placeholder="EAA...">
      <button type="submit">Dodaj klijenta</button>
    </form>
    <div id="odgovor"></div>
  </section>

  <section class="kartica">
    <h2>Klijenti</h2>
    <p class="opis">Dugme „Provjeri" pita Metu uživo radi li token, broj i slanje poruka.</p>
    <table>
      <thead><tr><th>Firma</th><th>Broj</th><th>Zadnja provjera</th><th></th></tr></thead>
      <tbody id="lista"><tr><td colspan="4" class="prazno">Učitavanje…</td></tr></tbody>
    </table>
    <div id="provjera"></div>
  </section>

</main>
<script nonce="${nonce}">
  const forma = document.getElementById('forma');
  const odgovor = document.getElementById('odgovor');
  const lista = document.getElementById('lista');
  const provjera = document.getElementById('provjera');

  function poruka(element, tekst, uspjeh) {
    element.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'poruka ' + (uspjeh ? 'ok' : 'greska');
    div.textContent = tekst;
    element.appendChild(div);
    return div;
  }

  function datum(vrijednost) {
    if (!vrijednost) return 'nikad';
    return new Date(vrijednost).toLocaleString('bs-BA');
  }

  async function ucitajListu() {
    try {
      const response = await fetch('/dashboard/api/klijenti');
      if (!response.ok) throw new Error('Lista se ne može učitati.');
      const podaci = await response.json();
      lista.innerHTML = '';
      if (!podaci.length) {
        lista.innerHTML = '<tr><td colspan="4" class="prazno">Još nema klijenata.</td></tr>';
        return;
      }
      for (const klijent of podaci) {
        const tr = document.createElement('tr');

        const tdNaziv = document.createElement('td');
        tdNaziv.innerHTML = '<strong></strong><br><span style="color:#7b9189;font-size:12.5px"></span>';
        tdNaziv.querySelector('strong').textContent = klijent.naziv;
        tdNaziv.querySelector('span').textContent = klijent.slug;

        const tdBroj = document.createElement('td');
        tdBroj.textContent = klijent.broj || '—';

        const tdProvjera = document.createElement('td');
        tdProvjera.textContent = datum(klijent.last_check_at);

        const tdAkcija = document.createElement('td');
        const dugme = document.createElement('button');
        dugme.className = 'sporedno';
        dugme.textContent = 'Provjeri';
        dugme.addEventListener('click', () => provjeriKlijenta(klijent.channel_id, klijent.naziv, dugme));
        tdAkcija.appendChild(dugme);

        if (klijent.webhook_key) {
          const dugmeWebhook = document.createElement('button');
          dugmeWebhook.className = 'sporedno';
          dugmeWebhook.style.marginLeft = '6px';
          dugmeWebhook.textContent = 'Webhook podaci';
          dugmeWebhook.addEventListener('click', () => prikaziWebhook(klijent.channel_id, klijent.naziv));
          tdAkcija.appendChild(dugmeWebhook);
        }

        tr.append(tdNaziv, tdBroj, tdProvjera, tdAkcija);
        lista.appendChild(tr);
      }
    } catch (error) {
      lista.innerHTML = '<tr><td colspan="4" class="prazno">Greška pri učitavanju.</td></tr>';
    }
  }

  function poljeZaKopiranje(oznaka, vrijednost) {
    const omot = document.createElement('div');
    omot.style.marginTop = '12px';

    const naslov = document.createElement('div');
    naslov.style.fontSize = '13px';
    naslov.style.fontWeight = '650';
    naslov.style.marginBottom = '4px';
    naslov.textContent = oznaka;

    const red = document.createElement('div');
    red.style.display = 'flex';
    red.style.gap = '8px';
    red.style.alignItems = 'center';

    const polje = document.createElement('input');
    polje.readOnly = true;
    polje.value = vrijednost;
    polje.style.fontSize = '13px';
    polje.addEventListener('focus', () => polje.select());

    const kopiraj = document.createElement('button');
    kopiraj.className = 'sporedno';
    kopiraj.style.flex = '0 0 auto';
    kopiraj.textContent = 'Kopiraj';
    kopiraj.addEventListener('click', async () => {
      polje.select();
      try {
        await navigator.clipboard.writeText(vrijednost);
      } catch {
        document.execCommand('copy');
      }
      kopiraj.textContent = 'Kopirano ✓';
      setTimeout(() => { kopiraj.textContent = 'Kopiraj'; }, 1500);
    });

    red.append(polje, kopiraj);
    omot.append(naslov, red);
    return omot;
  }

  async function prikaziWebhook(channelId, naziv) {
    try {
      const response = await fetch('/dashboard/api/klijenti/' + channelId + '/webhook');
      const podaci = await response.json();
      if (!response.ok) throw new Error(podaci.message || 'Podaci nisu dostupni.');

      provjera.innerHTML = '';
      const okvir = document.createElement('div');
      okvir.className = 'poruka ok';

      const naslov = document.createElement('div');
      naslov.style.fontWeight = '700';
      naslov.textContent = naziv + ' — podaci za Meta webhook';
      okvir.appendChild(naslov);

      const uputa = document.createElement('div');
      uputa.style.fontSize = '13px';
      uputa.style.marginTop = '6px';
      uputa.textContent = 'Klikni Kopiraj pa zalijepi u Metu: WhatsApp → Configuration → Webhook → Edit. Nemoj kucati ručno.';
      okvir.appendChild(uputa);

      okvir.appendChild(poljeZaKopiranje('Callback URL', podaci.webhook_url));
      okvir.appendChild(poljeZaKopiranje('Verify token', podaci.verify_token));
      provjera.appendChild(okvir);
    } catch (error) {
      poruka(provjera, error.message, false);
    }
  }

  async function provjeriKlijenta(channelId, naziv, dugme) {
    dugme.disabled = true;
    dugme.textContent = 'Provjeravam…';
    try {
      const response = await fetch('/dashboard/api/klijenti/' + channelId + '/provjera', { method: 'POST' });
      const podaci = await response.json();
      if (!response.ok) throw new Error(podaci.message || 'Provjera nije uspjela.');

      provjera.innerHTML = '';
      const okvir = document.createElement('div');
      okvir.className = 'poruka ' + (podaci.every(k => k.uspjeh) ? 'ok' : 'greska');
      const naslov = document.createElement('div');
      naslov.style.fontWeight = '700';
      naslov.style.marginBottom = '8px';
      naslov.textContent = naziv;
      okvir.appendChild(naslov);

      for (const korak of podaci) {
        const red = document.createElement('div');
        red.className = 'korak';
        const znak = document.createElement('span');
        znak.className = 'znak ' + (korak.uspjeh ? 'zeleno' : 'crveno');
        znak.textContent = korak.uspjeh ? '✓' : '✕';
        const tekst = document.createElement('span');
        tekst.innerHTML = '<strong></strong> — <span></span>';
        tekst.querySelector('strong').textContent = korak.naziv;
        tekst.querySelector('span').textContent = korak.detalj;
        red.append(znak, tekst);
        okvir.appendChild(red);
      }
      provjera.appendChild(okvir);
      await ucitajListu();
    } catch (error) {
      poruka(provjera, error.message, false);
    } finally {
      dugme.disabled = false;
      dugme.textContent = 'Provjeri';
    }
  }

  forma.addEventListener('submit', async (event) => {
    event.preventDefault();
    const dugme = forma.querySelector('button');
    dugme.disabled = true;
    const podaci = Object.fromEntries(new FormData(forma).entries());
    try {
      const response = await fetch('/dashboard/api/klijenti', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(podaci)
      });
      const tijelo = await response.json();
      if (!response.ok) throw new Error(tijelo.message || 'Dodavanje nije uspjelo.');

      const div = poruka(odgovor, 'Klijent je dodan. Klikni Kopiraj pa zalijepi u Metu, pod WhatsApp → Configuration → Webhook. Nemoj kucati ručno — ključ na kraju adrese se lako odsiječe.', true);
      div.appendChild(poljeZaKopiranje('Callback URL', tijelo.webhook_url));
      div.appendChild(poljeZaKopiranje('Verify token', tijelo.verify_token));

      forma.reset();
      await ucitajListu();
    } catch (error) {
      poruka(odgovor, error.message, false);
    } finally {
      dugme.disabled = false;
    }
  });

  // -------------------------------------------------------------------------
  // Super admin pregled: sve firme odjednom
  //
  // Sve ćelije se pune preko textContent, a klase značaka dolaze iz rječnika
  // ispod — nijedna vrijednost iz baze ne ulazi u HTML kao oznaka.
  // -------------------------------------------------------------------------
  const brojke = document.getElementById('brojke');
  const sazetakPoruka = document.getElementById('sazetakPoruka');
  const filteri = document.getElementById('filteri');
  const rezervacijeTijelo = document.getElementById('rezervacije');
  const razgovoriTijelo = document.getElementById('razgovori');
  const osvjezi = document.getElementById('osvjezi');
  let period = 'danas';

  const STATUS_TERMINA = {
    scheduled: ['z-zakazano', 'Zakazano'],
    confirmed: ['z-potvrdeno', 'Potvrđeno'],
    in_progress: ['z-utoku', 'U toku'],
    completed: ['z-zavrseno', 'Završeno'],
    cancelled: ['z-otkazano', 'Otkazano'],
    no_show: ['z-nedosao', 'Nije došao']
  };

  const STATUS_RAZGOVORA = {
    bot: ['z-bot', 'Asistent'],
    human: ['z-covjek', 'Kod čovjeka'],
    closed: ['z-zatvoreno', 'Zatvoren']
  };

  function jednaCelija(tijelo, kolona, tekst) {
    tijelo.innerHTML = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = kolona;
    td.className = 'prazno';
    td.textContent = tekst;
    tr.appendChild(td);
    tijelo.appendChild(tr);
  }

  function celija(tekst) {
    const td = document.createElement('td');
    td.textContent = tekst === null || tekst === undefined || tekst === '' ? '—' : String(tekst);
    return td;
  }

  function znacka(status, rjecnik) {
    const td = document.createElement('td');
    const span = document.createElement('span');
    const opis = Object.prototype.hasOwnProperty.call(rjecnik, status) ? rjecnik[status] : null;
    span.className = opis ? 'znacka ' + opis[0] : 'znacka';
    span.textContent = opis ? opis[1] : String(status || 'nepoznato');
    td.appendChild(span);
    return td;
  }

  async function ucitajSazetak() {
    try {
      const response = await fetch('/dashboard/api/pregled/sazetak');
      if (!response.ok) throw new Error('Sažetak se ne može učitati.');
      const podaci = await response.json();
      const stavke = [
        [podaci.danas, 'Termini danas'],
        [podaci.nadolazece, 'Nadolazeći termini'],
        [podaci.ukupnoRazgovora, 'Razgovora ukupno'],
        [podaci.razgovoriKodCovjeka, 'Kod čovjeka'],
        [podaci.aktivnihKlijenata, 'Aktivnih klijenata']
      ];
      brojke.innerHTML = '';
      for (const stavka of stavke) {
        const kutija = document.createElement('div');
        kutija.className = 'brojka';
        const broj = document.createElement('b');
        broj.textContent = String(stavka[0] === null || stavka[0] === undefined ? 0 : stavka[0]);
        const natpis = document.createElement('span');
        natpis.textContent = stavka[1];
        kutija.append(broj, natpis);
        brojke.appendChild(kutija);
      }
      sazetakPoruka.innerHTML = '';
    } catch (error) {
      poruka(sazetakPoruka, 'Sažetak se trenutno ne može učitati — provjeri vezu na Core bazu.', false);
    }
  }

  async function ucitajRezervacije() {
    jednaCelija(rezervacijeTijelo, 6, 'Učitavanje…');
    try {
      const response = await fetch('/dashboard/api/pregled/rezervacije?limit=50&period=' + encodeURIComponent(period));
      if (!response.ok) throw new Error('Rezervacije se ne mogu učitati.');
      const podaci = await response.json();
      if (!podaci.length) {
        jednaCelija(rezervacijeTijelo, 6, period === 'sve'
          ? 'Nijedan salon još nema nijednu rezervaciju.'
          : 'Za ovaj period nijedan salon nema zakazan termin.');
        return;
      }
      rezervacijeTijelo.innerHTML = '';
      for (const red of podaci) {
        const tr = document.createElement('tr');
        tr.append(
          celija(red.kod),
          celija(red.firma),
          celija(red.kupac),
          celija(red.usluga),
          celija(red.radnik),
          celija(red.vrijeme),
          znacka(red.status, STATUS_TERMINA)
        );
        rezervacijeTijelo.appendChild(tr);
      }
    } catch (error) {
      jednaCelija(rezervacijeTijelo, 6, 'Rezervacije se trenutno ne mogu učitati — provjeri vezu na Core bazu.');
    }
  }

  async function ucitajRazgovore() {
    jednaCelija(razgovoriTijelo, 5, 'Učitavanje…');
    try {
      const response = await fetch('/dashboard/api/pregled/razgovori?limit=50');
      if (!response.ok) throw new Error('Razgovori se ne mogu učitati.');
      const podaci = await response.json();
      if (!podaci.length) {
        jednaCelija(razgovoriTijelo, 5, 'Još niko nije pisao nijednom salonu. Čim stigne prva poruka, pojavit će se ovdje.');
        return;
      }
      razgovoriTijelo.innerHTML = '';
      for (const red of podaci) {
        const tr = document.createElement('tr');
        const tdPoruka = celija(red.zadnjaPoruka || 'Bez poruka.');
        if (red.zadnjiSmjer === 'outbound') tdPoruka.className = 'tiho';
        tr.append(
          celija(red.firma),
          celija(red.kontakt),
          tdPoruka,
          znacka(red.status, STATUS_RAZGOVORA),
          celija(red.vrijeme)
        );
        razgovoriTijelo.appendChild(tr);
      }
    } catch (error) {
      jednaCelija(razgovoriTijelo, 5, 'Razgovori se trenutno ne mogu učitati — provjeri vezu na Core bazu.');
    }
  }

  filteri.addEventListener('click', (dogadjaj) => {
    const dugme = dogadjaj.target.closest('button[data-period]');
    if (!dugme) return;
    period = dugme.dataset.period;
    for (const ostali of filteri.querySelectorAll('button[data-period]')) {
      ostali.setAttribute('aria-pressed', String(ostali === dugme));
    }
    ucitajRezervacije();
  });

  osvjezi.addEventListener('click', () => {
    ucitajSazetak();
    ucitajRezervacije();
    ucitajRazgovore();
  });

  ucitajSazetak();
  ucitajRezervacije();
  ucitajRazgovore();
  ucitajListu();
</script>
</body>
</html>`,
  };
}
