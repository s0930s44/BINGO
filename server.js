const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// 初始化 Express 應用
const app = express();

// 使用 CORS，允許所有來源
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

// 確保數據目錄存在
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 初始化 SQLite 數據庫
const db = new sqlite3.Database(path.join(DATA_DIR, 'bingo-game.db'));

// 用來設定房間空置後自動刪除的計時器 (保留在記憶體中)
const roomTimers = {};

// 將查詢轉換為 Promise
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// 初始化資料庫表
async function initializeDatabase() {
    try {
        console.log('初始化數據庫表...');

        // 用戶表
        await dbRun(`
            CREATE TABLE IF NOT EXISTS users (
                socket_id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                room TEXT NOT NULL,
                is_admin INTEGER NOT NULL,
                line_count INTEGER DEFAULT 0
            )
        `);

        // 房間表
        await dbRun(`
            CREATE TABLE IF NOT EXISTS rooms (
                room_name TEXT PRIMARY KEY,
                user_count INTEGER NOT NULL DEFAULT 0
            )
        `);

        // 開獎號碼表
        await dbRun(`
            CREATE TABLE IF NOT EXISTS drawn_numbers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room TEXT NOT NULL,
                number INTEGER NOT NULL,
                drawn_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(room, number)
            )
        `);

        // 房間計時器表
        await dbRun(`
            CREATE TABLE IF NOT EXISTS room_timers (
                room TEXT PRIMARY KEY,
                expires_at TIMESTAMP NOT NULL
            )
        `);

        // 建立索引以提升查詢效能
        await dbRun(`CREATE INDEX IF NOT EXISTS idx_users_room ON users(room)`);
        await dbRun(`CREATE INDEX IF NOT EXISTS idx_drawn_numbers_room ON drawn_numbers(room)`);

        console.log('數據庫初始化完成');
    } catch (error) {
        console.error('數據庫初始化錯誤:', error);
        process.exit(1);
    }
}

