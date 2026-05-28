const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const path     = require("path");
const crypto   = require("crypto");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 12e6 });
const PORT   = process.env.PORT || 3000;
const GROQ_KEY = "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";
const OWNER  = "Satz";

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Stores ────────────────────────────────────────────────────
const users      = {};  // key → { username, passwordHash, salt, pfp, bio, orientation, datingProfile, createdAt }
const sessions   = {};  // token → key
const servers    = {};  // id → server
const channels   = {};  // id → channel
const socketUser = {};  // socketId → { username }
const datingPool = {};  // username → { profile, likes:Set, passes:Set }
const matches    = {};  // matchId → { users:[u1,u2], channelId, messages:[] }
const reactions  = {};  // messageId → { emoji → Set<username> }
const deletedFor = {};  // messageId → Set<username> (deleted for me)
const deletedAll = new Set(); // messageIds deleted for everyone

function hash(pw,salt){return crypto.pbkdf2Sync(pw,salt,1000,64,"sha256").toString("hex")}
function tok(){return crypto.randomBytes(32).toString("hex")}
function uid(){return crypto.randomBytes(8).toString("hex")}
function inv(){return crypto.randomBytes(4).toString("hex").toUpperCase()}

// ── Auth ──────────────────────────────────────────────────────
app.post("/api/register",(req,res)=>{
  const {username,password}=req.body;
  if(!username||!password) return res.json({ok:false,error:"Missing fields"});
  if(username.length<3||username.length>20) return res.json({ok:false,error:"Username 3–20 chars"});
  if(!/^[a-zA-Z0-9_]+$/.test(username)) return res.json({ok:false,error:"Letters, numbers, _ only"});
  if(password.length<4) return res.json({ok:false,error:"Password min 4 chars"});
  const key=username.toLowerCase();
  if(users[key]) return res.json({ok:false,error:"Username taken"});
  const salt=crypto.randomBytes(16).toString("hex");
  users[key]={username,passwordHash:hash(password,salt),salt,pfp:null,bio:"",orientation:null,datingProfile:null,createdAt:Date.now()};
  const t=tok(); sessions[t]=key;
  res.json({ok:true,token:t,username});
});
app.post("/api/login",(req,res)=>{
  const {username,password}=req.body;
  const key=username?.toLowerCase();
  const u=users[key];
  if(!u) return res.json({ok:false,error:"User not found"});
  if(hash(password,u.salt)!==u.passwordHash) return res.json({ok:false,error:"Wrong password"});
  const t=tok(); sessions[t]=key;
  res.json({ok:true,token:t,username:u.username,pfp:u.pfp,bio:u.bio||""});
});
app.get("/api/me",(req,res)=>{
  const key=sessions[req.headers["authorization"]];
  if(!key) return res.json({ok:false});
  const u=users[key];
  res.json({ok:true,username:u.username,pfp:u.pfp,bio:u.bio||""});
});
app.post("/api/pfp",(req,res)=>{
  const {token:t,pfp}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false,error:"Not logged in"});
  if(pfp&&pfp.length>2e6) return res.json({ok:false,error:"Image too large"});
  users[key].pfp=pfp||null;
  io.emit("pfp_update",{username:users[key].username,pfp:users[key].pfp});
  res.json({ok:true});
});
app.post("/api/bio",(req,res)=>{
  const {token:t,bio}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false,error:"Not logged in"});
  users[key].bio=(bio||"").slice(0,300);
  res.json({ok:true});
});

// ── Admin: all servers ────────────────────────────────────────
app.get("/api/admin/servers",(req,res)=>{
  const key=sessions[req.headers["authorization"]];
  if(!key||users[key]?.username!==OWNER) return res.json({ok:false,error:"Not authorized"});
  const all=Object.values(servers).map(s=>serializeServer(s.id,users[key].username,true));
  res.json({ok:true,servers:all});
});

