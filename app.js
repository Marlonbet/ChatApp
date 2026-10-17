/* ChatApp — mensajería instantánea con Firebase (Auth + Firestore) */
(function () {
  'use strict';

  var firebaseConfig = {
    apiKey: "AIzaSyCmjSskk5YjCAVAX3XiHZSW1Tkz7sSYVqc",
    authDomain: "chatbot-marlon.firebaseapp.com",
    projectId: "chatbot-marlon",
    storageBucket: "chatbot-marlon.firebasestorage.app",
    messagingSenderId: "591781973859",
    appId: "1:591781973859:web:abf9c06119706104454d56"
  };

  firebase.initializeApp(firebaseConfig);
  var auth = firebase.auth();
  var db = firebase.firestore();
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function () {});

  var USERS = 'chatapp_users';
  var CHATS = 'chatapp_chats';

  var me = null;               // firebase user
  var myProfile = null;        // users/{uid} doc
  var chatsUnsub = null;
  var msgsUnsub = null;
  var peerUnsub = null;
  var openChatId = null;
  var openPeerUid = null;
  var profileCache = {};       // uid -> profile
  var chatMeta = {};           // chatId -> {peerUid, peerProfile}
  var presenceTimer = null;

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var AVATAR_COLORS = ['#0b6e5f', '#7b5ea7', '#c96f2e', '#2e7fc9', '#b03a5b', '#5b8c2a', '#8c5b2a'];
  function avatarColor(key) {
    var h = 0; key = String(key || '?');
    for (var i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  function setAvatar(el, name, uid) {
    el.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
    el.style.background = avatarColor(uid || name);
  }
  function toDate(ts) { return ts && ts.toDate ? ts.toDate() : null; }
  function fmtChatTime(ts) {
    var d = toDate(ts); if (!d) return '';
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var y = new Date(now); y.setDate(now.getDate() - 1);
    var hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return hh + ':' + mm;
    if (d.toDateString() === y.toDateString()) return 'Ayer';
    return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
  }
  function fmtMsgTime(ts) {
    var d = toDate(ts); if (!d) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function fmtDay(ts) {
    var d = toDate(ts); if (!d) return '';
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Hoy';
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Ayer';
    return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function authErrorMsg(code) {
    var map = {
      'auth/email-already-in-use': 'Ese correo ya está registrado. Prueba a iniciar sesión.',
      'auth/invalid-email': 'Ese correo no parece válido.',
      'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
      'auth/user-not-found': 'No hay ninguna cuenta con ese correo.',
      'auth/wrong-password': 'Contraseña incorrecta.',
      'auth/invalid-credential': 'Correo o contraseña incorrectos.',
      'auth/too-many-requests': 'Demasiados intentos. Espera un momento e inténtalo de nuevo.',
      'auth/network-request-failed': 'Sin conexión. Revisa tu internet e inténtalo de nuevo.'
    };
    return map[code] || 'Ocurrió un error. Inténtalo de nuevo.';
  }

  /* ---------- views ---------- */
  function show(view) {
    $('view-auth').hidden = view !== 'auth';
    $('view-main').hidden = view !== 'main';
  }
  function openChatPanel(open) {
    $('panel-chat').classList.toggle('open', !!open);
  }

  /* ---------- auth UI ---------- */
  $('tab-login').addEventListener('click', function () {
    $('tab-login').classList.add('active'); $('tab-register').classList.remove('active');
    $('form-login').hidden = false; $('form-register').hidden = true;
  });
  $('tab-register').addEventListener('click', function () {
    $('tab-register').classList.add('active'); $('tab-login').classList.remove('active');
    $('form-register').hidden = false; $('form-login').hidden = true;
  });

  $('form-login').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('login-error'); err.hidden = true;
    var btn = this.querySelector('button'); btn.disabled = true; btn.textContent = 'Entrando…';
    auth.signInWithEmailAndPassword($('login-email').value.trim(), $('login-pass').value)
      .catch(function (ex) { err.textContent = authErrorMsg(ex.code); err.hidden = false; })
      .finally(function () { btn.disabled = false; btn.textContent = 'Iniciar sesión'; });
  });

  $('form-register').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('reg-error'); err.hidden = true;
    var name = $('reg-name').value.trim(), email = $('reg-email').value.trim(), pass = $('reg-pass').value;
    if (name.length < 2) { err.textContent = 'Escribe tu nombre.'; err.hidden = false; return; }
    var btn = this.querySelector('button'); btn.disabled = true; btn.textContent = 'Creando cuenta…';
    auth.createUserWithEmailAndPassword(email, pass)
      .then(function (cred) {
        var uid = cred.user.uid;
        return db.collection(USERS).doc(uid).set({
          displayName: name,
          email: email,
          emailLower: email.toLowerCase(),
          nameLower: name.toLowerCase(),
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          lastSeen: firebase.firestore.FieldValue.serverTimestamp()
        });
      })
      .catch(function (ex) { err.textContent = authErrorMsg(ex.code); err.hidden = false; })
      .finally(function () { btn.disabled = false; btn.textContent = 'Crear cuenta'; });
  });

  $('btn-logout').addEventListener('click', function () {
    auth.signOut().catch(function () {});
  });

  /* ---------- session ---------- */
  auth.onAuthStateChanged(function (user) {
    teardown();
    if (!user) { me = null; myProfile = null; show('auth'); return; }
    me = user;
    db.collection(USERS).doc(me.uid).get().then(function (snap) {
      myProfile = snap.exists ? snap.data() : null;
      var name = (myProfile && myProfile.displayName) || me.email.split('@')[0];
      $('my-name').textContent = name;
      setAvatar($('my-avatar'), name, me.uid);
      show('main');
      subscribeChats();
      startPresence();
    }).catch(function () {
      show('auth');
    });
  });

  function teardown() {
    if (chatsUnsub) { chatsUnsub(); chatsUnsub = null; }
    closeChat();
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    chatMeta = {}; profileCache = {};
  }

  function startPresence() {
    var beat = function () {
      if (!me) return;
      db.collection(USERS).doc(me.uid).update({ lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(function () {});
    };
    beat();
    presenceTimer = setInterval(beat, 30000);
  }

  /* ---------- profiles ---------- */
  function getProfile(uid) {
    if (profileCache[uid]) return Promise.resolve(profileCache[uid]);
    return db.collection(USERS).doc(uid).get().then(function (snap) {
      var p = snap.exists ? snap.data() : { displayName: 'Usuario', email: '' };
      profileCache[uid] = p;
      return p;
    });
  }

  /* ---------- chat list ---------- */
  function subscribeChats() {
    if (chatsUnsub) chatsUnsub();
    chatsUnsub = db.collection(CHATS)
      .where('participants', 'array-contains', me.uid)
      .onSnapshot(function (snap) {
        var items = [];
        snap.forEach(function (d) {
          var c = d.data(); c.id = d.id;
          items.push(c);
        });
        items.sort(function (a, b) {
          var ta = a.updatedAt && a.updatedAt.toMillis ? a.updatedAt.toMillis() : 0;
          var tb = b.updatedAt && b.updatedAt.toMillis ? b.updatedAt.toMillis() : 0;
          return tb - ta;
        });
        renderChatList(items);
      }, function () { /* silencioso: reintenta solo */ });
  }

  function renderChatList(items) {
    var list = $('chat-list');
    var filter = $('search-chats').value.trim().toLowerCase();
    $('chat-list-empty').hidden = items.length > 0;
    list.innerHTML = '';
    var shown = 0;
    var pending = [];
    items.forEach(function (c) {
      var peerUid = (c.participants || []).filter(function (u) { return u !== me.uid; })[0] || me.uid;
      chatMeta[c.id] = { peerUid: peerUid };
      pending.push(getProfile(peerUid).then(function (p) {
        chatMeta[c.id].peerProfile = p;
        var name = p.displayName || p.email || 'Usuario';
        if (filter && name.toLowerCase().indexOf(filter) < 0 &&
            (c.lastMessage && c.lastMessage.text || '').toLowerCase().indexOf(filter) < 0) return;
        shown++;
        var unread = (c.unread && c.unread[me.uid]) || 0;
        var row = document.createElement('div');
        row.className = 'chat-item';
        row.innerHTML =
          '<div class="avatar"></div>' +
          '<div class="chat-item-body">' +
            '<div class="chat-item-top"><strong>' + esc(name) + '</strong>' +
            '<span class="chat-time">' + esc(fmtChatTime(c.updatedAt)) + '</span></div>' +
            '<div class="chat-item-bottom"><span class="chat-preview">' +
              esc(c.lastMessage ? (c.lastMessage.senderId === me.uid ? '✓ ' : '') + c.lastMessage.text : 'Di hola 👋') +
            '</span>' + (unread > 0 ? '<span class="unread-badge">' + unread + '</span>' : '') + '</div>' +
          '</div>';
        setAvatar(row.querySelector('.avatar'), name, peerUid);
        row.addEventListener('click', function () { openChat(c.id, peerUid); });
        list.appendChild(row);
      }));
    });
    Promise.all(pending).then(function () {
      if (shown === 0 && items.length > 0) {
        list.innerHTML = '<div class="empty"><p>No hay chats que coincidan con la búsqueda.</p></div>';
      }
    });
  }

  $('search-chats').addEventListener('input', function () { subscribeChats(); });

  /* ---------- open chat ---------- */
  function chatIdFor(a, b) { return [a, b].sort().join('_'); }

  function openChat(id, peerUid) {
    openChatId = id; openPeerUid = peerUid;
    if (msgsUnsub) msgsUnsub();
    if (peerUnsub) peerUnsub();
    $('chat-placeholder').hidden = true;
    $('chat-active').hidden = false;
    openChatPanel(true);
    $('messages').innerHTML = '';

    getProfile(peerUid).then(function (p) {
      var name = p.displayName || p.email || 'Usuario';
      $('peer-name').textContent = name;
      setAvatar($('peer-avatar'), name, peerUid);
    });

    // presencia del contacto
    peerUnsub = db.collection(USERS).doc(peerUid).onSnapshot(function (snap) {
      var p = snap.exists ? snap.data() : null;
      profileCache[peerUid] = p || profileCache[peerUid];
      var st = $('peer-status');
      if (!p || !p.lastSeen) { st.textContent = ''; return; }
      var diff = Date.now() - p.lastSeen.toDate().getTime();
      st.textContent = diff < 90000 ? 'en línea' : 'últ. vez ' + fmtChatTime(p.lastSeen);
    });

    // mensajes en tiempo real
    msgsUnsub = db.collection(CHATS).doc(id).collection('messages')
      .orderBy('createdAt', 'asc').limitToLast(200)
      .onSnapshot(function (snap) {
        renderMessages(snap);
        markRead();
      });

    markRead();
  }

  function closeChat() {
    openChatId = null; openPeerUid = null;
    if (msgsUnsub) { msgsUnsub(); msgsUnsub = null; }
    if (peerUnsub) { peerUnsub(); peerUnsub = null; }
    openChatPanel(false);
    if ($('chat-active')) { $('chat-active').hidden = true; }
    if ($('chat-placeholder')) { $('chat-placeholder').hidden = false; }
  }

  $('btn-back').addEventListener('click', closeChat);

  function renderMessages(snap) {
    var box = $('messages');
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    var html = '';
    var lastDay = '';
    var docs = [];
    snap.forEach(function (d) { docs.push(d); });
    // sello de "visto" del contacto
    var peerSeenAt = 0;
    var meta = chatMeta[openChatId];
    docs.forEach(function (d) {
      var m = d.data();
      var day = fmtDay(m.createdAt);
      if (day && day !== lastDay) { html += '<div class="day-divider">' + esc(day) + '</div>'; lastDay = day; }
      var mine = m.senderId === me.uid;
      var tick = '';
      if (mine) {
        var read = meta && meta.peerSeenAt && m.createdAt && meta.peerSeenAt >= m.createdAt.toMillis();
        tick = '<span class="tick' + (read ? ' read' : '') + '">' + (read ? '✓✓' : '✓') + '</span>';
      }
      html += '<div class="msg ' + (mine ? 'me' : 'them') + '">' + esc(m.text) +
        '<div class="msg-meta"><span>' + esc(fmtMsgTime(m.createdAt)) + '</span>' + tick + '</div></div>';
    });
    box.innerHTML = html;
    // actualizar sello de visto del contacto
    db.collection(CHATS).doc(openChatId).get().then(function (d) {
      if (d.exists && openChatId) {
        var seen = (d.data().seen || {})[openPeerUid];
        var t = seen && seen.toMillis ? seen.toMillis() : 0;
        if (chatMeta[openChatId]) chatMeta[openChatId].peerSeenAt = t;
        // re-render ticks sin recargar todo: simple, re-render
        if (t !== peerSeenAt) renderMessagesTickOnly(t);
      }
    });
    if (nearBottom || !box.dataset.init) { box.scrollTop = box.scrollHeight; box.dataset.init = '1'; }
  }

  function renderMessagesTickOnly() { /* los ticks se recalculan en el próximo snapshot */ }

  function markRead() {
    if (!openChatId || !me) return;
    var update = {};
    update['unread.' + me.uid] = 0;
    update['seen.' + me.uid] = firebase.firestore.FieldValue.serverTimestamp();
    db.collection(CHATS).doc(openChatId).update(update).catch(function () {});
  }

  /* ---------- send ---------- */
  var ta = $('msg-input');
  ta.addEventListener('input', function () {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  });
  ta.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
  });

  $('composer').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = ta.value.trim();
    if (!text || !openChatId || !me) return;
    ta.value = ''; ta.style.height = 'auto';
    var chatRef = db.collection(CHATS).doc(openChatId);
    var msg = {
      senderId: me.uid,
      text: text.slice(0, 2000),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    chatRef.collection('messages').add(msg).then(function () {
      var upd = {
        lastMessage: { text: msg.text, senderId: me.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      upd['unread.' + openPeerUid] = firebase.firestore.FieldValue.increment(1);
      chatRef.update(upd).catch(function () {});
    }).catch(function () {
      alert('No se pudo enviar el mensaje. Revisa tu conexión.');
    });
  });

  /* ---------- new chat: user search ---------- */
  var searchTimer = null;
  function openModal() { $('modal-new').hidden = false; $('user-search').value = ''; $('user-results').innerHTML = ''; $('user-search-hint').hidden = false; setTimeout(function () { $('user-search').focus(); }, 50); }
  function closeModal() { $('modal-new').hidden = true; }
  $('fab-new').addEventListener('click', openModal);
  $('modal-close').addEventListener('click', closeModal);
  $('modal-new').addEventListener('click', function (e) { if (e.target === $('modal-new')) closeModal(); });

  $('user-search').addEventListener('input', function () {
    clearTimeout(searchTimer);
    var q = this.value.trim().toLowerCase();
    if (q.length < 2) { $('user-results').innerHTML = ''; $('user-search-hint').hidden = false; return; }
    $('user-search-hint').hidden = true;
    searchTimer = setTimeout(function () { searchUsers(q); }, 350);
  });

  function searchUsers(q) {
    var end = q + '\uf8ff';
    var q1 = db.collection(USERS).where('emailLower', '>=', q).where('emailLower', '<=', end).limit(10).get();
    var q2 = db.collection(USERS).where('nameLower', '>=', q).where('nameLower', '<=', end).limit(10).get();
    Promise.all([q1, q2]).then(function (res) {
      var seen = {}, rows = [];
      res.forEach(function (snap) {
        snap.forEach(function (d) {
          if (d.id === me.uid || seen[d.id]) return;
          seen[d.id] = true;
          rows.push({ uid: d.id, p: d.data() });
        });
      });
      var box = $('user-results');
      box.innerHTML = '';
      if (!rows.length) {
        box.innerHTML = '<div class="empty"><p>No se encontró a nadie con "' + esc(q) + '".</p></div>';
        return;
      }
      rows.forEach(function (r) {
        var name = r.p.displayName || r.p.email || 'Usuario';
        var div = document.createElement('div');
        div.className = 'user-row';
        div.innerHTML = '<div class="avatar"></div><div class="user-row-body"><strong>' +
          esc(name) + '</strong><span>' + esc(r.p.email || '') + '</span></div><span class="go">›</span>';
        setAvatar(div.querySelector('.avatar'), name, r.uid);
        div.addEventListener('click', function () { startChatWith(r.uid); });
        box.appendChild(div);
      });
    });
  }

  function startChatWith(peerUid) {
    var id = chatIdFor(me.uid, peerUid);
    var ref = db.collection(CHATS).doc(id);
    closeModal();
    ref.get().then(function (snap) {
      if (snap.exists) { openChat(id, peerUid); return; }
      return ref.set({
        participants: [me.uid, peerUid],
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastMessage: null,
        unread: {},
        seen: {}
      }).then(function () { openChat(id, peerUid); });
    }).catch(function () { alert('No se pudo abrir el chat. Inténtalo de nuevo.'); });
  }

})();
