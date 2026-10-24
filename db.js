import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// SQLite-Datei: auf Render liegt sie auf der (laufzeit-persistenten) Instanz-Platte.
// Während eine Runde aktiv gespielt wird, hält der Dienst die Daten; dauerhafte
// Persistenz über Neustarts/Deploys hinweg bräuchte eine externe DB oder ein Render-Disk.
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'party-bingo.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  admin_token  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'lobby',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at     TEXT
);
CREATE TABLE IF NOT EXISTS players (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL,
  token       TEXT NOT NULL,
  name        TEXT NOT NULL,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(code, token)
);
CREATE TABLE IF NOT EXISTS cells (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  INTEGER NOT NULL,
  idx        INTEGER NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  UNIQUE(player_id, idx)
);
CREATE TABLE IF NOT EXISTS marks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   INTEGER NOT NULL,
  idx         INTEGER NOT NULL,
  image       BLOB,
  mime        TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(player_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_players_code ON players(code);
CREATE INDEX IF NOT EXISTS idx_cells_player ON cells(player_id);
CREATE INDEX IF NOT EXISTS idx_marks_player ON marks(player_id);
`;

export function initDb() {
  db.exec(SCHEMA);
  console.log('[db] SQLite bereit:', DB_PATH);
}

// kleine Helfer (synchron – node:sqlite ist synchron)
export const get = (sql, params = []) => db.prepare(sql).get(...params);
export const all = (sql, params = []) => db.prepare(sql).all(...params);
export const run = (sql, params = []) => db.prepare(sql).run(...params);
