// db.js
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: 'localhost',             // 若資料庫在同一台機器
    user: 'root',       // 替換成你的 MySQL 使用者名稱
    password: '', // 替換成你的 MySQL 密碼
    database: 'bingo_db',          // 你剛剛建立的資料庫名稱
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;
