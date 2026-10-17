// Test de integración del FRONTEND real (public/) contra el servidor real.
// Usa jsdom para el DOM y el paquete 'ws' para WebSocket real.
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:3100';
let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}
async function waitFor(fn, timeout = 15000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await fn()) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log('   ⏱ timeout esperando: ' + label);
  return false;
}

async function makePage() {
  const dom = await JSDOM.fromURL(BASE + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.WebSocket = WebSocket;
      // Node fetch no resuelve URLs relativas: resolver contra BASE como haría el navegador
      window.fetch = (url, opts) => globalThis.fetch(new URL(url, BASE).href, opts);
    },
  });
  const { document } = dom.window;
  await waitFor(() => document.getElementById('view-auth') !== null, 10000, 'DOM listo');
  await new Promise((r) => setTimeout(r, 800)); // scripts
  return { dom, document, window: dom.window };
}
function setVal(doc, id, v) {
  const el = doc.getElementById(id);
  el.value = v;
  el.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
}
function submit(doc, id) {
  doc.getElementById(id).dispatchEvent(new doc.defaultView.Event('submit', { bubbles: true, cancelable: true }));
}
function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
}
const visible = (el) => el && !el.hidden;

// ---- Ana ----
const ana = await makePage();
setVal(ana.document, 'reg-name', 'Ana Server');
setVal(ana.document, 'reg-email', 'ana@chatapp.local');
setVal(ana.document, 'reg-pass', 'Test123456');
ana.document.getElementById('tab-register').click();
submit(ana.document, 'form-register');
check('Ana se registra y entra', await waitFor(() => visible(ana.document.getElementById('view-main')), 15000, 'Ana en main'));

// ---- Luis ----
const luis = await makePage();
setVal(luis.document, 'reg-name', 'Luis Server');
setVal(luis.document, 'reg-email', 'luis@chatapp.local');
setVal(luis.document, 'reg-pass', 'Test123456');
luis.document.getElementById('tab-register').click();
submit(luis.document, 'form-register');
check('Luis se registra y entra', await waitFor(() => visible(luis.document.getElementById('view-main')), 15000, 'Luis en main'));

// ---- Ana busca a Luis y abre el chat ----
click(ana.document.getElementById('fab-new'));
setVal(ana.document, 'user-search', 'luis@chatapp.local');
const found = await waitFor(() => ana.document.querySelectorAll('.user-row').length > 0, 15000, 'resultado de búsqueda');
check('Ana encuentra a Luis en el buscador', found);
if (found) {
  click(ana.document.querySelector('.user-row'));
  check('el chat se abre al tocar el resultado', await waitFor(() => visible(ana.document.getElementById('chat-active')), 15000, 'chat activo'));
  const peerName = ana.document.getElementById('peer-name').textContent;
  check('cabecera muestra "Luis Server"', peerName === 'Luis Server', 'peer=' + peerName);
}

// ---- Ana envía, Luis recibe en tiempo real ----
setVal(ana.document, 'msg-input', 'Hola desde el servidor propio');
submit(ana.document, 'composer');
const luisGotChat = await waitFor(() => luis.document.querySelectorAll('.chat-item').length > 0, 15000, 'chat en lista de Luis');
check('el chat aparece en la lista de Luis', luisGotChat);
if (luisGotChat) {
  click(luis.document.querySelector('.chat-item'));
  const ok = await waitFor(() => {
    const msgs = luis.document.querySelectorAll('#messages .msg.them');
    return msgs.length > 0 && msgs[msgs.length - 1].textContent.includes('Hola desde el servidor propio');
  }, 15000, 'mensaje de Ana en Luis');
  check('Luis recibe el mensaje en tiempo real', ok);
}

// ---- Luis responde, Ana recibe ----
setVal(luis.document, 'msg-input', '¡Recibido en el servidor propio!');
submit(luis.document, 'composer');
const anaGotReply = await waitFor(() => {
  const msgs = ana.document.querySelectorAll('#messages .msg.them');
  return msgs.length > 0 && msgs[msgs.length - 1].textContent.includes('¡Recibido en el servidor propio!');
}, 15000, 'respuesta de Luis en Ana');
check('Ana recibe la respuesta en tiempo real', anaGotReply);

// ---- ticks de lectura ----
const readTick = await waitFor(() => {
  const ticks = ana.document.querySelectorAll('#messages .msg.me .tick.read');
  return ticks.length > 0;
}, 15000, 'tick leído ✓✓');
check('Ana ve ✓✓ (Luis leyó)', readTick);

// ---- persistencia: página nueva con el token ya en localStorage ----
const tokenLuis = luis.window.localStorage.getItem('chatapp_token');
check('token persistido en localStorage', !!tokenLuis);
const html = await (await fetch(BASE + '/')).text();
const dom2 = new JSDOM(html, {
  url: BASE + '/',
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  beforeParse(w) {
    w.WebSocket = WebSocket;
    w.fetch = (url, opts) => globalThis.fetch(new URL(url, BASE).href, opts);
    w.localStorage.setItem('chatapp_token', tokenLuis);
  },
});
const luis2doc = dom2.window.document;
const persisted = await waitFor(() => {
  const main = visible(luis2doc.getElementById('view-main'));
  const items = luis2doc.querySelectorAll('.chat-item').length;
  return main && items > 0;
}, 20000, 'sesión restaurada con chats');
check('al volver a entrar, sesión y chats persisten', persisted);

console.log(failures === 0 ? '\n🎉 FRONTEND TODO OK' : `\n💥 ${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
