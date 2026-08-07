'use strict';
const { q } = require('./db');
const { clientIp } = require('./util');

/**
 * Append an audit row. Never throws into the request path — a failed audit write
 * is logged loudly but must not roll back the user's action.
 */
async function audit(req, { action, entity, entityId, summary, before, after }) {
  const actor = req?.user || req?.device || null;
  const actorType = req?.user ? 'user' : req?.device ? 'device' : 'system';
  try {
    await q(
      `INSERT INTO audit_log (actor_type, actor_id, actor_name, action, entity, entity_id, summary, before, after, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        actorType,
        actor?.id || null,
        actor?.name || null,
        action,
        entity || null,
        entityId || null,
        summary,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        req ? clientIp(req) : null,
      ]
    );
  } catch (e) {
    console.error('[audit] failed to write entry', action, e.message);
  }
}

module.exports = { audit };
