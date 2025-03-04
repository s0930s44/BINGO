// server.js
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();

// 設定 CORS，允許前端 (例如 http://localhost:5173) 請求
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

// 用來暫存使用者資料：{ username, room, isAdmin, (lineCount) }
const users = {}; // key: socket.id
// 記錄各房間已開出的號碼：{ room: [number, ...] }
const drawnNumbers = {};
// 記錄目前已建立的房間：{ roomName: 連線數量 }
const rooms = {};

io.on('connection', (socket) => {
    console.log(`用戶連線: ${socket.id}`);

    // 處理使用者登入與房間加入
    socket.on('login', (data) => {
        // 驗證 username 與 room 必須為非空字串
        if (!data.username || !data.room || typeof data.username !== 'string' || typeof data.room !== 'string') {
            socket.emit('loginError', { message: '使用者名稱與房間名稱不能為空，且必須為字串' });
            return;
        }
        const isAdmin = data.isAdmin === true;
        if (data.username.trim().length === 0 || data.room.trim().length === 0) {
            socket.emit('loginError', { message: '使用者名稱與房間名稱不能全為空白' });
            return;
        }
        // 保存使用者資料並加入指定房間
        users[socket.id] = { username: data.username, room: data.room, isAdmin };
        socket.join(data.room);
        console.log(`用戶 ${data.username} (${isAdmin ? '管理員' : '玩家'}) 加入房間 ${data.room}`);

        // 初始化該房間的開獎紀錄（若尚未初始化）
        if (!drawnNumbers[data.room]) {
            drawnNumbers[data.room] = [];
        }
        // 更新房間列表
        if (!rooms[data.room]) {
            rooms[data.room] = 0;
        }
        rooms[data.room]++;
        updateRoomsList();

        socket.emit('loginSuccess', { message: '登入成功', room: data.room, isAdmin });
        // 更新管理員的玩家資訊
        updateAdminInfo(data.room);
    });

    // 管理員手動開獎事件：傳入號碼後驗證並廣播
    socket.on('drawNumber', (payload) => {
        const user = users[socket.id];
        if (!user || !user.isAdmin) {
            socket.emit('errorMessage', { message: '只有遊戲管理員能開獎' });
            return;
        }
        const room = user.room;
        const number = payload.number;
        // 檢查號碼是否為 1~36 的數字
        if (typeof number !== 'number' || number < 1 || number > 36) {
            socket.emit('errorMessage', { message: '號碼無效，請輸入 1 到 36 之間的數字' });
            return;
        }
        if (drawnNumbers[room].includes(number)) {
            socket.emit('errorMessage', { message: '該號碼已開過' });
            return;
        }
        // 記錄該號碼並廣播給房間所有使用者
        drawnNumbers[room].push(number);
        io.to(room).emit('numberDrawn', number);
        console.log(`房間 ${room} 管理員開獎: ${number}`);

        // 廣播鎖定訊息：管理員開獎後所有玩家卡片鎖定
        io.to(room).emit('lockCards');

        // 更新管理員端資料：玩家資訊與完成線數統計
        updateAdminInfo(room);
        updateAdminLineCounts(room);
    });

    // 玩家更新完成線數事件
    socket.on('updateLineCount', (data) => {
        const user = users[socket.id];
        if (user && !user.isAdmin) {
            user.lineCount = data.lineCount;
            console.log(`收到玩家 ${user.username} (${socket.id}) 完成線數更新：${data.lineCount}`);
            updateAdminLineCounts(user.room);
        }
    });

    // 使用者斷線時更新資料與房間列表
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            console.log(`用戶 ${user.username} 離線`);
            const room = user.room;
            delete users[socket.id];
            if (rooms[room]) {
                rooms[room]--;
                if (rooms[room] <= 0) {
                    delete rooms[room];
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

// 廣播目前所有已建立的房間列表
function updateRoomsList() {
    const roomList = Object.keys(rooms);
    console.log("更新房間列表：", roomList);
    io.emit('roomsListUpdate', roomList);
}

// 更新指定房間內所有管理員的玩家資訊（玩家名稱與連線數）
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
    // 傳送給該房間內所有管理員
    for (let id in users) {
        if (users[id].room === room && users[id].isAdmin) {
            io.to(id).emit('playersUpdate', { players: playerNames, count: playerCount });
        }
    }
}

// 更新指定房間內所有管理員的玩家完成線數統計
// 格式：{ 0: [username, ...], 1: [username, ...], ..., 6: [username, ...] }
function updateAdminLineCounts(room) {
    const lineCounts = {};
    for (let i = 0; i <= 6; i++) {
        lineCounts[i] = [];
    }
    for (let id in users) {
        if (users[id].room === room && !users[id].isAdmin) {
            const lc = users[id].lineCount || 0;
            if (lc >= 0 && lc <= 6) {
                // 修改這裡：改為推入玩家的 username 而非 socket id
                lineCounts[lc].push(users[id].username);
            }
        }
    }
    console.log(`房間 ${room} 完成線數統計：`, lineCounts);
    // 傳送給該房間內所有管理員
    for (let id in users) {
        if (users[id].room === room && users[id].isAdmin) {
            io.to(id).emit('lineCountUpdate', lineCounts);
        }
    }
}

server.listen(3000, () => {
    console.log('伺服器運行在 http://localhost:3000');
});
