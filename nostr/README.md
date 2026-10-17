# ChatApp Nostr — mensajería descentralizada, $0

La misma interfaz de ChatApp, pero sin ningún servidor propio ni de empresas:
los mensajes viajan **cifrados** por la red **Nostr** (relays públicos gratuitos).
No hay registro, no hay tarjeta, ninguna compañía puede bloquear el servicio.

## Cómo se usa (sin hosting)

`dist/chatapp-nostr.html` es **un solo archivo** autocontenido (132 KB):
se abre directamente en el navegador del teléfono (incluso con `file://`)
o se comparte por WhatsApp/Telegram/Bluetooth.

1. Ábrelo → **Crear mi identidad** (escribe tu nombre).
2. Se genera tu clave criptográfica (identidad Nostr). **Guárdala**:
   Ajustes → *Ver mi clave privada* → cópiala en un lugar seguro.
3. Comparte tu **ID** (`npub1…`, botón Copiar en *Nuevo chat*).
4. Para chatear: *Nuevo chat* → pega el `npub1…` de tu contacto.

Si cambias de teléfono: *Crear mi identidad* → *Ya tengo una clave → importar*
y pega tu clave privada.

## Privacidad honesta

- El **contenido** de los mensajes va cifrado (NIP-04): solo tú y tu contacto
  lo pueden leer.
- Los **metadatos** (quién habla con quién y cuándo) son visibles para los
  relays, como en cualquier red Nostr pública.
- El **historial** lo guardan los relays (semanas/meses según cada relay),
  no es eterno como una base de datos propia.

## Relays

Vienen 5 relays públicos preconfigurados. En Ajustes ves el estado de cada
uno (🟢/🟡/🔴): si alguno no conecta desde tu país, elimínalo con ✕ o añade
otros `wss://…`.

## Desarrollo

```bash
cd nostr
npm install
npm run build   # genera dist/chatapp-nostr.html
npm test        # 24 pruebas: transporte + UI contra un relay simulado
```

- `src/client.js` — transporte Nostr (sin DOM; testeable en Node).
- `src/app.js` — interfaz.
- `src/index.html`, `src/styles.css` — plantilla y estilos.
- `build.mjs` — empaqueta todo con esbuild en un solo HTML.
- `test/` — mock de relay + pruebas del cliente y de la UI (jsdom).

## Protocolo (eventos Nostr)

| Kind | Uso |
|------|-----|
| 0 | perfil `{name}` |
| 4 | mensaje directo cifrado (NIP-04) |
| 24501 | presencia "en línea" (efímero) |
| 24502 | "escribiendo…" (efímero) |
| 24503 | confirmación de lectura (persistente) |

Compatible con otras apps Nostr para DMs kind 4 (ej. Damus, Amethyst).
