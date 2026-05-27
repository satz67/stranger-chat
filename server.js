const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const path     = require("path");
const crypto   = require("crypto");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 12e6 });
const PORT   = process.env.PORT || 3000;

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── In-memory stores ──────────────────────────────────────────
const users    = {};   // username(lower) → { username, passwordHash, salt, pfp, createdAt }
const sessions = {};   // token → username(lower)
const servers  = {};   // serverId → { id, name, icon, description, ownerId, inviteCode, members:Set, channels:[], createdAt }
const channels = {};   // channelId → { id, serverId, name, type, messages:[] }
const socketUser = {}; // socketId → { username }

// ── Auth helpers ──────────────────────────────────────────────
function hash(pw, salt){ return crypto.pbkdf2Sync(pw, salt, 1000, 64, "sha256").toString("hex"); }
function token(){ return crypto.randomBytes(32).toString("hex"); }
function uid(){ return crypto.randomBytes(8).toString("hex"); }
function inviteCode(){ return crypto.randomBytes(4).toString("hex").toUpperCase(); }

// ── REST: Auth ────────────────────────────────────────────────
app.post("/api/register", (req,res)=>{
  const {username,password} = req.body;
  if(!username||!password) return res.json({ok:false,error:"Missing fields"});
  if(username.length<3||username.length>20) return res.json({ok:false,error:"Username 3–20 chars"});
  if(!/^[a-zA-Z0-9_]+$/.test(username)) return res.json({ok:false,error:"Letters, numbers, _ only"});
  if(password.length<4) return res.json({ok:false,error:"Password min 4 chars"});
  const key = username.toLowerCase();
  if(users[key]) return res.json({ok:false,error:"Username taken"});
  const salt = crypto.randomBytes(16).toString("hex");
  users[key] = { username, passwordHash:hash(password,salt), salt, pfp:null, createdAt:Date.now() };
  const tok = token(); sessions[tok]=key;
  res.json({ok:true, token:tok, username});
});

app.post("/api/login", (req,res)=>{
  const {username,password} = req.body;
  const key = username?.toLowerCase();
  const u = users[key];
  if(!u) return res.json({ok:false,error:"User not found"});
  if(hash(password,u.salt)!==u.passwordHash) return res.json({ok:false,error:"Wrong password"});
  const tok = token(); sessions[tok]=key;
  res.json({ok:true, token:tok, username:u.username, pfp:u.pfp});
});

app.get("/api/me", (req,res)=>{
  const key = sessions[req.headers["authorization"]];
  if(!key) return res.json({ok:false});
  const u = users[key];
  res.json({ok:true, username:u.username, pfp:u.pfp});
});

app.post("/api/pfp", (req,res)=>{
  const {token:tok, pfp} = req.body;
  const key = sessions[tok];
  if(!key) return res.json({ok:false,error:"Not logged in"});
  if(pfp&&pfp.length>2e6) return res.json({ok:false,error:"Image too large"});
  users[key].pfp = pfp||null;
  io.emit("pfp_update", {username:users[key].username, pfp:users[key].pfp});
  res.json({ok:true});
});

// ── REST: Servers ─────────────────────────────────────────────
app.post("/api/servers/create", (req,res)=>{
  const {token:tok, name, icon, description} = req.body;
  const key = sessions[tok];
  if(!key) return res.json({ok:false,error:"Not logged in"});
  if(!name||name.trim().length<1) return res.json({ok:false,error:"Server name required"});
  const username = users[key].username;
  const sid = uid();
  const invite = inviteCode();
  // Create default general channel
  const cid = uid();
  channels[cid] = { id:cid, serverId:sid, name:"general", type:"text", messages:[] };
  servers[sid] = {
    id:sid, name:name.trim().slice(0,30),
    icon: icon||"🏠", description:(description||"").slice(0,100),
    ownerId:username, inviteCode:invite,
    members: new Set([username]),
    channels:[cid], createdAt:Date.now()
  };
  res.json({ok:true, server:serializeServer(sid, username)});
});

app.post("/api/servers/join", (req,res)=>{
  const {token:tok, inviteCode:code} = req.body;
  const key = sessions[tok];
  if(!key) return res.json({ok:false,error:"Not logged in"});
  const username = users[key].username;
  const srv = Object.values(servers).find(s=>s.inviteCode===code.toUpperCase().trim());
  if(!srv) return res.json({ok:false,error:"Invalid invite code"});
  srv.members.add(username);
  // Notify all members in that server
  io.to(`server:${srv.id}`).emit("member_joined", {serverId:srv.id, username, pfp:users[key].pfp});
  res.json({ok:true, server:serializeServer(srv.id, username)});
});

