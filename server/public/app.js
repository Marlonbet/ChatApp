/* ChatApp — cliente para servidor propio (API REST + WebSocket).
   Misma interfaz que la versión Firebase; sin dependencias externas. */
(function () {
  'use strict';

  var API = ''; // mismo origen: el servidor sirve API y web juntos
  var TOKEN_KEY = 'chatapp_token';

  var me = null;               // {id,name,email}
  var token = localStorage.getItem(TOKEN_KEY);
  var ws = null;
  var wsTimer = null;
  var beatTimer = null;
  var openChatId = null;
  var openPeer = null;         // {id,name,email,lastSeen}
  var chatCache = {};          // chatId -> chat item de /api/chats
  var profileCache = {};       // uid -> {id,name,email,lastSeen}
  var pendingMsgs = {};        // cid -> elemento DOM
  var typingTimer = null;
  var cidSeq = 0;

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
  function d(ms) { return ms ? new Date(ms) : null; }
  function fmtChatTime(ms) {
    var dt = d(ms); if (!dt) return '';
    var now = new Date();
    var hh = String(dt.getHours()).padStart(2, '0'), mm = String(dt.getMinutes()).padStart(2, '0');
    if (dt.toDateString() === now.toDateString()) return hh + ':' + mm;
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (dt.toDateString() === y.toDateString()) return 'Ayer';
    return String(dt.getDate()).padStart(2, '0') + '/' + String(dt.getMonth() + 1).padStart(2, '0') + '/' + dt.getFullYear();
  }
  function fmtMsgTime(ms) {
    var dt = d(ms); if (!dt) return '';
    return String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
  }
  function fmtDay(ms) {
    var dt = d(ms); if (!dt) return '';
    var now = new Date();
    if (dt.toDateString() === now.toDateString()) return 'Hoy';
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (dt.toDateString() === y.toDateString()) return 'Ayer';
    return dt.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function presenceText(lastSeen) {
    if (!lastSeen) return '';
    var diff = Date.now() - lastSeen;
    return diff < 90000 ? 'en línea' : 'últ. vez ' + fmtChatTime(lastSeen);
  }

  /* ---------- API ---------- */
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || 'Error de red.');
        return j;
      });
    });
  }

  /* ---------- vistas ---------- */
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
    api('/api/login', { method: 'POST', body: { email: $('login-email').value.trim(), password: $('login-pass').value } })
      .then(function (j) { setSession(j.token, j.user); })
      .catch(function (ex) { err.textContent = ex.message; err.hidden = false; })
      .finally(function () { btn.disabled = false; btn.textContent = 'Iniciar sesión'; });
  });

  $('form-register').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('reg-error'); err.hidden = true;
    var name = $('reg-name').value.trim();
    if (name.length < 2) { err.textContent = 'Escribe tu nombre.'; err.hidden = false; return; }
    var btn = this.querySelector('button'); btn.disabled = true; btn.textContent = 'Creando cuenta…';
    api('/api/register', { method: 'POST', body: { name: name, email: $('reg-email').value.trim(), password: $('reg-pass').value } })
      .then(function (j) { setSession(j.token, j.user); })
      .catch(function (ex) { err.textContent = ex.message; err.hidden = false; })
      .finally(function () { btn.disabled = false; btn.textContent = 'Crear cuenta'; });
  });

  $('btn-logout').addEventListener('click', function () {
    if (token) api('/api/logout', { method: 'POST' }).catch(function () {});
    clearSession();
  });

  function setSession(tok, user) {
    token = tok;
    localStorage.setItem(TOKEN_KEY, tok);
    me = user;
    enter();
  }
  function clearSession() {
    token = null; me = null;
    localStorage.removeItem(TOKEN_KEY);
    teardown();
    show('auth');
  }
  function enter() {
    $('my-name').textContent = me.name;
    setAvatar($('my-avatar'), me.name, me.id);
    show('main');
    loadChats();
    connectWs();
    startBeat();
  }
  function teardown() {
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
    if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
    closeChat();
    chatCache = {}; profileCache = {};
  }

  /* ---------- websocket ---------- */
  function connectWs() {
    if (!token || ws) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { ws = new WebSocket(proto + '//' + location.host + '/ws?token=' + encodeURIComponent(token)); }
    catch (e) { scheduleReconnect(); return; }
    ws.onopen = function () {
      if (openChatId) wsSend({ t: 'open', chatId: openChatId });
      wsSend({ t: 'beat' });
    };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      onWs(m);
    };
    ws.onclose = function () { ws = null; scheduleReconnect(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  function scheduleReconnect() {
    if (!token || wsTimer) return;
    wsTimer = setTimeout(function () { wsTimer = null; connectWs(); }, 3000);
  }
  function wsSend(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  function startBeat() {
    if (beatTimer) clearInterval(beatTimer);
    var beat = function () { wsSend({ t: 'beat' }); };
    beat();
    beatTimer = setInterval(beat, 30000);
  }

  function onWs(m) {
    if (m.t === 'chats') { loadChats(); return; }
    if (m.t === 'msg') {
      // reconciliar optimista
      if (m.cid && pendingMsgs[m.cid]) {
        var el = pendingMsgs[m.cid];
        delete pendingMsgs[m.cid];
        el.dataset.mid = m.m.id;
        el.querySelector('.msg-meta span').textContent = fmtMsgTime(m.m.createdAt);
        el.querySelector('.tick').textContent = '✓';
      } else if (m.chatId === openChatId) {
        appendMessage(m.m, true);
        wsSend({ t: 'read', chatId: openChatId });
      }
      updateChatCache(m.chatId, m.m);
      return;
    }
    if (m.t === 'read') {
      if (chatCache[m.chatId]) chatCache[m.chatId].peerSeenAt = m.seenAt;
      if (m.chatId === openChatId) refreshTicks();
      return;
    }
    if (m.t === 'presence') {
      profileCache[m.userId] = profileCache[m.userId] || {};
      profileCache[m.userId].lastSeen = m.lastSeen;
      if (openPeer && openPeer.id === m.userId) {
        openPeer.lastSeen = m.lastSeen;
        if (!typingTimer) $('peer-status').textContent = presenceText(m.lastSeen);
      }
      return;
    }
    if (m.t === 'typing') {
      if (openPeer && openPeer.id === m.userId && m.chatId === openChatId) {
        if (m.on) {
          $('peer-status').textContent = 'escribiendo…';
          if (typingTimer) clearTimeout(typingTimer);
          typingTimer = setTimeout(function () {
            typingTimer = null;
            $('peer-status').textContent = presenceText(openPeer.lastSeen);
          }, 3000);
        }
      }
      return;
    }
  }

  /* ---------- lista de chats ---------- */
  function loadChats() {
    if (!me) return Promise.resolve();
    return api('/api/chats').then(function (j) {
      chatCache = {};
      (j.chats || []).forEach(function (c) { chatCache[c.id] = c; });
      renderChatList(j.chats || []);
    }).catch(function () {});
  }
  function updateChatCache(chatId, m) {
    var c = chatCache[chatId];
    if (!c) { loadChats(); return; }
    c.lastMessage = m;
    c.updatedAt = m.createdAt;
    if (m.senderId !== me.id && chatId !== openChatId) c.unread = (c.unread || 0) + 1;
    renderChatList(Object.values(chatCache));
  }

  function renderChatList(items) {
    var list = $('chat-list');
    var filter = $('search-chats').value.trim().toLowerCase();
    items = items.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    $('chat-list-empty').hidden = items.length > 0;
    list.innerHTML = '';
    var shown = 0;
    items.forEach(function (c) {
      var name = (c.peer && c.peer.name) || 'Usuario';
      if (filter && name.toLowerCase().indexOf(filter) < 0 &&
          (c.lastMessage && c.lastMessage.text || '').toLowerCase().indexOf(filter) < 0) return;
      shown++;
      var row = document.createElement('div');
      row.className = 'chat-item';
      row.innerHTML =
        '<div class="avatar"></div>' +
        '<div class="chat-item-body">' +
          '<div class="chat-item-top"><strong>' + esc(name) + '</strong>' +
          '<span class="chat-time">' + esc(fmtChatTime(c.updatedAt)) + '</span></div>' +
          '<div class="chat-item-bottom"><span class="chat-preview">' +
            esc(c.lastMessage ? (c.lastMessage.senderId === me.id ? '✓ ' : '') + c.lastMessage.text : 'Di hola 👋') +
          '</span>' + (c.unread > 0 ? '<span class="unread-badge">' + c.unread + '</span>' : '') + '</div>' +
        '</div>';
      setAvatar(row.querySelector('.avatar'), name, c.peer.id);
      row.addEventListener('click', function () { openChat(c.id); });
      list.appendChild(row);
    });
    if (shown === 0 && items.length > 0) {
      list.innerHTML = '<div class="empty"><p>No hay chats que coincidan con la búsqueda.</p></div>';
    }
  }
  $('search-chats').addEventListener('input', function () {
    renderChatList(Object.values(chatCache));
  });

  /* ---------- abrir chat ---------- */
  function openChat(id) {
    var c = chatCache[id];
    openChatId = id;
    openPeer = c ? c.peer : null;
    if (ws) wsSend({ t: 'open', chatId: id });
    $('chat-placeholder').hidden = true;
    $('chat-active').hidden = false;
    openChatPanel(true);
    $('messages').innerHTML = '';
    if (openPeer) {
      $('peer-name').textContent = openPeer.name;
      setAvatar($('peer-avatar'), openPeer.name, openPeer.id);
      $('peer-status').textContent = presenceText(openPeer.lastSeen);
    }
    api('/api/chats/' + encodeURIComponent(id) + '/messages?limit=100').then(function (j) {
      if (openChatId !== id) return;
      renderMessages(j.messages || []);
      markRead();
    }).catch(function () {});
  }
  function closeChat() {
    if (ws && openChatId) wsSend({ t: 'close' });
    openChatId = null; openPeer = null;
    openChatPanel(false);
    if ($('chat-active')) $('chat-active').hidden = true;
    if ($('chat-placeholder')) $('chat-placeholder').hidden = false;
  }
  $('btn-back').addEventListener('click', closeChat);

  function renderMessages(msgs) {
    var box = $('messages');
    var html = '';
    var lastDay = '';
    msgs.forEach(function (m) {
      var day = fmtDay(m.createdAt);
      if (day !== lastDay) { html += '<div class="day-divider">' + esc(day) + '</div>'; lastDay = day; }
      html += messageHtml(m);
    });
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }
  function messageHtml(m) {
    var mine = m.senderId === me.id;
    var c = chatCache[openChatId];
    var read = mine && c && c.peerSeenAt && c.peerSeenAt >= m.createdAt;
    var tick = mine ? '<span class="tick' + (read ? ' read' : '') + '">' + (read ? '✓✓' : '✓') + '</span>' : '';
    return '<div class="msg ' + (mine ? 'me' : 'them') + '" data-mid="' + m.id + '">' + esc(m.text) +
      '<div class="msg-meta"><span>' + esc(fmtMsgTime(m.createdAt)) + '</span>' + tick + '</div></div>';
  }
  function appendMessage(m, scroll) {
    var box = $('messages');
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.insertAdjacentHTML('beforeend', messageHtml(m));
    if (scroll || nearBottom) box.scrollTop = box.scrollHeight;
  }
  function refreshTicks() {
    var c = chatCache[openChatId];
    if (!c) return;
    Array.prototype.forEach.call($('messages').querySelectorAll('.msg.me'), function (el) {
      var mid = +el.dataset.mid;
      // aproximación: si el último mensaje propio es anterior al seen, marcar
      var tick = el.querySelector('.tick');
      if (tick && c.peerSeenAt) tick.className = 'tick read', tick.textContent = '✓✓';
    });
  }
  function markRead() {
    if (!openChatId) return;
    wsSend({ t: 'read', chatId: openChatId });
    if (chatCache[openChatId]) { chatCache[openChatId].unread = 0; renderChatList(Object.values(chatCache)); }
  }

  /* ---------- enviar ---------- */
  var ta = $('msg-input');
  ta.addEventListener('input', function () {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    wsSend({ t: 'typing', chatId: openChatId, on: ta.value.length > 0 });
  });
  ta.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = ta.value.trim();
    if (!text || !openChatId) return;
    ta.value = ''; ta.style.height = 'auto';
    wsSend({ t: 'typing', chatId: openChatId, on: false });
    var cid = 'c' + (++cidSeq) + '_' + Date.now();
    // optimista
    var box = $('messages');
    var tmp = document.createElement('div');
    tmp.className = 'msg me';
    tmp.innerHTML = esc(text) + '<div class="msg-meta"><span>…</span><span class="tick">◷</span></div>';
    box.appendChild(tmp);
    box.scrollTop = box.scrollHeight;
    pendingMsgs[cid] = tmp;
    wsSend({ t: 'send', chatId: openChatId, text: text.slice(0, 2000), cid: cid });
    setTimeout(function () {
      if (pendingMsgs[cid]) { delete pendingMsgs[cid]; loadChats(); }
    }, 8000);
  });

  /* ---------- nuevo chat: buscar usuarios ---------- */
  var searchTimer = null;
  function openModal() {
    $('modal-new').hidden = false; $('user-search').value = '';
    $('user-results').innerHTML = ''; $('user-search-hint').hidden = false;
    setTimeout(function () { $('user-search').focus(); }, 50);
  }
  function closeModal() { $('modal-new').hidden = true; }
  $('fab-new').addEventListener('click', openModal);
  $('modal-close').addEventListener('click', closeModal);
  $('modal-new').addEventListener('click', function (e) { if (e.target === $('modal-new')) closeModal(); });

  $('user-search').addEventListener('input', function () {
    clearTimeout(searchTimer);
    var q = this.value.trim();
    if (q.length < 2) { $('user-results').innerHTML = ''; $('user-search-hint').hidden = false; return; }
    $('user-search-hint').hidden = true;
    searchTimer = setTimeout(function () { searchUsers(q); }, 350);
  });
  function searchUsers(q) {
    api('/api/users/search?q=' + encodeURIComponent(q)).then(function (j) {
      var box = $('user-results');
      box.innerHTML = '';
      var rows = j.users || [];
      if (!rows.length) {
        box.innerHTML = '<div class="empty"><p>No se encontró a nadie con "' + esc(q) + '".</p></div>';
        return;
      }
      rows.forEach(function (u) {
        var div = document.createElement('div');
        div.className = 'user-row';
        div.innerHTML = '<div class="avatar"></div><div class="user-row-body"><strong>' +
          esc(u.name) + '</strong><span>' + esc(u.email) + '</span></div><span class="go">›</span>';
        setAvatar(div.querySelector('.avatar'), u.name, u.id);
        div.addEventListener('click', function () { startChatWith(u.id); });
        box.appendChild(div);
      });
    }).catch(function () {});
  }
  function startChatWith(peerId) {
    closeModal();
    api('/api/chats', { method: 'POST', body: { peerId: peerId } })
      .then(function (j) { return loadChats().then(function () { openChat(j.id); }); })
      .catch(function (ex) { alert(ex.message); });
  }

  /* ---------- arranque ---------- */
  if (token) {
    api('/api/me').then(function (j) {
      me = j.user;
      enter();
    }).catch(function () {
      token = null;
      localStorage.removeItem(TOKEN_KEY);
      show('auth');
    });
  } else {
    show('auth');
  }
})();
