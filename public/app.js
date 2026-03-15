(() => {
  'use strict';

  // ─── DOM ───
  const $ = id => document.getElementById(id);
  const loginScreen  = $('login-screen');
  const roomScreen   = $('room-screen');
  const usernameIn   = $('username');
  const roomIdIn     = $('room-id');
  const joinBtn      = $('join-btn');
  const genRoomBtn   = $('generate-room-btn');
  const loginError   = $('login-error');
  const roomName     = $('room-name');
  const userCount    = $('user-count');
  const usersGrid    = $('users-grid');
  const leaveBtn     = $('leave-btn');
  const micBtn       = $('mic-btn');

  // ─── State ───
  let ws = null;
  let localStream = null;
  let myId = null;
  let myName = '';
  let currentRoom = '';
  let isMuted = false;
  const peers = new Map();       // userId -> RTCPeerConnection
  const audioEls = new Map();    // userId -> <audio>
  let roomUsers = [];            // [{id, name, muted}]

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
  ];

  // ─── Yardımcılar ───
  function showScreen(screen) {
    loginScreen.classList.remove('active');
    roomScreen.classList.remove('active');
    screen.classList.add('active');
  }

  function showError(msg) {
    loginError.textContent = msg;
    setTimeout(() => { loginError.textContent = ''; }, 4000);
  }

  function genRoomId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
  }

  function getInitial(name) {
    return name ? name.charAt(0).toUpperCase() : '?';
  }

  // ─── UI Render ───
  function renderUsers() {
    usersGrid.innerHTML = '';
    userCount.textContent = roomUsers.length;

    roomUsers.forEach(u => {
      const card = document.createElement('div');
      card.className = 'user-card';
      if (u.id === myId) card.classList.add('you');
      if (u.muted) card.classList.add('muted');
      card.id = 'card-' + u.id;

      card.innerHTML = `
        <div class="user-avatar">${getInitial(u.name)}</div>
        <div class="user-name">${escapeHtml(u.name)}${u.id === myId ? ' (Sen)' : ''}</div>
        <div class="user-status">${u.muted ? '🔇 Sessiz' : '🎙️ Aktif'}</div>
      `;
      usersGrid.appendChild(card);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── WebSocket ───
  function connectWS() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'join',
        name: myName,
        roomId: currentRoom
      }));
    };

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);

      switch (msg.type) {
        case 'joined':
          myId = msg.userId;
          roomUsers = msg.users;
          roomName.textContent = currentRoom;
          showScreen(roomScreen);
          renderUsers();
          // Mevcut kullanıcılara bağlan (offer gönder)
          msg.users.forEach(u => {
            if (u.id !== myId) createPeer(u.id, true);
          });
          break;

        case 'user-joined':
          roomUsers = msg.users;
          renderUsers();
          break;

        case 'user-left':
          roomUsers = msg.users;
          renderUsers();
          closePeer(msg.userId);
          break;

        case 'user-muted':
          roomUsers = roomUsers.map(u =>
            u.id === msg.userId ? { ...u, muted: msg.muted } : u
          );
          renderUsers();
          break;

        case 'offer': {
          const pc = createPeer(msg.senderId, false);
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(JSON.stringify({
            type: 'answer',
            targetId: msg.senderId,
            sdp: answer
          }));
          break;
        }

        case 'answer': {
          const pc = peers.get(msg.senderId);
          if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          break;
        }

        case 'ice-candidate': {
          const pc = peers.get(msg.senderId);
          if (pc && msg.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
          break;
        }

        case 'error':
          showError(msg.message);
          break;
      }
    };

    ws.onclose = () => {
      cleanup();
      showScreen(loginScreen);
      showError('Bağlantı kesildi');
    };

    ws.onerror = () => {
      cleanup();
    };
  }

  // ─── WebRTC ───
  function createPeer(targetId, initiator) {
    if (peers.has(targetId)) closePeer(targetId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers.set(targetId, pc);

    // Lokal ses ekle
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    // Uzak ses al
    pc.ontrack = (e) => {
      let audio = audioEls.get(targetId);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        
        // Audio elementini DOM'a ekle (iOS ve bazı tarayıcılarda garbage collection / silinme sorununu çözer)
        let container = document.getElementById('audio-container');
        if (!container) {
          container = document.createElement('div');
          container.id = 'audio-container';
          container.style.display = 'none';
          document.body.appendChild(container);
        }
        container.appendChild(audio);
        
        audioEls.set(targetId, audio);
      }
      audio.srcObject = e.streams[0];
      
      // Mobilde otomatik oynatmayı zorla
      audio.play().catch(err => console.error("Otomatik oynatma engellendi:", err));
    };

    // ICE adayları
    pc.onicecandidate = (e) => {
      if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ice-candidate',
          targetId,
          candidate: e.candidate
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') closePeer(targetId);
    };

    if (initiator) {
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
          ws.send(JSON.stringify({
            type: 'offer',
            targetId,
            sdp: pc.localDescription
          }));
        });
    }

    return pc;
  }

  function closePeer(userId) {
    const pc = peers.get(userId);
    if (pc) { pc.close(); peers.delete(userId); }
    const audio = audioEls.get(userId);
    if (audio) { 
      audio.srcObject = null; 
      if (audio.parentNode) audio.parentNode.removeChild(audio);
      audioEls.delete(userId); 
    }
  }

  // ─── Mikrofon ───
  async function getMic() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      return true;
    } catch {
      showError('Mikrofon erişimi reddedildi');
      return false;
    }
  }

  function toggleMute() {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });

    micBtn.className = 'control-btn ' + (isMuted ? 'mic-off' : 'mic-on');
    micBtn.querySelector('.control-icon').textContent = isMuted ? '🔇' : '🎙️';

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'mute-toggle' }));
    }
  }

  // ─── Temizlik ───
  function cleanup() {
    peers.forEach((pc, id) => closePeer(id));
    peers.clear();
    audioEls.clear();
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    roomUsers = [];
    myId = null;
    isMuted = false;
    micBtn.className = 'control-btn mic-on';
    micBtn.querySelector('.control-icon').textContent = '🎙️';
  }

  // ─── Odaya Katıl ───
  async function joinRoom() {
    const name = usernameIn.value.trim();
    const room = roomIdIn.value.trim();

    if (!name) return showError('Kullanıcı adı gerekli');
    if (!room) return showError('Oda kodu gerekli');
    if (name.length > 20) return showError('İsim çok uzun (max 20)');

    const micOk = await getMic();
    if (!micOk) return;

    myName = name;
    currentRoom = room;
    joinBtn.disabled = true;
    joinBtn.textContent = 'Bağlanıyor...';

    connectWS();

    setTimeout(() => {
      joinBtn.disabled = false;
      joinBtn.textContent = 'Odaya Katıl';
    }, 3000);
  }

  function leaveRoom() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'leave' }));
      ws.close();
    }
    cleanup();
    showScreen(loginScreen);
  }

  // ─── Event Listeners ───
  joinBtn.addEventListener('click', joinRoom);
  leaveBtn.addEventListener('click', leaveRoom);
  micBtn.addEventListener('click', toggleMute);
  genRoomBtn.addEventListener('click', () => { roomIdIn.value = genRoomId(); });

  usernameIn.addEventListener('keydown', e => { if (e.key === 'Enter') roomIdIn.focus(); });
  roomIdIn.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
})();
