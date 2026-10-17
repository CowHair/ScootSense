// The ScootSense database in Tiger Data (PostgreSQL + TimescaleDB), organised by purpose:
//
//   accounts  who people are and what they keep: users, home stash, projects, trash list,
//             last known position, and their activity over time (hypertable)
//   sensing   what scooters measure: rides, every 0.5 s reading (hypertable), ESP32-CAM
//             devices and the litter alerts they raise
//   city      what the community has mapped: hazards, litter, and anonymous pickups
//   ml        the road classifier's labelled training data and trained models
//   app       settings and a change counter that keeps server instances in sync
//
// Everything is idempotent: safe to run on every cold start.

export const SCHEMAS = ['accounts', 'sensing', 'city', 'ml', 'app'];
export const SEARCH_PATH = `${SCHEMAS.join(', ')}, public`;

/** Tables created before the schemas existed, and where they now belong. */
const MOVES = {
  users: 'accounts', user_stash: 'accounts', user_projects: 'accounts', user_trash: 'accounts',
  user_presence: 'accounts', user_activity: 'accounts',
  ride_observations: 'sensing', cam_devices: 'sensing', trash_detections: 'sensing',
  litter: 'city',
};

const TABLES = [
  // ------------------------------------------------------------------ accounts
  `CREATE TABLE IF NOT EXISTS accounts.users (
     id text PRIMARY KEY,
     email text UNIQUE,
     name text NOT NULL,
     picture text,
     password_hash text,
     google_sub text UNIQUE,
     created_at timestamptz NOT NULL DEFAULT now(),
     last_login timestamptz)`,
  `CREATE TABLE IF NOT EXISTS accounts.user_stash (
     user_id text NOT NULL REFERENCES accounts.users(id) ON DELETE CASCADE,
     name text NOT NULL,
     material text,
     qty integer NOT NULL DEFAULT 1,
     PRIMARY KEY (user_id, name))`,
  `CREATE TABLE IF NOT EXISTS accounts.user_projects (
     id text PRIMARY KEY,
     user_id text NOT NULL REFERENCES accounts.users(id) ON DELETE CASCADE,
     data jsonb NOT NULL,
     origin text,
     saved_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS user_projects_user ON accounts.user_projects (user_id, saved_at DESC)`,
  `CREATE TABLE IF NOT EXISTS accounts.user_trash (
     id text PRIMARY KEY,
     user_id text NOT NULL REFERENCES accounts.users(id) ON DELETE CASCADE,
     time timestamptz NOT NULL DEFAULT now(),
     name text NOT NULL,
     material text,
     photo text,
     source text)`,
  `CREATE INDEX IF NOT EXISTS user_trash_user ON accounts.user_trash (user_id, time DESC)`,
  `CREATE TABLE IF NOT EXISTS accounts.user_presence (
     user_id text PRIMARY KEY,
     lat double precision NOT NULL,
     lng double precision NOT NULL,
     at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS accounts.user_activity (
     time timestamptz NOT NULL DEFAULT now(),
     user_id text NOT NULL,
     kind text NOT NULL,
     value double precision NOT NULL DEFAULT 1,
     meta jsonb)`,
  `CREATE INDEX IF NOT EXISTS user_activity_user ON accounts.user_activity (user_id, time DESC)`,

  // ------------------------------------------------------------------ sensing
  `CREATE TABLE IF NOT EXISTS sensing.rides (
     id text PRIMARY KEY,
     name text NOT NULL,
     source text,
     device text,
     user_id text,
     started_at timestamptz NOT NULL,
     ended_at timestamptz,
     distance_m double precision NOT NULL DEFAULT 0,
     observations integer NOT NULL DEFAULT 0,
     hazard_hits integer NOT NULL DEFAULT 0,
     avg_score real NOT NULL DEFAULT 0,
     summary text)`,
  `CREATE INDEX IF NOT EXISTS rides_user ON sensing.rides (user_id, started_at DESC)`,
  // One row per 0.5 s window of vibration (and air) data.
  `CREATE TABLE IF NOT EXISTS sensing.observations (
     time timestamptz NOT NULL,
     id text NOT NULL,
     ride_id text NOT NULL,
     t_ms bigint,
     lat double precision,
     lng double precision,
     speed real,
     pm25 real,
     label text NOT NULL,
     confidence real,
     model text,
     score smallint,
     features jsonb,
     UNIQUE (id, time))`,
  `CREATE INDEX IF NOT EXISTS observations_ride ON sensing.observations (ride_id, time)`,
  `CREATE INDEX IF NOT EXISTS observations_label ON sensing.observations (label, time DESC)`,
  // Older per-rider copy of readings (kept for history; new readings go to sensing.observations).
  `CREATE TABLE IF NOT EXISTS sensing.ride_observations (
     time timestamptz NOT NULL,
     user_id text,
     ride_id text NOT NULL,
     lat double precision,
     lng double precision,
     label text,
     score smallint,
     pm25 real,
     speed real)`,
  `CREATE TABLE IF NOT EXISTS sensing.cam_devices (
     device_id text PRIMARY KEY,
     user_id text REFERENCES accounts.users(id) ON DELETE SET NULL,
     linked_at timestamptz,
     last_frame_at timestamptz,
     last_frame text,
     last_result text)`,
  `CREATE TABLE IF NOT EXISTS sensing.trash_detections (
     id text PRIMARY KEY,
     user_id text NOT NULL,
     device_id text,
     time timestamptz NOT NULL DEFAULT now(),
     status text NOT NULL DEFAULT 'pending',
     items jsonb NOT NULL DEFAULT '[]',
     summary text,
     idea jsonb,
     photo text,
     lat double precision,
     lng double precision,
     litter_no integer,
     resolved_at timestamptz)`,
  `CREATE INDEX IF NOT EXISTS trash_detections_user ON sensing.trash_detections (user_id, status, time DESC)`,

  // ------------------------------------------------------------------ city
  `CREATE TABLE IF NOT EXISTS city.hazards (
     id text PRIMARY KEY,
     no integer UNIQUE NOT NULL,
     lat double precision NOT NULL,
     lng double precision NOT NULL,
     type text NOT NULL,
     severity smallint NOT NULL,
     max_score smallint NOT NULL,
     hits integer NOT NULL DEFAULT 0,
     ride_ids text[] NOT NULL DEFAULT '{}',
     first_seen timestamptz,
     last_seen timestamptz,
     status text NOT NULL DEFAULT 'unverified',
     votes jsonb NOT NULL DEFAULT '{"confirm":0,"dismiss":0}',
     photos jsonb NOT NULL DEFAULT '[]',
     notes jsonb NOT NULL DEFAULT '[]')`,
  `CREATE INDEX IF NOT EXISTS hazards_status ON city.hazards (status)`,
  // Photos riders took of a hazard (only kept when Gemini saw no faces or plates).
  `CREATE TABLE IF NOT EXISTS city.hazard_photos (
     id text PRIMARY KEY,
     hazard_id text NOT NULL,
     time timestamptz NOT NULL DEFAULT now(),
     mime text NOT NULL,
     image bytea NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS hazard_photos_hazard ON city.hazard_photos (hazard_id)`,
  `CREATE TABLE IF NOT EXISTS city.litter (
     no serial PRIMARY KEY,
     id text UNIQUE NOT NULL,
     lat double precision NOT NULL,
     lng double precision NOT NULL,
     items jsonb NOT NULL DEFAULT '[]',
     summary text,
     photo text,
     status text NOT NULL DEFAULT 'reported',
     reporter_id text,
     at timestamptz NOT NULL DEFAULT now(),
     last_seen timestamptz NOT NULL DEFAULT now(),
     cleared_at timestamptz,
     checks jsonb NOT NULL DEFAULT '[]')`,
  `CREATE INDEX IF NOT EXISTS litter_status ON city.litter (status)`,
  // Anonymous count of litter picked up (no location stored, by design).
  `CREATE TABLE IF NOT EXISTS city.pickups (
     seq serial PRIMARY KEY,
     time timestamptz NOT NULL DEFAULT now(),
     count integer NOT NULL DEFAULT 1,
     materials text[] NOT NULL DEFAULT '{}')`,

  // ------------------------------------------------------------------ ml
  `CREATE TABLE IF NOT EXISTS ml.training_samples (
     id text PRIMARY KEY,
     label text NOT NULL,
     recording_id text,
     features jsonb NOT NULL,
     source text,
     at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS training_label ON ml.training_samples (label)`,
  `CREATE TABLE IF NOT EXISTS ml.models (
     id serial PRIMARY KEY,
     model jsonb NOT NULL,
     trained_at timestamptz NOT NULL DEFAULT now(),
     active boolean NOT NULL DEFAULT true)`,

  // ------------------------------------------------------------------ app
  `CREATE TABLE IF NOT EXISTS app.settings (
     key text PRIMARY KEY,
     value jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now())`,
  // version bumps on every write; epoch bumps when readings are deleted (full reload needed).
  `CREATE TABLE IF NOT EXISTS app.meta (
     id boolean PRIMARY KEY DEFAULT true CHECK (id),
     version bigint NOT NULL DEFAULT 0,
     obs_epoch bigint NOT NULL DEFAULT 0)`,
  `INSERT INTO app.meta (id) VALUES (true) ON CONFLICT DO NOTHING`,
];

