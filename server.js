const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
// 使用 SQL.js 替代 better-sqlite3
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

// 初始化 Express 應用
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

// 確保數據目錄存在
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_FILE = path.join(DATA_DIR, 'bingo-game.db');

// 全局數據庫變數
let db;

// 用來設定房間空置後自動刪除的計時器 (保留在記憶體中)
const roomTimers = {};

// 保存數據庫到文件
function saveDatabase() {
    try {
        if (db) {
            const data = db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(DB_FILE, buffer);
        }
    } catch (error) {
        console.error('保存數據庫錯誤:', error);
    }
}

// 自動保存數據庫 (每30秒)
setInterval(saveDatabase, 30000);

// 初始化資料庫
async function initializeDatabase() {
    try {
        console.log('初始化數據庫...');

        // 載入 SQL.js
        const SQL = await initSqlJs();

        // 檢查數據庫文件是否存在
        if (fs.existsSync(DB_FILE)) {
            const filebuffer = fs.readFileSync(DB_FILE);
            db = new SQL.Database(filebuffer);
            console.log('已載入現有數據庫文件');
        } else {
            // 創建新數據庫
            db = new SQL.Database();
            console.log('創建新數據庫');
        }

        // 用戶表
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                socket_id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                room TEXT NOT NULL,
                is_admin INTEGER NOT NULL,
                line_count INTEGER DEFAULT 0
            )
        `);

        // 房間表
        db.run(`
            CREATE TABLE IF NOT EXISTS rooms (
                room_name TEXT PRIMARY KEY,
                user_count INTEGER NOT NULL DEFAULT 0
            )
        `);

        // 開獎號碼表
        db.run(`
            CREATE TABLE IF NOT EXISTS drawn_numbers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room TEXT NOT NULL,
                number INTEGER NOT NULL,
                drawn_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(room, number)
            )
        `);

        // 房間計時器表
        db.run(`
            CREATE TABLE IF NOT EXISTS room_timers (
                room TEXT PRIMARY KEY,
                expires_at TIMESTAMP NOT NULL
            )
        `);

        // 建立索引以提升查詢效能
        db.run(`CREATE INDEX IF NOT EXISTS idx_users_room ON users(room)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_drawn_numbers_room ON drawn_numbers(room)`);

        // 保存初始化後的數據庫
        saveDatabase();
        console.log('數據庫初始化完成');

        // 啟動伺服器
        startServer();
    } catch (error) {
        console.error('數據庫初始化錯誤:', error);
        process.exit(1);
    }
}

// SQL.js 查詢輔助函數
function dbGet(sql, params = []) {
    try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const result = stmt.step() ? stmt.getAsObject() : null;
        stmt.free();
        return result;
    } catch (error) {
        console.error('查詢錯誤:', sql, params, error);
        return null;
    }
}

function dbAll(sql, params = []) {
    try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const results = [];
        while(stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    } catch (error) {
        console.error('查詢錯誤:', sql, params, error);
        return [];
    }
}

function dbRun(sql, params = []) {
    try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        stmt.step();
        stmt.free();
        return true;
    } catch (error) {
        console.error('執行錯誤:', sql, params, error);
        return false;
    }
}

// Socket.io 連接處理
function setupSocketIO() {
    io.on('connection', (socket) => {
        console.log(`用戶連線: ${socket.id}`);

        try {
            // 連線後先發送最新房間列表給該用戶
            const roomList = getRoomsList();
            socket.emit('roomsListUpdate', roomList);
        } catch (error) {
            console.error('獲取房間列表錯誤:', error);
        }

        // 使用者登入事件
        socket.on('login', (data) => {
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
                    const roomExists = dbGet(`SELECT * FROM rooms WHERE room_name = ?`, [data.room]);

                    if (!roomExists) {
                        socket.emit('loginError', { message: '房間不存在，請由管理員創建房間' });
                        return;
                    }

                    // 檢查房間是否有管理員
                    const adminExists = dbGet(`
                        SELECT * FROM users 
                        WHERE room = ? AND is_admin = 1
                    `, [data.room]);

                    if (!adminExists) {
                        socket.emit('loginError', { message: '該房間尚未創建或管理員不在線，請等待管理員創建房間' });
                        return;
                    }
                } else {
                    // 若是管理員，若房間不存在則建立房間
                    const roomExists = dbGet(`SELECT * FROM rooms WHERE room_name = ?`, [data.room]);

                    if (!roomExists) {
                        dbRun(`INSERT INTO rooms (room_name, user_count) VALUES (?, 0)`, [data.room]);
                    }
                }

                // 更新房間人數
                dbRun(`
                    UPDATE rooms SET user_count = user_count + 1 
                    WHERE room_name = ?
                `, [data.room]);

                // 儲存使用者資料
                dbRun(`
                    INSERT INTO users (socket_id, username, room, is_admin, line_count) 
                    VALUES (?, ?, ?, ?, 0)
                `, [socket.id, data.username, data.room, isAdmin ? 1 : 0]);

                socket.join(data.room);
                console.log(`用戶 ${data.username} (${isAdmin ? '管理員' : '玩家'}) 加入房間 ${data.room}`);

                // 若該房間曾設定過自動刪除的計時器，則清除
                if (roomTimers[data.room]) {
                    clearTimeout(roomTimers[data.room]);
                    delete roomTimers[data.room];

                    dbRun(`DELETE FROM room_timers WHERE room = ?`, [data.room]);
                }

                // 保存數據庫變更
                saveDatabase();

                updateRoomsList();
                socket.emit('loginSuccess', { message: '登入成功', room: data.room, isAdmin });
                updateAdminInfo(data.room);
            } catch (error) {
                console.error('登入處理錯誤:', error);
                socket.emit('loginError', { message: '登入處理出錯，請稍後再試' });
            }
        });

        socket.on('requestRoomsList', () => {
            try {
                const roomList = getRoomsList();
                socket.emit('roomsListUpdate', roomList);
            } catch (error) {
                console.error('獲取房間列表錯誤:', error);
                socket.emit('errorMessage', { message: '無法獲取房間列表' });
            }
        });

        // 管理員開獎事件：傳入號碼後驗證並廣播
        socket.on('drawNumber', (payload) => {
            try {
                // 檢查使用者是否為管理員
                const user = dbGet(`
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
                const numberExists = dbGet(`
                    SELECT * FROM drawn_numbers 
                    WHERE room = ? AND number = ?
                `, [room, number]);

                if (numberExists) {
                    socket.emit('errorMessage', { message: '該號碼已開過' });
                    return;
                }

                // 儲存開獎號碼
                dbRun(`
                    INSERT INTO drawn_numbers (room, number) 
                    VALUES (?, ?)
                `, [room, number]);

                // 保存數據庫變更
                saveDatabase();

                io.to(room).emit('numberDrawn', number);
                console.log(`房間 ${room} 管理員開獎: ${number}`);

                // 廣播鎖定訊息：開獎後所有玩家卡片鎖定
                io.to(room).emit('lockCards');

                updateAdminInfo(room);
                updateAdminLineCounts(room);
            } catch (error) {
                console.error('開獎處理錯誤:', error);
                socket.emit('errorMessage', { message: '開獎處理出錯，請稍後再試' });
            }
        });

        // 玩家更新完成線數事件
        socket.on('updateLineCount', (data) => {
            try {
                const user = dbGet(`
                    SELECT * FROM users WHERE socket_id = ?
                `, [socket.id]);

                if (user && !user.is_admin) {
                    dbRun(`
                        UPDATE users SET line_count = ? 
                        WHERE socket_id = ?
                    `, [data.lineCount, socket.id]);

                    // 保存數據庫變更
                    saveDatabase();

                    console.log(`收到玩家 ${user.username} (${socket.id}) 完成線數更新：${data.lineCount}`);
                    updateAdminLineCounts(user.room);
                }
            } catch (error) {
                console.error('更新線數錯誤:', error);
            }
        });

        // 當使用者斷線時
        socket.on('disconnect', () => {
            try {
                const user = dbGet(`
                    SELECT * FROM users WHERE socket_id = ?
                `, [socket.id]);

                if (user) {
                    console.log(`用戶 ${user.username} 離線`);
                    const room = user.room;

                    // 刪除用戶
                    dbRun(`
                        DELETE FROM users WHERE socket_id = ?
                    `, [socket.id]);

                    // 更新房間人數
                    dbRun(`
                        UPDATE rooms SET user_count = user_count - 1 
                        WHERE room_name = ?
                    `, [room]);

                    // 檢查房間剩餘人數
                    const roomInfo = dbGet(`
                        SELECT user_count FROM rooms 
                        WHERE room_name = ?
                    `, [room]);

                    if (roomInfo && roomInfo.user_count <= 0) {
                        // 刪除房間和相關數據
                        dbRun(`
                            DELETE FROM rooms WHERE room_name = ?
                        `, [room]);

                        dbRun(`
                            DELETE FROM drawn_numbers WHERE room = ?
                        `, [room]);

                        if (roomTimers[room]) {
                            clearTimeout(roomTimers[room]);
                            delete roomTimers[room];

                            dbRun(`
                                DELETE FROM room_timers WHERE room = ?
                            `, [room]);
                        }
                    }

                    // 保存數據庫變更
                    saveDatabase();

                    updateRoomsList();
                    updateAdminInfo(room);
                    updateAdminLineCounts(room);
                } else {
                    console.log(`未知用戶離線: ${socket.id}`);
                }
            } catch (error) {
                console.error('處理用戶離線錯誤:', error);
            }
        });
    });
}