// ── Servers ───────────────────────────────────────────────────
app.post("/api/servers/create",(req,res)=>{
  const {token:t,name,icon,description}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false,error:"Not logged in"});
  if(!name?.trim()) return res.json({ok:false,error:"Name required"});
  const username=users[key].username;
  const sid=uid(); const invite=inv(); const cid=uid();
  channels[cid]={id:cid,serverId:sid,name:"general",type:"text",messages:[]};
  servers[sid]={id:sid,name:name.trim().slice(0,30),icon:icon||"🏠",description:(description||"").slice(0,100),ownerId:username,inviteCode:invite,members:new Set([username]),channels:[cid],createdAt:Date.now()};
  res.json({ok:true,server:serializeServer(sid,username)});
});
app.post("/api/servers/join",(req,res)=>{
  const {token:t,inviteCode:code}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false,error:"Not logged in"});
  const username=users[key].username;
  const srv=Object.values(servers).find(s=>s.inviteCode===code?.toUpperCase().trim());
  if(!srv) return res.json({ok:false,error:"Invalid invite code"});
  srv.members.add(username);
  io.to(`server:${srv.id}`).emit("member_joined",{serverId:srv.id,username,pfp:users[key].pfp});
  res.json({ok:true,server:serializeServer(srv.id,username)});
});
app.get("/api/servers",(req,res)=>{
  const key=sessions[req.headers["authorization"]]; if(!key) return res.json({ok:false});
  const username=users[key].username;
  const mine=Object.values(servers).filter(s=>s.members.has(username)).map(s=>serializeServer(s.id,username));
  res.json({ok:true,servers:mine});
});
app.post("/api/servers/channel/create",(req,res)=>{
  const {token:t,serverId,name}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false,error:"Not logged in"});
  const srv=servers[serverId]; if(!srv) return res.json({ok:false,error:"Not found"});
  if(srv.ownerId!==users[key].username&&users[key].username!==OWNER) return res.json({ok:false,error:"Not owner"});
  if(srv.channels.length>=5) return res.json({ok:false,error:"Max 5 channels"});
  if(!name?.trim()) return res.json({ok:false,error:"Name required"});
  const cid=uid();
  channels[cid]={id:cid,serverId,name:name.trim().toLowerCase().replace(/\s+/g,"-").slice(0,20),type:"text",messages:[]};
  srv.channels.push(cid);
  io.to(`server:${serverId}`).emit("channel_created",{serverId,channel:channels[cid]});
  res.json({ok:true,channel:channels[cid]});
});
app.post("/api/servers/channel/delete",(req,res)=>{
  const {token:t,serverId,channelId}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false,error:"Not logged in"});
  const srv=servers[serverId];
  if(!srv||(srv.ownerId!==users[key].username&&users[key].username!==OWNER)) return res.json({ok:false,error:"Not allowed"});
  if(srv.channels.length<=1) return res.json({ok:false,error:"Need at least 1 channel"});
  srv.channels=srv.channels.filter(c=>c!==channelId);
  delete channels[channelId];
  io.to(`server:${serverId}`).emit("channel_deleted",{serverId,channelId});
  res.json({ok:true});
});
app.post("/api/servers/leave",(req,res)=>{
  const {token:t,serverId}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false});
  const srv=servers[serverId]; if(!srv) return res.json({ok:false,error:"Not found"});
  const username=users[key].username;
  if(srv.ownerId===username) return res.json({ok:false,error:"Owner must delete"});
  srv.members.delete(username);
  io.to(`server:${serverId}`).emit("member_left",{serverId,username});
  res.json({ok:true});
});
app.post("/api/servers/delete",(req,res)=>{
  const {token:t,serverId}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false});
  const srv=servers[serverId];
  if(!srv||(srv.ownerId!==users[key].username&&users[key].username!==OWNER)) return res.json({ok:false,error:"Not owner"});
  srv.channels.forEach(cid=>delete channels[cid]);
  io.to(`server:${serverId}`).emit("server_deleted",{serverId});
  delete servers[serverId];
  res.json({ok:true});
});
app.post("/api/servers/update",(req,res)=>{
  const {token:t,serverId,name,icon,description}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false});
  const srv=servers[serverId];
  if(!srv||(srv.ownerId!==users[key].username&&users[key].username!==OWNER)) return res.json({ok:false,error:"Not owner"});
  if(name) srv.name=name.trim().slice(0,30);
  if(icon) srv.icon=icon;
  if(description!==undefined) srv.description=description.slice(0,100);
  io.to(`server:${serverId}`).emit("server_updated",{serverId,name:srv.name,icon:srv.icon,description:srv.description});
  res.json({ok:true});
});

