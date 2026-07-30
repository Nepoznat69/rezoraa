import { randomBytes } from 'node:crypto';
import { config } from '../../../config.js';
import { query } from '../../../infrastructure/database.js';

interface MetaErrorBody {
  error?: { message?: string; code?: number };
}

interface TokenResponse extends MetaErrorBody {
  access_token?: string;
  token_type?: string;
}

interface WabaResponse extends MetaErrorBody {
  id?: string;
  name?: string;
}

interface PhoneResponse extends MetaErrorBody {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
}

export interface MetaOnboardingInput {
  state: string;
  code: string;
  waba_id: string;
  phone_number_id: string;
}

const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 15 * 60 * 1000;

function graphVersion(): string {
  if (!config.META_GRAPH_VERSION || !/^v\d+\.\d+$/.test(config.META_GRAPH_VERSION)) {
    throw new Error('META_GRAPH_VERSION nije ispravno konfigurisan.');
  }
  return config.META_GRAPH_VERSION;
}

function requiredOnboardingConfig(): { appId: string; configurationId: string } {
  if (!config.META_APP_ID || !/^\d+$/.test(config.META_APP_ID)) {
    throw new Error('META_APP_ID nije konfigurisan.');
  }
  if (!config.META_EMBEDDED_SIGNUP_CONFIG_ID || !/^\d+$/.test(config.META_EMBEDDED_SIGNUP_CONFIG_ID)) {
    throw new Error('META_EMBEDDED_SIGNUP_CONFIG_ID nije konfigurisan.');
  }
  return { appId: config.META_APP_ID, configurationId: config.META_EMBEDDED_SIGNUP_CONFIG_ID };
}

function createState(): string {
  const now = Date.now();
  for (const [state, expiresAt] of pendingStates) {
    if (expiresAt <= now) pendingStates.delete(state);
  }
  const state = randomBytes(32).toString('base64url');
  pendingStates.set(state, now + STATE_TTL_MS);
  return state;
}

function consumeState(state: string): boolean {
  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);
  return typeof expiresAt === 'number' && expiresAt > Date.now();
}

