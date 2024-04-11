const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// CORS setup for Socket.IO
const io = new Server(server, {
  cors: {
    origin: ["http://127.0.0.1:5500", "https://lingomingle.com"],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Redirect the root route to your frontend domain
app.get('/', (req, res) => {
  res.redirect('https://lingomingle.com');
});

const waitingUsers = new Set();
const userPairs = new Map();
const privateRooms = new Map();
const onlineUsers = new Set(); // Track online users with a set

function updateOnlineUsersCount() {
  io.emit("onlineUsers", onlineUsers.size);
}

io.on("connection", (socket) => {
  onlineUsers.add(socket.id); // Add new connection to online users tracking
  updateOnlineUsersCount();

  socket.on("disconnect", () => {
    onlineUsers.delete(socket.id); // Remove connection from online users tracking
    updateOnlineUsersCount();
    handleDisconnection(socket.id);
  });

  socket.on("pairRequest", () => {
    waitingUsers.add(socket.id);
    socket.emit("waiting");
    pairUsers();
  });

  socket.on("unpairRequest", () => {
    unpairUsers(socket.id);
  });

  socket.on("unwaitRequest", () => {
    waitingUsers.delete(socket.id);
    socket.emit("unpaired");
  });

  socket.on("skipRequest", () => {
    skipUsers(socket.id);
  });

  socket.on("createPrivateRoom", (roomId) => {
    if (!privateRooms.has(roomId) && roomId.length > 6) {
      privateRooms.set(roomId, [socket.id]);
      socket.join(roomId);
      socket.emit("privateRoomCreated", { roomId });
    } else {
      socket.emit("roomError", "Room already exists or invalid ID");
    }
  });

  socket.on("joinPrivateRoom", (roomId) => {
    if (privateRooms.has(roomId)) {
      const roomParticipants = privateRooms.get(roomId);
      if (roomParticipants.length < 2) {
        roomParticipants.push(socket.id);
        socket.join(roomId);
        if (roomParticipants.length === 2) {
          const [user1Id, user2Id] = roomParticipants;
          io.to(roomId).emit("pairedInPrivateRoom", { roomId, user1Id, user2Id });
          io.to(user1Id).emit("initiateCall");
          console.log(`Both users are now in room: ${roomId}`);
        } else {
          socket.emit("waitingForPartner", { roomId });
        }
      } else {
        socket.emit("roomError", "Room is already full");
      }
    } else {
      socket.emit("roomError", "Room does not exist");
    }
  });

  socket.on("leavePrivateRoom", () => {
    for (let [roomId, users] of privateRooms.entries()) {
      if (users.includes(socket.id)) {
        users.forEach((userId) => {
          io.to(userId).emit("unpaired");
          io.sockets.sockets.get(userId).leave(roomId);
        });
        privateRooms.delete(roomId); // Delete the room once empty
        break;
      }
    }
  });

  socket.on("messageFromClient", (message) => {
    sendMessageToPartner(socket.id, message);
  });

  socket.on('sendOffer', data => {
    console.log(`Relaying offer from ${socket.id} to ${data.to}`);
    socket.to(data.to).emit('receiveOffer', { offer: data.offer, from: socket.id });
  });

  socket.on('sendAnswer', data => {
    console.log(`Relaying answer from ${socket.id} to ${data.to}`);
    socket.to(data.to).emit('receiveAnswer', { answer: data.answer });
  });

  socket.on('sendCandidate', data => {
    console.log(`Relaying ICE candidate from ${socket.id} to ${data.to}`);
    socket.to(data.to).emit('receiveCandidate', { candidate: data.candidate });
  });
});

function handleDisconnection(socketId) {
  waitingUsers.delete(socketId);
  if (userPairs.has(socketId)) {
    unpairUsers(socketId);
  }
  console.log("--Disconnected:", socketId);
}

function pairUsers() {
  function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  if (waitingUsers.size >= 2) {
    const usersArray = Array.from(waitingUsers);
    shuffleArray(usersArray);

    while (usersArray.length >= 2) {
      const user1Id = usersArray.pop();
      const user2Id = usersArray.pop();

      const user1Socket = io.sockets.sockets.get(user1Id);
      const user2Socket = io.sockets.sockets.get(user2Id);

      if (user1Socket && user2Socket) {
        const roomName = `${user1Id}_${user2Id}`;
        user1Socket.join(roomName);
        user2Socket.join(roomName);

        io.to(roomName).emit("paired", { roomName, user1Id, user2Id });
        io.to(user1Id).emit("initiateCall");

        console.log(`Created room: ${roomName} with ${user1Id} and ${user2Id}`);

        userPairs.set(user1Id, user2Id);
        userPairs.set(user2Id, user1Id);

        waitingUsers.delete(user1Id);
        waitingUsers.delete(user2Id);
      }
    }
  }
}

function unpairUsers(socketId) {
  const partnerId = userPairs.get(socketId);
  if (partnerId) {
    const roomName = `${socketId}_${partnerId}`;
    [socketId, partnerId].forEach(id => {
      const socket = io.sockets.sockets.get(id);
      if (socket) {
        socket.leave(roomName);
        socket.emit("unpaired");
        waitingUsers.add(id);
      }
    });

    userPairs.delete(socketId);
    userPairs.delete(partnerId);
  }
}

function skipUsers(socketId) {
  if (userPairs.has(socketId)) {
    const partnerId = userPairs.get(socketId);
    const roomName = `${socketId}_${partnerId}`;
    [socketId, partnerId].forEach(id => {
      const socket = io.sockets.sockets.get(id);
      if (socket) {
        socket.leave(roomName);
        waitingUsers.add(id);
        socket.emit("waiting");
      }
    });

    userPairs.delete(socketId);
    userPairs.delete(partnerId);
    pairUsers();
  }
}

function sendMessageToPartner(senderId, message) {
  let isInPrivateRoom = false;
  let roomIdToSend = null;
  for (let [roomId, users] of privateRooms.entries()) {
    if (users.includes(senderId)) {
      isInPrivateRoom = true;
      roomIdToSend = roomId;
      break;
    }
  }

  if (isInPrivateRoom && roomIdToSend) {
    io.to(roomIdToSend).emit("messageFromServer", { sender: senderId, text: message });
  } else if (userPairs.has(senderId)) {
    const partnerId = userPairs.get(senderId);
    io.to(partnerId).emit("messageFromServer", { sender: senderId, text: message });
  }
}
