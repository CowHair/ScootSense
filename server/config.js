import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Server-only application settings. Edit these values directly.
export const config = {
  "GOOGLE_CLIENT_ID": "",
  "AUTH_SECRET": "8e246e8e7de1737653804ecfa14abeb3bdbd5a0dba14c5634e0a6c74b47bc5f8",
  "INGEST_TOKEN": "",
  "SOLANA_SECRET_KEY": "",
  "SOLANA_MINT": "",
  "SOLANA_RPC": "",
  "CLOUDFLARE_ACCOUNT_ID": "",
  "CLOUDFLARE_API_TOKEN": "",
  "DATABASE_URL": "postgresql://tsdbadmin:f1yw5uphhnm4web9@abk85bd26s.phiratkahf.tsdb.cloud.timescale.com:36911/tsdb?sslmode=require",
  "PORT": "3000",
  "POTHOLE_G": "",
  "REVERSE_GEOCODER_URL": "",
  "GOOGLE_MAPS_EMBED_KEY": ""
};

// Only the standalone server entry point starts a listener.
export const isServerless = !process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(new URL('./index.js', import.meta.url));