async function metaRequest<T extends MetaErrorBody>(url: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = (await response.json()) as T;
    if (!response.ok || body.error) {
      throw new Error(`Meta API greška ${response.status}: ${body.error?.message ?? 'nepoznata greška'}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

export function renderMetaOnboardingPage(options: { coexistence?: boolean } = {}): {
  html: string;
  cspNonce: string;
} {
  // Dijagnostički način: bez featureType pokreće se standardni Embedded Signup.
  // Služi samo da se utvrdi da li Meta blokira cijelu aplikaciju ili samo Coexistence.
  const coexistence = options.coexistence !== false;
  const { appId, configurationId } = requiredOnboardingConfig();
  const state = createState();
  const cspNonce = randomBytes(18).toString('base64url');
  const clientConfig = JSON.stringify({
    appId,
    configurationId,
    graphVersion: graphVersion(),
    state,
    coexistence,
  });

  return {
    cspNonce,
    html: `<!doctype html>
<html lang="bs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rezora — povezivanje WhatsApp Businessa</title>
  <style nonce="${cspNonce}">
    :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f7f5; color: #183128; }
    main { width: min(620px, calc(100% - 32px)); box-sizing: border-box; padding: 36px; border-radius: 20px; background: white; box-shadow: 0 18px 60px rgba(20,55,42,.12); }
    .brand { color: #158057; font-weight: 800; letter-spacing: .04em; }
    h1 { margin: 12px 0; font-size: clamp(26px, 5vw, 40px); line-height: 1.08; }
    p { line-height: 1.6; color: #496259; }
    button { width: 100%; margin-top: 18px; padding: 15px 20px; border: 0; border-radius: 12px; background: #1fae73; color: white; font-size: 17px; font-weight: 750; cursor: pointer; }
    button:disabled { opacity: .55; cursor: wait; }
    #status { margin-top: 18px; padding: 14px; border-radius: 10px; background: #eef7f3; color: #285c49; }
    .warning { font-size: 14px; }
    .diag { padding: 12px 14px; border-radius: 10px; background: #fff4e5; color: #8a4b00; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <div class="brand">REZORA</div>
    <h1>Poveži WhatsApp Business</h1>
${
  coexistence
    ? `    <p>Ovaj postupak koristi službeni Meta Embedded Signup i zadržava postojeći broj u WhatsApp Business aplikaciji.</p>
    <p class="warning"><strong>Važno:</strong> u Meta prozoru biraj povezivanje postojećeg WhatsApp Business broja. Nemoj birati klasičnu migraciju.</p>`
    : `    <p class="diag"><strong>DIJAGNOSTIČKI NAČIN</strong> — standardni Embedded Signup, bez Coexistencea.
    Služi samo da vidimo dokle Meta pusti prozor.</p>
    <p class="warning"><strong>STANI I ZATVORI PROZOR</strong> čim vidiš bilo koji ekran koji traži izbor broja,
    kreiranje WhatsApp naloga ili unos telefona. Ništa ne potvrđuj. Ne želimo migrirati broj.</p>`
}
    <button id="connect" type="button" disabled>Učitavanje Mete…</button>
    <div id="status" role="status">Pripremamo sigurno povezivanje.</div>
  </main>
  <script nonce="${cspNonce}">
    const cfg = ${clientConfig};
    const button = document.getElementById('connect');
    const statusBox = document.getElementById('status');
    let authCode = null;
    let sessionInfo = null;
    let completing = false;

    function status(message) { statusBox.textContent = message; }

    async function completeIfReady() {
      if (completing || !authCode || !sessionInfo) return;
      completing = true;
      button.disabled = true;
      status('Meta je potvrdila broj. Završavamo povezivanje s Rezorom…');
      try {
        const response = await fetch('/api/v1/meta/onboarding/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            state: cfg.state,
            code: authCode,
            waba_id: sessionInfo.waba_id,
            phone_number_id: sessionInfo.phone_number_id
          })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || 'Povezivanje nije završeno.');
        status('✅ Broj ' + (body.display_phone_number || '') + ' je povezan s Rezorom.');
        button.textContent = 'Povezano';
      } catch (error) {
        completing = false;
        button.disabled = false;
        button.textContent = 'Pokušaj ponovo';
        status('❌ ' + (error instanceof Error ? error.message : 'Povezivanje nije uspjelo.'));
      }
    }

    window.addEventListener('message', (event) => {
      if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return;
      if (typeof event.data !== 'string') return;
      try {
        const data = JSON.parse(event.data);
        if (data.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (
          data.event === 'FINISH' ||
          data.event === 'FINISH_ONLY_WABA' ||
          data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'
        ) {
          sessionInfo = data.data;
          void completeIfReady();
        } else if (data.event === 'CANCEL') {
          status('Povezivanje je prekinuto. Možeš pokušati ponovo.');
        }
      } catch { /* Facebook šalje i druge poruke koje nisu JSON. */ }
    });

    window.fbAsyncInit = function () {
      FB.init({ appId: cfg.appId, cookie: true, xfbml: false, version: cfg.graphVersion });
      button.disabled = false;
      button.textContent = 'Poveži WhatsApp Business';
      status('Spremno. Klikni dugme za službeni Meta postupak.');
    };

    button.addEventListener('click', () => {
      button.disabled = true;
      status('Otvaramo sigurni Meta prozor…');
      FB.login((response) => {
        if (response.authResponse?.code) {
          authCode = response.authResponse.code;
          void completeIfReady();
        } else {
          button.disabled = false;
          status('Prijava nije završena. Klikni dugme i pokušaj ponovo.');
        }
      }, {
        config_id: cfg.configurationId,
        response_type: 'code',
        override_default_response_type: true,
        extras: cfg.coexistence
          ? { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' }
          : { setup: {}, sessionInfoVersion: '3' }
      });
    });
  </script>
  <script nonce="${cspNonce}" async defer crossorigin="anonymous" src="https://connect.facebook.net/bs_BA/sdk.js"></script>
</body>
</html>`,
  };
}

export async function completeMetaOnboarding(input: MetaOnboardingInput): Promise<{
  channel_id: string;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string;
  verified_name: string;
}> {
  const { appId } = requiredOnboardingConfig();
  if (!consumeState(input.state)) {
    throw new Error('Onboarding sesija je istekla. Osvježi stranicu i pokušaj ponovo.');
  }
  if (!config.META_APP_SECRET) throw new Error('META_APP_SECRET nije konfigurisan.');

  const tokenParams = new URLSearchParams({
    client_id: appId,
    client_secret: config.META_APP_SECRET,
    code: input.code,
  });
  const tokenResponse = await metaRequest<TokenResponse>(
    `https://graph.facebook.com/${graphVersion()}/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams,
    },
  );
  if (!tokenResponse.access_token) throw new Error('Meta nije vratila pristupni token.');
  const accessToken = tokenResponse.access_token;
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  const [waba, phone] = await Promise.all([
    metaRequest<WabaResponse>(
      `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(input.waba_id)}?fields=id,name`,
      { method: 'GET', headers: authHeaders },
    ),
    metaRequest<PhoneResponse>(
      `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(input.phone_number_id)}?fields=id,display_phone_number,verified_name`,
      { method: 'GET', headers: authHeaders },
    ),
  ]);

  if (waba.id !== input.waba_id || phone.id !== input.phone_number_id) {
    throw new Error('Meta je vratila podatke koji se ne podudaraju s odabranim računom.');
  }

  await metaRequest<MetaErrorBody>(
    `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(input.waba_id)}/subscribed_apps`,
    { method: 'POST', headers: authHeaders },
  );

  const phoneNumber = phone.display_phone_number ?? '';
  const metadata = JSON.stringify({
    coexistence: true,
    onboarding: 'embedded_signup',
    onboarded_at: new Date().toISOString(),
  });
  const existing = await query<{ id: string }>(
    `SELECT id FROM channels
      WHERE tenant_id = $1 AND type = 'whatsapp_cloud'
        AND (external_phone_number_id = $2 OR external_account_id = $3)
      ORDER BY (external_phone_number_id = $2) DESC
      LIMIT 1`,
    [config.QR_TENANT_ID, input.phone_number_id, input.waba_id],
  );

  let channelId = existing[0]?.id;
  if (channelId) {
    await query(
      `UPDATE channels
        SET name = $2, phone_number = $3, external_account_id = $4,
            external_phone_number_id = $5, status = 'active',
            configuration = configuration || $6::jsonb, updated_at = now()
        WHERE id = $1`,
      [
        channelId,
        `${phone.verified_name ?? waba.name ?? 'Rezora'} Meta Cloud kanal`,
        phoneNumber.replace(/\s+/g, ''),
        input.waba_id,
        input.phone_number_id,
        metadata,
      ],
    );
  } else {
    const inserted = await query<{ id: string }>(
      `INSERT INTO channels (
         tenant_id, type, name, phone_number, external_account_id,
         external_phone_number_id, primary_outbound, status, configuration
       ) VALUES ($1, 'whatsapp_cloud', $2, $3, $4, $5, true, 'active', $6::jsonb)
       RETURNING id`,
      [
        config.QR_TENANT_ID,
        `${phone.verified_name ?? waba.name ?? 'Rezora'} Meta Cloud kanal`,
        phoneNumber.replace(/\s+/g, ''),
        input.waba_id,
        input.phone_number_id,
        metadata,
      ],
    );
    channelId = inserted[0]?.id;
  }

  if (!channelId) throw new Error('Meta kanal nije mogao biti spremljen.');

  // Token vrijedi 60 dana prema odabranoj Meta konfiguraciji. Držimo ga samo
  // u memoriji procesa; trajno spremanje radi se kroz secrets manager u produkciji.
  config.META_ACCESS_TOKEN = accessToken;

  return {
    channel_id: channelId,
    waba_id: input.waba_id,
    phone_number_id: input.phone_number_id,
    display_phone_number: phoneNumber,
    verified_name: phone.verified_name ?? waba.name ?? '',
  };
}