// ── Dating ────────────────────────────────────────────────────
app.post("/api/dating/setup",(req,res)=>{
  const {token:t,orientation,displayName,bio,pfp}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false});
  const u=users[key];
  u.orientation=orientation;
  u.datingProfile={username:u.username,displayName:displayName||u.username,bio:bio||"",pfp:pfp||u.pfp,orientation,active:true};
  datingPool[u.username]={profile:u.datingProfile,likes:new Set(),passes:new Set()};
  res.json({ok:true});
});
app.post("/api/dating/cards",(req,res)=>{
  const {token:t}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false});
  const u=users[key];
  if(!u.datingProfile) return res.json({ok:false,error:"Setup dating profile first"});
  const me=u.username; const myOrient=u.orientation;
  const pool=datingPool[me]; if(!pool) return res.json({ok:false,error:"Not in pool"});
  // Filter compatible users
  const cards=Object.values(datingPool).filter(p=>{
    if(p.profile.username===me) return false;
    if(pool.likes.has(p.profile.username)||pool.passes.has(p.profile.username)) return false;
    if(!p.profile.active) return false;
    // Compatibility
    const them=p.profile.orientation;
    if(myOrient==="straight") return them==="straight";
    if(myOrient==="gay") return them==="gay";
    if(myOrient==="lesbian") return them==="lesbian";
    if(myOrient==="bromance") return them==="bromance";
    return false;
  }).slice(0,10).map(p=>p.profile);
  res.json({ok:true,cards});
});
app.post("/api/dating/swipe",(req,res)=>{
  const {token:t,targetUsername,direction}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false});
  const u=users[key]; const me=u.username;
  const myPool=datingPool[me]; if(!myPool) return res.json({ok:false});
  if(direction==="right"){
    myPool.likes.add(targetUsername);
    // Check mutual like = match!
    const theirPool=datingPool[targetUsername];
    if(theirPool&&theirPool.likes.has(me)){
      const mid=uid(); const cid=uid();
      matches[mid]={id:mid,users:[me,targetUsername],channelId:cid,messages:[],createdAt:Date.now()};
      // Notify both users via socket
      io.emit("dating_match",{matchId:mid,users:[me,targetUsername],channelId:cid});
      return res.json({ok:true,match:true,matchId:mid});
    }
  } else {
    myPool.passes.add(targetUsername);
  }
  res.json({ok:true,match:false});
});
app.post("/api/dating/message",(req,res)=>{
  const {token:t,matchId,text}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false});
  const m=matches[matchId]; if(!m) return res.json({ok:false});
  const u=users[key];
  if(!m.users.includes(u.username)) return res.json({ok:false,error:"Not in match"});
  const msg={id:uid(),username:u.username,pfp:u.pfp,text:text.slice(0,500),ts:Date.now()};
  m.messages.push(msg);
  if(m.messages.length>100) m.messages.shift();
  io.emit(`match:${matchId}`,{matchId,message:msg});
  res.json({ok:true,message:msg});
});
app.get("/api/dating/matches",(req,res)=>{
  const key=sessions[req.headers["authorization"]]; if(!key) return res.json({ok:false});
  const u=users[key];
  const myMatches=Object.values(matches).filter(m=>m.users.includes(u.username)).map(m=>({
    id:m.id,channelId:m.channelId,
    partner:m.users.find(x=>x!==u.username),
    messages:m.messages,createdAt:m.createdAt
  }));
  res.json({ok:true,matches:myMatches});
});

