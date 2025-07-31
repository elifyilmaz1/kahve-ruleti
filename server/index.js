const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const crypto = require('crypto');

// Helper function for secure random integer
const getRandomInt = (max) => {
  // Generate a random 32-bit number using crypto
  const randomBuffer = crypto.randomBytes(4);
  const randomNumber = randomBuffer.readUInt32BE(0);
  // Return a number between 0 and max-1
  return randomNumber % max;
};

const app = express();
const server = http.createServer(app);

// CORS ayarları ve production URL'i
const isDevelopment = process.env.NODE_ENV !== 'production';
const FRONTEND_URL = isDevelopment ? 'http://localhost:3000' : 'https://kahve-ruleti.onrender.com';

const io = new Server(server, {
  cors: {
    origin: isDevelopment ? '*' : FRONTEND_URL,
    methods: ['GET', 'POST']
  }
});

app.use(cors({
  origin: isDevelopment ? '*' : FRONTEND_URL
}));
app.use(express.json());

// Production için static dosyaları serve et
if (!isDevelopment) {
  app.use(express.static(path.join(__dirname, '../client/build')));
}

// In-memory data structures
const rooms = {};
const socketToRoom = new Map(); // Track which room each socket is in
const socketToUser = new Map(); // Track user info for each socket
const disconnectedUsers = new Map(); // Track disconnected users and their timeouts

const DISCONNECT_TIMEOUT = 30000; // 30 seconds grace period for reconnection

// Helper Functions
const cleanupRoom = (roomId) => {
  // Remove room if it exists and has no participants
  if (rooms[roomId] && rooms[roomId].participants.length === 0) {
    delete rooms[roomId];
    console.log(`Room ${roomId} cleaned up due to no participants`);
  }
};

const removeParticipant = (socket, immediate = false) => {
  const roomId = socketToRoom.get(socket.id);
  const userInfo = socketToUser.get(socket.id);
  
  if (roomId && rooms[roomId] && userInfo) {
    if (!immediate) {
      // If not immediate removal, set a timeout
      const timeoutId = setTimeout(() => {
        // Only remove if they haven't reconnected
        if (disconnectedUsers.has(userInfo.id)) {
          // Actually remove the participant
          rooms[roomId].participants = rooms[roomId].participants.filter(p => p.id !== userInfo.id);
          io.to(roomId).emit('participants_update', rooms[roomId].participants);
          disconnectedUsers.delete(userInfo.id);
          cleanupRoom(roomId);
          console.log(`User ${userInfo.name} removed from room ${roomId} after timeout`);
        }
      }, DISCONNECT_TIMEOUT);

      // Store the disconnection info
      disconnectedUsers.set(userInfo.id, {
        timeoutId,
        roomId,
        userInfo
      });
    } else {
      // Immediate removal (e.g., when explicitly leaving)
      rooms[roomId].participants = rooms[roomId].participants.filter(p => p.id !== userInfo.id);
      io.to(roomId).emit('participants_update', rooms[roomId].participants);
      
      // Clear any existing timeout
      const disconnectInfo = disconnectedUsers.get(userInfo.id);
      if (disconnectInfo) {
        clearTimeout(disconnectInfo.timeoutId);
        disconnectedUsers.delete(userInfo.id);
      }
      
      cleanupRoom(roomId);
      console.log(`User ${userInfo.name} removed from room ${roomId} immediately`);
    }
    
    // Cleanup socket mappings
    socketToRoom.delete(socket.id);
    socketToUser.delete(socket.id);
  }
};

// Oda oluşturma
app.post('/api/rooms', (req, res) => {
  const { ownerName } = req.body;
  if (!ownerName || ownerName.trim().length === 0) {
    return res.status(400).json({ error: 'Oda sahibi ismi gerekli' });
  }

  const roomId = uuidv4().slice(0, 8);
  const ownerId = uuidv4();
  const ownerToken = `room_owner_${roomId}`;
  
  rooms[roomId] = {
    id: roomId,
    owner: ownerName,
    ownerId: ownerId,
    ownerToken: ownerToken,
    participants: [{ name: ownerName, id: ownerId }],
    started: false,
    selected: null,
    createdAt: Date.now()
  };
  
  res.json({ roomId, ownerToken });
});

// Katılımcı listesini alma
app.get('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms[roomId];
  
  if (!room) {
    return res.status(404).json({ error: 'Oda bulunamadı' });
  }
  
  // Don't send sensitive information to client
  const safeRoom = {
    id: room.id,
    owner: room.owner,
    participants: room.participants,
    started: room.started
  };
  
  res.json(safeRoom);
});

