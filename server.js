const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const initDB = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// تهيئة قاعدة البيانات المحلية
const db = initDB();

// لتتبع المستخدمين المتصلين: username -> socket.id
const connectedUsers = {};

io.on('connection', (socket) => {
    console.log(`[+] هاتف متصل: ${socket.id}`);

    // تسجيل الدخول
    socket.on('login', (data) => {
        const { username, password } = data;
        db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
            if (row) {
                connectedUsers[username] = socket.id;
                socket.username = username;
                socket.userId = row.id;
                socket.emit('login_success', { user: row });
                console.log(`[=] تسجيل دخول ناجح: ${username}`);
            } else {
                socket.emit('login_error', { message: 'بيانات غير صحيحة' });
            }
        });
    });

    // إنشاء حساب جديد
    socket.on('register', (data) => {
        const { email, username, password } = data;
        db.get("SELECT * FROM users WHERE username = ? OR email = ?", [username, email], (err, row) => {
            if (row) {
                socket.emit('register_error', { message: 'اسم المستخدم أو البريد الإلكتروني موجود مسبقاً' });
            } else {
                db.run("INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)", [username, email, password, 'user'], function(err) {
                    if (err) {
                        socket.emit('register_error', { message: 'حدث خطأ أثناء إنشاء الحساب' });
                    } else {
                        connectedUsers[username] = socket.id;
                        socket.username = username;
                        socket.userId = this.lastID;
                        socket.emit('register_success', { user: { id: this.lastID, username: username, email: email, role: 'user' } });
                        console.log(`[+] حساب جديد: ${username} (${email})`);
                    }
                });
            }
        });
    });

    // جلب قائمة الأصدقاء
    socket.on('get_friends', () => {
        if (!socket.userId) return;
        db.all("SELECT friend_username FROM friends WHERE user_id = ?", [socket.userId], (err, rows) => {
            if (!err) {
                const friendsList = rows.map(r => r.friend_username);
                socket.emit('friends_list', { friends: friendsList });
            }
        });
    });

    // إضافة صديق
    socket.on('add_friend', (data) => {
        if (!socket.userId) return;
        const { friend_username } = data;
        
        // التأكد أن الصديق موجود في قاعدة البيانات
        db.get("SELECT id FROM users WHERE username = ?", [friend_username], (err, row) => {
            if (row) {
                // التأكد أنه لم تتم إضافته مسبقاً
                db.get("SELECT id FROM friends WHERE user_id = ? AND friend_username = ?", [socket.userId, friend_username], (err, friendRow) => {
                    if (!friendRow) {
                        db.run("INSERT INTO friends (user_id, friend_username) VALUES (?, ?)", [socket.userId, friend_username], (err) => {
                            if (!err) {
                                socket.emit('add_friend_success', { friend_username });
                            }
                        });
                    } else {
                        socket.emit('add_friend_error', { message: 'هذا المستخدم صديقك بالفعل' });
                    }
                });
            } else {
                socket.emit('add_friend_error', { message: 'المستخدم غير موجود' });
            }
        });
    });

    // إرسال رسالة (أو إنذار)
    socket.on('send_message', (data) => {
        if (!socket.username) return;
        const { receiver, content, type } = data; // type: 'text' or 'alarm'
        const sender = socket.username;

        db.run("INSERT INTO messages (sender, receiver, content, type) VALUES (?, ?, ?, ?)", [sender, receiver, content, type], function(err) {
            if (!err) {
                const msgData = { id: this.lastID, sender, receiver, content, type, timestamp: new Date() };
                // إرسال للطرف الآخر إذا كان متصلاً
                if (connectedUsers[receiver]) {
                    io.to(connectedUsers[receiver]).emit('receive_message', msgData);
                }
                // إرسال تأكيد للمرسل
                socket.emit('message_sent', msgData);
            }
        });
    });

    socket.on('get_messages', (data) => {
        if (!socket.username) return;
        const { friend_username } = data;
        db.all("SELECT * FROM messages WHERE ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)) AND (hidden_from IS NULL OR hidden_from != ?) ORDER BY id ASC", 
        [socket.username, friend_username, friend_username, socket.username, socket.username], (err, rows) => {
            if (!err) {
                socket.emit('messages_history', { messages: rows });
            }
        });
    });

    socket.on('delete_message', (data) => {
        if (!socket.username) return;
        const { message_id, delete_for_everyone } = data;

        db.get("SELECT * FROM messages WHERE id = ?", [message_id], (err, row) => {
            if (!row) return;

            if (delete_for_everyone) {
                if (row.sender === socket.username) {
                    db.run("DELETE FROM messages WHERE id = ?", [message_id], (err) => {
                        if (!err) {
                            socket.emit('message_deleted', { message_id });
                            if (connectedUsers[row.receiver]) {
                                io.to(connectedUsers[row.receiver]).emit('message_deleted', { message_id });
                            }
                        }
                    });
                }
            } else {
                // Delete for me only
                db.run("UPDATE messages SET hidden_from = ? WHERE id = ?", [socket.username, message_id], (err) => {
                    if (!err) {
                        socket.emit('message_deleted', { message_id });
                    }
                });
            }
        });
    });

    // WebRTC Signaling
    socket.on('webrtc_offer', (data) => {
        const { receiver, offer } = data;
        if (connectedUsers[receiver]) {
            io.to(connectedUsers[receiver]).emit('webrtc_offer', {
                sender: socket.username,
                offer: offer
            });
        }
    });

    socket.on('webrtc_group_invite', (data) => {
        const { receiver, participants } = data;
        if (connectedUsers[receiver]) {
            io.to(connectedUsers[receiver]).emit('webrtc_group_invite', {
                sender: socket.username,
                participants: participants // Array of usernames already in the call
            });
        }
    });

    socket.on('webrtc_answer', (data) => {
        const { receiver, answer } = data;
        if (connectedUsers[receiver]) {
            io.to(connectedUsers[receiver]).emit('webrtc_answer', {
                sender: socket.username,
                answer: answer
            });
        }
    });

    socket.on('webrtc_ice_candidate', (data) => {
        const { receiver, candidate } = data;
        if (connectedUsers[receiver]) {
            io.to(connectedUsers[receiver]).emit('webrtc_ice_candidate', {
                sender: socket.username,
                candidate: candidate
            });
        }
    });

    socket.on('end_call', (data) => {
        const { receiver } = data;
        if (connectedUsers[receiver]) {
            io.to(connectedUsers[receiver]).emit('call_ended', {
                sender: socket.username
            });
        }
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            delete connectedUsers[socket.username];
        }
        console.log(`[-] هاتف غير متصل: ${socket.id}`);
    });
});

const PORT = 3000;
// استخدم "0.0.0.0" للسماح بالاتصال من أي جهاز على الشبكة
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
