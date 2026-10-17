# ChatApp Server — backend propio (sin Firebase)

Servidor de ChatApp en Node.js: API REST + WebSocket + SQLite. Reemplaza a
Firebase Auth y Firestore para que la app funcione sin depender de Google
(útil donde Firebase está bloqueado).

## Estructura

| Archivo | Qué es |
|---|---|
| `server.js` | Servidor: API REST, WebSocket en tiempo real, SQLite |
| `package.json` | Única dependencia: `ws` (SQLite y crypto vienen con Node) |
| `public/` | Frontend que habla con este servidor (misma interfaz) |
| `deploy.sh` | Instalación automática en un VPS Ubuntu/Debian |
| `Caddyfile` | Ejemplo de proxy inverso con HTTPS automático |

## API

- `POST /api/register` `{name, email, password}` → `{token, user}`
- `POST /api/login` `{email, password}` → `{token, user}`
- `POST /api/logout` → `{ok}`
- `GET /api/me` → `{user}`
- `GET /api/users/search?q=` → `{users}`
- `GET /api/chats` → `{chats}` (con último mensaje, no leídos, visto del otro)
- `POST /api/chats` `{peerId}` → `{id}`
- `GET /api/chats/:id/messages?before=&limit=` → `{messages}`

Auth: header `Authorization: Bearer <token>`. Contraseñas con scrypt,
tokens aleatorios de 32 bytes con expiración de 30 días, rate limit en
registro/login.

## WebSocket (`/ws?token=`)

Cliente → servidor: `send`, `read`, `typing`, `open`, `close`, `beat`.
Servidor → cliente: `msg`, `chats`, `read`, `typing`, `presence`.

## Desarrollo local

```bash
cd server
npm install
node server.js   # http://localhost:3000  (API + web)
```

Variables: `PORT` (defecto 3000), `DATA_DIR` (defecto `./data`).

## Producción (VPS Ubuntu/Debian)

```bash
sudo ./deploy.sh tu-dominio.com
```

Instala Node 22, Caddy (HTTPS automático con Let's Encrypt), crea el
servicio `chatapp` (systemd) y el proxy inverso. Sin dominio sirve por
HTTP en la IP — solo para pruebas.

Respaldo: copiar `data/chatapp.sqlite` periódicamente.