// Socket.io ile gerçek zamanlı katılım ve rulet
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  socket.on('join_room', ({ roomId, name, userId }) => {
    console.log(`Join attempt - Room: ${roomId}, Name: ${name}, UserId: ${userId}`);
    
    // Validate room
    if (!rooms[roomId]) {
      socket.emit('join_error', { message: 'Oda bulunamadı' });
      return;
    }
    
    const room = rooms[roomId];
    
    // Check if room is already started
    if (room.started) {
      socket.emit('room_expired', { message: 'Davet linkinin süresi doldu' });
      return;
    }

    // Check for reconnection
    if (userId && disconnectedUsers.has(userId)) {
      const disconnectInfo = disconnectedUsers.get(userId);
      clearTimeout(disconnectInfo.timeoutId);
      disconnectedUsers.delete(userId);
      
      // Use existing participant info
      const participant = room.participants.find(p => p.id === userId);
      if (participant) {
        socketToRoom.set(socket.id, roomId);
        socketToUser.set(socket.id, participant);
        socket.join(roomId);
        socket.emit('joined', participant);
        io.to(roomId).emit('participants_update', room.participants);
        console.log(`${name} reconnected to room ${roomId}`);
        return;
      }
    }

    // Check if this person is the room owner
    const isRoomOwner = room.owner === name;
    
    // If not room owner, check for duplicate names
    if (!isRoomOwner && room.participants.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      socket.emit('join_error', { message: 'Bu isimle zaten bir katılımcı var' });
      return;
    }

    // Setup participant
    let participant;
    if (isRoomOwner) {
      participant = room.participants.find(p => p.name === name);
    } else {
      participant = { name, id: userId || uuidv4() };
      room.participants.push(participant);
    }

    // Track socket session
    socketToRoom.set(socket.id, roomId);
    socketToUser.set(socket.id, participant);

    // Join socket room
    socket.join(roomId);
    
    // Notify all participants
    io.to(roomId).emit('participants_update', room.participants);
    socket.emit('joined', participant);
    
    console.log(`${name} joined room ${roomId}`);
  });

  socket.on('start_roulette', ({ roomId, ownerToken }) => {
    console.log(`Start roulette attempt - Room: ${roomId}`);
    
    const room = rooms[roomId];
    if (!room) {
      socket.emit('roulette_error', { message: 'Oda bulunamadı' });
      return;
    }

    if (room.started) {
      socket.emit('roulette_error', { message: 'Rulet zaten başlatıldı' });
      return;
    }

    // Validate owner token
    if (!ownerToken || ownerToken !== room.ownerToken) {
      socket.emit('roulette_error', { message: 'Sadece oda sahibi ruleti başlatabilir' });
      return;
    }

    if (room.participants.length < 2) {
      socket.emit('roulette_error', { message: 'Rulet başlatmak için en az iki katılımcı olmalı' });
      return;
    }

    // Start the roulette process
    console.log(`Starting roulette for room ${roomId}`);
    console.log('Current participants:', JSON.stringify(room.participants.map(p => ({
      name: p.name,
      id: p.id,
      isOwner: p.name === room.owner
    })), null, 2));
    io.to(roomId).emit('roulette_start');

    // Select winner after delay
    setTimeout(() => {
      room.started = true;
      
      // Log participants again right before selection
      console.log('Participants before selection:', JSON.stringify(room.participants.map(p => ({
        name: p.name,
        id: p.id,
        isOwner: p.name === room.owner
      })), null, 2));
      
      // Use crypto for true random selection
      const randomIndex = getRandomInt(room.participants.length);
      
      console.log('Random selection details:');
      console.log('- Number of participants:', room.participants.length);
      console.log('- Selected index:', randomIndex);
      console.log('- All possible indices:', Array.from({length: room.participants.length}, (_, i) => i).join(', '));
      
      const winner = room.participants[randomIndex];
      room.selected = winner;
      
      console.log('Selected winner:', JSON.stringify({
        name: winner.name,
        id: winner.id,
        isOwner: winner.name === room.owner,
        indexInArray: randomIndex
      }, null, 2));
      
      io.to(roomId).emit('roulette_result', winner);
      console.log(`Winner selected for room ${roomId}: ${winner.name}`);
    }, 500);
  });

  // Handle disconnections
  socket.on('disconnecting', () => {
    removeParticipant(socket, false); // Use grace period
  });

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
  });
});

// Production için catch-all route
if (!isDevelopment) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
  });
}

// Cleanup old rooms periodically (24 hours)
setInterval(() => {
  const now = Date.now();
  for (const roomId in rooms) {
    if (now - rooms[roomId].createdAt > 24 * 60 * 60 * 1000) {
      delete rooms[roomId];
      console.log(`Room ${roomId} cleaned up due to age`);
    } 
  }2
}, 60 * 60 * 1000); // Check every hour

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
}); 