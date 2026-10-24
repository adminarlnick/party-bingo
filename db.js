import pg from 'pg';

const { Pool } = pg;

// Render stellt DATABASE_URL (intern, ohne SSL) bereit. Für externe/lokale
// Verbindungen DATABASE_SSL=true setzen.
const useSsl = process.env.DATABASE_SSL === 'true';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 8,
  idleTimeoutMillis: 30000,
});

export const q = (text, params) => pool.query(text, params);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  admin_token  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'lobby',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS players (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  name        TEXT NOT NULL,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(code, token)
);
CREATE TABLE IF NOT EXISTS cells (
  id         SERIAL PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  UNIQUE(player_id, idx)
);
CREATE TABLE IF NOT EXISTS marks (
  id          SERIAL PRIMARY KEY,
  player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  image       BYTEA,
  mime        TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(player_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_players_code ON players(code);
CREATE INDEX IF NOT EXISTS idx_cells_player ON cells(player_id);
CREATE INDEX IF NOT EXISTS idx_marks_player ON marks(player_id);
`;

export async function initDb() {
  await pool.query(SCHEMA);
  console.log('[db] Schema bereit');
}
