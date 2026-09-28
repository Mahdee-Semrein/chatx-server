const sqlite3 = require('sqlite3').verbose();
const path = require('path');

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
        // إنشاء جدول المستخدمين
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            email TEXT,
            password TEXT,
            role TEXT
        )`);

        // إنشاء جدول الأصدقاء
        db.run(`CREATE TABLE IF NOT EXISTS friends (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            friend_username TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )`);

        // إنشاء جدول الرسائل
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender TEXT,
            receiver TEXT,
            group_id INTEGER,
            content TEXT,
            type TEXT DEFAULT 'text',
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // إنشاء جدول المجموعات
        db.run(`CREATE TABLE IF NOT EXISTS chat_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            group_pic TEXT,
            created_by TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // إنشاء جدول أعضاء المجموعات
        db.run(`CREATE TABLE IF NOT EXISTS group_members (
            group_id INTEGER,
            username TEXT,
            FOREIGN KEY(group_id) REFERENCES chat_groups(id)
        )`);

        // محاولة إضافة الأعمدة الجديدة إن لم تكن موجودة (التحديثات)
        db.run("ALTER TABLE users ADD COLUMN email TEXT", (err) => {});
        db.run("ALTER TABLE users ADD COLUMN profile_pic TEXT", (err) => {});
        db.run("ALTER TABLE messages ADD COLUMN hidden_from TEXT", (err) => {});
        db.run("ALTER TABLE messages ADD COLUMN group_id INTEGER", (err) => {});
        db.run("ALTER TABLE messages ADD COLUMN reply_to INTEGER", (err) => {});
        db.run("ALTER TABLE messages ADD COLUMN is_forwarded INTEGER DEFAULT 0", (err) => {});
        db.run("ALTER TABLE messages ADD COLUMN is_pinned INTEGER DEFAULT 0", (err) => {});
        db.run("ALTER TABLE friends ADD COLUMN status TEXT DEFAULT 'accepted'", (err) => {});

        // تهيئة بيانات الأدمن الثابت (Hardcoded Admin)
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
