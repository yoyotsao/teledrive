/**
 * Playwright globalSetup — authenticates with the running backend and writes
 * storageState.json so upload_perf.spec.ts starts already logged in.
 *
 * Reads TELEGRAM_SESSION_STRING from:
 *   1. Environment variable TELEGRAM_SESSION_STRING
 *   2. ../../.env file  (repo root)
 */
import { chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readEnvFile(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = new URL(url);
    const req = http.request(
      { hostname: opts.hostname, port: opts.port, path: opts.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch { reject(new Error('Bad JSON: ' + raw.slice(0, 200))); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Convert Telethon StringSession (urlsafe base64, binary IP) to GramJS StringSession
 * (standard base64, string IP with length prefix).
 *
 * Telethon: '1' + urlsafe_b64( dc_id[1] + ip[4|16] + port[2BE] + auth_key[256] )
 * GramJS:   '1' + b64( dc_id[1] + addr_len[2BE] + addr[str] + port[2BE] + auth_key[256] )
 */
function telethonToGramJS(telethon: string): string {
  if (!telethon || telethon[0] !== '1') return telethon; // already GramJS or unknown
  const b64 = telethon.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const raw = Buffer.from(b64, 'base64');
  // layout: dc_id[1] + ip[4 or 16] + port[2] + auth_key[256]
  if (raw.length < 1 + 4 + 2 + 256) return telethon; // too short, pass through
  const auth_key = raw.slice(raw.length - 256);
  const port = raw.readUInt16BE(raw.length - 258);
  const ip_bytes = raw.slice(1, raw.length - 258);
  const dc_id = raw[0];

  let ip_str: string;
  if (ip_bytes.length === 4) {
    ip_str = Array.from(ip_bytes).join('.');
  } else {
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2)
      groups.push(((ip_bytes[i] << 8) | ip_bytes[i + 1]).toString(16));
    ip_str = groups.join(':');
  }

  const ip_buf = Buffer.from(ip_str, 'utf-8');
  const out = Buffer.allocUnsafe(1 + 2 + ip_buf.length + 2 + 256);
  out[0] = dc_id;
  out.writeUInt16BE(ip_buf.length, 1);
  ip_buf.copy(out, 3);
  out.writeUInt16BE(port, 3 + ip_buf.length);
  auth_key.copy(out, 5 + ip_buf.length);
  return '1' + out.toString('base64');
}

export default async function globalSetup() {
  const envVars = readEnvFile(path.resolve(__dirname, '../../.env'));
  const rawSession = process.env.TELEGRAM_SESSION_STRING ?? envVars['TELEGRAM_SESSION_STRING'];
  if (!rawSession) {
    console.warn('[auth-setup] TELEGRAM_SESSION_STRING not found — tests will be skipped if login is needed');
    return;
  }
  // .env holds a Telethon session; login endpoint expects GramJS format
  const sessionString = telethonToGramJS(rawSession.trim());

  console.log('[auth-setup] Logging in via backend…');
  const resp = await postJson('http://localhost:8000/api/v1/auth/login', { session_string: sessionString }) as any;
  const jwt: string = resp?.token;
  if (!jwt) throw new Error('[auth-setup] Login failed: ' + JSON.stringify(resp).slice(0, 200));

  // Write storageState with tg_session + tg_jwt injected
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('http://localhost:3000');
  await page.evaluate(
    ({ sess, token }: { sess: string; token: string }) => {
      localStorage.setItem('tg_session', sess);
      localStorage.setItem('tg_jwt', token);
    },
    { sess: sessionString, token: jwt }
  );
  const stateFile = path.join(__dirname, 'storageState.json');
  await ctx.storageState({ path: stateFile });
  await browser.close();
  console.log('[auth-setup] storageState saved →', stateFile);
}
