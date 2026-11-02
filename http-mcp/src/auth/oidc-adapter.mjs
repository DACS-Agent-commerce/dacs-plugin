// oidc-provider storage adapter over the plugin's SQLite database, so
// authorization codes, grants, sessions, registered clients and refresh tokens
// survive restart. Implements the adapter contract documented by oidc-provider
// (upsert/find/findByUid/findByUserCode/consume/destroy/revokeByGrantId).
const GRANTABLE = new Set([
  'AccessToken',
  'AuthorizationCode',
  'RefreshToken',
  'DeviceCode',
  'BackchannelAuthenticationRequest',
]);

export function createSqliteAdapter(db, now = () => Date.now()) {
  const upsert = db.prepare(`INSERT INTO oidc_models (model, id, payload, grant_id, user_code, uid, expires_at, consumed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT (model, id) DO UPDATE SET payload = excluded.payload, grant_id = excluded.grant_id,
      user_code = excluded.user_code, uid = excluded.uid, expires_at = excluded.expires_at`);
  const findById = db.prepare('SELECT payload, expires_at, consumed_at FROM oidc_models WHERE model = ? AND id = ?');
  const findByUid = db.prepare('SELECT payload, expires_at, consumed_at FROM oidc_models WHERE model = ? AND uid = ?');
  const findByUserCode = db.prepare('SELECT payload, expires_at, consumed_at FROM oidc_models WHERE model = ? AND user_code = ?');
  const consume = db.prepare('UPDATE oidc_models SET consumed_at = ? WHERE model = ? AND id = ? AND consumed_at IS NULL');
  const destroy = db.prepare('DELETE FROM oidc_models WHERE model = ? AND id = ?');
  const revokeByGrant = db.prepare('DELETE FROM oidc_models WHERE grant_id = ?');
  const purge = db.prepare('DELETE FROM oidc_models WHERE expires_at IS NOT NULL AND expires_at < ?');

  function materialize(row) {
    if (!row) return undefined;
    const nowSeconds = Math.floor(now() / 1000);
    if (row.expires_at != null && row.expires_at <= nowSeconds) return undefined;
    const payload = JSON.parse(row.payload);
    if (row.consumed_at != null) payload.consumed = row.consumed_at;
    return payload;
  }

  return class SqliteOidcAdapter {
    constructor(model) {
      this.model = model;
    }

    async upsert(id, payload, expiresIn) {
      const expiresAt = expiresIn ? Math.floor(now() / 1000) + expiresIn : null;
      upsert.run(
        this.model,
        id,
        JSON.stringify(payload),
        GRANTABLE.has(this.model) || this.model === 'Grant' ? (payload.grantId ?? null) : null,
        payload.userCode ?? null,
        payload.uid ?? null,
        expiresAt,
      );
    }

    async find(id) {
      return materialize(findById.get(this.model, id));
    }

    async findByUid(uid) {
      return materialize(findByUid.get(this.model, uid));
    }

    async findByUserCode(userCode) {
      return materialize(findByUserCode.get(this.model, userCode));
    }

    async consume(id) {
      consume.run(Math.floor(now() / 1000), this.model, id);
    }

    async destroy(id) {
      destroy.run(this.model, id);
    }

    async revokeByGrantId(grantId) {
      revokeByGrant.run(grantId);
    }

    static purgeExpired() {
      purge.run(Math.floor(now() / 1000));
    }
  };
}