app.get("/api/servers", (req,res)=>{
  const key = sessions[req.headers["authorization"]];
  if(!key) return res.json({ok:false});
  const username = users[key].username;
  const myServers = Object.values(servers)
    .filter(s=>s.members.has(username))
    .map(s=>serializeServer(s.id, username));
  res.json({ok:true, servers:myServers});
});

app.post("/api/servers/channel/create", (req,res)=>{
  const {token:tok, serverId, name} = req.body;
  const key = sessions[tok];
  if(!key) return res.json({ok:false,error:"Not logged in"});
  const srv = servers[serverId];
  if(!srv) return res.json({ok:false,error:"Server not found"});
  if(srv.ownerId!==users[key].username) return res.json({ok:false,error:"Only owner can add channels"});
  if(srv.channels.length>=5) return res.json({ok:false,error:"Max 5 channels per server"});
  if(!name||!name.trim()) return res.json({ok:false,error:"Channel name required"});
  const cid = uid();
  channels[cid] = {id:cid, serverId, name:name.trim().toLowerCase().replace(/\s+/g,"-").slice(0,20), type:"text", messages:[]};
  srv.channels.push(cid);
  io.to(`server:${serverId}`).emit("channel_created", {serverId, channel:channels[cid]});
  res.json({ok:true, channel:channels[cid]});
});

app.post("/api/servers/channel/delete", (req,res)=>{
  const {token:tok, serverId, channelId} = req.body;
  const key = sessions[tok];
  if(!key) return res.json({ok:false,error:"Not logged in"});
  const srv = servers[serverId];
  if(!srv||srv.ownerId!==users[key].username) return res.json({ok:false,error:"Not allowed"});
  if(srv.channels.length<=1) return res.json({ok:false,error:"Need at least 1 channel"});
  srv.channels = srv.channels.filter(c=>c!==channelId);
  delete channels[channelId];
  io.to(`server:${serverId}`).emit("channel_deleted", {serverId, channelId});
  res.json({ok:true});
});

app.post("/api/servers/leave", (req,res)=>{
  const {token:tok, serverId} = req.body;
  const key = sessions[tok];
  if(!key) return res.json({ok:false,error:"Not logged in"});
  const srv = servers[serverId];
  if(!srv) return res.json({ok:false,error:"Server not found"});
  const username = users[key].username;
  if(srv.ownerId===username) return res.json({ok:false,error:"Owner must delete server, not leave"});
  srv.members.delete(username);
  io.to(`server:${serverId}`).emit("member_left", {serverId, username});
  res.json({ok:true});
});

app.post("/api/servers/delete", (req,res)=>{
  const {token:tok, serverId} = req.body;
  const key = sessions[tok];
  if(!key) return res.json({ok:false,error:"Not logged in"});
  const srv = servers[serverId];
  if(!srv||srv.ownerId!==users[key].username) return res.json({ok:false,error:"Not owner"});
  srv.channels.forEach(cid=>delete channels[cid]);
  io.to(`server:${serverId}`).emit("server_deleted", {serverId});
  delete servers[serverId];
  res.json({ok:true});
});

app.post("/api/servers/update", (req,res)=>{
  const {token:tok, serverId, name, icon, description} = req.body;
  const key = sessions[tok];
  if(!key) return res.json({ok:false,error:"Not logged in"});
  const srv = servers[serverId];
  if(!srv||srv.ownerId!==users[key].username) return res.json({ok:false,error:"Not owner"});
  if(name) srv.name = name.trim().slice(0,30);
  if(icon) srv.icon = icon;
  if(description!==undefined) srv.description = description.slice(0,100);
  io.to(`server:${serverId}`).emit("server_updated", {serverId, name:srv.name, icon:srv.icon, description:srv.description});
  res.json({ok:true});
});

// ── Helpers ───────────────────────────────────────────────────
function serializeServer(sid, username){
  const s = servers[sid];
  if(!s) return null;
  return {
    id:s.id, name:s.name, icon:s.icon, description:s.description,
    ownerId:s.ownerId, inviteCode:s.ownerId===username?s.inviteCode:null,
    memberCount:s.members.size,
    isOwner:s.ownerId===username,
    channels: s.channels.map(cid=>channels[cid]).filter(Boolean).map(c=>({id:c.id,name:c.name,type:c.type}))
  };
}
function getUserPfp(username){ const u=users[username?.toLowerCase()]; return u?u.pfp:null; }

