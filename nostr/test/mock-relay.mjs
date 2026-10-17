// Mock de relay Nostr para tests: implementa EVENT/REQ/CLOSE/EOSE/OK
// con filtros (ids, authors, kinds, since, until, limit, #p, #e).
import { WebSocketServer } from 'ws';

function matchTag(ev, name, values) {
  return ev.tags.some((t) => t[0] === name && values.includes(t[1]));
}
function matchFilter(ev, f) {
  if (f.ids && !f.ids.some((p) => ev.id.startsWith(p))) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.since && ev.created_at < f.since) return false;
  if (f.until && ev.created_at > f.until) return false;
  for (const k of Object.keys(f)) {
    if (k.startsWith('#') && k.length === 2) {
      if (!matchTag(ev, k[1], f[k])) return false;
    }
  }
  return true;
}

export function startMockRelay(port) {
  const stored = [];
  const allSubs = new Map(); // subId -> { ws, filters }
  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws) => {
    ws.on('close', () => {
      for (const [id, s] of allSubs) if (s.ws === ws) allSubs.delete(id);
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!Array.isArray(msg)) return;
      const [type, ...rest] = msg;
      if (type === 'EVENT') {
        const [ev] = rest;
        // validación mínima
        if (!ev || !ev.id || !ev.pubkey || typeof ev.kind !== 'number') {
          ws.send(JSON.stringify(['OK', ev?.id || '', false, 'invalid: evento malformado']));
          return;
        }
        if (ev.kind < 20000 || ev.kind > 29999) {
          if (!stored.some((s) => s.id === ev.id)) stored.push(ev);
        }
        ws.send(JSON.stringify(['OK', ev.id, true, '']));
        for (const [, s] of allSubs) {
          if (s.ws.readyState === 1 && s.filters.some((f) => matchFilter(ev, f))) {
            s.ws.send(JSON.stringify(['EVENT', s.subId, ev]));
          }
        }
      } else if (type === 'REQ') {
        const [subId, ...filters] = rest;
        allSubs.set(subId, { ws, subId, filters });
        const matched = [];
        for (const f of filters) {
          const hits = stored.filter((ev) => matchFilter(ev, f))
            .sort((a, b) => b.created_at - a.created_at);
          const lim = f.limit || 500;
          for (const ev of hits.slice(0, lim)) {
            if (!matched.some((m) => m.id === ev.id)) matched.push(ev);
          }
        }
        for (const ev of matched) ws.send(JSON.stringify(['EVENT', subId, ev]));
        ws.send(JSON.stringify(['EOSE', subId]));
      } else if (type === 'CLOSE') {
        allSubs.delete(rest[0]);
      }
    });
  });
  return { wss, stored };
}
