import { ClobClient, SignatureType } from '@polymarket/clob-client';
import type { ApiKeyCreds } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { logger } from '../reporting/logs';
import fs from 'fs';
import path from 'path';

let cachedClient: ClobClient | undefined;
let tradingAddresses = new Set<string>();
let initPromise: Promise<ClobClient> | undefined;

/** File where auto-derived API creds are cached (gitignored via .env.* rule). */
const CREDS_CACHE_FILE = path.resolve(process.cwd(), '.env.clob-creds');

/**
 * Build or return the singleton ClobClient used for LIVE order submission.
 *
 * Required env vars:
 *   POLYMARKET_PRIVATE_KEY          – Wallet private key (hex, with or without 0x prefix)
 *
 * Optional env vars (auto-derived from private key if absent):
 *   POLYMARKET_API_KEY              – CLOB API key
 *   POLYMARKET_API_SECRET           – CLOB API secret
 *   POLYMARKET_API_PASSPHRASE       – CLOB API passphrase
 *   POLYMARKET_FUNDER               – Polymarket profile (funder) address
 *   POLYMARKET_SIGNATURE_TYPE       – 0 = EOA (default), 1 = POLY_PROXY (Magic/email)
 *   POLYMARKET_CLOB_API             – CLOB host override (default https://clob.polymarket.com)
 *   POLYMARKET_CHAIN_ID             – 137 (Polygon, default) or 80002 (Amoy testnet)
 */
export async function getClobClient(clobApiOverride?: string): Promise<ClobClient> {
  if (cachedClient) return cachedClient;
  if (initPromise) return initPromise;

  initPromise = buildClient(clobApiOverride);
  try {
    cachedClient = await initPromise;
    return cachedClient;
  } finally {
    initPromise = undefined;
  }
}

async function buildClient(clobApiOverride?: string): Promise<ClobClient> {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      'POLYMARKET_PRIVATE_KEY is not set. LIVE trading requires an Ethereum private key for order signing.',
    );
  }

  const host = clobApiOverride ?? process.env.POLYMARKET_CLOB_API ?? 'https://clob.polymarket.com';

  const chainId = Number(process.env.POLYMARKET_CHAIN_ID ?? '137') as 137 | 80002;

  const sigTypeRaw = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? '0');
  const signatureType: SignatureType =
    sigTypeRaw === 1
      ? SignatureType.POLY_PROXY
      : sigTypeRaw === 2
        ? SignatureType.POLY_GNOSIS_SAFE
        : SignatureType.EOA;

  const funderAddress = process.env.POLYMARKET_FUNDER;
  const signer = new Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);

  /* ── Resolve API credentials ── */
  let creds = loadCredsFromEnv() ?? loadCredsFromCache(signer.address);

  if (!creds) {
    logger.info('No CLOB API credentials found — deriving from private key…');
    const tempClient = new ClobClient(host, chainId, signer);
    creds = await tempClient.createOrDeriveApiKey();
    logger.info({ address: signer.address }, 'CLOB API credentials derived successfully');
    saveCreds(creds, signer.address);
  }

  const client = new ClobClient(host, chainId, signer, creds, signatureType, funderAddress);

  /* Addresses our orders are attributed to.  EOA signing makes the signer the
     maker; proxy/safe signing makes the funder the maker.  Collect both so
     maker-side fills can be matched back to us regardless of signature type. */
  tradingAddresses = new Set(
    [signer.address, funderAddress].filter((a): a is string => !!a).map((a) => a.toLowerCase()),
  );

  logger.info(
    {
      host,
      chainId,
      signerAddress: signer.address,
      funderAddress: funderAddress ?? '(none — EOA signing)',
      signatureType: SignatureType[signatureType],
    },
    'ClobClient initialised for LIVE trading',
  );

  if (signatureType !== SignatureType.EOA && !funderAddress) {
    logger.error(
      { signatureType: SignatureType[signatureType] },
      'Proxy/Safe signing selected but POLYMARKET_FUNDER is unset — maker fills cannot be attributed and reconciled positions will be wrong',
    );
  }

  return client;
}

/**
 * Addresses this bot's orders are attributed to, lowercased.  Populated when
 * the client is built.  Used to pick our own fills out of a match that
 * included other makers.
 */
export async function getTradingAddresses(clobApiOverride?: string): Promise<Set<string>> {
  await getClobClient(clobApiOverride);
  return new Set(tradingAddresses);
}

/* ── Credential helpers ── */

function loadCredsFromEnv(): ApiKeyCreds | undefined {
  const key = process.env.POLYMARKET_API_KEY;
  const secret = process.env.POLYMARKET_API_SECRET;
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE;
  if (key && secret && passphrase) return { key, secret, passphrase };
  return undefined;
}

function loadCredsFromCache(address: string): ApiKeyCreds | undefined {
  try {
    if (!fs.existsSync(CREDS_CACHE_FILE)) return undefined;
    const raw = JSON.parse(fs.readFileSync(CREDS_CACHE_FILE, 'utf8'));
    if (raw.address?.toLowerCase() !== address.toLowerCase()) {
      logger.info('Cached CLOB creds are for a different address — will re-derive');
      return undefined;
    }
    if (raw.key && raw.secret && raw.passphrase) {
      logger.info('Loaded CLOB API credentials from cache');
      return { key: raw.key, secret: raw.secret, passphrase: raw.passphrase };
    }
  } catch {
    /* corrupted file — ignore */
  }
  return undefined;
}

function saveCreds(creds: ApiKeyCreds, address: string): void {
  try {
    const data = JSON.stringify({ address, ...creds }, null, 2);
    fs.writeFileSync(CREDS_CACHE_FILE, data, { mode: 0o600 });
    logger.info({ path: CREDS_CACHE_FILE }, 'CLOB API credentials cached to disk');
  } catch (err) {
    logger.warn({ error: err }, 'Failed to cache CLOB creds to disk (non-fatal)');
  }
}

/** Reset the cached client (useful for tests). */
export function resetClobClient(): void {
  cachedClient = undefined;
  initPromise = undefined;
  tradingAddresses = new Set();
}
