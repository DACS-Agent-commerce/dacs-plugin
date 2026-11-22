// Every row of every table in an app database, as one string, so a test can show a call changed nothing.
export function databaseRows(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => name);
  const rows = tables.map((name) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]);
  return JSON.stringify(rows, (_key, value) => (typeof value === 'bigint' ? String(value) : value));
}
