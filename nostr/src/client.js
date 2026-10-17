// ChatApp Nostr — capa de transporte. Sin dependencias de DOM ni de red
// concretas: recibe el constructor WebSocket a usar (navegador o 'ws' en Node).
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip19,
  nip04,
} from 'nostr-tools';

export const KIND_DM = 4;          // mensaje directo (NIP-04, cifrado)
export const KIND_PROFILE = 0;     // perfil: {name}
export const KIND_PRESENCE = 24501;// "en línea" (efímero, no se guarda)
export const KIND_TYPING = 24502;  // "escribiendo…" (efímero)
export const KIND_RECEIPT = 24503; // confirmación de lectura (se guarda)

const EPHEMERAL_MIN = 20000, EPHEMERAL_MAX = 29999;

function randId(prefix) {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return prefix + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function createIdentity(name) {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  return { sk, pubkey, nsec: nip19.nsecEncode(sk), npub: nip19.npubEncode(pubkey), name };
}

export function importIdentity(nsec) {
  const { type, data } = nip19.decode(nsec.trim());
  if (type !== 'nsec') throw new Error('Eso no es una clave privada nsec.');
  const pubkey = getPublicKey(data);
  return { sk: data, pubkey, nsec: nip19.nsecEncode(data), npub: nip19.npubEncode(pubkey) };
}

export function pubkeyFromNpub(npub) {
  const { type, data } = nip19.decode(npub.trim());
  if (type !== 'npub') throw new Error('Eso no es un npub válido.');
  return data;
}

export class NostrClient {
  constructor({ relays, secretKey, WSImpl, onRelayStatus }) {
    this.relays = relays.slice();
    this.sk = secretKey;
    this.pubkey = getPublicKey(secretKey);
    this.WSImpl = WSImpl || WebSocket;
    this.onRelayStatus = onRelayStatus || (() => {});
    this.sockets = new Map();   // url -> {ws, status, queue:[], subs:Map}
    this.connected = 0;
  }

  status(url) { return (this.sockets.get(url) || {}).status || 'down'; }

  connect() {
    for (const url of this.relays) this._connectOne(url, 0);
  }

  _connectOne(url, attempt) {
    if (this.sockets.get(url)?.status === 'open') return;
    const entry = this.sockets.get(url) || { subs: new Map(), queue: [] };
    entry.status = 'connecting';
    this.sockets.set(url, entry);
    this.onRelayStatus(url, 'connecting');
    let ws;
    try {
      ws = new this.WSImpl(url);
    } catch {
      return this._scheduleReconnect(url, attempt);
    }
    entry.ws = ws;
    ws.onopen = () => {
      entry.status = 'open';
      this.onRelayStatus(url, 'open');
      for (const msg of entry.queue) ws.send(msg);
      entry.queue = [];
      for (const [subId, sub] of entry.subs) {
        ws.send(JSON.stringify(['REQ', subId, ...sub.filters]));
      }
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      this._handleRelayMessage(url, entry, msg);
    };
    ws.onclose = () => {
      if (entry.ws !== ws) return;
      entry.status = 'down';
      entry.ws = null;
      this.onRelayStatus(url, 'down');
      this._scheduleReconnect(url, attempt);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  _scheduleReconnect(url, attempt) {
    const delay = Math.min(30000, 2000 * Math.pow(1.5, attempt));
    setTimeout(() => {
      const e = this.sockets.get(url);
      if (e && e.status !== 'open') this._connectOne(url, attempt + 1);
    }, delay);
  }

  _send(url, arr) {
    const entry = this.sockets.get(url);
    const text = JSON.stringify(arr);
    if (entry?.status === 'open' && entry.ws) entry.ws.send(text);
    else if (entry) entry.queue.push(text);
  }

  _handleRelayMessage(url, entry, msg) {
    if (!Array.isArray(msg)) return;
    const [type, ...rest] = msg;
    if (type === 'EVENT') {
      const [subId, event] = rest;
      const cb = entry.subs.get(subId)?.cb;
      if (cb) cb(event, url);
    } else if (type === 'OK') {
      const [eventId, ok, reason] = rest;
      const pending = entry.pendingPubs?.get(eventId);
      if (pending) {
        entry.pendingPubs.delete(eventId);
        pending(ok === true ? null : new Error('relay rechazó: ' + (reason || 'desconocido')));
      }
    } else if (type === 'EOSE') {
      const [subId] = rest;
      const done = entry.subs.get(subId)?.onEose;
      if (done) done();
    }
  }

  // Publica un evento firmado en todos los relays. Resuelve cuando al menos
  // uno lo acepta (OK true). Rechaza si todos lo rechazan o hay timeout.
  publish(template, { timeoutMs = 12000 } = {}) {
    const event = finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...template }, this.sk);
    const payload = JSON.stringify(['EVENT', event]);
    const urls = this.relays;
    return new Promise((resolve, reject) => {
      let settled = 0, accepted = 0;
      const timer = setTimeout(() => finish(new Error('ningún relay respondió a tiempo')), timeoutMs);
      const finish = (err) => {
        clearTimeout(timer);
        for (const u of urls) this.sockets.get(u)?.pendingPubs?.delete(event.id);
        if (accepted > 0) resolve({ event, relays: accepted });
        else reject(err || new Error('todos los relays rechazaron el evento'));
      };
      for (const url of urls) {
        let entry = this.sockets.get(url);
        if (!entry) { this._connectOne(url, 0); entry = this.sockets.get(url); }
        entry.pendingPubs = entry.pendingPubs || new Map();
        entry.pendingPubs.set(event.id, (err) => {
          settled++;
          if (!err) accepted++;
          if (accepted > 0) finish();
          else if (settled === urls.length) finish(err);
        });
        if (entry.status === 'open' && entry.ws) entry.ws.send(payload);
        else entry.queue.push(payload);
      }
    });
  }

  // Suscribe filtros en todos los relays. onEvent(event, url). Devuelve {unsub, eose()}.
  subscribe(filters, onEvent) {
    const subId = randId('sub');
    const subs = { cb: onEvent, filters, onEose: null, eoseCount: 0, eoseResolve: null };
    for (const url of this.relays) {
      let entry = this.sockets.get(url);
      if (!entry) { this._connectOne(url, 0); entry = this.sockets.get(url); }
      entry.subs.set(subId, subs);
      if (entry.status === 'open' && entry.ws) {
        entry.ws.send(JSON.stringify(['REQ', subId, ...filters]));
      }
    }
    const origCb = subs.cb;
    return {
      unsub: () => {
        for (const url of this.relays) {
          const e = this.sockets.get(url);
          if (e?.subs.delete(subId) && e.status === 'open' && e.ws) {
            try { e.ws.send(JSON.stringify(['CLOSE', subId])); } catch {}
          }
        }
      },
      eose: () =>
        new Promise((resolve) => {
          subs.eoseResolve = resolve;
          subs.onEose = () => {
            subs.eoseCount++;
            if (subs.eoseCount >= this.relays.length && subs.eoseResolve) {
              const r = subs.eoseResolve; subs.eoseResolve = null; r();
            }
          };
          // relays ya conectados que no envíen EOSE: timeout de seguridad
          setTimeout(() => { if (subs.eoseResolve) { const r = subs.eoseResolve; subs.eoseResolve = null; r(); } }, 8000);
        }),
    };
  }

  // ---------- API de alto nivel ----------

  async sendDM(peerPubkey, text) {
    const content = await nip04.encrypt(this.sk, peerPubkey, text);
    return this.publish({ kind: KIND_DM, tags: [['p', peerPubkey]], content });
  }

  async decryptDM(event) {
    const peer = event.pubkey === this.pubkey
      ? (event.tags.find((t) => t[0] === 'p') || [])[1]
      : event.pubkey;
    if (!peer) throw new Error('DM sin contraparte');
    return nip04.decrypt(this.sk, peer, event.content);
  }

  publishProfile(name) {
    return this.publish({ kind: KIND_PROFILE, tags: [], content: JSON.stringify({ name }) });
  }

  async fetchProfile(pubkey) {
    return new Promise((resolve) => {
      let best = null;
      const sub = this.subscribe([{ kinds: [KIND_PROFILE], authors: [pubkey], limit: 1 }], (ev) => {
        if (!best || ev.created_at > best.created_at) best = ev;
      });
      sub.eose().then(() => {
        sub.unsub();
        if (!best) return resolve(null);
        try { resolve({ ...JSON.parse(best.content), _at: best.created_at }); }
        catch { resolve(null); }
      });
    });
  }

  sendPresence() {
    // efímero: no se guarda en relays, solo llega a quien esté conectado
    return this.publish({ kind: KIND_PRESENCE, tags: [], content: '' }).catch(() => {});
  }

  sendTyping(peerPubkey) {
    return this.publish({ kind: KIND_TYPING, tags: [['p', peerPubkey]], content: '' }).catch(() => {});
  }

  sendReceipt(peerPubkey, msgId, msgTs) {
    return this.publish({
      kind: KIND_RECEIPT,
      tags: [['p', peerPubkey], ['e', msgId]],
      content: String(msgTs),
    }).catch(() => {});
  }

  // Descarga historial de DMs y receipts. onEvent(event). Resuelve tras EOSE.
  async syncHistory(onEvent) {
    const filters = [
      { kinds: [KIND_DM], '#p': [this.pubkey], limit: 300 },
      { kinds: [KIND_DM], authors: [this.pubkey], limit: 300 },
      { kinds: [KIND_RECEIPT], '#p': [this.pubkey], limit: 300 },
    ];
    const sub = this.subscribe(filters, onEvent);
    await sub.eose();
    sub.unsub();
  }

  // Suscripción en vivo a DMs, receipts, typing y presencia.
  subscribeLive({ onDM, onReceipt, onTyping, onPresence }) {
    const since = Math.floor(Date.now() / 1000);
    return this.subscribe(
      [
        { kinds: [KIND_DM], '#p': [this.pubkey], since },
        { kinds: [KIND_RECEIPT], '#p': [this.pubkey], since },
        { kinds: [KIND_TYPING], '#p': [this.pubkey], since },
        { kinds: [KIND_PRESENCE], since },
      ],
      (ev) => {
        if (ev.kind === KIND_DM && onDM) onDM(ev);
        else if (ev.kind === KIND_RECEIPT && onReceipt) onReceipt(ev);
        else if (ev.kind === KIND_TYPING && onTyping) onTyping(ev);
        else if (ev.kind === KIND_PRESENCE && onPresence) onPresence(ev);
      }
    );
  }

  close() {
    for (const [, entry] of this.sockets) {
      try { entry.ws?.close(); } catch {}
      entry.status = 'down';
      entry.ws = null;
    }
  }
}
