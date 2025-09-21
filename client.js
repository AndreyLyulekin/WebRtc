const $ = (id) => document.getElementById(id);

let pc, dc, localStream, remoteStream;
let joined = false;
let localName = '';
let remoteName = 'Peer';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// локальный буфер кандидатов для «Copy Candidates»
const localCands = [];

const enable = (id, on) => { $(id).disabled = !on; };
const setChatEnabled = (on) => { $('chatInput').disabled = !on; $('chatSend').disabled = !on; };

initUI();

/* === JOIN === */
$('joinBtn').onclick = () => {
  localName = $('name').value.trim();
  if (!localName) return alert('Введите Name');
  joined = true;
  $('status').textContent = `Joined as ${localName}`;
  enable('mediaBtn', true);
  // Создать/принять оффер можно и без медиа; но включить — полезно
  enable('acceptOfferBtn', true);
  enable('applyAnswerBtn', true);
  // Разрешим приём чужих кандидатов
  enable('applyCandsFromOffererBtn', true);
  enable('applyCandsFromAnswererBtn', true);
  enable('unmuteBtn', true);
};

/* === MEDIA === */
$('mediaBtn').onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    $('localVideo').srcObject = localStream;
    ensurePC(); // если PC уже есть — добавим треки
    enable('offerBtn', true);
  } catch (e) {
    alert('Не удалось получить камеру/микрофон: ' + e.message);
  }
};

$('unmuteBtn').onclick = () => {
  const v = $('remoteVideo');
  try { v.muted = false; v.play?.(); } catch {}
};

/* === INITIATOR: create/copy offer; apply answer; copy/apply candidates === */
$('offerBtn').onclick = async () => {
  if (!joined) return;

  ensurePC(true);           // инициатор создаёт DataChannel
  addLocalOrReceivers();    // если нет медиа — добавит recvonly транссиверы

  // крошечный оффер (не ждём ICE)
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  $('offerOut').value = JSON.stringify({ type: 'offer', sdp: offer.sdp, name: localName, ts: Date.now() });
  enable('copyOfferBtn', true);
  enable('applyAnswerBtn', true);
};

$('copyOfferBtn').onclick = () => navigator.clipboard.writeText($('offerOut').value);

$('applyAnswerBtn').onclick = async () => {
  let data;
  try { data = JSON.parse($('answerIn').value); } catch { return alert('Неверный JSON ответа'); }
  if (data.type !== 'answer' || !data.sdp) return alert('Это не answer');
  if (data.name) remoteName = data.name;
  await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
};

/* === ANSWERER: accept offer / copy answer === */
$('acceptOfferBtn').onclick = async () => {
  if (!joined) return;

  let data;
  try { data = JSON.parse($('offerIn').value); } catch { return alert('Неверный JSON оффера'); }
  if (data.type !== 'offer' || !data.sdp) return alert('Это не оффер');
  if (data.name) remoteName = data.name;

  ensurePC(false);          // получатель: НЕ создаёт DataChannel вручную

  // ВАЖНО: сначала применяем оффер
  await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });

  // Затем добавляем свои треки (если есть) или recvonly
  addLocalOrReceivers();

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  $('answerOut').value = JSON.stringify({ type: 'answer', sdp: answer.sdp, name: localName, ts: Date.now() });
  enable('copyAnswerBtn', true);
};

$('copyAnswerBtn').onclick = () => navigator.clipboard.writeText($('answerOut').value);

/* === CANDIDATES: copy/apply (trickle) === */
$('copyCandsOffererBtn').onclick = () => {
  const payload = { type: 'candidates', list: localCands, end: true };
  $('candsOutOfferer').value = JSON.stringify(payload);
  navigator.clipboard.writeText($('candsOutOfferer').value);
};
$('copyCandsAnswererBtn').onclick = () => {
  const payload = { type: 'candidates', list: localCands, end: true };
  $('candsOutAnswerer').value = JSON.stringify(payload);
  navigator.clipboard.writeText($('candsOutAnswerer').value);
};

$('applyCandsFromOffererBtn').onclick = async () => {
  let data;
  try { data = JSON.parse($('candsInFromOfferer').value); } catch { return alert('Неверный JSON кандидатов'); }
  await applyRemoteCandidates(data);
};
$('applyCandsFromAnswererBtn').onclick = async () => {
  let data;
  try { data = JSON.parse($('candsInFromAnswerer').value); } catch { return alert('Неверный JSON кандидатов'); }
  await applyRemoteCandidates(data);
};