const HYPERTABLES = ['accounts.user_activity', 'sensing.observations', 'sensing.ride_observations'];

/** Create schemas, move legacy tables out of public, create everything, make hypertables. */
export async function migrate(query) {
  for (const s of SCHEMAS) await query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
  for (const [table, schema] of Object.entries(MOVES)) {
    const { rows } = await query(
      `SELECT (to_regclass('public.${table}') IS NOT NULL) AS legacy, (to_regclass('${schema}.${table}') IS NOT NULL) AS moved`);
    if (rows[0].legacy && !rows[0].moved) await query(`ALTER TABLE public.${table} SET SCHEMA ${schema}`);
  }
  for (const sql of TABLES) await query(sql);
  for (const t of HYPERTABLES) {
    try {
      await query(`SELECT create_hypertable('${t}', by_range('time'), if_not_exists => TRUE, migrate_data => TRUE)`);
    } catch {
      // Older TimescaleDB, or plain Postgres without the extension: keep a normal table.
      try { await query(`SELECT create_hypertable('${t}', 'time', if_not_exists => TRUE, migrate_data => TRUE)`); } catch {}
    }
  }
  // Compress readings older than a week (TimescaleDB columnstore); harmless to skip if unsupported.
  try {
    await query(`ALTER TABLE sensing.observations SET (timescaledb.compress, timescaledb.compress_segmentby = 'ride_id')`);
    await query(`SELECT add_compression_policy('sensing.observations', INTERVAL '7 days', if_not_exists => TRUE)`);
  } catch {}
}
