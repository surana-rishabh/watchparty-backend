require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Simple in-memory rooms (for MVP)
const rooms = {}; // { roomId: { hostSocketId, media: {type:'youtube'|'file', url}, users: [] } }

// Upload setup (stores uploaded files in backend/uploads)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads')),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

app.post('/api/create-room', (req, res) => {
  const roomId = uuidv4().slice(0,8);
  rooms[roomId] = { media: null, users: [] };
  res.json({ roomId });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url, filename: req.file.filename });
});

app.post('/api/set-media', (req, res) => {
  const { roomId, media } = req.body;
  if (!rooms[roomId]) return res.status(404).json({ error: 'Room not found' });
  rooms[roomId].media = media;
  res.json({ ok: true });
});

app.get('/api/room/:id', (req, res) => {
  const r = rooms[req.params.id];
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('join-room', ({ roomId, username }) => {
    if (!rooms[roomId]) rooms[roomId] = { media: null, users: [] };
    socket.join(roomId);
    rooms[roomId].users.push({ id: socket.id, username });
    socket.to(roomId).emit('user-joined', { id: socket.id, username });
    io.to(roomId).emit('room-users', rooms[roomId].users);
    // send current media state
    socket.emit('media-update', rooms[roomId].media);
  });

  socket.on('leave-room', ({ roomId }) => {
    socket.leave(roomId);
    if (rooms[roomId]) {
      rooms[roomId].users = rooms[roomId].users.filter(u=>u.id!==socket.id);
      io.to(roomId).emit('room-users', rooms[roomId].users);
    }
  });

  // signalling for WebRTC (simple relay)
  socket.on('signal', (payload) => {
    const { to, data } = payload;
    if (to) io.to(to).emit('signal', { from: socket.id, data });
  });

  // chat
  socket.on('chat', ({ roomId, message, username }) => {
    io.to(roomId).emit('chat', { message, username, ts: Date.now() });
  });

  // playback sync - host emits actions to others
  socket.on('playback', ({ roomId, action, time }) => {
    if (rooms[roomId]) {
      io.to(roomId).emit('playback', { action, time });
    }
  });

  socket.on('set-media', ({ roomId, media }) => {
    if (!rooms[roomId]) rooms[roomId] = { media: null, users: [] };
    rooms[roomId].media = media;
    io.to(roomId).emit('media-update', media);
  });

  socket.on('disconnect', () => {
    // remove from rooms
    for (const id of Object.keys(rooms)) {
      rooms[id].users = rooms[id].users.filter(u=>u.id!==socket.id);
      io.to(id).emit('room-users', rooms[id].users);
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, ()=>console.log('Backend listening on', PORT));
