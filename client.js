const $ = (id) => document.getElementById(id);

let pc, dc, localStream;
let joined = false;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' }, // публичный STUN
];

initControls();

$('joinBtn').onclick = () => {
  const room = $('room').value.trim();
  const name = $('name').value.trim();
  if (!room || !name) return alert('Введите и Room ID, и Name');
  joined = true;
  $('status').textContent = `Joined as ${name} in room ${room}`;
  $('mediaBtn').disabled = false;
  $('offerBtn').disabled = false;
  $('acceptOfferBtn').disabled = false;
  $('applyAnswerBtn').disabled = false;
};

$('mediaBtn').onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    $('localVideo').srcObject = localStream;
    ensurePC(); // чтобы треки добавились, если PC уже был создан
  } catch (e) {
    alert('Не удалось получить камеру/микрофон: ' + e.message);
  }
};

$('offerBtn').onclick = async () => {
  if (!joined) return;

  ensurePC(true);                 // отправитель создаёт DataChannel
  await addLocalOrReceivers();    // добавим треки или recvonly-транссиверы

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceComplete();        // no-trickle: ждём полную сборку ICE

  const payload = {
    type: 'offer',
    sdp: pc.localDescription.sdp,
    room: $('room').value.trim(),
    name: $('name').value.trim(),
    ts: Date.now(),
  };
  $('offerOut').value = JSON.stringify(payload);
  $('copyOfferBtn').disabled = false;
  $('applyAnswerBtn').disabled = false;
};

$('copyOfferBtn').onclick = async () => {
  await navigator.clipboard.writeText($('offerOut').value);
};

$('acceptOfferBtn').onclick = async () => {
  if (!joined) return;

  let data;
  try {
    data = JSON.parse($('offerIn').value);
  } catch {
    return alert('Неверный JSON оффера');
  }
  if (data.type !== 'offer' || !data.sdp) return alert('Это не оффер');

  ensurePC(false);                // получатель: не создаёт DataChannel вручную
  await addLocalOrReceivers();

  await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIceComplete();

  const payload = {
    type: 'answer',
    sdp: pc.localDescription.sdp,
    room: $('room').value.trim(),
    name: $('name').value.trim(),
    ts: Date.now(),
  };
  $('answerOut').value = JSON.stringify(payload);
  $('copyAnswerBtn').disabled = false;
};

$('copyAnswerBtn').onclick = async () => {
  await navigator.clipboard.writeText($('answerOut').value);
};

$('applyAnswerBtn').onclick = async () => {
  let data;
  try {
    data = JSON.parse($('answerIn').value);
  } catch {
    return alert('Неверный JSON ответа');
  }
  if (data.type !== 'answer' || !data.sdp) return alert('Это не answer');

  await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
};

$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

$('hangupBtn').onclick = () => {
  if (dc) { try { dc.close(); } catch {} dc = null; }
  if (pc) {
    pc.getSenders().forEach(s => s.track && s.track.stop());
    try { pc.close(); } catch {}
    pc = null;
  }
  $('remoteVideo').srcObject = null;
  setChatEnabled(false);
  $('hangupBtn').disabled = true;
  $('peerHint').textContent = '';
  $('status').textContent = 'Disconnected';
};

function ensurePC(createDC = false) {
  if (pc) return pc;

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicegatheringstatechange = () => {
    $('peerHint').textContent = `ICE: ${pc.iceGatheringState}`;
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    $('status').textContent = `State: ${s}`;
    $('hangupBtn').disabled = (s === 'closed' || s === 'failed' || s === 'disconnected');
  };

  pc.ontrack = (ev) => {
    $('remoteVideo').srcObject = ev.streams[0];
  };

  pc.ondatachannel = (ev) => {
    dc = ev.channel;
    wireDC();
  };

  if (createDC) {
    dc = pc.createDataChannel('chat', { ordered: true });
    wireDC();
  }

  return pc;
}

function wireDC() {
  if (!dc) return;
  dc.onopen = () => setChatEnabled(true);
  dc.onclose = () => setChatEnabled(false);
  dc.onmessage = (ev) => addMsg('peer', `Peer: ${ev.data}`);
}

async function addLocalOrReceivers() {
  if (localStream) {
    for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
  } else {
    // чтобы принимать удалённые треки даже без своей камеры/микрофона
    try {
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
    } catch {}
  }
}

function waitIceComplete() {
  // ждём, пока браузер довыгребет кандидаты (чтобы не передавать их отдельно)
  return new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    const onchg = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onchg);
        res();
      }
    };
    pc.addEventListener('icegatheringstatechange', onchg);
    setTimeout(res, 4000); // failsafe
  });
}

function sendChat() {
  const el = $('chatInput');
  const text = el.value.trim();
  if (!text) return;
  if (dc && dc.readyState === 'open') {
    dc.send(text);
    addMsg('me', `You: ${text}`);
  } else {
    alert('DataChannel ещё не установлен');
  }
  el.value = '';
}

function addMsg(cls, text) {
  const p = document.createElement('p');
  p.className = `msg ${cls}`;
  p.textContent = text;
  $('chatMessages').appendChild(p);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
}

function setChatEnabled(on) {
  $('chatInput').disabled = !on;
  $('chatSend').disabled = !on;
}

function initControls() {
  $('mediaBtn').disabled = true;
  $('offerBtn').disabled = true;
  $('hangupBtn').disabled = true;
  $('copyOfferBtn').disabled = true;
  $('acceptOfferBtn').disabled = true;
  $('copyAnswerBtn').disabled = true;
  $('applyAnswerBtn').disabled = true;
  setChatEnabled(false);
}