// 啟動前初始化數據庫
initializeDatabase().then(() => {
    // Socket.io 連接處理
    io.on('connection', (socket) => {
        console.log(`用戶連線: ${socket.id}`);

        // 連線後先發送最新房間列表給該用戶
        getRoomsList().then(roomList => {
            socket.emit('roomsListUpdate', roomList);
        }).catch(error => {
            console.error('獲取房間列表錯誤:', error);
        });

        // 使用者登入事件
        socket.on('login', async (data) => {
            try {
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

                // 若使用者不是管理員，檢查該房間是否存在且有管理員
                if (!isAdmin) {
                    // 檢查房間是否存在
                    const roomExists = await dbGet(`SELECT * FROM rooms WHERE room_name = ?`, [data.room]);

                    if (!roomExists) {
                        socket.emit('loginError', { message: '房間不存在，請由管理員創建房間' });
                        return;
                    }

                    // 檢查房間是否有管理員
                    const adminExists = await dbGet(`
                        SELECT * FROM users 
                        WHERE room = ? AND is_admin = 1
                    `, [data.room]);

                    if (!adminExists) {
                        socket.emit('loginError', { message: '該房間尚未創建或管理員不在線，請等待管理員創建房間' });
                        return;
                    }
                } else {
                    // 若是管理員，若房間不存在則建立房間
                    const roomExists = await dbGet(`SELECT * FROM rooms WHERE room_name = ?`, [data.room]);

                    if (!roomExists) {
                        await dbRun(`INSERT INTO rooms (room_name, user_count) VALUES (?, 0)`, [data.room]);
                    }
                }

                // 更新房間人數
                await dbRun(`
                    UPDATE rooms SET user_count = user_count + 1 
                    WHERE room_name = ?
                `, [data.room]);

                // 儲存使用者資料
                await dbRun(`
                    INSERT INTO users (socket_id, username, room, is_admin, line_count) 
                    VALUES (?, ?, ?, ?, 0)
                `, [socket.id, data.username, data.room, isAdmin ? 1 : 0]);

                socket.join(data.room);
                console.log(`用戶 ${data.username} (${isAdmin ? '管理員' : '玩家'}) 加入房間 ${data.room}`);

                // 若該房間曾設定過自動刪除的計時器，則清除
                if (roomTimers[data.room]) {
                    clearTimeout(roomTimers[data.room]);
                    delete roomTimers[data.room];

                    await dbRun(`DELETE FROM room_timers WHERE room = ?`, [data.room]);
                }

                await updateRoomsList();
                socket.emit('loginSuccess', { message: '登入成功', room: data.room, isAdmin });
                await updateAdminInfo(data.room);
            } catch (error) {
                console.error('登入處理錯誤:', error);
                socket.emit('loginError', { message: '登入處理出錯，請稍後再試' });
            }
        });

        socket.on('requestRoomsList', async () => {
            try {
                const roomList = await getRoomsList();
                socket.emit('roomsListUpdate', roomList);
            } catch (error) {
                console.error('獲取房間列表錯誤:', error);
                socket.emit('errorMessage', { message: '無法獲取房間列表' });
            }
        });

        // 管理員開獎事件：傳入號碼後驗證並廣播
        socket.on('drawNumber', async (payload) => {
            try {
                // 檢查使用者是否為管理員
                const user = await dbGet(`
                    SELECT * FROM users WHERE socket_id = ?
                `, [socket.id]);

                if (!user || !user.is_admin) {
                    socket.emit('errorMessage', { message: '只有遊戲管理員能開獎' });
                    return;
                }

                const room = user.room;
                const number = payload.number;

                if (typeof number !== 'number' || number < 1 || number > 36) {
                    socket.emit('errorMessage', { message: '號碼無效，請輸入 1 到 36 之間的數字' });
                    return;
                }

                // 檢查號碼是否已開過
                const numberExists = await dbGet(`
                    SELECT * FROM drawn_numbers 
                    WHERE room = ? AND number = ?
                `, [room, number]);

                if (numberExists) {
                    socket.emit('errorMessage', { message: '該號碼已開過' });
                    return;
                }

                // 儲存開獎號碼
                await dbRun(`
                    INSERT INTO drawn_numbers (room, number) 
                    VALUES (?, ?)
                `, [room, number]);

                io.to(room).emit('numberDrawn', number);
                console.log(`房間 ${room} 管理員開獎: ${number}`);

                // 廣播鎖定訊息：開獎後所有玩家卡片鎖定
                io.to(room).emit('lockCards');

                await updateAdminInfo(room);
                await updateAdminLineCounts(room);
            } catch (error) {
                console.error('開獎處理錯誤:', error);
                socket.emit('errorMessage', { message: '開獎處理出錯，請稍後再試' });
            }
        });

        // 玩家更新完成線數事件
        socket.on('updateLineCount', async (data) => {
            try {
                const user = await dbGet(`
                    SELECT * FROM users WHERE socket_id = ?
                `, [socket.id]);

                if (user && !user.is_admin) {
                    await dbRun(`
                        UPDATE users SET line_count = ? 
                        WHERE socket_id = ?
                    `, [data.lineCount, socket.id]);

                    console.log(`收到玩家 ${user.username} (${socket.id}) 完成線數更新：${data.lineCount}`);
                    await updateAdminLineCounts(user.room);
                }
            } catch (error) {
                console.error('更新線數錯誤:', error);
            }
        });

        // 當使用者斷線時
        socket.on('disconnect', async () => {
            try {
                const user = await dbGet(`
                    SELECT * FROM users WHERE socket_id = ?
                `, [socket.id]);

                if (user) {
                    console.log(`用戶 ${user.username} 離線`);
                    const room = user.room;

                    // 刪除用戶
                    await dbRun(`
                        DELETE FROM users WHERE socket_id = ?
                    `, [socket.id]);

                    // 更新房間人數
                    await dbRun(`
                        UPDATE rooms SET user_count = user_count - 1 
                        WHERE room_name = ?
                    `, [room]);

                    // 檢查房間剩餘人數
                    const roomInfo = await dbGet(`
                        SELECT user_count FROM rooms 
                        WHERE room_name = ?
                    `, [room]);

                    if (roomInfo && roomInfo.user_count <= 0) {
                        // 刪除房間和相關數據
                        await dbRun(`
                            DELETE FROM rooms WHERE room_name = ?
                        `, [room]);

                        await dbRun(`
                            DELETE FROM drawn_numbers WHERE room = ?
                        `, [room]);

                        if (roomTimers[room]) {
                            clearTimeout(roomTimers[room]);
                            delete roomTimers[room];

                            await dbRun(`
                                DELETE FROM room_timers WHERE room = ?
                            `, [room]);
                        }
                    }

                    await updateRoomsList();
                    await updateAdminInfo(room);
                    await updateAdminLineCounts(room);
                } else {
                    console.log(`未知用戶離線: ${socket.id}`);
                }
            } catch (error) {
                console.error('處理用戶離線錯誤:', error);
            }
        });
    });

    // 每分鐘檢查房間與用戶數據一致性
    setInterval(async () => {
        try {
            // 獲取所有房間
            const rooms = await dbAll(`
                SELECT room_name FROM rooms
            `);

            for (const room of rooms) {
                // 計算實際用戶數
                const userCount = await dbGet(`
                    SELECT COUNT(*) as count FROM users 
                    WHERE room = ?
                `, [room.room_name]);

                // 更新房間用戶數
                await dbRun(`
                    UPDATE rooms SET user_count = ? 
                    WHERE room_name = ?
                `, [userCount.count, room.room_name]);
            }

            await updateRoomsList();
        } catch (error) {
            console.error('同步房間數據錯誤:', error);
        }
    }, 60 * 1000);

    // 啟動伺服器
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`伺服器運行在 http://localhost:${PORT}`);
    });

}).catch(error => {
    console.error('啟動伺服器失敗:', error);
});

