const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

const ROOMS = {
  general: { name: "General",       emoji: "💬", description: "Talk about anything" },
  chill:   { name: "Chill Zone",    emoji: "🌙", description: "Relax & unwind" },
  games:   { name: "Games & Memes", emoji: "🎮", description: "Fun stuff only" },
  music:   { name: "Music Vibes",   emoji: "🎵", description: "Share what you're hearing" }
};

const messageHistory = {};
const roomUsers      = {};
const usernames      = {};
const callParticipants = {}; // roomId → Set<socketId>

Object.keys(ROOMS).forEach(id => {
  messageHistory[id]    = [];
  roomUsers[id]         = new Set();
  callParticipants[id]  = new Set();
});

const ADJECTIVES = ["Silent","Cosmic","Neon","Fuzzy","Stealthy","Quantum","Blazing","Chill","Phantom","Shadow","Velvet","Hollow","Electric","Frozen","Mystic","Rapid","Solar","Lunar","Amber","Jade","Rusty","Turbo","Wispy","Blazed","Drifting"];
const NOUNS      = ["Panda","Fox","Comet","Raven","Drifter","Nomad","Ghost","Wanderer","Pilot","Cipher","Spark","Byte","Echo","Pixel","Vortex","Glitch","Specter","Sage","Lynx","Drake","Prism","Orbit","Dune","Tide","Wraith"];

function generateUsername() {
  return ADJECTIVES[Math.floor(Math.random()*ADJECTIVES.length)] +
         NOUNS[Math.floor(Math.random()*NOUNS.length)] +
         (Math.floor(Math.random()*90)+10);
}
function getRoomCount(id) { return roomUsers[id] ? roomUsers[id].size : 0; }
function getAllCounts() {
  const c = {};
  Object.keys(ROOMS).forEach(id => { c[id] = getRoomCount(id); });
  return c;
}
function getCallInfo(roomId) {
  return {
    active: callParticipants[roomId].size > 0,
    count:  callParticipants[roomId].size,
    participants: [...callParticipants[roomId]].map(sid => ({
      socketId: sid,
      username: usernames[sid]
    }))
  };
}

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  const username = generateUsername();
  usernames[socket.id] = username;
  socket.emit("identity", { username, rooms: ROOMS, counts: getAllCounts() });

  // ── Join room ──────────────────────────────────────────────
  socket.on("join_room", (roomId) => {
    if (!ROOMS[roomId]) return;
    Object.keys(ROOMS).forEach(id => {
      if (socket.rooms.has(id)) {
        socket.leave(id);
        roomUsers[id].delete(socket.id);
        // If they were in a call, remove them
        if (callParticipants[id].has(socket.id)) {
          callParticipants[id].delete(socket.id);
          io.to(id).emit("call_update", getCallInfo(id));
        }
        io.to(id).emit("room_count", { roomId: id, count: getRoomCount(id) });
        io.to(id).emit("user_left", { username: usernames[socket.id], roomId: id });
      }
    });
    socket.join(roomId);
    roomUsers[roomId].add(socket.id);
    socket.emit("history", { roomId, messages: messageHistory[roomId] });
    socket.emit("call_update", getCallInfo(roomId));
    io.to(roomId).emit("room_count", { roomId, count: getRoomCount(roomId) });
    io.to(roomId).emit("user_joined", { username, roomId });
    io.emit("all_counts", getAllCounts());
  });

  // ── Messages ───────────────────────────────────────────────
  socket.on("send_message", ({ roomId, text }) => {
    if (!ROOMS[roomId] || !text || !text.trim()) return;
    const msg = { id: `${Date.now()}-${socket.id.slice(0,4)}`, username: usernames[socket.id], text: text.trim().slice(0,500), ts: Date.now() };
    messageHistory[roomId].push(msg);
    if (messageHistory[roomId].length > 50) messageHistory[roomId].shift();
    io.to(roomId).emit("new_message", { roomId, message: msg });
  });

  socket.on("typing_start", ({ roomId }) => socket.to(roomId).emit("typing_start", { username: usernames[socket.id], roomId }));
  socket.on("typing_stop",  ({ roomId }) => socket.to(roomId).emit("typing_stop",  { username: usernames[socket.id], roomId }));

  // ── WebRTC Signaling ───────────────────────────────────────
  socket.on("call_join", ({ roomId }) => {
    if (!ROOMS[roomId]) return;
    callParticipants[roomId].add(socket.id);
    // Tell existing participants about new joiner
    socket.to(roomId).emit("call_user_joined", { socketId: socket.id, username: usernames[socket.id] });
    // Tell the new joiner about existing participants
    socket.emit("call_existing_participants", {
      participants: [...callParticipants[roomId]]
        .filter(sid => sid !== socket.id)
        .map(sid => ({ socketId: sid, username: usernames[sid] }))
    });
    io.to(roomId).emit("call_update", getCallInfo(roomId));
  });

  socket.on("call_leave", ({ roomId }) => {
    callParticipants[roomId].delete(socket.id);
    io.to(roomId).emit("call_user_left", { socketId: socket.id, username: usernames[socket.id] });
    io.to(roomId).emit("call_update", getCallInfo(roomId));
  });

  // WebRTC offer/answer/ice relay
  socket.on("rtc_offer",     ({ to, offer })       => io.to(to).emit("rtc_offer",     { from: socket.id, username: usernames[socket.id], offer }));
  socket.on("rtc_answer",    ({ to, answer })       => io.to(to).emit("rtc_answer",    { from: socket.id, answer }));
  socket.on("rtc_ice",       ({ to, candidate })    => io.to(to).emit("rtc_ice",       { from: socket.id, candidate }));

  // ── Disconnect ─────────────────────────────────────────────
  socket.on("disconnect", () => {
    const uname = usernames[socket.id];
    Object.keys(ROOMS).forEach(id => {
      if (roomUsers[id].has(socket.id)) {
        roomUsers[id].delete(socket.id);
        io.to(id).emit("room_count", { roomId: id, count: getRoomCount(id) });
        io.to(id).emit("user_left",  { username: uname, roomId: id });
      }
      if (callParticipants[id].has(socket.id)) {
        callParticipants[id].delete(socket.id);
        io.to(id).emit("call_user_left", { socketId: socket.id, username: uname });
        io.to(id).emit("call_update", getCallInfo(id));
      }
    });
    io.emit("all_counts", getAllCounts());
    delete usernames[socket.id];
  });
});

server.listen(PORT, () => console.log(`\n  ✦ Stranger running → http://localhost:${PORT}\n`));
