// Shared activity log, used by every module's write endpoints to record what
// happened, and read by the Dashboard/Admin "Your activity" (level 1) and
// "In your area" (level 2) inbox tabs - see mfpl-notifications-design.md.
//
// KV shapes, in ob_app_data (env.APP_DATA):
//   activity:{eventId}                              -> full event object (below)
//   idx:activity_by_role:{role}:{isoAt}:{eventId}    -> eventId
//   idx:activity_by_participant:{uid}:{isoAt}:{eventId} -> eventId
//
// The timestamp is embedded in the index key (not just the value) because KV
// list() is prefix-scoped only, not range-scoped (see schema doc) - encoding
// an ISO-8601 timestamp in the key makes list() return entries in
// chronological order for free, and lets a 30-day cutoff be applied in app
// code after listing, rather than needing a KV-native range query.
//
// 'admin' is always added to an event's roles fan-out (the spec: "Admin
// covers all areas"), so admin's "in your area" read reuses the exact same
// by-role index as every other role instead of a separate code path.
//
// Never notify the acting user about their own change (spec rule): callers
// should exclude the actor's own uid from `participants` unless the actor is
// also a participant for an unrelated earlier reason (e.g. they created the
// record and are now seeing someone else's change to it - that's a *future*
// event's participant list, not this one).

import { getJSON, putJSON, safeKeyPart } from './kv.js';
import { randomId } from './crypto.js';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// event: {
//   recordType, recordId, so, title,
//   by: { uid, name, role },
//   changes: [{ field, from, to }],   // old -> new, for display
//   roles: [role, ...],               // level-2 audience (role map from the
//                                      // notifications doc), NOT including 'admin'
//   participants: [uid, ...],         // level-1 audience; exclude the actor
//   exceptions: boolean,              // true = shows in the admin exceptions filter
// }
export async function logEvent(appDataKv, event) {
  const id = randomId('evt');
  const at = new Date().toISOString();
  const full = { id, at, ...event };
  await putJSON(appDataKv, `activity:${id}`, full);

  const roles = Array.from(new Set([...(event.roles || []), 'admin']));
  for (const role of roles) {
    await appDataKv.put(`idx:activity_by_role:${safeKeyPart(role)}:${at}:${id}`, id);
  }
  for (const uid of event.participants || []) {
    await appDataKv.put(`idx:activity_by_participant:${safeKeyPart(uid)}:${at}:${id}`, id);
  }
  return full;
}

// Shared pagination/cutoff walk over an index prefix. EdgeOne's list() caps
// at 256 keys/page (schema doc) - we follow its cursor until either we run
// out of pages or hit an entry older than the cutoff (keys are chronological
// within a prefix, so we can stop early rather than paging through all of
// history every time).
async function listIndexEntries(appDataKv, prefix, sinceMs) {
  const ids = [];
  let cursor = undefined;
  let done = false;
  while (!done) {
    const page = await appDataKv.list({ prefix, cursor });
    for (const entry of page.keys) {
      // key: <prefix><isoAt>:<id> - isoAt is everything after the prefix up
      // to the last ':'.
      const rest = entry.name.slice(prefix.length);
      const sepIdx = rest.lastIndexOf(':');
      const isoAt = sepIdx === -1 ? null : rest.slice(0, sepIdx);
      const atMs = isoAt ? Date.parse(isoAt) : NaN;
      if (!Number.isNaN(atMs) && atMs < sinceMs) continue; // older than cutoff, skip
      ids.push(entry.name.slice(entry.name.lastIndexOf(':') + 1));
    }
    cursor = page.cursor;
    done = !page.hasMore || !cursor;
  }
  return ids;
}

async function hydrateEvents(appDataKv, ids) {
  const events = [];
  for (const id of ids) {
    const ev = await getJSON(appDataKv, `activity:${id}`);
    if (ev) events.push(ev);
  }
  // Newest first for display.
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events;
}

export async function listByRole(appDataKv, role, { sinceMs = Date.now() - RETENTION_MS } = {}) {
  const ids = await listIndexEntries(appDataKv, `idx:activity_by_role:${safeKeyPart(role)}:`, sinceMs);
  return hydrateEvents(appDataKv, ids);
}

export async function listByParticipant(appDataKv, uid, { sinceMs = Date.now() - RETENTION_MS } = {}) {
  const ids = await listIndexEntries(appDataKv, `idx:activity_by_participant:${safeKeyPart(uid)}:`, sinceMs);
  return hydrateEvents(appDataKv, ids);
}

export { RETENTION_MS };
