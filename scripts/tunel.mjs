/**
 * Pokreće Cloudflare tunel i automatski prijavljuje novu adresu Meti.
 *
 * Zašto: besplatni trycloudflare URL se mijenja pri svakom pokretanju. Ovaj
 * skript preuzima taj posao — pročita novu adresu i sam ažurira Meta webhook,
 * pa nema ručnog prepisivanja u App Dashboardu.
 *
 * Pokretanje:  node scripts/tunel.mjs
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CONTAINER = 'rezora-tunnel';
const PORT = process.env.PORT ?? '3001';

const WEBHOOK_FIELDS = [
  'account_alerts',
  'account_review_update',
  'account_update',
  'calls',
  'history',
  'message_template_quality_update',
  'message_template_status_update',
  'messages',
  'phone_number_name_update',
  'phone_number_quality_update',
  'security',
  'smb_app_state_sync',
  'smb_message_echoes',
].join(',');

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker ${args[0]} nije uspio: ${result.stderr?.trim() || 'nepoznata greška'}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} nije postavljen u .env.`);
  return value;
}

async function pokreniTunel() {
  console.log('Zaustavljam stari tunel ako postoji…');
  docker(['rm', '-f', CONTAINER], { allowFailure: true });

  console.log(`Pokrećem novi tunel prema portu ${PORT}…`);
  docker([
    'run', '--rm', '-d', '--name', CONTAINER,
    'cloudflare/cloudflared:latest',
    'tunnel', '--no-autoupdate',
    '--url', `http://host.docker.internal:${PORT}`,
  ]);

  for (let pokusaj = 1; pokusaj <= 30; pokusaj += 1) {
    const logs = docker(['logs', CONTAINER], { allowFailure: true });
    const match = logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) return match[0];
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Cloudflare nije prijavio adresu u očekivanom vremenu.');
}

async function provjeriZdravlje(url) {
  for (let pokusaj = 1; pokusaj <= 15; pokusaj += 1) {
    try {
      const response = await fetch(`${url}/health/live`);
      if (response.ok) return true;
    } catch {
      /* tunel se još podiže */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function prijaviMeti(url) {
  const appId = requiredEnv('META_APP_ID');
  const appSecret = requiredEnv('META_APP_SECRET');
  const graphVersion = requiredEnv('META_GRAPH_VERSION');
  const verifyToken = requiredEnv('META_VERIFY_TOKEN');
  const callbackUrl = `${url}/api/v1/meta/webhook`;
  const appToken = `${appId}|${appSecret}`;

  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${appId}/subscriptions`, {
    method: 'POST',
    body: new URLSearchParams({
      object: 'whatsapp_business_account',
      callback_url: callbackUrl,
      fields: WEBHOOK_FIELDS,
      verify_token: verifyToken,
      access_token: appToken,
    }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`Meta nije prihvatila adresu: ${body.error.message}`);

  const check = await fetch(
    `https://graph.facebook.com/${graphVersion}/${appId}/subscriptions?access_token=${encodeURIComponent(appToken)}`,
  );
  const checkBody = await check.json();
  const subscription = checkBody.data?.find((item) => item.object === 'whatsapp_business_account');
  return {
    callbackUrl: subscription?.callback_url ?? '(nepoznato)',
    active: subscription?.active ?? false,
    messages: Boolean(subscription?.fields?.some((field) => field.name === 'messages')),
  };
}

/**
 * Upisuje novu adresu u .env. Bez toga bi dashboard klijentima ispisivao
 * webhook adrese sa starog, mrtvog tunela.
 */
function zapisiJavnuAdresu(url) {
  const sadrzaj = readFileSync('.env', 'utf8');
  const red = /^PUBLIC_BASE_URL=.*$/m;
  const novi = red.test(sadrzaj)
    ? sadrzaj.replace(red, `PUBLIC_BASE_URL=${url}`)
    : `${sadrzaj}${sadrzaj.endsWith('\n') ? '' : '\n'}PUBLIC_BASE_URL=${url}\n`;
  writeFileSync('.env', novi, 'utf8');
}

const url = await pokreniTunel();
console.log(`\nNova adresa: ${url}`);

zapisiJavnuAdresu(url);
console.log('PUBLIC_BASE_URL u .env je usklađen.');

const zdrav = await provjeriZdravlje(url);
if (!zdrav) {
  console.error('\nTunel radi, ali server ne odgovara. Provjeri je li pokrenut: npm run dev:server');
  process.exit(1);
}
console.log('Server odgovara kroz tunel.');

const stanje = await prijaviMeti(url);
console.log('\nMeta webhook je ažuriran:');
console.log(`  callback_url: ${stanje.callbackUrl}`);
console.log(`  active:       ${stanje.active}`);
console.log(`  messages:     ${stanje.messages}`);

console.log(`\nGotovo.`);
console.log(`  Dashboard: ${url}/dashboard`);
console.log('\nAko su klijenti već spojeni, njihove webhook adrese sadrže staru');
console.log('adresu tunela i prestale su raditi. Svakom klijentu treba prepisati');
console.log('novi Callback URL u njegovu Meta aplikaciju.');