// 獲取房間列表
function getRoomsList() {
    try {
        const rooms = dbAll(`
            SELECT room_name FROM rooms
        `);

        return rooms.map(room => room.room_name);
    } catch (error) {
        console.error('獲取房間列表錯誤:', error);
        return [];
    }
}

// 廣播房間列表
function updateRoomsList() {
    try {
        const roomList = getRoomsList();
        console.log("更新房間列表：", roomList);
        io.emit('roomsListUpdate', roomList);
    } catch (error) {
        console.error('更新房間列表錯誤:', error);
    }
}

// 更新指定房間內所有管理員的玩家資訊
function updateAdminInfo(room) {
    try {
        // 獲取該房間內的玩家列表
        const players = dbAll(`
            SELECT username FROM users 
            WHERE room = ? AND is_admin = 0
        `, [room]);

        const playerNames = players.map(player => player.username);
        const playerCount = playerNames.length;

        console.log(`更新房間 ${room} 玩家資訊：${playerNames}，連線數：${playerCount}`);

        // 獲取該房間內的所有管理員
        const admins = dbAll(`
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
function updateAdminLineCounts(room) {
    try {
        // 初始化線數統計
        const lineCounts = {};
        for (let i = 0; i <= 14; i++) {
            lineCounts[i] = [];
        }

        // 獲取該房間內的所有玩家及其線數
        const players = dbAll(`
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
        const admins = dbAll(`
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

// 每分鐘檢查房間與用戶數據一致性
function setupPeriodicChecks() {
    setInterval(() => {
        try {
            // 獲取所有房間
            const rooms = dbAll(`
                SELECT room_name FROM rooms
            `);

            for (const room of rooms) {
                // 計算實際用戶數
                const userCount = dbGet(`
                    SELECT COUNT(*) as count FROM users 
                    WHERE room = ?
                `, [room.room_name]);

                // 更新房間用戶數
                dbRun(`
                    UPDATE rooms SET user_count = ? 
                    WHERE room_name = ?
                `, [userCount.count, room.room_name]);
            }

            // 保存數據庫變更
            saveDatabase();
            updateRoomsList();
        } catch (error) {
            console.error('同步房間數據錯誤:', error);
        }
    }, 60 * 1000);
}

// 啟動伺服器
function startServer() {
    // 設置 Socket.io 處理
    setupSocketIO();

    // 設置定期檢查
    setupPeriodicChecks();

    // 靜態文件服務
    app.use(express.static(path.join(__dirname, 'public')));

    // 啟動伺服器
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`伺服器運行在 http://localhost:${PORT}`);
    });
}

// 優雅關閉
process.on('SIGINT', () => {
    console.log('正在關閉伺服器...');

    // 保存數據庫
    saveDatabase();

    // 關閉 Socket.io 連接
    io.close(() => {
        console.log('Socket.io 伺服器已關閉');
        process.exit(0);
    });
});

// 啟動初始化流程
initializeDatabase();