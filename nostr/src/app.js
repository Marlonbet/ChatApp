// ChatApp Nostr — interfaz. Importa el transporte de ./client.js.
// Se empaqueta con esbuild en un solo archivo HTML (sin CDN ni hosting).
import {
  NostrClient, createIdentity, importIdentity, pubkeyFromNpub,
  KIND_DM, KIND_RECEIPT,
} from './client.js';
import { nip19, getPublicKey } from 'nostr-tools';

(function () {
  'use strict';

  var DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://relay.primal.net',
    'wss://nostr-pub.wellorder.net',
  ];
  var LS_NSEC = 'chatapp_nostr_nsec';
  var LS_RELAYS = 'chatapp_nostr_relays';
  var LS_PROFILES = 'chatapp_nostr_profiles';
  var LS_LASTREAD = 'chatapp_nostr_lastread';

  var client = null;
  var me = null; // {pubkey, npub, name}
  var chats = {};       // peerPubkey -> {peer, name, messages:[], lastTs, unread, peerSeenTs}
  var seenIds = {};
  var profiles = loadJSON(LS_PROFILES, {});
  var lastRead = loadJSON(LS_LASTREAD, {});
  var presenceAt = {};  // peer -> ms
  var openPeer = null;
  var typingTimer = null;
  var typingSentAt = 0;
  var pendingMsgs = {}; // tempId -> {el, peer}
  var relayStates = {};

  /* ---------- utils ---------- */
  function $(id) { return document.getElementById(id); }
  function loadJSON(k, fb) { try { var v = JSON.parse(localStorage.getItem(k)); return v || fb; } catch (e) { return fb; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
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
  function setAvatar(el, name, key) {
    el.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
    el.style.background = avatarColor(key || name);
  }
  function shortNpub(npub) { return npub ? npub.slice(0, 12) + '…' + npub.slice(-6) : ''; }
  function d(ts) { return new Date(ts * 1000); }
  function fmtChatTime(ts) {
    var dt = d(ts), now = new Date();
    var hh = String(dt.getHours()).padStart(2, '0'), mm = String(dt.getMinutes()).padStart(2, '0');
    if (dt.toDateString() === now.toDateString()) return hh + ':' + mm;
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (dt.toDateString() === y.toDateString()) return 'Ayer';
    return String(dt.getDate()).padStart(2, '0') + '/' + String(dt.getMonth() + 1).padStart(2, '0') + '/' + dt.getFullYear();
  }
  function fmtMsgTime(ts) { var dt = d(ts); return String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0'); }
  function fmtDay(ts) {
    var dt = d(ts), now = new Date();
    if (dt.toDateString() === now.toDateString()) return 'Hoy';
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (dt.toDateString() === y.toDateString()) return 'Ayer';
    return dt.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function copyText(t, btn) {
    function done() { if (btn) { var o = btn.textContent; btn.textContent = '✓'; setTimeout(function () { btn.textContent = o; }, 1200); } }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done).catch(function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); done();
    }
  }

  /* ---------- identidad ---------- */
  function show(view) {
    $('view-identity').hidden = view !== 'identity';
    $('view-main').hidden = view !== 'main';
  }

  $('btn-show-import').addEventListener('click', function () {
    $('identity-new').hidden = true; $('identity-import').hidden = false;
  });
  $('btn-back-new').addEventListener('click', function () {
    $('identity-import').hidden = true; $('identity-new').hidden = false;
  });
  $('btn-create-id').addEventListener('click', function () {
    var err = $('id-error'); err.hidden = true;
    var name = $('id-name').value.trim();
    if (name.length < 2) { err.textContent = 'Escribe tu nombre.'; err.hidden = false; return; }
    var id = createIdentity(name);
    try { localStorage.setItem(LS_NSEC, id.nsec); } catch (e) {
      err.textContent = 'No se pudo guardar la clave en este navegador.'; err.hidden = false; return;
    }
    bootIdentity(id, name, true);
  });
  $('btn-import-id').addEventListener('click', function () {
    var err = $('id-error'); err.hidden = true;
    try {
      var id = importIdentity($('id-nsec').value);
      localStorage.setItem(LS_NSEC, id.nsec);
      bootIdentity(id, null, false);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });

  function bootIdentity(id, name, isNew) {
    me = { pubkey: id.pubkey, npub: id.npub, name: name || (profiles[id.pubkey] && profiles[id.pubkey].name) || 'Yo' };
    enter(id.sk, isNew, name);
  }

  /* ---------- entrada ---------- */
  function getRelays() {
    var r = loadJSON(LS_RELAYS, null);
    return (r && r.length) ? r : DEFAULT_RELAYS.slice();
  }

  function enter(sk, isNew, name) {
    $('my-name').textContent = me.name;
    setAvatar($('my-avatar'), me.name, me.pubkey);
    $('my-npub').textContent = me.npub;
    $('set-npub').textContent = me.npub;
    show('main');
    client = new NostrClient({
      relays: getRelays(),
      secretKey: sk,
      onRelayStatus: function (url, st) {
        relayStates[url] = st;
        renderRelayStatus();
        if ($('modal-settings') && !$('modal-settings').hidden) renderRelayList();
      },
    });
    client.connect();
    // 1) suscripción en vivo primero (con dedupe por id)
    client.subscribeLive({
      onDM: function (ev) { handleDM(ev); },
      onReceipt: function (ev) { handleReceipt(ev); },
      onTyping: function (ev) { handleTyping(ev); },
      onPresence: function (ev) { handlePresence(ev); },
    });
    // 2) historial
    client.syncHistory(function (ev) {
      if (ev.kind === KIND_DM) handleDM(ev, true);
      else if (ev.kind === KIND_RECEIPT) handleReceipt(ev, true);
    }).then(function () {
      renderChatList();
      refreshPeerNames();
    });
    if (isNew && name) {
      client.publishProfile(name).catch(function () {});
      profiles[me.pubkey] = { name: name, at: Date.now() / 1000 };
      saveJSON(LS_PROFILES, profiles);
    }
    // presencia periódica
    client.sendPresence();
    setInterval(function () { client.sendPresence(); }, 30000);
  }

  /* ---------- eventos ---------- */
  function peerOfDM(ev) {
    if (ev.pubkey === me.pubkey) {
      var t = ev.tags.find(function (x) { return x[0] === 'p'; });
      return t ? t[1] : null;
    }
    return ev.pubkey;
  }

  function ensureChat(peer) {
    if (!chats[peer]) {
      chats[peer] = {
        peer: peer,
        name: (profiles[peer] && profiles[peer].name) || shortNpub(safeNpub(peer)),
        messages: [], lastTs: 0, unread: 0, peerSeenTs: 0,
      };
      chats[peer].unread = 0;
    }
    return chats[peer];
  }
  function safeNpub(pubkey) {
    try { return nip19.npubEncode(pubkey); } catch (e) { return ''; }
  }

  function handleDM(ev, isHistory) {
    if (seenIds[ev.id]) return;
    seenIds[ev.id] = 1;
    var peer = peerOfDM(ev);
    if (!peer) return;
    var chat = ensureChat(peer);
    var mine = ev.pubkey === me.pubkey;
    var msg = { id: ev.id, peer: peer, mine: mine, ts: ev.created_at, text: null, ev: ev };
    chat.messages.push(msg);
    chat.messages.sort(function (a, b) { return a.ts - b.ts; });
    if (ev.created_at > chat.lastTs) chat.lastTs = ev.created_at;
    // descifrar (async) y luego pintar
    client.decryptDM(ev).then(function (plain) {
      msg.text = plain;
      if (openPeer === peer) appendOrUpdateMessage(msg, true);
      renderChatList();
    }).catch(function () { msg.text = '⚠️ no se pudo descifrar'; renderChatList(); });

    if (!mine) {
      if (openPeer === peer) {
        markRead(peer);
      } else if (!isHistory) {
        chat.unread = (chat.unread || 0) + 1;
      }
    }
    if (!isHistory) renderChatList();
  }

  function handleReceipt(ev, isHistory) {
    var peer = ev.pubkey;
    if (peer === me.pubkey) return;
    var chat = ensureChat(peer);
    var ts = parseInt(ev.content, 10);
    if (ts > (chat.peerSeenTs || 0)) {
      chat.peerSeenTs = ts;
      if (openPeer === peer) refreshTicks();
      if (!isHistory) renderChatList();
    }
  }

  function handleTyping(ev) {
    if (openPeer && ev.pubkey === openPeer) {
      $('peer-status').textContent = 'escribiendo…';
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = setTimeout(function () {
        typingTimer = null;
        $('peer-status').textContent = presenceText(openPeer);
      }, 3000);
    }
  }

  function handlePresence(ev) {
    if (ev.pubkey === me.pubkey) return;
    presenceAt[ev.pubkey] = Date.now();
    if (openPeer === ev.pubkey && !typingTimer) {
      $('peer-status').textContent = presenceText(openPeer);
    }
  }

  function presenceText(peer) {
    var at = presenceAt[peer];
    return at && Date.now() - at < 90000 ? 'en línea' : '';
  }

  /* ---------- lista de chats ---------- */
  function renderChatList() {
    var list = $('chat-list');
    var filter = $('search-chats').value.trim().toLowerCase();
    var items = Object.keys(chats).map(function (k) { return chats[k]; })
      .filter(function (c) { return c.messages.length > 0; })
      .sort(function (a, b) { return b.lastTs - a.lastTs; });
    $('chat-list-empty').hidden = items.length > 0;
    list.innerHTML = '';
    items.forEach(function (c) {
      var last = c.messages[c.messages.length - 1];
      var preview = last.text == null ? '…' : (last.mine ? '✓ ' : '') + last.text;
      if (filter && c.name.toLowerCase().indexOf(filter) < 0 && preview.toLowerCase().indexOf(filter) < 0) return;
      var row = document.createElement('div');
      row.className = 'chat-item';
      row.innerHTML =
        '<div class="avatar"></div>' +
        '<div class="chat-item-body">' +
          '<div class="chat-item-top"><strong>' + esc(c.name) + '</strong>' +
          '<span class="chat-time">' + esc(fmtChatTime(c.lastTs)) + '</span></div>' +
          '<div class="chat-item-bottom"><span class="chat-preview">' + esc(preview.slice(0, 60)) + '</span>' +
          (c.unread > 0 ? '<span class="unread-badge">' + c.unread + '</span>' : '') + '</div>' +
        '</div>';
      setAvatar(row.querySelector('.avatar'), c.name, c.peer);
      row.addEventListener('click', function () { openChat(c.peer); });
      list.appendChild(row);
    });
  }
  $('search-chats').addEventListener('input', renderChatList);

  function refreshPeerNames() {
    Object.keys(chats).forEach(function (peer) {
      if (profiles[peer]) { chats[peer].name = profiles[peer].name; return; }
      client.fetchProfile(peer).then(function (p) {
        if (p && p.name) {
          profiles[peer] = { name: p.name, at: p._at };
          saveJSON(LS_PROFILES, profiles);
          chats[peer].name = p.name;
          renderChatList();
          if (openPeer === peer) $('peer-name').textContent = p.name;
        }
      }).catch(function () {});
    });
    renderChatList();
  }

  /* ---------- abrir chat ---------- */
  function openChat(peer) {
    openPeer = peer;
    var chat = ensureChat(peer);
    $('chat-placeholder').hidden = true;
    $('chat-active').hidden = false;
    if (window.innerWidth < 720) $('panel-chat').classList.add('open');
    $('peer-name').textContent = chat.name;
    setAvatar($('peer-avatar'), chat.name, peer);
    $('peer-status').textContent = presenceText(peer);
    renderMessages(chat);
    markRead(peer);
  }
  function closeChat() {
    openPeer = null;
    $('panel-chat').classList.remove('open');
    $('chat-active').hidden = true;
    $('chat-placeholder').hidden = false;
  }
  $('btn-back').addEventListener('click', closeChat);

  function renderMessages(chat) {
    var box = $('messages');
    var html = '', lastDay = '';
    chat.messages.forEach(function (m) {
      var day = fmtDay(m.ts);
      if (day !== lastDay) { html += '<div class="day-divider">' + esc(day) + '</div>'; lastDay = day; }
      html += messageHtml(m, chat);
    });
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }
  function messageHtml(m, chat) {
    var tick = '';
    if (m.mine) {
      var read = chat.peerSeenTs && m.ts <= chat.peerSeenTs;
      tick = '<span class="tick' + (read ? ' read' : '') + '">' + (read ? '✓✓' : '✓') + '</span>';
    }
    return '<div class="msg ' + (m.mine ? 'me' : 'them') + '" data-mid="' + m.id + '">' +
      esc(m.text == null ? '…' : m.text) +
      '<div class="msg-meta"><span>' + esc(fmtMsgTime(m.ts)) + '</span>' + tick + '</div></div>';
  }
  function appendOrUpdateMessage(m, scroll) {
    var chat = chats[m.peer];
    var box = $('messages');
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    var html = '', lastDay = '', prev = null;
    // re-render simple: solo añadir al final (los mensajes llegan en orden)
    var day = fmtDay(m.ts);
    var needDay = true;
    var nodes = box.querySelectorAll('.day-divider');
    if (nodes.length) {
      var lastNode = nodes[nodes.length - 1];
      if (lastNode.textContent === day) needDay = false;
    }
    if (needDay) html += '<div class="day-divider">' + esc(day) + '</div>';
    html += messageHtml(m, chat);
    box.insertAdjacentHTML('beforeend', html);
    if (scroll || nearBottom) box.scrollTop = box.scrollHeight;
  }
  function refreshTicks() {
    var chat = chats[openPeer];
    if (!chat) return;
    var byId = {};
    chat.messages.forEach(function (m) { byId[m.id] = m; });
    Array.prototype.forEach.call($('messages').querySelectorAll('.msg.me'), function (el) {
      var m = byId[el.getAttribute('data-mid')];
      var tick = el.querySelector('.tick');
      if (m && tick && chat.peerSeenTs && m.ts <= chat.peerSeenTs) {
        tick.className = 'tick read'; tick.textContent = '✓✓';
      }
    });
  }
  function markRead(peer) {
    var chat = chats[peer];
    if (!chat) return;
    chat.unread = 0;
    var received = chat.messages.filter(function (m) { return !m.mine; });
    if (received.length) {
      var last = received[received.length - 1];
      lastRead[peer] = last.ts;
      saveJSON(LS_LASTREAD, lastRead);
      client.sendReceipt(peer, last.id, last.ts);
    }
    renderChatList();
  }

  /* ---------- enviar ---------- */
  var ta = $('msg-input');
  ta.addEventListener('input', function () {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    var now = Date.now();
    if (openPeer && now - typingSentAt > 3000 && ta.value.length > 0) {
      typingSentAt = now;
      client.sendTyping(openPeer);
    }
  });
  ta.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = ta.value.trim();
    if (!text || !openPeer) return;
    ta.value = ''; ta.style.height = 'auto';
    var peer = openPeer;
    var chat = ensureChat(peer);
    var tmpId = 'tmp' + Date.now();
    var msg = { id: tmpId, peer: peer, mine: true, ts: Math.floor(Date.now() / 1000), text: text };
    chat.messages.push(msg);
    chat.lastTs = msg.ts;
    appendOrUpdateMessage(msg, true);
    renderChatList();
    client.sendDM(peer, text.slice(0, 2000)).then(function (r) {
      // reconciliar: reemplazar el temporal por el evento real
      seenIds[r.event.id] = 1;
      msg.id = r.event.id; msg.ts = r.event.created_at;
      var el = document.querySelector('[data-mid="' + tmpId + '"]');
      if (el) el.setAttribute('data-mid', r.event.id);
      renderChatList();
    }).catch(function (err) {
      msg.text = text + ' ⚠️ (no se pudo enviar)';
      renderMessages(chat);
    });
  });

  /* ---------- nuevo chat ---------- */
  function openModal() {
    $('modal-new').hidden = false;
    $('peer-npub').value = '';
    $('newchat-error').hidden = true;
    setTimeout(function () { $('peer-npub').focus(); }, 50);
  }
  function closeModal() { $('modal-new').hidden = true; }
  $('fab-new').addEventListener('click', openModal);
  $('modal-close').addEventListener('click', closeModal);
  $('modal-new').addEventListener('click', function (e) { if (e.target === $('modal-new')) closeModal(); });
  $('btn-copy-npub').addEventListener('click', function () { copyText(me.npub, $('btn-copy-npub')); });

  $('btn-open-chat').addEventListener('click', function () {
    var err = $('newchat-error'); err.hidden = true;
    var raw = $('peer-npub').value.trim();
    var peer;
    try { peer = pubkeyFromNpub(raw); }
    catch (e) { err.textContent = 'ID inválido. Pega un npub1… de tu contacto.'; err.hidden = false; return; }
    if (peer === me.pubkey) { err.textContent = 'Ese eres tú 😄'; err.hidden = false; return; }
    closeModal();
    ensureChat(peer);
    // buscar su nombre
    client.fetchProfile(peer).then(function (p) {
      if (p && p.name) {
        profiles[peer] = { name: p.name, at: p._at };
        saveJSON(LS_PROFILES, profiles);
        chats[peer].name = p.name;
      }
      openChat(peer);
      renderChatList();
    }).catch(function () { openChat(peer); });
  });

  /* ---------- ajustes ---------- */
  $('btn-settings').addEventListener('click', function () {
    $('modal-settings').hidden = false;
    renderRelayList();
  });
  $('settings-close').addEventListener('click', function () { $('modal-settings').hidden = true; });
  $('modal-settings').addEventListener('click', function (e) { if (e.target === $('modal-settings')) $('modal-settings').hidden = true; });
  $('btn-copy-npub2').addEventListener('click', function () { copyText(me.npub, $('btn-copy-npub2')); });
  $('btn-show-nsec').addEventListener('click', function () {
    var box = $('nsec-box');
    if (box.hidden) {
      box.hidden = false;
      $('my-nsec').textContent = localStorage.getItem(LS_NSEC) || '';
      $('btn-show-nsec').textContent = 'Ocultar mi clave privada';
    } else {
      box.hidden = true;
      $('btn-show-nsec').textContent = 'Ver mi clave privada';
    }
  });
  $('btn-copy-nsec').addEventListener('click', function () {
    copyText(localStorage.getItem(LS_NSEC) || '', $('btn-copy-nsec'));
  });
  $('btn-logout').addEventListener('click', function () {
    if (!confirm('¿Borrar tu identidad de este teléfono?\n\nSOLO hazlo si guardaste tu clave privada (nsec) en otro lugar. Sin ella no podrás recuperar tus chats.')) return;
    try {
      localStorage.removeItem(LS_NSEC);
    } catch (e) {}
    location.reload();
  });

  function renderRelayStatus() {
    var states = Object.keys(relayStates).map(function (u) { return relayStates[u]; });
    var open = states.filter(function (s) { return s === 'open'; }).length;
    $('relay-status').textContent = open > 0 ? '● ' + open + ' relay' + (open > 1 ? 's' : '') : 'conectando…';
    $('relay-status').style.color = open > 0 ? '#25d366' : '#8696a0';
  }
  function renderRelayList() {
    var box = $('relay-list');
    box.innerHTML = '';
    getRelays().forEach(function (url) {
      var st = relayStates[url] || 'down';
      var dot = st === 'open' ? '🟢' : (st === 'connecting' ? '🟡' : '🔴');
      var div = document.createElement('div');
      div.className = 'relay-row';
      div.innerHTML = '<span>' + dot + '</span><code>' + esc(url) + '</code>';
      var del = document.createElement('button');
      del.className = 'mini danger-text'; del.textContent = '✕'; del.title = 'Eliminar';
      del.addEventListener('click', function () {
        var r = getRelays().filter(function (x) { return x !== url; });
        saveJSON(LS_RELAYS, r);
        renderRelayList();
        setTimeout(function () { location.reload(); }, 400);
      });
      div.appendChild(del);
      box.appendChild(div);
    });
  }
  $('btn-relay-add').addEventListener('click', function () {
    var url = $('relay-add').value.trim();
    if (!/^wss?:\/\/.+/.test(url)) return;
    var r = getRelays();
    if (r.indexOf(url) < 0) { r.push(url); saveJSON(LS_RELAYS, r); }
    $('relay-add').value = '';
    renderRelayList();
    setTimeout(function () { location.reload(); }, 400);
  });

  /* ---------- arranque ---------- */
  (function boot() {
    var nsec = null;
    try { nsec = localStorage.getItem(LS_NSEC); } catch (e) {}
    if (nsec) {
      try {
        var id = importIdentity(nsec);
        bootIdentity(id, null, false);
        return;
      } catch (e) { try { localStorage.removeItem(LS_NSEC); } catch (e2) {} }
    }
    show('identity');
  })();
})();
