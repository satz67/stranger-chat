const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const path     = require("path");
const crypto   = require("crypto");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 10e6 });
const PORT   = process.env.PORT || 3000;

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── In-memory stores ──────────────────────────────────────────
const users    = {};   // username → { passwordHash, salt, pfp, createdAt }
const sessions = {};   // token → username
const ROOMS = {
  general: { name:"General",       emoji:"💬", description:"Talk about anything" },
  chill:   { name:"Chill Zone",    emoji:"🌙", description:"Relax & unwind" },
  games:   { name:"Games & Memes", emoji:"🎮", description:"Fun stuff only" },
  music:   { name:"Music Vibes",   emoji:"🎵", description:"Share what you're hearing" }
};
const messageHistory   = {};
const roomUsers        = {};  // roomId → Set<socketId>
const socketUser       = {};  // socketId → { username, token }
const callParticipants = {};

Object.keys(ROOMS).forEach(id => {
  messageHistory[id]   = [];
  roomUsers[id]        = new Set();
  callParticipants[id] = new Set();
});

// ── Auth helpers ──────────────────────────────────────────────
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, "sha256").toString("hex");
}
function generateToken() { return crypto.randomBytes(32).toString("hex"); }

// ── Auth REST endpoints ───────────────────────────────────────
app.post("/api/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: "Missing fields" });
  if (username.length < 3 || username.length > 20) return res.json({ ok: false, error: "Username must be 3–20 chars" });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.json({ ok: false, error: "Letters, numbers, underscores only" });
  if (password.length < 4) return res.json({ ok: false, error: "Password must be 4+ chars" });
  if (users[username.toLowerCase()]) return res.json({ ok: false, error: "Username taken" });
  const salt = crypto.randomBytes(16).toString("hex");
  users[username.toLowerCase()] = { username, passwordHash: hashPassword(password, salt), salt, pfp: null, createdAt: Date.now() };
  const token = generateToken();
  sessions[token] = username.toLowerCase();
  res.json({ ok: true, token, username });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: "Missing fields" });
  const user = users[username.toLowerCase()];
  if (!user) return res.json({ ok: false, error: "User not found" });
  if (hashPassword(password, user.salt) !== user.passwordHash) return res.json({ ok: false, error: "Wrong password" });
  const token = generateToken();
  sessions[token] = username.toLowerCase();
  res.json({ ok: true, token, username: user.username, pfp: user.pfp });
});

app.post("/api/pfp", (req, res) => {
  const { token, pfp } = req.body;
  const ukey = sessions[token];
  if (!ukey) return res.json({ ok: false, error: "Not logged in" });
  if (pfp && pfp.length > 2e6) return res.json({ ok: false, error: "Image too large (max 1.5MB)" });
  users[ukey].pfp = pfp || null;
  // Notify all sockets of this user about pfp change
  io.emit("pfp_update", { username: users[ukey].username, pfp: users[ukey].pfp });
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const token = req.headers["authorization"];
  const ukey  = sessions[token];
  if (!ukey) return res.json({ ok: false });
  const u = users[ukey];
  res.json({ ok: true, username: u.username, pfp: u.pfp });
});

// ── Helpers ───────────────────────────────────────────────────
function getRoomCount(id) { return roomUsers[id] ? roomUsers[id].size : 0; }
function getAllCounts() { const c={}; Object.keys(ROOMS).forEach(id=>{c[id]=getRoomCount(id);}); return c; }
function getCallInfo(roomId) {
  return { active: callParticipants[roomId].size>0, count: callParticipants[roomId].size,
    participants: [...callParticipants[roomId]].map(sid=>({ socketId:sid, username:socketUser[sid]?.username })) };
}
function getUserPfp(username) {
  const u = users[username?.toLowerCase()]; return u ? u.pfp : null;
}

