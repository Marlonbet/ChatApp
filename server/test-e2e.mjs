// Test E2E del backend: registro, login, búsqueda, chat, mensajes por WS, leídos, presencia.
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:3100';
let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failures++;
}
async function api(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ana = await api('/api/register', { method: 'POST', body: { name: 'Ana Prueba', email: 'ana@test.local', password: 'secreta123' } });
check('registro Ana', ana.status === 201 && ana.j.token, ana.j.error);
const dup = await api('/api/register', { method: 'POST', body: { name: 'Otra', email: 'ana@test.local', password: 'secreta123' } });
check('registro duplicado rechazado', dup.status === 409);
const weak = await api('/api/register', { method: 'POST', body: { name: 'X', email: 'x@test.local', password: '123' } });
check('validación (nombre corto / pass débil)', weak.status === 400);
const luis = await api('/api/register', { method: 'POST', body: { name: 'Luis Prueba', email: 'luis@test.local', password: 'secreta123' } });
check('registro Luis', luis.status === 201);
const badLogin = await api('/api/login', { method: 'POST', body: { email: 'ana@test.local', password: 'mal' } });
check('login con pass mala → 401', badLogin.status === 401);
const noAuth = await api('/api/chats');
check('sin token → 401', noAuth.status === 401);

const tA = ana.j.token, tL = luis.j.token;
const search = await api('/api/users/search?q=lui', { token: tA });
check('búsqueda encuentra a Luis', search.j.users?.length === 1 && search.j.users[0].email === 'luis@test.local', JSON.stringify(search.j.users?.map(u => u.email)));
const searchShort = await api('/api/users/search?q=l', { token: tA });
check('búsqueda <2 letras vacía', searchShort.j.users?.length === 0);

const chat = await api('/api/chats', { method: 'POST', token: tA, body: { peerId: luis.j.user.id } });
check('crear chat Ana→Luis', chat.status === 200 && chat.j.id, chat.j.error);
const chatId = chat.j.id;
const chat2 = await api('/api/chats', { method: 'POST', token: tL, body: { peerId: ana.j.user.id } });
check('chat determinista (mismo id)', chat2.j.id === chatId);

// WebSocket: ambos conectados
function connect(t) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:3100/ws?token=' + t);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
const wsA = await connect(tA), wsL = await connect(tL);
const gotL = [], gotA = [];
wsL.on('message', (d) => gotL.push(JSON.parse(d.toString())));
wsA.on('message', (d) => gotA.push(JSON.parse(d.toString())));
wsA.send(JSON.stringify({ t: 'send', chatId, text: 'Hola Luis', cid: 'c1' }));
await wait(500);
const msgL = gotL.find((m) => m.t === 'msg');
check('Luis recibe mensaje en tiempo real', msgL?.m.text === 'Hola Luis', JSON.stringify(msgL?.m));
const echoA = gotA.find((m) => m.t === 'msg' && m.cid === 'c1');
check('Ana recibe eco con cid', !!echoA);
const listL = await api('/api/chats', { token: tL });
check('lista de Luis muestra unread=1', listL.j.chats?.[0]?.unread === 1, 'unread=' + listL.j.chats?.[0]?.unread);

wsL.send(JSON.stringify({ t: 'read', chatId }));
await wait(400);
const readA = gotA.find((m) => m.t === 'read');
check('Ana recibe confirmación de lectura', readA?.userId === luis.j.user.id);
const listL2 = await api('/api/chats', { token: tL });
check('unread vuelve a 0 tras leer', listL2.j.chats?.[0]?.unread === 0);

// con el chat abierto no debe subir el no-leído
wsL.send(JSON.stringify({ t: 'open', chatId }));
await wait(200);
wsA.send(JSON.stringify({ t: 'send', chatId, text: '¿ves esto?', cid: 'c0' }));
await wait(400);
const listL3 = await api('/api/chats', { token: tL });
check('con chat abierto no sube unread', listL3.j.chats?.[0]?.unread === 0, 'unread=' + listL3.j.chats?.[0]?.unread);

wsA.send(JSON.stringify({ t: 'typing', chatId, on: true }));
await wait(300);
check('Luis ve "escribiendo"', gotL.some((m) => m.t === 'typing' && m.on === true));

wsA.send(JSON.stringify({ t: 'beat' }));
await wait(300);
check('presencia llega a Luis', gotL.some((m) => m.t === 'presence' && m.userId === ana.j.user.id));

wsL.send(JSON.stringify({ t: 'send', chatId, text: '¡Hola Ana!', cid: 'c2' }));
await wait(500);
check('Ana recibe respuesta', gotA.some((m) => m.t === 'msg' && m.m.text === '¡Hola Ana!'));

const hist = await api(`/api/chats/${chatId}/messages?limit=50`, { token: tA });
check('historial persistido (3 mensajes)', hist.j.messages?.length === 3, 'n=' + hist.j.messages?.length);
const other = await api(`/api/chats/${chatId}/messages`, { token: 'invalido' });
check('token inválido → 401', other.status === 401);

// privacidad: un tercero no puede leer el chat
const eva = await api('/api/register', { method: 'POST', body: { name: 'Eva', email: 'eva@test.local', password: 'secreta123' } });
const forbidden = await api(`/api/chats/${chatId}/messages`, { token: eva.j.token });
check('tercero no puede leer mensajes → 403', forbidden.status === 403);
const forbiddenList = await api('/api/chats', { token: eva.j.token });
check('tercero no ve el chat en su lista', (forbiddenList.j.chats || []).length === 0);

wsA.close(); wsL.close();
console.log(failures === 0 ? '\n🎉 TODO OK' : `\n💥 ${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
