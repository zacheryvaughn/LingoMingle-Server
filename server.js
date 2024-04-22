////////////////////////////////////////////////////////////////////////////////////
// DEPENDENCIES AND ROUTING ////////////////////////////////////////////////////////
const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
const io = new Server(server, {
  cors: {
    // origin: ["http://127.0.0.1:5500", "https://ludo.lingomingle.com"],
    origin: ["http://127.0.0.1:5501"],
    methods: ["GET", "POST"],
    credentials: true,
  },
});
app.get('/', (req, res) => {
  res.redirect("http://127.0.0.1:5501");
});

////////////////////////////////////////////////////////////////////////////////////
// PLAYER AND ROOM LOCATIONS ///////////////////////////////////////////////////////
const availablePlayers = new Map();
const queuedPlayers = new Map();
const publicLobbies = new Map();
const privateLobbies = new Map();

////////////////////////////////////////////////////////////////////////////////////
// CONNECTION SIGNALS //////////////////////////////////////////////////////////////
io.on("connection", (socket) => {
  availablePlayers.set(socket.id, { nickname: "Anonymous", desiredPlayers: 4, playerNum: null });
  console.log("Connected:", socket.id);

  socket.on("disconnect", () => {
    handleDisconnect(socket.id);
    if (availablePlayers.has(socket.id)) {
      availablePlayers.delete(socket.id);
      console.log("Disconnected (removed from availablePlayers):", socket.id);
    }
    if (queuedPlayers.has(socket.id)) {
      queuedPlayers.delete(socket.id);
      console.log("Disconnected (removed from queuedPlayers):", socket.id);
    }
  });

  socket.on("playRequest", (data) => {
    availablePlayers.delete(socket.id);
    const nickname = data.nickname || "Anonymous";
    const desiredPlayers = data.desiredPlayers || 4;
    queuedPlayers.set(socket.id, { nickname: nickname, desiredPlayers: desiredPlayers, playerNum: null });
    console.log("Moved to queuedPlayers:", socket.id, { nickname: nickname, desiredPlayers: desiredPlayers, playerNum: null });
    socket.emit("findingLobby");
  });

});

////////////////////////////////////////////////////////////////////////////////////
// LOBBY MANAGEMENT ////////////////////////////////////////////////////////////////
function joinLobby(playerId, lobbyId) {
  const lobby = publicLobbies.get(lobbyId);
  if (!lobby) {
    console.error(`No lobby found with ID: ${lobbyId}`);
    return; // Fail-safe check
  }

  const playerData = queuedPlayers.get(playerId);
  if (!playerData) {
    console.error(`No queued player data found for ID: ${playerId}`);
    return; // Additional fail-safe check
  }

  const playerNum = lobby.members.length + 1;
  // Store the complete player data in the lobby, including the nickname
  lobby.members.push({ id: playerId, nickname: playerData.nickname, playerNum: playerNum });
  lobby.vacantSlots--;

  // Player is now fully joined to the lobby, remove from queued players
  queuedPlayers.delete(playerId);
  console.log(`Player ${playerId} joined lobby ${lobbyId} as Player ${playerNum}`);

  // Ensure the player joins the room
  io.sockets.sockets.get(playerId).join(lobbyId);

  // Directly use lobby members to emit details, ensuring all data is accurate
  const lobbyMembers = lobby.members.map(member => ({
    nickname: member.nickname,
    playerNum: member.playerNum
  }));

  io.to(playerId).emit('inLobby');
  io.to(lobbyId).emit('updateLobby', lobbyMembers);

  if (lobby.vacantSlots === 0) {
    lobby.inMatch = true;
    console.log(`Lobby ${lobbyId} is now full. Match will start in 1 second.`);
    // Delay match start by 1 second
    setTimeout(() => {
      io.to(lobbyId).emit('matchStarted');
      console.log(`Match started in lobby ${lobbyId}.`);
    }, 1000); // Delay is 1000 milliseconds
  }
};

function createNewLobby(playerId) {
  const player = queuedPlayers.get(playerId);
  const lobbyId = `lobby_${Math.random().toString(36).substr(2, 9)}`; // Generate a unique ID
  const newLobby = {
    maxPlayers: player.desiredPlayers,
    vacantSlots: player.desiredPlayers - 1,
    inMatch: false,
    members: [{ id: playerId, nickname: player.nickname, playerNum: 1 }]
  };

  publicLobbies.set(lobbyId, newLobby);
  // Player data is used up, remove from queue
  queuedPlayers.delete(playerId);
  console.log(`New lobby created with ID: ${lobbyId} by player: ${playerId}`);

  // Ensure the player joins the room
  io.sockets.sockets.get(playerId).join(lobbyId);

  // Emit the player's own data as they are the only member
  io.to(playerId).emit('inLobby');
  io.to(lobbyId).emit('updateLobby', [{ nickname: player.nickname, playerNum: 1 }]);
};

function setupLobby() {
  queuedPlayers.forEach((_, playerId) => {
    const player = queuedPlayers.get(playerId);
    if (!player) return; // No player found in the queue

    const desiredPlayers = player.desiredPlayers;
    let foundLobby = false;

    for (const [lobbyId, lobby] of publicLobbies) {
      if (!lobby.inMatch && lobby.vacantSlots > 0 && lobby.maxPlayers === desiredPlayers) {
        joinLobby(playerId, lobbyId);
        foundLobby = true;
        break;
      }
    }

    if (!foundLobby) {
      createNewLobby(playerId);
    }
  });
};

setInterval(() => {
  if (queuedPlayers.size > 0) {
    console.log("Checking queued players for lobby assignment...");
    setupLobby();
  }
}, 2000);

function handleDisconnect(playerId) {
  let lobbyIdFound = null;

  // Find the lobby the player is in, if any
  for (const [lobbyId, lobby] of publicLobbies) {
    const memberIndex = lobby.members.findIndex(member => member.id === playerId);
    if (memberIndex !== -1) {
      lobbyIdFound = lobbyId;
      break;
    }
  }

  if (!lobbyIdFound) {
    console.log("Player was not in any lobby:", playerId);
    return; // Player was not in any lobby
  }

  const lobby = publicLobbies.get(lobbyIdFound);
  if (!lobby) return; // Just a safety check, should not be necessary

  // Filter out the player from the lobby
  lobby.members.splice(lobby.members.findIndex(member => member.id === playerId), 1);
  lobby.vacantSlots++;

  // Reassign player numbers to remaining members
  lobby.members.forEach((member, index) => {
    member.playerNum = index + 1;
  });

  if (lobby.inMatch) {
    console.log(`Player ${playerId} disconnected after match started in lobby ${lobbyIdFound}.`);
  } else {
    console.log(`Player ${playerId} disconnected before match started in lobby ${lobbyIdFound}.`);
    if (lobby.members.length === 0) {
      // If the lobby is now empty, we might as well delete it
      publicLobbies.delete(lobbyIdFound);
      console.log(`Lobby ${lobbyIdFound} is now empty and has been deleted.`);
    } else {
      // Reset the match start countdown if it was the last player needed to start the match
      if (lobby.vacantSlots === 1) {
        console.log(`Resetting match start countdown for lobby ${lobbyIdFound}.`);
        // Code to reset the countdown would go here (if applicable)
      }
    }
  }

  // Emit the update to all players in the lobby
  const lobbyMembers = lobby.members.map(member => ({
    nickname: member.nickname,
    playerNum: member.playerNum
  }));
  io.to(lobbyIdFound).emit('updateLobby', lobbyMembers);
}