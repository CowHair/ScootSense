import { config } from './config.js';

export const usesSharedDatabase = true;
export const databaseURL = config.DATABASE_URL.trim();
