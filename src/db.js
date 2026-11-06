let ready = false;
export async function ensureSchema(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, owner TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS snapshots (board_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (board_id, at))'),
  ]);
  ready = true;
}
