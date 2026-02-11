// ==== RAYCAST LOBBY + ROOMS + WORLD + CHAT + WEBRTC SIGNALING (WS) ====
// install: npm i ws
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const rooms = new Map();   // roomId -> room
const clients = new Map(); // ws -> { playerId, roomId, nickname }

function uid(n = 6) { return crypto.randomBytes(n).toString("hex"); }
function now() { return Date.now(); }

function makeCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[(Math.random() * chars.length) | 0];
  return out;
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function error(ws, message) { send(ws, { t: "error", message }); }

function safeRoomForList(r) {
  return {
    id: r.id,
    name: r.name,
    visibility: r.visibility, // public/private
    lock: r.lock,             // none/code/password
    codeRequired: r.visibility === "private" && r.lock === "code",
    passwordRequired: r.visibility === "private" && r.lock === "password",
    maxPlayers: r.maxPlayers,
    players: r.players.size,
    status: r.players.size >= r.maxPlayers ? "full" : "open",
    createdAt: r.createdAt
  };
}

function broadcastRooms() {
  const list = Array.from(rooms.values()).map(safeRoomForList);
  const msg = JSON.stringify({ t: "rooms", rooms: list });
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastToRoom(roomId, obj) {
  const msg = JSON.stringify(obj);
  for (const [ws, c] of clients) {
    if (c.roomId === roomId && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function roomRoster(roomId) {
  const roster = [];
  for (const c of clients.values()) {
    if (c.roomId === roomId) roster.push({ id: c.playerId, nickname: c.nickname || "Player" });
  }
  return roster;
}

function leaveRoom(ws) {
  const c = clients.get(ws);
  if (!c || !c.roomId) return;

  const r = rooms.get(c.roomId);
  const roomId = c.roomId;

  if (r) {
    r.players.delete(c.playerId);
    r.states.delete(c.playerId);
    if (r.players.size === 0) rooms.delete(r.id);
  }
  c.roomId = null;

  // avisar a los otros para que cierren peers
  broadcastToRoom(roomId, { t: "peer_left", id: c.playerId });

  broadcastRooms();
}

function createRoom(ws, msg) {
  const c = clients.get(ws);
  if (!c) return error(ws, "Cliente inválido.");
  if (c.roomId) return error(ws, "Ya estás en una sala. Salí primero.");

  const vis = msg.visibility === "private" ? "private" : "public";
  const mp = Math.max(2, Math.min(16, Number(msg.maxPlayers || 2)));

  let lock = "none";
  let password = null;
  let code = null;

  if (vis === "private") {
    lock = msg.lock === "password" ? "password" : "code";
    if (lock === "password") {
      password = String(msg.password || "");
      if (password.length < 3) return error(ws, "Contraseña muy corta (mínimo 3).");
    } else {
      code = makeCode(6);
    }
  }

  const room = {
    id: uid(4),
    name: String(msg.name || "Sala").slice(0, 24),
    visibility: vis,
    lock,
    password, // demo plain text
    code,
    maxPlayers: mp,
    players: new Set(),
    createdAt: now(),
    states: new Map(), // playerId -> state
  };

  rooms.set(room.id, room);
  send(ws, { t: "created", room: safeRoomForList(room), code: room.code || null });
  broadcastRooms();
}

function joinRoom(ws, msg) {
  const c = clients.get(ws);
  if (!c) return error(ws, "Cliente inválido.");
  if (c.roomId) return error(ws, "Ya estás en una sala.");

  const r = rooms.get(msg.roomId);
  if (!r) return error(ws, "Sala no existe.");
  if (r.players.size >= r.maxPlayers) return error(ws, "Sala llena.");

  if (r.visibility === "private") {
    if (r.lock === "code" && msg.code !== r.code) return error(ws, "Código incorrecto.");
    if (r.lock === "password" && msg.password !== r.password) return error(ws, "Contraseña incorrecta.");
  }

  c.nickname = String(msg.nickname || "Player").slice(0, 18);
  c.roomId = r.id;
  r.players.add(c.playerId);

  send(ws, { t: "joined", room: safeRoomForList(r), playerId: c.playerId });

  // mandar roster al que entra
  send(ws, { t: "roster", roster: roomRoster(r.id) });
  // avisar a los demás que alguien entró
  broadcastToRoom(r.id, { t: "peer_joined", id: c.playerId, nickname: c.nickname });

  broadcastRooms();
}

function handleState(ws, msg) {
  const c = clients.get(ws);
  if (!c || !c.roomId) return;

  const r = rooms.get(c.roomId);
  if (!r) return;

  const s = msg.state || {};
  const x = Number.isFinite(s.x) ? s.x : 0;
  const y = Number.isFinite(s.y) ? s.y : 0;
  const a = Number.isFinite(s.a) ? s.a : 0;
  const z = Number.isFinite(s.z) ? s.z : 0;

  r.states.set(c.playerId, { id: c.playerId, nickname: c.nickname, x, y, a, z });

  broadcastToRoom(r.id, { t: "world", players: Array.from(r.states.values()) });
}

function handleChat(ws, msg) {
  const c = clients.get(ws);
  if (!c || !c.roomId) return;

  const text = String(msg.text || "").slice(0, 220);
  if (!text.trim()) return;

  broadcastToRoom(c.roomId, {
    t: "chat",
    from: c.nickname || "Player",
    id: c.playerId,
    text,
    at: Date.now()
  });
}

// WebRTC signaling (offer/answer/ice) => reenviar al target dentro de la sala
function handleRTC(ws, msg) {
  const c = clients.get(ws);
  if (!c || !c.roomId) return;
  const to = String(msg.to || "");
  if (!to) return;

  // buscar websocket del target
  let targetWS = null;
  for (const [w, cc] of clients) {
    if (cc.playerId === to && cc.roomId === c.roomId) { targetWS = w; break; }
  }
  if (!targetWS) return;

  send(targetWS, {
    t: msg.t,          // rtc_offer / rtc_answer / rtc_ice
    from: c.playerId,
    payload: msg.payload
  });
}

wss.on("connection", (ws) => {
  const playerId = uid(6);
  clients.set(ws, { playerId, roomId: null, nickname: "Player" });

  send(ws, { t: "welcome", playerId });
  send(ws, { t: "rooms", rooms: Array.from(rooms.values()).map(safeRoomForList) });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === "list") return send(ws, { t: "rooms", rooms: Array.from(rooms.values()).map(safeRoomForList) });
    if (msg.t === "create_room") return createRoom(ws, msg);
    if (msg.t === "join_room") return joinRoom(ws, msg);
    if (msg.t === "leave_room") return leaveRoom(ws);
    if (msg.t === "state") return handleState(ws, msg);
    if (msg.t === "chat") return handleChat(ws, msg);

    // WebRTC signaling:
    if (msg.t === "rtc_offer" || msg.t === "rtc_answer" || msg.t === "rtc_ice") return handleRTC(ws, msg);

    return error(ws, "Tipo desconocido.");
  });

  ws.on("close", () => {
    leaveRoom(ws);
    clients.delete(ws);
    broadcastRooms();
  });
});

console.log("Servidor multiplayer iniciado en puerto " + PORT);
