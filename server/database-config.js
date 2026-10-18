import { config } from './config.js';

export const usesSharedDatabase = process.env.SHARED_DATABASE === '1';
export const databaseURL = config.DATABASE_URL.trim();
export const spotsTable = usesSharedDatabase ? 'public.spots' : 'city.spots';
