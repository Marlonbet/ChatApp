// Test de la capa Nostr contra el mock relay (sin internet).
import WebSocket from 'ws';
import { startMockRelay } from './mock-relay.mjs';
import { NostrClient, createIdentity, pubkeyFromNpub, KIND_DM } from '../src/client.js';

const { wss } = startMockRelay(3199);
const RELAYS = ['ws://127.0.0.1:3199'];
let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ana = createIdentity('Ana');
const luis = createIdentity('Luis');
check('identidades generadas (nsec/npub)', ana.nsec.startsWith('nsec1') && luis.npub.startsWith('npub1'));
check('npub decodifica al pubkey', pubkeyFromNpub(luis.npub) === luis.pubkey);

const cAna = new NostrClient({ relays: RELAYS, secretKey: ana.sk, WSImpl: WebSocket });
const cLuis = new NostrClient({ relays: RELAYS, secretKey: luis.sk, WSImpl: WebSocket });
cAna.connect(); cLuis.connect();
await wait(600);
check('relays conectados', cAna.status(RELAYS[0]) === 'open' && cLuis.status(RELAYS[0]) === 'open');

// perfil
await cAna.publishProfile('Ana Server');
await wait(300);
const prof = await cLuis.fetchProfile(ana.pubkey);
check('perfil kind 0 publicado y leído', prof?.name === 'Ana Server', JSON.stringify(prof));

// DM en vivo
let gotDM = null;
cLuis.subscribeLive({ onDM: (ev) => { gotDM = ev; } });
await wait(300);
const { event: dmEvent } = await cAna.sendDM(luis.pubkey, 'Hola Luis, por Nostr');
await wait(600);
check('Luis recibe el DM en vivo', !!gotDM && gotDM.id === dmEvent.id);
const plain = await cLuis.decryptDM(gotDM);
check('contenido cifrado y descifrable', plain === 'Hola Luis, por Nostr', plain);

// historial (nuevo cliente de Ana sincroniza)
const cAna2 = new NostrClient({ relays: RELAYS, secretKey: ana.sk, WSImpl: WebSocket });
cAna2.connect();
await wait(400);
const hist = [];
await cAna2.syncHistory((ev) => hist.push(ev));
check('syncHistory trae el DM', hist.some((e) => e.id === dmEvent.id), 'eventos=' + hist.length);

// respuesta + receipt
await cLuis.sendDM(ana.pubkey, '¡Recibido por Nostr!');
await wait(600);
let gotReceipt = null;
cAna.subscribeLive({ onReceipt: (ev) => { gotReceipt = ev; } });
await wait(300);
await cLuis.sendReceipt(ana.pubkey, dmEvent.id, dmEvent.created_at);
await wait(600);
check('Ana recibe confirmación de lectura', !!gotReceipt && gotReceipt.tags.some((t) => t[0] === 'e' && t[1] === dmEvent.id));

// presencia y typing (efímeros)
let gotPresence = null, gotTyping = null;
cAna.subscribeLive({ onPresence: (ev) => { gotPresence = ev; }, onTyping: (ev) => { gotTyping = ev; } });
await wait(300);
await cLuis.sendPresence();
await cLuis.sendTyping(ana.pubkey);
await wait(600);
check('Ana ve presencia de Luis', !!gotPresence && gotPresence.pubkey === luis.pubkey);
check('Ana ve "escribiendo" de Luis', !!gotTyping && gotTyping.pubkey === luis.pubkey);

// publicar en relay caído no cuelga para siempre (timeout), y funciona con 1 de 2
const cBad = new NostrClient({ relays: ['ws://127.0.0.1:3999', RELAYS[0]], secretKey: ana.sk, WSImpl: WebSocket });
cBad.connect();
await wait(400);
try {
  await cBad.publish({ kind: 4, tags: [['p', luis.pubkey]], content: 'x' }, { timeoutMs: 6000 });
  check('publica aunque un relay esté caído', true);
} catch (e) {
  check('publica aunque un relay esté caído', false, e.message);
}

// regresión: suscribirse ANTES de que abra la conexión (replay en onopen)
const cEarly = new NostrClient({ relays: RELAYS, secretKey: ana.sk, WSImpl: WebSocket });
cEarly.connect();
let earlyGot = null;
cEarly.subscribe([{ kinds: [KIND_DM], '#p': [ana.pubkey] }], (ev) => { earlyGot = ev; });
await cLuis.sendDM(ana.pubkey, 'mensaje temprano');
await wait(800);
check('DM recibido con sub pre-conexión (replay onopen)', !!earlyGot);
cEarly.close();
cAna.close(); cLuis.close(); cAna2.close(); cBad.close();
wss.close();
console.log(failures === 0 ? '\n🎉 NOSTR CLIENT TODO OK' : `\n💥 ${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