// 獲取房間列表
async function getRoomsList() {
    try {
        const rooms = await dbAll(`
            SELECT room_name FROM rooms
        `);

        return rooms.map(room => room.room_name);
    } catch (error) {
        console.error('獲取房間列表錯誤:', error);
        return [];
    }
}

// 廣播房間列表
async function updateRoomsList() {
    try {
        const roomList = await getRoomsList();
        console.log("更新房間列表：", roomList);
        io.emit('roomsListUpdate', roomList);
    } catch (error) {
        console.error('更新房間列表錯誤:', error);
    }
}

// 更新指定房間內所有管理員的玩家資訊
async function updateAdminInfo(room) {
    try {
        // 獲取該房間內的玩家列表
        const players = await dbAll(`
            SELECT username FROM users 
            WHERE room = ? AND is_admin = 0
        `, [room]);

        const playerNames = players.map(player => player.username);
        const playerCount = playerNames.length;

        console.log(`更新房間 ${room} 玩家資訊：${playerNames}，連線數：${playerCount}`);

        // 獲取該房間內的所有管理員
        const admins = await dbAll(`
            SELECT socket_id FROM users 
            WHERE room = ? AND is_admin = 1
        `, [room]);

        // 向每位管理員發送更新
        for (const admin of admins) {
            io.to(admin.socket_id).emit('playersUpdate', {
                players: playerNames,
                count: playerCount
            });
        }
    } catch (error) {
        console.error('更新管理員資訊錯誤:', error);
    }
}

// 更新指定房間內所有管理員的玩家完成線數統計
async function updateAdminLineCounts(room) {
    try {
        // 初始化線數統計
        const lineCounts = {};
        for (let i = 0; i <= 14; i++) {
            lineCounts[i] = [];
        }

        // 獲取該房間內的所有玩家及其線數
        const players = await dbAll(`
            SELECT username, line_count FROM users 
            WHERE room = ? AND is_admin = 0
        `, [room]);

        // 整理線數統計
        for (const player of players) {
            const lc = player.line_count || 0;
            if (lc >= 0 && lc <= 14) {
                lineCounts[lc].push(player.username);
            }
        }

        console.log(`房間 ${room} 完成線數統計：`, lineCounts);

        // 獲取該房間內的所有管理員
        const admins = await dbAll(`
            SELECT socket_id FROM users 
            WHERE room = ? AND is_admin = 1
        `, [room]);

        // 向每位管理員發送線數統計
        for (const admin of admins) {
            io.to(admin.socket_id).emit('lineCountUpdate', lineCounts);
        }
    } catch (error) {
        console.error('更新線數統計錯誤:', error);
    }
}

// 優雅關閉
process.on('SIGINT', () => {
    console.log('正在關閉伺服器...');

    // 關閉 Socket.io 連接
    io.close(() => {
        console.log('Socket.io 伺服器已關閉');

        // 關閉 SQLite 數據庫連接
        db.close();
        console.log('數據庫連接已關閉');

        process.exit(0);
    });
});