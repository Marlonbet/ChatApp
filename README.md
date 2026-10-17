# ChatApp 💬

Web de mensajería instantánea estilo WhatsApp (sin llamadas), responsive y pensada para móvil.

## Funciones

- **Registro** con correo y contraseña (Firebase Authentication, guardado en el servidor).
- **Inicio de sesión** persistente (la sesión se mantiene en el dispositivo).
- **Buscar usuarios** por correo o nombre para iniciar un chat.
- **Chats 1 a 1 en tiempo real** (Firestore, se actualizan solos sin recargar).
- **Chats persistentes**: el historial se guarda en el servidor y está al volver a entrar.
- **Privados**: las reglas de Firestore solo permiten leer cada chat a sus dos participantes.
- **Confirmación de lectura** (✓ enviado, ✓✓ leído), no leídos, presencia ("en línea" / "últ. vez…").
- Responsive: en móvil el chat ocupa toda la pantalla; en escritorio se ve lista + chat lado a lado.

## Estructura

| Archivo | Qué es |
|---|---|
| `index.html` | Pantallas: login/registro, lista de chats, chat, buscar usuarios |
| `styles.css` | Diseño mobile-first |
| `app.js` | Lógica: auth, Firestore en tiempo real, búsqueda, presencia |
| `firestore.rules` | Reglas de seguridad (fusionar con las existentes en Firebase Console) |

## Puesta en marcha (una sola vez)

1. En [Firebase Console](https://console.firebase.google.com/) → proyecto **chatbot-marlon** → **Authentication > Sign-in method**: habilitar **Correo electrónico/contraseña**.
2. En **Firestore Database > Rules**: pegar el contenido de `firestore.rules` fusionado con las reglas que ya existan (chatbot y arranque) y **Publicar**.
3. Subir estos archivos a la raíz del repo y activar **GitHub Pages** (rama `main`, carpeta raíz).

## Modelo de datos

- `chatapp_users/{uid}` → `{ displayName, email, emailLower, nameLower, createdAt, lastSeen }`
- `chatapp_chats/{uidA_uidB}` → `{ participants: [uidA, uidB], lastMessage, updatedAt, unread: {uid: n}, seen: {uid: timestamp} }`
- `chatapp_chats/{id}/messages/{msgId}` → `{ senderId, text, createdAt }`

El `chatId` es determinista (`uidA_uidB` ordenados) para que dos usuarios siempre compartan el mismo chat.
