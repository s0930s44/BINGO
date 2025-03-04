const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();

// CORS 設定：允許所有來源（測試階段）
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
}));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true
    }
});

const users = {};         // key: socket.id → { username, room, isAdmin, lineCount }
const drawnNumbers = {};  // key: roomName → [number, ...]
const rooms = {};         // key: roomName → 目前房間人數
const roomTimers = {};    // key: roomName → setTimeout 計時器

io.on('connection', (socket) => {
    console.log(`用戶連線: ${socket.id}`);

    // 剛連線時，推送目前房間列表給該用戶
    socket.emit('roomsListUpdate', Object.keys(rooms));

    // 使用者登入
    socket.on('login', (data) => {
        if (!data.username || !data.room || typeof data.username !== 'string' || typeof data.room !== 'string') {
            socket.emit('loginError', { message: '使用者名稱與房間名稱不能為空，且必須為字串' });
            return;
        }
        const isAdmin = data.isAdmin === true;
        if (data.username.trim().length === 0 || data.room.trim().length === 0) {
            socket.emit('loginError', { message: '使用者名稱與房間名稱不能全為空白' });
            return;
        }

        // 保存使用者資料
        users[socket.id] = { username: data.username, room: data.room, isAdmin };
        socket.join(data.room);
        console.log(`用戶 ${data.username} (${isAdmin ? '管理員' : '玩家'}) 加入房間 ${data.room}`);

        // 若該房間尚未有開獎紀錄，初始化
        if (!drawnNumbers[data.room]) {
            drawnNumbers[data.room] = [];
        }
        // 更新房間人數
        if (!rooms[data.room]) {
            rooms[data.room] = 0;
        }
        rooms[data.room]++;

        // 若之前設定了刪除房間的計時器，且有人又加入該房間，就清除計時器
        if (roomTimers[data.room]) {
            clearTimeout(roomTimers[data.room]);
            delete roomTimers[data.room];
        }

        updateRoomsList();

        socket.emit('loginSuccess', { message: '登入成功', room: data.room, isAdmin });
        updateAdminInfo(data.room);
    });

    // 前端要求更新房間列表
    socket.on('requestRoomsList', () => {
        socket.emit('roomsListUpdate', Object.keys(rooms));
    });

    // 管理員開獎
    socket.on('drawNumber', (payload) => {
        const user = users[socket.id];
        if (!user || !user.isAdmin) {
            socket.emit('errorMessage', { message: '只有遊戲管理員能開獎' });
            return;
        }
        const room = user.room;
        const number = payload.number;
        if (typeof number !== 'number' || number < 1 || number > 36) {
            socket.emit('errorMessage', { message: '號碼無效，請輸入 1 到 36 之間的數字' });
            return;
        }
        if (drawnNumbers[room].includes(number)) {
            socket.emit('errorMessage', { message: '該號碼已開過' });
            return;
        }
        drawnNumbers[room].push(number);
        io.to(room).emit('numberDrawn', number);
        console.log(`房間 ${room} 管理員開獎: ${number}`);

        // 開獎後，所有玩家卡片鎖定
        io.to(room).emit('lockCards');

        updateAdminInfo(room);
        updateAdminLineCounts(room);
    });

    // 玩家更新完成線數
    socket.on('updateLineCount', (data) => {
        const user = users[socket.id];
        if (user && !user.isAdmin) {
            user.lineCount = data.lineCount;
            console.log(`收到玩家 ${user.username} (${socket.id}) 完成線數更新：${data.lineCount}`);
            updateAdminLineCounts(user.room);
        }
    });

    // 使用者斷線
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            console.log(`用戶 ${user.username} 離線`);
            const room = user.room;
            delete users[socket.id];

            if (rooms[room]) {
                rooms[room]--;
                // 當該房間人數 <= 0，表示房間已無人
                if (rooms[room] <= 0) {
                    // 設定 5 分鐘計時器，若期間內都沒人進房，就刪除該房間資料
                    roomTimers[room] = setTimeout(() => {
                        // 再次確認房間人數確實為 0
                        if (rooms[room] && rooms[room] <= 0) {
                            delete rooms[room];
                            delete drawnNumbers[room]; // <=== 關鍵：刪除該房間的開獎紀錄
                            delete roomTimers[room];
                            updateRoomsList();
                        }
                    }, 5 * 60 * 1000);
                }
            }

            updateRoomsList();
            updateAdminInfo(room);
            updateAdminLineCounts(room);
        } else {
            console.log(`未知用戶離線: ${socket.id}`);
        }
    });
});

// 更新房間列表並廣播給所有人
function updateRoomsList() {
    const roomList = Object.keys(rooms);
    console.log("更新房間列表：", roomList);
    io.emit('roomsListUpdate', roomList);
}

// 更新管理員的玩家資訊
function updateAdminInfo(room) {
    const playerNames = [];
    let playerCount = 0;
    for (let id in users) {
        if (users[id].room === room && !users[id].isAdmin) {
            playerNames.push(users[id].username);
            playerCount++;
        }
    }
    console.log(`更新房間 ${room} 玩家資訊：${playerNames}，連線數：${playerCount}`);
    for (let id in users) {
        if (users[id].room === room && users[id].isAdmin) {
            io.to(id).emit('playersUpdate', { players: playerNames, count: playerCount });
        }
    }
}

// 更新該房間內的完成線數統計，並推送給管理員
function updateAdminLineCounts(room) {
    const lineCounts = {};
    for (let i = 0; i <= 6; i++) {
        lineCounts[i] = [];
    }
    for (let id in users) {
        if (users[id].room === room && !users[id].isAdmin) {
            const lc = users[id].lineCount || 0;
            if (lc >= 0 && lc <= 6) {
                lineCounts[lc].push(users[id].username);
            }
        }
    }
    console.log(`房間 ${room} 完成線數統計：`, lineCounts);
    for (let id in users) {
        if (users[id].room === room && users[id].isAdmin) {
            io.to(id).emit('lineCountUpdate', lineCounts);
        }
    }
}

// 每 30 分鐘檢查一次 rooms 與 users 是否同步
setInterval(() => {
    for (const room in rooms) {
        let actualCount = 0;
        for (const id in users) {
            if (users[id].room === room) {
                actualCount++;
            }
        }
        if (rooms[room] !== actualCount) {
            rooms[room] = actualCount;
        }
    }
    updateRoomsList();
}, 30 * 60 * 1000);

// 監聽 3000 埠
server.listen(3000, () => {
    console.log('伺服器運行在 http://localhost:3000');
});
