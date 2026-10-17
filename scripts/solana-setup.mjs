// One-time Solana devnet setup for ScootSense rewards.
//
//   npm run solana:setup
//
// 1. Creates the app's devnet wallet (SOLANA_SECRET_KEY in .env, never printed or committed).
// 2. Asks the devnet faucet for free test SOL to pay transaction fees.
// 3. Creates the SCOOT reward token (Token-2022 with its name and symbol stored on-chain) and
//    writes SOLANA_MINT to .env.
// Safe to run again: it reuses what already exists.
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction, clusterApiUrl } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, TYPE_SIZE, LENGTH_SIZE, getMintLen,
  createInitializeMetadataPointerInstruction, createInitializeMintInstruction,
} from '@solana/spl-token';
import { createInitializeInstruction, pack } from '@solana/spl-token-metadata';

const ENV = path.resolve(import.meta.dirname, '../.env');
const env = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
const get = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim();
const append = (k, v) => fs.appendFileSync(ENV, `${env.endsWith('\n') || !env ? '' : '\n'}${k}=${v}\n`);

const connection = new Connection(process.env.SOLANA_RPC || clusterApiUrl('devnet'), 'confirmed');

// 1. wallet
let secret = get('SOLANA_SECRET_KEY');
if (!secret) {
  secret = JSON.stringify([...Keypair.generate().secretKey]);
  append('SOLANA_SECRET_KEY', secret);
  console.log('Created the app wallet and saved its key to .env');
}
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
console.log('App wallet (public address):', payer.publicKey.toBase58());

// 2. test SOL for fees
let balance = await connection.getBalance(payer.publicKey);
if (balance < 0.2 * LAMPORTS_PER_SOL) {
  try {
    const sig = await connection.requestAirdrop(payer.publicKey, 1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');
    balance = await connection.getBalance(payer.publicKey);
  } catch (e) {
    console.log(`\nThe devnet faucet refused (${e.message.split('\n')[0]}).`);
    console.log('Get free devnet SOL at https://faucet.solana.com for the address above, then run this again.');
    process.exit(2);
  }
}
console.log('Balance:', balance / LAMPORTS_PER_SOL, 'devnet SOL');

// 3. SCOOT token
if (get('SOLANA_MINT')) {
  console.log('SCOOT token already exists:', get('SOLANA_MINT'));
  process.exit(0);
}
const mint = Keypair.generate();
const metadata = {
  mint: mint.publicKey,
  name: 'ScootSense Points',
  symbol: 'SCOOT',
  uri: 'https://scootsense.vercel.app/scoot-token.json',
  additionalMetadata: [],
};
const mintLen = getMintLen([ExtensionType.MetadataPointer]);
const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length);
const tx = new Transaction().add(
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
  createInitializeMetadataPointerInstruction(mint.publicKey, payer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
  createInitializeMintInstruction(mint.publicKey, 0, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
  createInitializeInstruction({
    programId: TOKEN_2022_PROGRAM_ID, mint: mint.publicKey, metadata: mint.publicKey,
    name: metadata.name, symbol: metadata.symbol, uri: metadata.uri,
    mintAuthority: payer.publicKey, updateAuthority: payer.publicKey,
  }),
);
const sig = await sendAndConfirmTransaction(connection, tx, [payer, mint]);
append('SOLANA_MINT', mint.publicKey.toBase58());
console.log('Created the SCOOT token:', mint.publicKey.toBase58());
console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);
