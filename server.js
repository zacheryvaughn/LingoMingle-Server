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
    // origin: ["http://127.0.0.1:5500"],
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

function cleanUp() {
  const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
  let removedWaitingUsers = 0;
  let removedPairs = 0;
  let removedRooms = 0;

  // Clean up waitingUsers
  waitingUsers.forEach((userId) => {
    if (!connectedSocketIds.has(userId)) {
      waitingUsers.delete(userId);
      removedWaitingUsers++;
    }
  });

  // Clean up userPairs
  const toRemoveFromUserPairs = [];
  userPairs.forEach((partnerId, userId) => {
    if (!connectedSocketIds.has(userId) || !connectedSocketIds.has(partnerId)) {
      toRemoveFromUserPairs.push(userId, partnerId);
    }
  });

  toRemoveFromUserPairs.forEach((userId) => {
    if (userPairs.delete(userId)) {
      removedPairs++;
    }
  });

  // Clean up privateRooms
  privateRooms.forEach((users, roomId) => {
    const connectedUsers = users.filter((userId) =>
      connectedSocketIds.has(userId)
    );
    if (connectedUsers.length === 0) {
      privateRooms.delete(roomId);
      removedRooms++;
    } else if (connectedUsers.length < users.length) {
      privateRooms.set(roomId, connectedUsers);
    }
  });

  // Log cleanup details
  if (removedWaitingUsers > 0 || removedPairs > 0 || removedRooms > 0) {
    console.log(
      `Cleanup completed: ${removedWaitingUsers} waitingUsers removed, ${removedPairs / 2
      } pairs removed, ${removedRooms} empty rooms removed.`
    );
  }
}
setInterval(cleanUp, 10000);

io.on("connection", (socket) => {
  socket.emit("yourId", socket.id);
  console.log("--Connected:", socket.id);
  io.emit("onlineUsers", io.engine.clientsCount);

  socket.on("disconnect", () => {
    console.log("--Disconnected:", socket.id);
    io.emit("onlineUsers", io.engine.clientsCount);
    waitingUsers.delete(socket.id);
    if (userPairs.has(socket.id)) {
      unpairUsers(socket.id);
    }
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
    // Ensure room doesn't already exist and roomId is valid
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

        // If the room now has two participants
        if (roomParticipants.length === 2) {
          const [user1Id, user2Id] = roomParticipants; // Assuming the first element is the existing user

          // Emit to the room, all participants get the same message
          io.to(roomId).emit("pairedInPrivateRoom", { roomId, user1Id, user2Id });
          io.to(user1Id).emit("initiateCall");

          console.log(`Both users are now in room: ${roomId}`);
        } else {
          // Notify the single user that they are waiting for a partner
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
    // Find and leave the private room
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

  // Run message emit function when message is received from client.
  socket.on("messageFromClient", (message) => {
    sendMessageToPartner(socket.id, message);
  });

  // Relaying the WebRTC offer
  socket.on('sendOffer', data => {
    console.log(`Relaying offer from ${socket.id} to ${data.to}`);
    socket.to(data.to).emit('receiveOffer', { offer: data.offer, from: socket.id });
  });

  // Relaying the WebRTC answer
  socket.on('sendAnswer', data => {
    console.log(`Relaying answer from ${socket.id} to ${data.to}`);
    socket.to(data.to).emit('receiveAnswer', { answer: data.answer });
  });

  // Relaying ICE candidates
  socket.on('sendCandidate', data => {
    console.log(`Relaying ICE candidate from ${socket.id} to ${data.to}`);
    socket.to(data.to).emit('receiveCandidate', { candidate: data.candidate });
  });

});

function pairUsers() {
  function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      // Pick a remaining element
      const j = Math.floor(Math.random() * (i + 1));
      // And swap it with the current element
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
  if (userPairs.has(socketId)) {
    const partnerId = userPairs.get(socketId);
    const roomName = `${socketId}_${partnerId}`;

    [socketId, partnerId].forEach((id) => {
      const socket = io.sockets.sockets.get(id);
      if (socket) {
        socket.leave(roomName);
        socket.emit(id === socketId ? "unpaired" : "waiting");
        if (id === partnerId) waitingUsers.add(id);
      }
    });

    userPairs.delete(socketId);
    userPairs.delete(partnerId);

    pairUsers();
  }
}

function skipUsers(socketId) {
  if (userPairs.has(socketId)) {
    const partnerId = userPairs.get(socketId);
    const roomName = `${socketId}_${partnerId}`;

    // Prepare both users for re-pairing without emitting 'unpaired'
    [socketId, partnerId].forEach((userId) => {
      const userSocket = io.sockets.sockets.get(userId);
      if (userSocket) {
        // Ensure users leave their current room to avoid message crossover
        userSocket.leave(roomName);
        // Re-add both users to waitingUsers for immediate re-pairing
        waitingUsers.add(userId);
        // Notify both users they're being re-paired
        userSocket.emit("waiting");
      }
    });

    // Remove the users from the userPairs map
    userPairs.delete(socketId);
    userPairs.delete(partnerId);

    // Attempt to re-pair users including the ones just skipped
    pairUsers();
  }
}

// Function that determined how messages should be routed
function sendMessageToPartner(senderId, message) {
  // Check if the sender is in a private room
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
    // If the sender is in a private room, emit the message to the other user in the room
    io.to(roomIdToSend).emit("messageFromServer", {
      sender: senderId,
      text: message,
    });
  } else if (userPairs.has(senderId)) {
    // If the sender is randomly paired, emit the message to the paired user
    const partnerId = userPairs.get(senderId);
    io.to(partnerId).emit("messageFromServer", {
      sender: senderId,
      text: message,
    });
  }
}
