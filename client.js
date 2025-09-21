const $ = (id) => document.getElementById(id);

let pc, dc, localStream, remoteStream;
let joined = false;
let localName = '';
let remoteName = 'Peer';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const enable = (id, on) => { const el = $(id); if (el) el.disabled = !on; };
const setChatEnabled = (on) => { enable('chatInput', on); enable('chatSend', on); };

window.addEventListener('DOMContentLoaded', () => {
  initUI();
  wireHandlers();
});

/* ---------- UI wiring ---------- */
function wireHandlers() {
  $('joinBtn').onclick = onJoin;
  $('mediaBtn').onclick = onGetMedia;
  $('unmuteBtn').onclick = () => {
    const v = $('remoteVideo');
    try { v.muted = false; v.play?.(); } catch {}
  };

  // Initiator
  $('offerBtn').onclick = onCreateOffer;
  $('copyOfferBtn').onclick = () => navigator.clipboard.writeText($('offerOut').value);
  $('applyAnswerBtn').onclick = onApplyAnswer;

  // Answerer
  $('acceptOfferBtn').onclick = onAcceptOffer;
  $('copyAnswerBtn').onclick = () => navigator.clipboard.writeText($('answerOut').value);

  // Chat
  $('chatSend').onclick = sendChat;
  $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

  // Hangup
  $('hangupBtn').onclick = hangup;
}

/* ---------- Join / Media ---------- */
function onJoin() {
  localName = $('name').value.trim();
  if (!localName) return alert('Введите Name');
  joined = true;
  $('status').textContent = `Joined as ${localName}`;

  // Сразу разрешаем и Get Media, и Create Offer
  enable('mediaBtn', true);
  enable('offerBtn', true);
  enable('acceptOfferBtn', true);
  enable('applyAnswerBtn', true);
  enable('unmuteBtn', true);
}

async function onGetMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    $('localVideo').srcObject = localStream;
    // Если PC уже существует — добавим треки (до оффера/ансвера — отлично)
    if (pc && pc.signalingState === 'stable') {
      for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
    }
  } catch (e) {
    alert('Не удалось получить камеру/микрофон: ' + e.message);
  }
}

/* ---------- Offerer flow (no-trickle) ---------- */
async function onCreateOffer() {
  if (!joined) return;

  ensurePC(true);            // инициатор создаёт DataChannel
  addLocalOrReceivers();     // если нет медиа — добавим recvonly транссиверы

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // ждём полного сбора ICE, чтобы включить кандидатов в SDP
  await waitIceComplete(pc);

  $('offerOut').value = JSON.stringify({
    type: 'offer',
    sdp: pc.localDescription.sdp,
    name: localName,
    ts: Date.now(),
  });
  enable('copyOfferBtn', true);
  enable('applyAnswerBtn', true);
}

async function onApplyAnswer() {
  let data;
  try { data = JSON.parse($('answerIn').value); } catch { return alert('Неверный JSON ответа'); }
  if (data.type !== 'answer' || !data.sdp) return alert('Это не answer');
  if (data.name) remoteName = data.name;

  await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
}

/* ---------- Answerer flow (no-trickle) ---------- */
async function onAcceptOffer() {
  if (!joined) return;

  let data;
  try { data = JSON.parse($('offerIn').value); } catch { return alert('Неверный JSON оффера'); }
  if (data.type !== 'offer' || !data.sdp) return alert('Это не оффер');
  if (data.name) remoteName = data.name;

  ensurePC(false);           // получатель: НЕ создаёт DataChannel вручную

  // 1) Сначала применяем оффер
  await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });

  // 2) Затем добавляем свои треки (если есть) или recvonly
  addLocalOrReceivers();

  // 3) Создаём answer и ждём ICE complete, чтобы включить кандидатов
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIceComplete(pc);

  $('answerOut').value = JSON.stringify({
    type: 'answer',
    sdp: pc.localDescription.sdp,
    name: localName,
    ts: Date.now(),
  });
  enable('copyAnswerBtn', true);
}

/* ---------- Helpers ---------- */

// ждём окончания сбора ICE для включения кандидатов в SDP
function waitIceComplete(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => {
      $('iceState').textContent = `ICE: ${pc.iceGatheringState}`;
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    // failsafe таймаут: если что-то залипло — отдаём то, что есть
    setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }, 5000);
  });
}

function ensurePC(createDC = false) {
  if (pc) return pc;

  remoteStream = new MediaStream();
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicegatheringstatechange = () => {
    $('iceState').textContent = `ICE: ${pc.iceGatheringState}`;
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    $('status').textContent = `State: ${s}`;
    enable('hangupBtn', !(s === 'closed' || s === 'failed' || s === 'disconnected'));
  };

  // Критично: собираем единый поток из входящих треков
  pc.ontrack = (ev) => {
    remoteStream.addTrack(ev.track);
    const v = $('remoteVideo');
    if (v.srcObject !== remoteStream) v.srcObject = remoteStream;
    v.play?.().catch(() => {}); // на мобиле может требоваться жест
  };

  // DataChannel
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

function hangup() {
  if (dc) { try { dc.close(); } catch {} dc = null; }
  if (pc) {
    pc.getSenders().forEach(s => s.track && s.track.stop());
    try { pc.close(); } catch {}
    pc = null;
  }
  $('remoteVideo').srcObject = null;
  setChatEnabled(false);
  enable('hangupBtn', false);
  $('iceState').textContent = '';
  $('status').textContent = 'Disconnected';
}

function initUI() {
  enable('mediaBtn', false);
  enable('offerBtn', false);
  enable('hangupBtn', false);
  enable('copyOfferBtn', false);
  enable('acceptOfferBtn', false);
  enable('copyAnswerBtn', false);
  enable('applyAnswerBtn', false);
  enable('unmuteBtn', false);
  setChatEnabled(false);
}