/* === CHAT === */
$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

/* === HANGUP === */
$('hangupBtn').onclick = () => {
  if (dc) { try { dc.close(); } catch{} dc = null; }
  if (pc) {
    pc.getSenders().forEach(s => s.track && s.track.stop());
    try { pc.close(); } catch{}
    pc = null;
  }
  $('remoteVideo').srcObject = null;
  setChatEnabled(false);
  enable('hangupBtn', false);
  $('iceState').textContent = '';
  $('status').textContent = 'Disconnected';
};

/* === CORE === */
function ensurePC(createDC = false) {
  if (pc) return pc;

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      localCands.push(ev.candidate);
    } else {
      // конец сбора — теперь можно копировать кандидаты
      $('iceState').textContent = `ICE gathered`;
      enable('copyCandsOffererBtn', true);
      enable('copyCandsAnswererBtn', true);
    }
  };

  pc.onicegatheringstatechange = () => {
    $('iceState').textContent = `ICE: ${pc.iceGatheringState}`;
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    $('status').textContent = `State: ${s}`;
    enable('hangupBtn', !(s === 'closed' || s === 'failed' || s === 'disconnected'));
  };

  pc.ontrack = (ev) => {
    if (!remoteStream) remoteStream = new MediaStream();
    remoteStream.addTrack(ev.track);
    const v = $('remoteVideo');
    if (v.srcObject !== remoteStream) v.srcObject = remoteStream;
    v.play?.().catch(() => {}); // на мобиле может требоваться жест
  };

  pc.ondatachannel = (ev) => { dc = ev.channel; wireDC(); };

  if (createDC) { dc = pc.createDataChannel('chat', { ordered: true }); wireDC(); }

  return pc;
}

function wireDC() {
  if (!dc) return;
  dc.onopen = () => {
    setChatEnabled(true);
    // мини-handshake: сообщим своё имя
    try { dc.send(JSON.stringify({ type: 'hello', name: localName })); } catch {}
  };
  dc.onclose = () => setChatEnabled(false);
  dc.onmessage = (ev) => {
    let obj; try { obj = JSON.parse(ev.data); } catch { obj = null; }
    if (obj && obj.type === 'hello' && obj.name) {
      remoteName = obj.name;
    } else if (obj && obj.type === 'chat') {
      addMsg('peer', `${remoteName}: ${obj.text}`);
    } else {
      addMsg('peer', `${remoteName}: ${ev.data}`);
    }
  };
}

function addLocalOrReceivers() {
  if (localStream) {
    for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
  } else {
    // без своей камеры — всё равно сможем принимать удалённое видео/аудио
    try {
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
    } catch {}
  }
}

async function applyRemoteCandidates(data) {
  if (!data || data.type !== 'candidates') return alert('Это не пакет кандидатов');
  for (const c of data.list || []) {
    try { await pc.addIceCandidate(c); } catch (e) { console.error(e); }
  }
  try { await pc.addIceCandidate(null); } catch {}
  alert('Кандидаты применены');
}

function sendChat() {
  const el = $('chatInput');
  const text = el.value.trim();
  if (!text) return;
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify({ type: 'chat', text }));
    addMsg('me', `You: ${text}`);
    el.value = '';
  } else {
    alert('DataChannel ещё не установлен');
  }
}

function addMsg(cls, text) {
  const p = document.createElement('p');
  p.className = `msg ${cls}`;
  p.textContent = text;
  $('chatMessages').appendChild(p);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
}

function initUI() {
  enable('mediaBtn', false);
  enable('offerBtn', false);
  enable('hangupBtn', false);
  enable('copyOfferBtn', false);
  enable('acceptOfferBtn', false);
  enable('copyAnswerBtn', false);
  enable('applyAnswerBtn', false);
  enable('copyCandsOffererBtn', false);
  enable('copyCandsAnswererBtn', false);
  enable('applyCandsFromOffererBtn', false);
  enable('applyCandsFromAnswererBtn', false);
  enable('unmuteBtn', false);
  setChatEnabled(false);
}