// ── AI ────────────────────────────────────────────────────────
app.post("/api/ai",(req,res)=>{
  const {token:t,prompt}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false,error:"Not logged in"});
  fetch("https://api.groq.com/openai/v1/chat/completions",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${GROQ_KEY}`},
    body:JSON.stringify({model:"llama3-8b-8192",messages:[{role:"system",content:"You are a helpful, friendly chat assistant. Keep responses concise and conversational."},{role:"user",content:prompt}],max_tokens:500})
  }).then(r=>r.json()).then(d=>{
    const text=d.choices?.[0]?.message?.content||"Sorry, I couldn't respond right now.";
    res.json({ok:true,text});
  }).catch(()=>res.json({ok:false,error:"AI error"}));
});

// ── Message actions ───────────────────────────────────────────
app.post("/api/message/delete",(req,res)=>{
  const {token:t,channelId,messageId,deleteFor}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false});
  const username=users[key].username;
  const ch=channels[channelId]; if(!ch) return res.json({ok:false});
  if(deleteFor==="everyone"){
    const msg=ch.messages.find(m=>m.id===messageId);
    if(!msg||(msg.username!==username&&username!==OWNER)) return res.json({ok:false,error:"Not your message"});
    deletedAll.add(messageId);
    io.to(`ch:${channelId}`).emit("message_deleted",{channelId,messageId,deleteFor:"everyone"});
  } else {
    if(!deletedFor[messageId]) deletedFor[messageId]=new Set();
    deletedFor[messageId].add(username);
    res.json({ok:true}); return;
  }
  res.json({ok:true});
});
app.post("/api/message/react",(req,res)=>{
  const {token:t,channelId,messageId,emoji}=req.body;
  const key=sessions[t]; if(!key) return res.json({ok:false});
  const username=users[key].username;
  if(!reactions[messageId]) reactions[messageId]={};
  if(!reactions[messageId][emoji]) reactions[messageId][emoji]=new Set();
  if(reactions[messageId][emoji].has(username)) reactions[messageId][emoji].delete(username);
  else reactions[messageId][emoji].add(username);
  if(reactions[messageId][emoji].size===0) delete reactions[messageId][emoji];
  const r=Object.fromEntries(Object.entries(reactions[messageId]||{}).map(([e,s])=>[e,{count:s.size,users:[...s]}]));
  io.to(`ch:${channelId}`).emit("reaction_update",{channelId,messageId,reactions:r});
  res.json({ok:true});
});

// ── Helpers ───────────────────────────────────────────────────
function serializeServer(sid,username,isAdmin=false){
  const s=servers[sid]; if(!s) return null;
  const isOwner=s.ownerId===username||isAdmin;
  return {id:s.id,name:s.name,icon:s.icon,description:s.description,ownerId:s.ownerId,
    inviteCode:isOwner?s.inviteCode:null,memberCount:s.members.size,isOwner,
    channels:s.channels.map(cid=>channels[cid]).filter(Boolean).map(c=>({id:c.id,name:c.name,type:c.type}))};
}
function getUserPfp(username){const u=users[username?.toLowerCase()];return u?u.pfp:null}

// ── Socket ────────────────────────────────────────────────────
io.on("connection",(socket)=>{
  socket.on("auth",({token:t})=>{
    const key=sessions[t]; if(!key){socket.emit("auth_fail");return;}
    socketUser[socket.id]={username:users[key].username};
    socket.emit("auth_ok",{username:users[key].username,pfp:users[key].pfp});
  });
  socket.on("subscribe_server",({serverId})=>{
    const u=socketUser[socket.id]; if(!u) return;
    const srv=servers[serverId];
    if(!srv||(!srv.members.has(u.username)&&u.username!==OWNER)) return;
    socket.join(`server:${serverId}`);
  });
  socket.on("join_channel",({channelId})=>{
    const u=socketUser[socket.id]; if(!u) return;
    const ch=channels[channelId]; if(!ch) return;
    const srv=servers[ch.serverId];
    if(!srv||(!srv.members.has(u.username)&&u.username!==OWNER)) return;
    Object.keys(channels).forEach(cid=>{if(socket.rooms.has(`ch:${cid}`))socket.leave(`ch:${cid}`);});
    socket.join(`ch:${channelId}`);
    const msgs=channels[channelId].messages.filter(m=>!deletedAll.has(m.id)).map(m=>({
      ...m, reactions:Object.fromEntries(Object.entries(reactions[m.id]||{}).map(([e,s])=>[e,{count:s.size,users:[...s]}]))
    }));
    socket.emit("channel_history",{channelId,messages:msgs});
    const room=io.sockets.adapter.rooms.get(`ch:${channelId}`);
    io.to(`ch:${channelId}`).emit("channel_online",{channelId,count:room?room.size:1});
  });
  socket.on("send_message",({channelId,text,mediaData,mediaType,mediaName})=>{
    const u=socketUser[socket.id]; if(!u||!channelId) return;
    const ch=channels[channelId]; if(!ch) return;
    const srv=servers[ch.serverId];
    if(!srv||(!srv.members.has(u.username)&&u.username!==OWNER)) return;
    if(!text&&!mediaData) return;
    const msg={id:`${Date.now()}-${socket.id.slice(0,4)}`,username:u.username,pfp:getUserPfp(u.username),
      text:text?text.trim().slice(0,1000):null,mediaData:mediaData||null,mediaType:mediaType||null,mediaName:mediaName||null,ts:Date.now()};
    ch.messages.push(msg);
    if(ch.messages.length>50) ch.messages.shift();
    io.to(`ch:${channelId}`).emit("new_message",{channelId,message:{...msg,reactions:{}}});
  });
  socket.on("typing_start",({channelId})=>{const u=socketUser[socket.id];if(u)socket.to(`ch:${channelId}`).emit("typing_start",{channelId,username:u.username});});
  socket.on("typing_stop",({channelId})=>{const u=socketUser[socket.id];if(u)socket.to(`ch:${channelId}`).emit("typing_stop",{channelId,username:u.username});});

  // Calls
  const callRooms={};
  socket.on("call_join",({channelId})=>{
    if(!callRooms[channelId])callRooms[channelId]=new Set();
    callRooms[channelId].add(socket.id);
    socket.to(`ch:${channelId}`).emit("call_user_joined",{socketId:socket.id,username:socketUser[socket.id]?.username,channelId});
    socket.emit("call_existing",{participants:[...callRooms[channelId]].filter(s=>s!==socket.id).map(s=>({socketId:s,username:socketUser[s]?.username}))});
    io.to(`ch:${channelId}`).emit("call_update",{channelId,count:callRooms[channelId].size,participants:[...callRooms[channelId]].map(s=>({socketId:s,username:socketUser[s]?.username}))});
  });
  socket.on("call_leave",({channelId})=>{
    if(callRooms[channelId]){callRooms[channelId].delete(socket.id);io.to(`ch:${channelId}`).emit("call_user_left",{socketId:socket.id,username:socketUser[socket.id]?.username,channelId});io.to(`ch:${channelId}`).emit("call_update",{channelId,count:callRooms[channelId].size,participants:[...callRooms[channelId]].map(s=>({socketId:s,username:socketUser[s]?.username}))});}
  });
  socket.on("rtc_offer",({to,offer})=>io.to(to).emit("rtc_offer",{from:socket.id,username:socketUser[socket.id]?.username,offer}));
  socket.on("rtc_answer",({to,answer})=>io.to(to).emit("rtc_answer",{from:socket.id,answer}));
  socket.on("rtc_ice",({to,candidate})=>io.to(to).emit("rtc_ice",{from:socket.id,candidate}));

  socket.on("disconnect",()=>{delete socketUser[socket.id];});
});

server.listen(PORT,()=>console.log(`\n  ✦ Stranger running → http://localhost:${PORT}\n`));