// ── Socket.io ─────────────────────────────────────────────────
io.on("connection", (socket) => {

  socket.on("auth", ({ token }) => {
    const ukey = sessions[token];
    if (!ukey) { socket.emit("auth_fail"); return; }
    const user = users[ukey];
    socketUser[socket.id] = { username: user.username, token };
    socket.emit("auth_ok", { username: user.username, pfp: user.pfp, rooms: ROOMS, counts: getAllCounts() });
  });

  socket.on("join_room", (roomId) => {
    if (!ROOMS[roomId] || !socketUser[socket.id]) return;
    const { username } = socketUser[socket.id];
    Object.keys(ROOMS).forEach(id => {
      if (socket.rooms.has(id)) {
        socket.leave(id); roomUsers[id].delete(socket.id);
        if (callParticipants[id].has(socket.id)) { callParticipants[id].delete(socket.id); io.to(id).emit("call_update", getCallInfo(id)); }
        io.to(id).emit("room_count", { roomId:id, count:getRoomCount(id) });
        io.to(id).emit("user_left", { username, roomId:id });
      }
    });
    socket.join(roomId); roomUsers[roomId].add(socket.id);
    socket.emit("history", { roomId, messages: messageHistory[roomId] });
    socket.emit("call_update", getCallInfo(roomId));
    io.to(roomId).emit("room_count", { roomId, count:getRoomCount(roomId) });
    io.to(roomId).emit("user_joined", { username, pfp:getUserPfp(username), roomId });
    io.emit("all_counts", getAllCounts());
  });

  socket.on("send_message", ({ roomId, text, mediaData, mediaType, mediaName }) => {
    if (!ROOMS[roomId] || !socketUser[socket.id]) return;
    const { username } = socketUser[socket.id];
    const msg = {
      id: `${Date.now()}-${socket.id.slice(0,4)}`,
      username, pfp: getUserPfp(username),
      text: text ? text.trim().slice(0,500) : null,
      mediaData: mediaData || null,
      mediaType: mediaType || null,
      mediaName: mediaName || null,
      ts: Date.now()
    };
    messageHistory[roomId].push(msg);
    if (messageHistory[roomId].length > 50) messageHistory[roomId].shift();
    io.to(roomId).emit("new_message", { roomId, message: msg });
  });

  socket.on("typing_start", ({ roomId }) => { if(socketUser[socket.id]) socket.to(roomId).emit("typing_start", { username:socketUser[socket.id].username, roomId }); });
  socket.on("typing_stop",  ({ roomId }) => { if(socketUser[socket.id]) socket.to(roomId).emit("typing_stop",  { username:socketUser[socket.id].username, roomId }); });

  socket.on("call_join", ({ roomId }) => {
    if (!ROOMS[roomId] || !socketUser[socket.id]) return;
    callParticipants[roomId].add(socket.id);
    socket.to(roomId).emit("call_user_joined", { socketId:socket.id, username:socketUser[socket.id].username });
    socket.emit("call_existing_participants", { participants: [...callParticipants[roomId]].filter(s=>s!==socket.id).map(s=>({ socketId:s, username:socketUser[s]?.username })) });
    io.to(roomId).emit("call_update", getCallInfo(roomId));
  });

  socket.on("call_leave", ({ roomId }) => {
    callParticipants[roomId].delete(socket.id);
    io.to(roomId).emit("call_user_left", { socketId:socket.id, username:socketUser[socket.id]?.username });
    io.to(roomId).emit("call_update", getCallInfo(roomId));
  });

  socket.on("rtc_offer",  ({ to, offer })     => io.to(to).emit("rtc_offer",  { from:socket.id, username:socketUser[socket.id]?.username, offer }));
  socket.on("rtc_answer", ({ to, answer })    => io.to(to).emit("rtc_answer", { from:socket.id, answer }));
  socket.on("rtc_ice",    ({ to, candidate }) => io.to(to).emit("rtc_ice",    { from:socket.id, candidate }));

  socket.on("disconnect", () => {
    const info = socketUser[socket.id];
    if (!info) return;
    Object.keys(ROOMS).forEach(id => {
      if (roomUsers[id].has(socket.id)) { roomUsers[id].delete(socket.id); io.to(id).emit("room_count",{roomId:id,count:getRoomCount(id)}); io.to(id).emit("user_left",{username:info.username,roomId:id}); }
      if (callParticipants[id].has(socket.id)) { callParticipants[id].delete(socket.id); io.to(id).emit("call_user_left",{socketId:socket.id,username:info.username}); io.to(id).emit("call_update",getCallInfo(id)); }
    });
    io.emit("all_counts", getAllCounts());
    delete socketUser[socket.id];
  });
});

server.listen(PORT, () => console.log(`\n  ✦ Stranger running → http://localhost:${PORT}\n`));
