// Test de la UI Nostr compilada (dist/chatapp-nostr.html) contra el mock relay.
// Simula el archivo abierto en el navegador del teléfono (file://-like).
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';
import { readFileSync } from 'fs';
import { startMockRelay } from './mock-relay.mjs';

const { wss } = startMockRelay(3199);
const RELAYS = ['ws://127.0.0.1:3199'];
const html = readFileSync(new URL('../dist/chatapp-nostr.html', import.meta.url), 'utf8');

let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}
async function waitFor(fn, timeout = 20000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await fn()) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log('   ⏱ timeout: ' + label);
  return false;
}
function makePage(seed = {}) {
  return new Promise((resolve) => {
    const dom = new JSDOM(html, {
      url: 'https://chatapp.local/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(w) {
        w.WebSocket = WebSocket;
        if (seed.relays) w.localStorage.setItem('chatapp_nostr_relays', JSON.stringify(seed.relays));
        if (seed.nsec) w.localStorage.setItem('chatapp_nostr_nsec', seed.nsec);
      },
    });
    setTimeout(() => resolve({ dom, document: dom.window.document, window: dom.window }), 1200);
  });
}
const visible = (el) => el && !el.hidden;
function click(el) { el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true })); }

// ---- Ana crea su identidad ----
const ana = await makePage({ relays: RELAYS });
check('pantalla de identidad visible', await waitFor(() => visible(ana.document.getElementById('view-identity')), 15000, 'identity'));
ana.document.getElementById('id-name').value = 'Ana';
click(ana.document.getElementById('btn-create-id'));
check('Ana crea identidad y entra', await waitFor(() => visible(ana.document.getElementById('view-main')), 20000, 'main'));
check('relay conectado (● 1 relay)', await waitFor(() => ana.document.getElementById('relay-status').textContent.includes('1 relay'), 15000, 'relay status'));
const anaNpub = ana.document.getElementById('my-npub').textContent;
check('Ana tiene npub', anaNpub.startsWith('npub1'), anaNpub.slice(0, 20));

// ---- Luis crea su identidad ----
const luis = await makePage({ relays: RELAYS });
luis.document.getElementById('id-name').value = 'Luis';
click(luis.document.getElementById('btn-create-id'));
await waitFor(() => visible(luis.document.getElementById('view-main')), 20000, 'luis main');
const luisNpub = luis.document.getElementById('my-npub').textContent;

// ---- Ana abre chat con el npub de Luis ----
click(ana.document.getElementById('fab-new'));
await waitFor(() => visible(ana.document.getElementById('modal-new')), 10000, 'modal');
ana.document.getElementById('peer-npub').value = luisNpub;
click(ana.document.getElementById('btn-open-chat'));
check('chat abierto con Luis', await waitFor(() => visible(ana.document.getElementById('chat-active')), 15000, 'chat activo'));

// ---- Ana envía → Luis lo ve en su lista y lo abre ----
ana.document.getElementById('msg-input').value = 'Hola por Nostr';
ana.document.getElementById('composer').dispatchEvent(new ana.window.Event('submit', { bubbles: true, cancelable: true }));
const luisSeesChat = await waitFor(() => luis.document.querySelectorAll('.chat-item').length > 0, 20000, 'chat en lista de Luis');
check('el chat llega a la lista de Luis', luisSeesChat);
if (luisSeesChat) {
  click(luis.document.querySelector('.chat-item'));
  const ok = await waitFor(() => {
    const msgs = luis.document.querySelectorAll('#messages .msg.them');
    return msgs.length > 0 && msgs[msgs.length - 1].textContent.includes('Hola por Nostr');
  }, 20000, 'DM de Ana en Luis');
  check('Luis lee el mensaje cifrado', ok);
}

// ---- Luis responde → Ana recibe en el chat abierto ----
luis.document.getElementById('msg-input').value = '¡Recibido sin servidores!';
luis.document.getElementById('composer').dispatchEvent(new luis.window.Event('submit', { bubbles: true, cancelable: true }));
const anaGotReply = await waitFor(() => {
  const msgs = ana.document.querySelectorAll('#messages .msg.them');
  return msgs.length > 0 && msgs[msgs.length - 1].textContent.includes('¡Recibido sin servidores!');
}, 20000, 'respuesta en Ana');
check('Ana recibe la respuesta en tiempo real', anaGotReply);

// ---- ✓✓ : Luis abrió el chat → Ana debe ver lectura ----
const readTick = await waitFor(() => ana.document.querySelectorAll('#messages .msg.me .tick.read').length > 0, 20000, 'tick leído');
check('Ana ve ✓✓ (Luis leyó)', readTick);

// ---- presencia: Luis hace heartbeat → Ana lo ve "en línea" ----
const online = await waitFor(() => ana.document.getElementById('peer-status').textContent === 'en línea', 40000, 'presencia');
check('Ana ve a Luis "en línea"', online);

// ---- persistencia: Ana "reinicia" (misma nsec) y recupera el chat ----
const anaNsec = ana.window.localStorage.getItem('chatapp_nostr_nsec');
const ana2 = await makePage({ relays: RELAYS, nsec: anaNsec });
const restored = await waitFor(() => {
  return visible(ana2.document.getElementById('view-main')) &&
    ana2.document.querySelectorAll('.chat-item').length > 0;
}, 25000, 'sesión restaurada');
check('al reabrir, identidad y chats se restauran', restored);
if (restored) {
  click(ana2.document.querySelector('.chat-item'));
  const histOk = await waitFor(() => ana2.document.querySelectorAll('#messages .msg').length >= 2, 20000, 'historial');
  check('el historial del relay se carga', histOk);
}

wss.close();
console.log(failures === 0 ? '\n🎉 UI NOSTR TODO OK' : `\n💥 ${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
