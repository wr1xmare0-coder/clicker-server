import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// === ХРАНИЛИЩЕ В ПАМЯТИ (пропадёт при перезапуске — это ок для теста) ===
const onlinePlayers = new Map(); // nick -> socketId
const globalLeaderboard = [];    // [{nick, score, date}]
const pendingInvites = new Map(); // toNick -> { fromNick, raceId }
const activeRaces = new Map();   // raceId -> { players: [nick1, nick2], scores: {}, startTime }

// === HTTP ENDPOINTS ===
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    online: onlinePlayers.size,
    leaderboardTop: globalLeaderboard.slice(0, 5)
  });
});

app.get('/leaderboard', (req, res) => {
  res.json(globalLeaderboard.slice(0, 100));
});

// === WEBSOCKET ===
io.on('connection', (socket) => {
  let myNick = null;

  socket.on('login', (nick) => {
    if (!nick || nick.length < 2 || nick.length > 20) {
      socket.emit('login-error', 'Ник должен быть 2-20 символов');
      return;
    }
    myNick = nick;
    onlinePlayers.set(nick, socket.id);
    socket.emit('login-ok', { nick });
    io.emit('online-list', Array.from(onlinePlayers.keys()));
    console.log(`✅ ${nick} зашёл. Онлайн: ${onlinePlayers.size}`);
  });

  // Отправка приглашения на гонку
  socket.on('invite', (toNick) => {
    if (!myNick) return;
    if (!onlinePlayers.has(toNick)) {
      socket.emit('invite-error', `Игрок "${toNick}" не в сети`);
      return;
    }
    if (toNick === myNick) {
      socket.emit('invite-error', 'Нельзя пригласить себя');
      return;
    }
    const raceId = 'race_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    pendingInvites.set(toNick, { fromNick: myNick, raceId });
    const targetSocketId = onlinePlayers.get(toNick);
    io.to(targetSocketId).emit('invited', { from: myNick, raceId });
    socket.emit('invite-sent', { to: toNick });
    console.log(`📨 ${myNick} → ${toNick} (${raceId})`);
  });

  // Принятие приглашения
  socket.on('accept-invite', () => {
    if (!myNick) return;
    const invite = pendingInvites.get(myNick);
    if (!invite) {
      socket.emit('invite-error', 'Нет активного приглашения');
      return;
    }
    const { fromNick, raceId } = invite;
    pendingInvites.delete(myNick);

    activeRaces.set(raceId, {
      players: [fromNick, myNick],
      scores: { [fromNick]: 0, [myNick]: 0 },
      startTime: Date.now()
    });

    const fromSocketId = onlinePlayers.get(fromNick);
    const mySocketId = onlinePlayers.get(myNick);
    io.to(fromSocketId).emit('race-start', { raceId, opponent: myNick, role: 'host' });
    io.to(mySocketId).emit('race-start', { raceId, opponent: fromNick, role: 'guest' });
    console.log(`🏁 Гонка ${raceId}: ${fromNick} vs ${myNick}`);
  });

  // Отклонение приглашения
  socket.on('decline-invite', () => {
    if (!myNick) return;
    const invite = pendingInvites.get(myNick);
    if (invite) {
      const fromSocketId = onlinePlayers.get(invite.fromNick);
      io.to(fromSocketId).emit('invite-declined', { by: myNick });
      pendingInvites.delete(myNick);
    }
  });

  // Обновление очков во время гонки
  socket.on('race-score', ({ raceId, score }) => {
    if (!myNick) return;
    const race = activeRaces.get(raceId);
    if (!race || !race.players.includes(myNick)) return;
    race.scores[myNick] = score;
    race.players.forEach(nick => {
      const sid = onlinePlayers.get(nick);
      if (sid) io.to(sid).emit('race-update', { raceId, scores: race.scores });
    });
  });

  // Завершение гонки
  socket.on('race-finish', ({ raceId }) => {
    if (!myNick) return;
    const race = activeRaces.get(raceId);
    if (!race) return;
    const winner = race.scores[race.players[0]] >= race.scores[race.players[1]]
      ? race.players[0] : race.players[1];
    race.players.forEach(nick => {
      const sid = onlinePlayers.get(nick);
      if (sid) io.to(sid).emit('race-over', {
        raceId,
        winner,
        scores: race.scores
      });
    });
    activeRaces.delete(raceId);
    console.log(`🏆 Гонка ${raceId} окончена. Победил ${winner}`);
  });

  // Отправка результата в глобальный лидерборд
  socket.on('submit-score', ({ nick, score }) => {
    if (!nick || !score) return;
    globalLeaderboard.push({ nick, score, date: new Date().toISOString() });
    globalLeaderboard.sort((a, b) => b.score - a.score);
    if (globalLeaderboard.length > 100) globalLeaderboard.length = 100;
    io.emit('global-leaderboard', globalLeaderboard.slice(0, 100));
  });

  socket.on('disconnect', () => {
    if (myNick) {
      onlinePlayers.delete(myNick);
      io.emit('online-list', Array.from(onlinePlayers.keys()));
      console.log(`❌ ${myNick} вышел. Онлайн: ${onlinePlayers.size}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});