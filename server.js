const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const pool = require('./db');  // 引入剛才建立的資料庫連線模組

const app = express();

// 使用 CORS，允許所有來源（測試階段）
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

// 儲存所有使用者資料：{ username, room, isAdmin, lineCount }
const users = {};
// 儲存各房間的開獎號碼：{ room: [number, ...] }
const drawnNumbers = {};
// 儲存目前每個房間的連線人數：{ room: count }
const rooms = {};
// 用來設定房間空置後自動刪除的計時器
const roomTimers = {};

// 建立房間：若房間不存在，管理員登入時呼叫
async function createRoom(roomName, adminName) {
    try {
        await pool.query(
            'INSERT INTO rooms (room_name, admin) VALUES (?, ?)',
            [roomName, adminName]
        );
        console.log(`DB: 房間 ${roomName} 建立成功`);
    } catch (err) {
        console.error('DB: 建立房間錯誤：', err);
    }
}

// 新增玩家：玩家加入時呼叫
async function addPlayer(username, roomName, isAdmin = false) {
    try {
        await pool.query(
            'INSERT INTO players (username, room_name, is_admin) VALUES (?, ?, ?)',
            [username, roomName, isAdmin]
        );
        console.log(`DB: 玩家 ${username} 加入房間 ${roomName}`);
    } catch (err) {
        console.error('DB: 新增玩家錯誤：', err);
    }
}

// 取得房間資料
async function getRoom(roomName) {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM rooms WHERE room_name = ?',
            [roomName]
        );
        return rows;
    } catch (err) {
        console.error('DB: 取得房間錯誤：', err);
        return null;
    }
}

// 刪除房間：當房間空置時，從資料庫中刪除房間（ON DELETE CASCADE 自動清除玩家資料）
async function deleteRoomFromDB(roomName) {
    try {
        await pool.query(
            'DELETE FROM rooms WHERE room_name = ?',
            [roomName]
        );
        console.log(`DB: 房間 ${roomName} 已刪除`);
    } catch (err) {
        console.error('DB: 刪除房間錯誤：', err);
    }
}

io.on('connection', (socket) => {
    console.log(`用戶連線: ${socket.id}`);

    // 連線後先發送最新房間列表給該用戶（後續你可以改從資料庫中查詢）
    socket.emit('roomsListUpdate', Object.keys(rooms));

    // 使用者登入事件
    socket.on('login', async (data) => {
        // 驗證 username 與 room 是否存在且為字串
        if (!data.username || !data.room || typeof data.username !== 'string' || typeof data.room !== 'string') {
            socket.emit('loginError', { message: '使用者名稱與房間名稱不能為空，且必須為字串' });
            return;
        }
        const isAdmin = data.isAdmin === true;
        if (data.username.trim().length === 0 || data.room.trim().length === 0) {
            socket.emit('loginError', { message: '使用者名稱與房間名稱不能全為空白' });
            return;
        }

        if (!isAdmin) {
            // 如果是玩家，先檢查資料庫中房間是否存在
            const roomData = await getRoom(data.room);
            if (!roomData || roomData.length === 0) {
                socket.emit('loginError', { message: '房間不存在，請由管理員創建房間' });
                return;
            }
        } else {
            // 若是管理員，若房間不存在則建立房間
            const roomData = await getRoom(data.room);
            if (!roomData || roomData.length === 0) {
                await createRoom(data.room, data.username);
            }
        }

        // 更新房間人數（不論管理員或玩家，都要加1）
        rooms[data.room] = (rooms[data.room] || 0) + 1;
        // 儲存使用者資料並加入房間
        users[socket.id] = { username: data.username, room: data.room, isAdmin };
        socket.join(data.room);
        console.log(`用戶 ${data.username} (${isAdmin ? '管理員' : '玩家'}) 加入房間 ${data.room}`);

        // 初始化該房間的開獎紀錄（若尚未初始化）
        if (!drawnNumbers[data.room]) {
            drawnNumbers[data.room] = [];
        }

        // 若該房間曾設定過自動刪除的計時器，則清除
        if (roomTimers[data.room]) {
            clearTimeout(roomTimers[data.room]);
            delete roomTimers[data.room];
        }

        // 如果是玩家，新增玩家資料到資料庫
        if (!isAdmin) {
            await addPlayer(data.username, data.room, false);
        }

        updateRoomsList();
        socket.emit('loginSuccess', { message: '登入成功', room: data.room, isAdmin });
        updateAdminInfo(data.room);
    });

    socket.on('requestRoomsList', () => {
        socket.emit('roomsListUpdate', Object.keys(rooms));
    });

    // 管理員開獎事件：傳入號碼後驗證並廣播
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

        // 廣播鎖定訊息：開獎後所有玩家卡片鎖定
        io.to(room).emit('lockCards');

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

    // 當使用者斷線時
    socket.on('disconnect', async () => {
        const user = users[socket.id];
        if (user) {
            console.log(`用戶 ${user.username} 離線`);
            const room = user.room;
            delete users[socket.id];
            if (rooms[room]) {
                rooms[room]--;
                // 當房間人數 <= 0，立即刪除房間與開獎紀錄，同時清除資料庫中該房間資料
                if (rooms[room] <= 0) {
                    delete rooms[room];
                    delete drawnNumbers[room];
                    if (roomTimers[room]) {
                        clearTimeout(roomTimers[room]);
                        delete roomTimers[room];
                    }
                    // 刪除資料庫中的房間 (ON DELETE CASCADE 將刪除對應的玩家資料)
                    await deleteRoomFromDB(room);
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
    for (let id in users) {
        if (users[id].room === room && users[id].isAdmin) {
            io.to(id).emit('playersUpdate', { players: playerNames, count: playerCount });
        }
    }
}

// 更新指定房間內所有管理員的玩家完成線數統計
function updateAdminLineCounts(room) {
    const lineCounts = {};
    for (let i = 0; i <= 14; i++) {
        lineCounts[i] = [];
    }
    for (let id in users) {
        if (users[id].room === room && !users[id].isAdmin) {
            const lc = users[id].lineCount || 0;
            if (lc >= 0 && lc <= 14) {
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

// 每 60 分鐘檢查一次 rooms 與 users 是否同步
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
}, 60 * 1000);

server.listen(3000, () => {
    console.log('伺服器運行在 http://localhost:3000');
});
