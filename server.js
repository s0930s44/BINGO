const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

// 載入環境變數
dotenv.config();

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

// 創建 MySQL 連接池
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bingo_game',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 初始化數據庫
async function initializeDatabase() {
    try {
        const connection = await pool.getConnection();

        // 創建用戶表
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(255) PRIMARY KEY,
                username VARCHAR(255) NOT NULL,
                room VARCHAR(255) NOT NULL,
                is_admin BOOLEAN DEFAULT FALSE,
                line_count INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 創建房間表，新增 has_drawn 欄位標記是否已開獎
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS rooms (
                room_name VARCHAR(255) PRIMARY KEY,
                user_count INT DEFAULT 0,
                has_drawn BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        // 檢查 has_drawn 欄位是否存在，如果不存在則添加
        try {
            await connection.execute(`
                SELECT has_drawn FROM rooms LIMIT 1
            `);
        } catch (error) {
            // 欄位不存在，添加它
            await connection.execute(`
                ALTER TABLE rooms ADD COLUMN has_drawn BOOLEAN DEFAULT FALSE
            `);
            console.log('已添加 has_drawn 欄位到 rooms 表');
        }

        // 創建開獎號碼表
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS drawn_numbers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room VARCHAR(255) NOT NULL,
                number INT NOT NULL,
                drawn_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_room (room)
            )
        `);

        console.log('數據庫初始化成功');
        connection.release();
    } catch (error) {
        console.error('數據庫初始化失敗:', error);
        process.exit(1);
    }
}

// 初始化數據庫
initializeDatabase();

// 當新連接時，清理舊數據（保持資料庫與實際用戶狀態同步）
async function cleanupOldConnections() {
    try {
        await pool.execute('DELETE FROM users');
        console.log('清理舊連接數據成功');
    } catch (error) {
        console.error('清理舊連接數據失敗:', error);
    }
}

// 伺服器啟動時清理舊連接
cleanupOldConnections();

// 資料庫操作函數封裝
async function getRooms() {
    try {
        const [rows] = await pool.execute('SELECT room_name, has_drawn FROM rooms WHERE user_count > 0');
        return rows;
    } catch (error) {
        console.error('取得房間列表失敗:', error);
        return [];
    }
}

async function getRoomNames() {
    try {
        const [rows] = await pool.execute('SELECT room_name FROM rooms WHERE user_count > 0');
        return rows.map(row => row.room_name);
    } catch (error) {
        console.error('取得房間名稱列表失敗:', error);
        return [];
    }
}

async function getRoom(roomName) {
    try {
        const [rows] = await pool.execute('SELECT * FROM rooms WHERE room_name = ?', [roomName]);
        return rows[0] || null;
    } catch (error) {
        console.error(`取得房間 ${roomName} 失敗:`, error);
        return null;
    }
}

async function createOrUpdateRoom(roomName, changeUserCount = 0, setHasDrawn = null) {
    try {
        const [roomRows] = await pool.execute('SELECT * FROM rooms WHERE room_name = ?', [roomName]);
        if (roomRows.length === 0) {
            // 創建新房間
            await pool.execute(
                'INSERT INTO rooms (room_name, user_count, has_drawn) VALUES (?, ?, ?)',
                [roomName, changeUserCount > 0 ? changeUserCount : 0, setHasDrawn !== null ? setHasDrawn : false]
            );
            return {
                room_name: roomName,
                user_count: changeUserCount > 0 ? changeUserCount : 0,
                has_drawn: setHasDrawn !== null ? setHasDrawn : false
            };
        } else {
            // 更新現有房間
            const newCount = Math.max(0, roomRows[0].user_count + changeUserCount);
            let query = 'UPDATE rooms SET user_count = ? WHERE room_name = ?';
            let params = [newCount, roomName];

            // 如果要更新 has_drawn 狀態
            if (setHasDrawn !== null) {
                query = 'UPDATE rooms SET user_count = ?, has_drawn = ? WHERE room_name = ?';
                params = [newCount, setHasDrawn, roomName];
            }

            await pool.execute(query, params);

            return {
                room_name: roomName,
                user_count: newCount,
                has_drawn: setHasDrawn !== null ? setHasDrawn : roomRows[0].has_drawn
            };
        }
    } catch (error) {
        console.error(`更新房間 ${roomName} 失敗:`, error);
        return null;
    }
}

async function markRoomAsDrawn(roomName) {
    try {
        await pool.execute('UPDATE rooms SET has_drawn = TRUE WHERE room_name = ?', [roomName]);
        console.log(`房間 ${roomName} 已標記為已開獎`);
        return true;
    } catch (error) {
        console.error(`標記房間 ${roomName} 已開獎失敗:`, error);
        return false;
    }
}

async function deleteRoom(roomName) {
    try {
        await pool.execute('DELETE FROM rooms WHERE room_name = ?', [roomName]);
        await pool.execute('DELETE FROM drawn_numbers WHERE room = ?', [roomName]);
        console.log(`房間 ${roomName} 已刪除`);
        return true;
    } catch (error) {
        console.error(`刪除房間 ${roomName} 失敗:`, error);
        return false;
    }
}

async function saveUser(socketId, username, room, isAdmin, lineCount = 0) {
    try {
        await pool.execute(
            'INSERT INTO users (id, username, room, is_admin, line_count) VALUES (?, ?, ?, ?, ?)',
            [socketId, username, room, isAdmin, lineCount]
        );
        return true;
    } catch (error) {
        console.error(`保存用戶 ${username} 失敗:`, error);
        return false;
    }
}

async function getUser(socketId) {
    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [socketId]);
        return rows[0] || null;
    } catch (error) {
        console.error(`取得用戶 ${socketId} 失敗:`, error);
        return null;
    }
}

async function deleteUser(socketId) {
    try {
        const [userRows] = await pool.execute('SELECT * FROM users WHERE id = ?', [socketId]);
        if (userRows.length > 0) {
            const user = userRows[0];
            await pool.execute('DELETE FROM users WHERE id = ?', [socketId]);

            // 更新房間人數
            await createOrUpdateRoom(user.room, -1);

            // 檢查房間是否還有人
            const [roomUserRows] = await pool.execute('SELECT COUNT(*) as count FROM users WHERE room = ?', [user.room]);
            if (roomUserRows[0].count === 0) {
                await deleteRoom(user.room);
            }

            return user;
        }
        return null;
    } catch (error) {
        console.error(`刪除用戶 ${socketId} 失敗:`, error);
        return null;
    }
}

async function updateUserLineCount(socketId, lineCount) {
    try {
        await pool.execute('UPDATE users SET line_count = ? WHERE id = ?', [lineCount, socketId]);
        return true;
    } catch (error) {
        console.error(`更新用戶 ${socketId} 線數失敗:`, error);
        return false;
    }
}

async function getRoomAdmins(room) {
    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE room = ? AND is_admin = TRUE', [room]);
        return rows;
    } catch (error) {
        console.error(`取得房間 ${room} 管理員失敗:`, error);
        return [];
    }
}

async function getRoomPlayers(room) {
    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE room = ? AND is_admin = FALSE', [room]);
        return rows;
    } catch (error) {
        console.error(`取得房間 ${room} 玩家失敗:`, error);
        return [];
    }
}

async function saveDrawnNumber(room, number) {
    try {
        await pool.execute('INSERT INTO drawn_numbers (room, number) VALUES (?, ?)', [room, number]);
        return true;
    } catch (error) {
        console.error(`保存開獎號碼 ${number} 失敗:`, error);
        return false;
    }
}

async function getDrawnNumbers(room) {
    try {
        const [rows] = await pool.execute('SELECT number FROM drawn_numbers WHERE room = ? ORDER BY drawn_at', [room]);
        return rows.map(row => row.number);
    } catch (error) {
        console.error(`取得房間 ${room} 開獎號碼失敗:`, error);
        return [];
    }
}

async function hasRoomDrawnNumbers(room) {
    try {
        const [rows] = await pool.execute('SELECT COUNT(*) as count FROM drawn_numbers WHERE room = ?', [room]);
        return rows[0].count > 0;
    } catch (error) {
        console.error(`檢查房間 ${room} 是否有開獎號碼失敗:`, error);
        return false;
    }
}

// 用來設定房間空置後自動刪除的計時器
const roomTimers = {};

io.on('connection', (socket) => {
    console.log(`用戶連線: ${socket.id}`);

    // 連線後先發送最新房間列表給該用戶
    getRoomNames().then(roomList => {
        socket.emit('roomsListUpdate', roomList);
    });

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

        // 若使用者不是管理員，檢查該房間是否存在且有管理員
        if (!isAdmin) {
            const room = await getRoom(data.room);
            if (!room) {
                socket.emit('loginError', { message: '房間不存在，請由管理員創建房間' });
                return;
            }

            // 檢查房間是否已經開獎
            if (room.has_drawn) {
                socket.emit('loginError', { message: '該房間已經開始遊戲，不能加入' });
                return;
            }

            const admins = await getRoomAdmins(data.room);
            if (admins.length === 0) {
                socket.emit('loginError', { message: '該房間尚未創建或管理員不在線，請等待管理員創建房間' });
                return;
            }
        } else {
            // 檢查房間是否已經存在且已開獎
            const room = await getRoom(data.room);
            if (room && room.has_drawn) {
                // 允許管理員重新連接到已開獎房間
                console.log(`管理員 ${data.username} 重新連接到已開獎房間 ${data.room}`);
            }
        }

        // 更新或創建房間
        await createOrUpdateRoom(data.room, 1);

        // 儲存使用者資料並加入房間
        await saveUser(socket.id, data.username, data.room, isAdmin);
        socket.join(data.room);
        console.log(`用戶 ${data.username} (${isAdmin ? '管理員' : '玩家'}) 加入房間 ${data.room}`);

        // 若該房間曾設定過自動刪除的計時器，則清除
        if (roomTimers[data.room]) {
            clearTimeout(roomTimers[data.room]);
            delete roomTimers[data.room];
        }

        updateRoomsList();
        socket.emit('loginSuccess', { message: '登入成功', room: data.room, isAdmin });
        updateAdminInfo(data.room);
    });

    socket.on('requestRoomsList', async () => {
        const roomList = await getRoomNames();
        socket.emit('roomsListUpdate', roomList);
    });

    // 管理員開獎事件：傳入號碼後驗證並廣播
    socket.on('drawNumber', async (payload) => {
        const user = await getUser(socket.id);
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

        const drawnNumbers = await getDrawnNumbers(room);
        if (drawnNumbers.includes(number)) {
            socket.emit('errorMessage', { message: '該號碼已開過' });
            return;
        }

        await saveDrawnNumber(room, number);

        // 標記房間為已開獎狀態（第一次開獎時）
        if (drawnNumbers.length === 0) {
            await markRoomAsDrawn(room);
        }

        io.to(room).emit('numberDrawn', number);
        console.log(`房間 ${room} 管理員開獎: ${number}`);

        // 廣播鎖定訊息：開獎後所有玩家卡片鎖定
        io.to(room).emit('lockCards');

        await updateAdminInfo(room);
        await updateAdminLineCounts(room);
    });

    // 玩家更新完成線數事件
    socket.on('updateLineCount', async (data) => {
        const user = await getUser(socket.id);
        if (user && !user.is_admin) {
            await updateUserLineCount(socket.id, data.lineCount);
            console.log(`收到玩家 ${user.username} (${socket.id}) 完成線數更新：${data.lineCount}`);
            await updateAdminLineCounts(user.room);
        }
    });

    // 當使用者斷線時
    socket.on('disconnect', async () => {
        const user = await deleteUser(socket.id);
        if (user) {
            console.log(`用戶 ${user.username} 離線`);
            const room = user.room;

            // 檢查房間是否還有人，這在 deleteUser 已處理

            updateRoomsList();
            updateAdminInfo(room);
            updateAdminLineCounts(room);
        } else {
            console.log(`未知用戶離線: ${socket.id}`);
        }
    });
});

// 廣播目前所有已建立的房間列表
async function updateRoomsList() {
    const roomList = await getRoomNames();
    console.log("更新房間列表：", roomList);
    io.emit('roomsListUpdate', roomList);
}

// 更新指定房間內所有管理員的玩家資訊（玩家名稱與連線數）
async function updateAdminInfo(room) {
    try {
        const players = await getRoomPlayers(room);
        const playerNames = players.map(player => player.username);
        const playerCount = players.length;

        console.log(`更新房間 ${room} 玩家資訊：${playerNames}，連線數：${playerCount}`);

        const admins = await getRoomAdmins(room);
        for (const admin of admins) {
            io.to(admin.id).emit('playersUpdate', { players: playerNames, count: playerCount });
        }
    } catch (error) {
        console.error(`更新房間 ${room} 管理員資訊失敗:`, error);
    }
}

// 更新指定房間內所有管理員的玩家完成線數統計
// 統計格式：{ 0: [username, ...], 1: [username, ...], ..., 6: [username, ...] }
async function updateAdminLineCounts(room) {
    try {
        const players = await getRoomPlayers(room);
        const lineCounts = {};
        for (let i = 0; i <= 14; i++) {
            lineCounts[i] = [];
        }

        for (const player of players) {
            const lc = player.line_count || 0;
            if (lc >= 0 && lc <= 14) {
                lineCounts[lc].push(player.username);
            }
        }

        console.log(`房間 ${room} 完成線數統計：`, lineCounts);

        const admins = await getRoomAdmins(room);
        for (const admin of admins) {
            io.to(admin.id).emit('lineCountUpdate', lineCounts);
        }
    } catch (error) {
        console.error(`更新房間 ${room} 線數統計失敗:`, error);
    }
}

// 每 30 分鐘檢查一次數據庫與伺服器狀態是否同步
setInterval(async () => {
    try {
        // 檢查並同步房間人數
        const [roomRows] = await pool.execute('SELECT room_name FROM rooms');
        for (const row of roomRows) {
            const [userRows] = await pool.execute('SELECT COUNT(*) as count FROM users WHERE room = ?', [row.room_name]);
            const actualCount = userRows[0].count;
            await pool.execute('UPDATE rooms SET user_count = ? WHERE room_name = ?', [actualCount, row.room_name]);
        }

        // 清理空房間
        await pool.execute('DELETE FROM rooms WHERE user_count <= 0');

        // 更新房間列表
        await updateRoomsList();
        console.log('資料庫同步完成');
    } catch (error) {
        console.error('資料庫同步失敗:', error);
    }
}, 2 * 60 * 1000);

server.listen(3000, () => {
    console.log('伺服器運行在 http://localhost:3000');
});