// ── Socket.io ─────────────────────────────────────────────────
io.on("connection", (socket)=>{

  socket.on("auth", ({token:tok})=>{
    const key = sessions[tok];
    if(!key){ socket.emit("auth_fail"); return; }
    const u = users[key];
    socketUser[socket.id] = {username:u.username};
    socket.emit("auth_ok", {username:u.username, pfp:u.pfp});
  });

  // Join server room for real-time events
  socket.on("subscribe_server", ({serverId})=>{
    const u = socketUser[socket.id];
    if(!u) return;
    const srv = servers[serverId];
    if(!srv||!srv.members.has(u.username)) return;
    socket.join(`server:${serverId}`);
  });

  socket.on("join_channel", ({channelId})=>{
    const u = socketUser[socket.id];
    if(!u) return;
    const ch = channels[channelId];
    if(!ch) return;
    const srv = servers[ch.serverId];
    if(!srv||!srv.members.has(u.username)) return;
    // Leave other channels
    Object.keys(channels).forEach(cid=>{
      if(socket.rooms.has(`ch:${cid}`)) socket.leave(`ch:${cid}`);
    });
    socket.join(`ch:${channelId}`);
    socket.emit("channel_history", {channelId, messages:channels[channelId].messages});
    // Online count
    const room = io.sockets.adapter.rooms.get(`ch:${channelId}`);
    io.to(`ch:${channelId}`).emit("channel_online", {channelId, count:room?room.size:1});
  });

  socket.on("send_message", ({channelId, text, mediaData, mediaType, mediaName})=>{
    const u = socketUser[socket.id];
    if(!u||!channelId) return;
    const ch = channels[channelId];
    if(!ch) return;
    const srv = servers[ch.serverId];
    if(!srv||!srv.members.has(u.username)) return;
    if(!text&&!mediaData) return;
    const msg = {
      id:`${Date.now()}-${socket.id.slice(0,4)}`,
      username:u.username, pfp:getUserPfp(u.username),
      text:text?text.trim().slice(0,1000):null,
      mediaData:mediaData||null, mediaType:mediaType||null, mediaName:mediaName||null,
      ts:Date.now()
    };
    ch.messages.push(msg);
    if(ch.messages.length>50) ch.messages.shift();
    io.to(`ch:${channelId}`).emit("new_message", {channelId, message:msg});
  });

  socket.on("typing_start", ({channelId})=>{
    const u = socketUser[socket.id];
    if(u) socket.to(`ch:${channelId}`).emit("typing_start", {channelId, username:u.username});
  });
  socket.on("typing_stop", ({channelId})=>{
    const u = socketUser[socket.id];
    if(u) socket.to(`ch:${channelId}`).emit("typing_stop", {channelId, username:u.username});
  });

  // ── Voice calls (per channel) ────────────────────────────────
  const callRooms = {}; // channelId → Set<socketId>
  socket.on("call_join", ({channelId})=>{
    if(!callRooms[channelId]) callRooms[channelId]=new Set();
    callRooms[channelId].add(socket.id);
    socket.to(`ch:${channelId}`).emit("call_user_joined",{socketId:socket.id,username:socketUser[socket.id]?.username,channelId});
    socket.emit("call_existing",{participants:[...callRooms[channelId]].filter(s=>s!==socket.id).map(s=>({socketId:s,username:socketUser[s]?.username}))});
    io.to(`ch:${channelId}`).emit("call_update",{channelId,count:callRooms[channelId].size,participants:[...callRooms[channelId]].map(s=>({socketId:s,username:socketUser[s]?.username}))});
  });
  socket.on("call_leave", ({channelId})=>{
    if(callRooms[channelId]){callRooms[channelId].delete(socket.id); io.to(`ch:${channelId}`).emit("call_user_left",{socketId:socket.id,username:socketUser[socket.id]?.username,channelId}); io.to(`ch:${channelId}`).emit("call_update",{channelId,count:callRooms[channelId].size,participants:[...callRooms[channelId]].map(s=>({socketId:s,username:socketUser[s]?.username}))});}
  });
  socket.on("rtc_offer",  ({to,offer})      => io.to(to).emit("rtc_offer",  {from:socket.id,username:socketUser[socket.id]?.username,offer}));
  socket.on("rtc_answer", ({to,answer})     => io.to(to).emit("rtc_answer", {from:socket.id,answer}));
  socket.on("rtc_ice",    ({to,candidate})  => io.to(to).emit("rtc_ice",    {from:socket.id,candidate}));

  socket.on("disconnect", ()=>{
    delete socketUser[socket.id];
  });
});

server.listen(PORT, ()=>console.log(`\n  ✦ Stranger running → http://localhost:${PORT}\n`));
