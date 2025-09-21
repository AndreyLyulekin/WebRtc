const $ = (id) => document.getElementById(id);
const log = () => {};
const addMsg = (cls, text) => {
  const p = document.createElement('p');
  p.className = 'msg ' + cls;
  p.textContent = text;
  $('chatMessages').appendChild(p);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
};

let ws; // WebSocket signaling
let pc; // RTCPeerConnection
let dc; // RTCDataChannel (for chat over WebRTC)
let makingOffer = false; // perfect negotiation flags
let ignoreOffer = false;
let polite = false;
let joined = false;

let localStream;

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

$('chatInput').disabled = true;
$('chatSend').disabled = true;
function setChatEnabled(on) {
  $('chatInput').disabled = !on;
  $('chatSend').disabled = !on;
}

$('joinBtn').onclick = () => {
  const room = $('room').value.trim();
  const name = $('name').value.trim();
  if (!room || !name) return alert('Enter both Room ID and Name');

  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', roomId: room, name }));
    $('joinBtn').disabled = true;
    $('leaveBtn').disabled = false;
    $('startBtn').disabled = false;
    log('Connected to signaling. Room:', room);
  };

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'peers') {
      $('peerCount').textContent = `Peers in room (excluding you): ${msg.count}`;
      polite = msg.count > 0; // if someone is already there, be polite
      if (!joined) {
        joined = true;
        setChatEnabled(true); // можно писать в чат (через WS-фолбэк), даже до WebRTC
      }
    } else if (msg.type === 'chat') {
      addMsg('sys', `${msg.from}: ${msg.text}`);
    } else if (msg.type === 'peer-left') {
      log('Peer left.');
    } else if (msg.type === 'signal') {
      await onSignal(msg.data);
    }
  };

  ws.onclose = () => {
    $('joinBtn').disabled = false;
    $('leaveBtn').disabled = true;
    $('startBtn').disabled = true;
    $('callBtn').disabled = true;
    $('hangupBtn').disabled = true;
    $('peerCount').textContent = '';
    setChatEnabled(false);
    joined = false;
  };
};

$('leaveBtn').onclick = () => {
  if (ws) ws.close();
  hangUp();
};

$('startBtn').onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    $('localVideo').srcObject = localStream;
    $('callBtn').disabled = false;
    log('Got local media');
  } catch (e) {
    alert('Failed to get camera/mic: ' + e.message);
  }
};

$('callBtn').onclick = async () => {
  await ensurePeerConnection();
  // Create the DataChannel for chat (caller side)
  if (!dc || dc.readyState === 'closed') createDataChannel();
  await negotiate();
};

$('hangupBtn').onclick = () => hangUp();

$('chatSend').onclick = () => sendChat();
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

function getWsUrl() {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}`;
}

function sendChat() {
  const text = $('chatInput').value.trim();
  if (!text) return;
  if (dc && dc.readyState === 'open') {
    dc.send(text);
    addMsg('me', `You: ${text}`);
  } else if (ws && ws.readyState === WebSocket.OPEN) {
    // optional: fallback chat via signaling before WebRTC is up
    ws.send(JSON.stringify({ type: 'chat', text }));
    addMsg('me', `You: ${text}`);
  }
  $('chatInput').value = '';
}

async function ensurePeerConnection() {
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  $('hangupBtn').disabled = false;

  // Add local tracks
  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  }

  // Remote track
  pc.ontrack = (ev) => {
    $('remoteVideo').srcObject = ev.streams[0];
  };

  // ICE candidates -> signal to remote
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) ws?.send(JSON.stringify({ type: 'signal', data: { candidate } }));
  };

  // DataChannel (answerer side)
  pc.ondatachannel = (ev) => {
    dc = ev.channel;
    wireChannel();
  };

  // Perfect Negotiation pattern to avoid glare
  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws?.send(JSON.stringify({ type: 'signal', data: { description: pc.localDescription } }));
      log('Sent offer');
    } catch (e) {
      console.error(e);
    } finally {
      makingOffer = false;
    }
  };

  return pc;
}

function createDataChannel() {
  dc = pc.createDataChannel('chat', { ordered: true });
  wireChannel();
}

function wireChannel() {
  if (!dc) return;
  dc.onopen = () => log('DataChannel open');
  dc.onclose = () => log('DataChannel closed');
  dc.onmessage = (ev) => addMsg('sys', `Peer: ${ev.data}`);
}

async function negotiate() {
  // Trigger onnegotiationneeded pathway
  // If tracks were added earlier, simply rely on that
  if (pc.signalingState === 'stable' && !makingOffer) {
    // calling addTransceiver nudges negotiation if needed
    // (no-op if already negotiated)
    pc.getTransceivers();
  }
}

async function onSignal({ description, candidate }) {
  await ensurePeerConnection();

  try {
    if (description) {
      const readyForOffer =
        !makingOffer && (pc.signalingState === 'stable' || (polite && pc.signalingState === 'have-local-offer'));
      const offerCollision = description.type === 'offer' && !readyForOffer;
      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) {
        log('Ignoring offer (not polite and in collision)');
        return;
      }

      await pc.setRemoteDescription(description);
      log('Set remote description:', description.type);

      if (description.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws?.send(JSON.stringify({ type: 'signal', data: { description: pc.localDescription } }));
        log('Sent answer');
      }
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        if (!ignoreOffer) throw err; // suppress if ignoring offers
      }
    }
  } catch (e) {
    console.error(e);
  }
}

function hangUp() {
  if (dc) {
    try {
      dc.close();
    } catch {}
    dc = null;
  }
  if (pc) {
    pc.getSenders().forEach((s) => s.track && s.track.stop());
    pc.close();
    pc = null;
  }
  $('remoteVideo').srcObject = null;
  $('hangupBtn').disabled = true;
  log('Call ended');
}
