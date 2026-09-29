// db.js - opens the SQLite database file and creates the tables on first run.
const Database = require('better-sqlite3');

const db = new Database(process.env.DB_FILE || 'tracker.db');
db.pragma('journal_mode = WAL');   // safer when several people save at once
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS members (
    id     INTEGER PRIMARY KEY,
    name   TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    start_time    TEXT NOT NULL,          -- "HH:MM"
    end_time      TEXT NOT NULL,          -- "HH:MM"; end <= start means overnight
    break_minutes INTEGER NOT NULL DEFAULT 0,
    active        INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS categories (
    id     INTEGER PRIMARY KEY,
    name   TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
  );

  -- One row per task a person logs. expected_hours is copied from the shift
  -- when the row is saved, so editing a shift later doesn't rewrite history.
  CREATE TABLE IF NOT EXISTS entries (
    id             INTEGER PRIMARY KEY,
    member_id      INTEGER NOT NULL REFERENCES members(id),
    shift_date     TEXT NOT NULL,         -- date the shift STARTED, "YYYY-MM-DD"
    shift_id       INTEGER NOT NULL REFERENCES shifts(id),
    category       TEXT,
    task           TEXT,
    hours          REAL NOT NULL,
    expected_hours REAL NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(shift_date);
`);

// First run only: put in starter data so the app isn't empty.
// Change these from the Settings screen once it's running.
if (db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n === 0) {
  const seed = db.transaction(() => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('teamName', 'My Team'), ('targetPct', '85')").run();
    const addShift = db.prepare('INSERT INTO shifts (name, start_time, end_time, break_minutes) VALUES (?, ?, ?, ?)');
    addShift.run('General', '01:00', '10:00', 60);
    addShift.run('Night', '21:00', '06:00', 60);
    const addCat = db.prepare('INSERT INTO categories (name) VALUES (?)');
    ['Project work', 'Support', 'Tickets','Meetings', 'Admin'].forEach(c => addCat.run(c));
  });
  seed();
}

module.exports = db;
