const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

function initDB() {
    const dbPath = path.resolve(__dirname, 'chatx.db');
    const db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error("خطأ في الاتصال بقاعدة البيانات", err.message);
        } else {
            console.log("تم الاتصال بقاعدة بيانات SQLite المحلية.");
        }
    });

    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            email TEXT,
            password TEXT,
            role TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS friends (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            friend_username TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender TEXT,
            receiver TEXT,
            content TEXT,
            type TEXT DEFAULT 'text',
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run("ALTER TABLE users ADD COLUMN email TEXT", (err) => {});
        db.run("ALTER TABLE messages ADD COLUMN hidden_from TEXT", (err) => {});

        const checkAdmin = "SELECT * FROM users WHERE username = 'admin'";
        db.get(checkAdmin, [], (err, row) => {
            if (!row) {
                const insertAdmin = "INSERT INTO users (username, email, password, role) VALUES ('admin', 'admin@chatx.local', 'admin123', 'admin')";
                db.run(insertAdmin, [], function(err) {
                    if (!err) {
                        console.log("تم إضافة حساب الأدمن الافتراضي.");
                    }
                });
            }
        });
    });

    return db;
}

module.exports = initDB;
