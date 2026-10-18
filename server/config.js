import { fileURLToPath } from 'node:url';
import path from 'node:path';

const KEYS = ['GOOGLE_CLIENT_ID', 'AUTH_SECRET', 'INGEST_TOKEN', 'SOLANA_SECRET_KEY', 'SOLANA_MINT', 'SOLANA_RPC',
  'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'DATABASE_URL', 'PORT', 'POTHOLE_G', 'REVERSE_GEOCODER_URL', 'GOOGLE_MAPS_EMBED_KEY'];

export const config = Object.fromEntries(KEYS.map((k) => [k, process.env[k] || '']));

export const isServerless = Boolean(process.env.VERCEL)
  || !process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(new URL('./index.js', import.meta.url));
