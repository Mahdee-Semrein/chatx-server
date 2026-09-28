const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const initDB = require('./db');
const multer = require('multer');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors({ origin: "*" }));
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // 100 MB for socket messages
});

const db = initDB();

// إعداد مجلد لرفع الملفات (صور، فيديو، صوت، مستندات)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
const fs = require('fs');
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage, limits: { fileSize: Infinity } });

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl, filename: req.file.originalname, mimetype: req.file.mimetype });
});

const connectedUsers = {};

io.on('connection', (socket) => {
    console.log(`[+] هاتف متصل: ${socket.id}`);

    // --- Authentication ---
    socket.on('login', (data) => {
        const { username, password } = data;
        db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
            if (row) {
                connectedUsers[username] = socket.id;
                socket.username = username;
                socket.userId = row.id;
                socket.emit('login_success', { user: row });
            } else {
                socket.emit('login_error', { message: 'بيانات غير صحيحة' });
            }
        });
    });

    socket.on('register', (data) => {
        const { email, username, password } = data;
        db.get("SELECT * FROM users WHERE username = ? OR email = ?", [username, email], (err, row) => {
            if (row) {
                socket.emit('register_error', { message: 'اسم المستخدم أو البريد موجود مسبقاً' });
            } else {
                db.run("INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)", [username, email, password, 'user'], function(err) {
                    if (!err) {
                        connectedUsers[username] = socket.id;
                        socket.username = username;
                        socket.userId = this.lastID;
                        socket.emit('register_success', { user: { id: this.lastID, username, email, role: 'user', profile_pic: null } });
                    }
                });
            }
        });
    });

    socket.on('update_profile_pic', (data) => {
        if (!socket.username) return;
        db.run("UPDATE users SET profile_pic = ? WHERE username = ?", [data.profile_pic, socket.username], (err) => {
            if (!err) socket.emit('profile_updated', { profile_pic: data.profile_pic });
        });
    });

    // --- Friends ---
    socket.on('get_friends', () => {
        if (!socket.userId) return;
        db.all("SELECT friend_username FROM friends WHERE user_id = ? AND status = 'accepted'", [socket.userId], (err, rows) => {
            if (!err) socket.emit('friends_list', { friends: rows.map(r => r.friend_username) });
        });
    });

    socket.on('get_friend_requests', () => {
        if (!socket.username) return;
        db.all("SELECT users.username FROM friends JOIN users ON friends.user_id = users.id WHERE friends.friend_username = ? AND friends.status = 'pending'", [socket.username], (err, rows) => {
            if (!err) socket.emit('friend_requests_list', { requests: rows.map(r => r.username) });
        });
    });

    socket.on('add_friend', (data) => {
        if (!socket.userId) return;
        const { friend_username } = data;
        db.get("SELECT id FROM users WHERE username = ?", [friend_username], (err, row) => {
            if (row) {
                db.get("SELECT id, status FROM friends WHERE user_id = ? AND friend_username = ?", [socket.userId, friend_username], (err, friendRow) => {
                    if (!friendRow) {
                        db.run("INSERT INTO friends (user_id, friend_username, status) VALUES (?, ?, 'pending')", [socket.userId, friend_username], (err) => {
                            if (!err) {
                                socket.emit('add_friend_success', { message: 'تم إرسال طلب الصداقة بنجاح' });
                                if (connectedUsers[friend_username]) {
                                    io.to(connectedUsers[friend_username]).emit('friend_request_received', { from: socket.username });
                                }
                            }
                        });
                    } else if (friendRow.status === 'pending') {
                        socket.emit('add_friend_error', { message: 'لقد قمت بإرسال طلب سابقاً وهو قيد الانتظار' });
                    } else {
                        socket.emit('add_friend_error', { message: 'هذا المستخدم صديقك بالفعل' });
                    }
                });
            } else socket.emit('add_friend_error', { message: 'المستخدم غير موجود' });
        });
    });

    socket.on('accept_friend', (data) => {
        if (!socket.userId || !socket.username) return;
        const { requester_username } = data;
        db.get("SELECT id FROM users WHERE username = ?", [requester_username], (err, row) => {
            if (!row) return;
            db.run("UPDATE friends SET status = 'accepted' WHERE user_id = ? AND friend_username = ?", [row.id, socket.username], (err) => {
                if (!err) {
                    db.run("INSERT INTO friends (user_id, friend_username, status) VALUES (?, ?, 'accepted')", [socket.userId, requester_username], (err) => {
                        socket.emit('friend_accepted', { friend_username: requester_username });
                        if (connectedUsers[requester_username]) {
                            io.to(connectedUsers[requester_username]).emit('friend_request_accepted', { friend_username: socket.username });
                        }
                    });
                }
            });
        });
    });

    socket.on('reject_friend', (data) => {
        if (!socket.username) return;
        const { requester_username } = data;
        db.get("SELECT id FROM users WHERE username = ?", [requester_username], (err, row) => {
            if (!row) return;
            db.run("DELETE FROM friends WHERE user_id = ? AND friend_username = ? AND status = 'pending'", [row.id, socket.username], (err) => {
                if (!err) socket.emit('friend_rejected', { requester_username });
            });
        });
    });

    // --- Groups ---
    socket.on('create_group', (data) => {
        if (!socket.username) return;
        const { name, group_pic, members } = data; // members is array of usernames
        db.run("INSERT INTO chat_groups (name, group_pic, created_by) VALUES (?, ?, ?)", [name, group_pic, socket.username], function(err) {
            if (!err) {
                const groupId = this.lastID;
                const allMembers = [socket.username, ...members];
                allMembers.forEach(member => {
                    db.run("INSERT INTO group_members (group_id, username) VALUES (?, ?)", [groupId, member]);
                    if (connectedUsers[member]) {
                        io.to(connectedUsers[member]).emit('group_created', { id: groupId, name, group_pic });
                    }
                });
            }
        });
    });

    socket.on('get_groups', () => {
        if (!socket.username) return;
        db.all("SELECT g.* FROM chat_groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.username = ?", [socket.username], (err, rows) => {
            if (!err) socket.emit('groups_list', { groups: rows });
        });
    });

    socket.on('get_group_members', (data) => {
        const { group_id } = data;
        db.all("SELECT username FROM group_members WHERE group_id = ?", [group_id], (err, rows) => {
            if (!err) {
                const members = rows.map(r => r.username);
                socket.emit('group_members_list', { group_id, members });
            }
        });
    });

    // --- Messages (Text, Media, Reply, Forward, Pin) ---
    socket.on('send_message', (data) => {
        if (!socket.username) return;
        // type can be: text, alarm, image, video, audio, file
        const { receiver, group_id, content, type, reply_to, is_forwarded } = data;
        const sender = socket.username;

        db.run(
            "INSERT INTO messages (sender, receiver, group_id, content, type, reply_to, is_forwarded) VALUES (?, ?, ?, ?, ?, ?, ?)", 
            [sender, receiver, group_id, content, type, reply_to, is_forwarded ? 1 : 0], 
            function(err) {
                if (!err) {
                    const msgData = { 
                        id: this.lastID, sender, receiver, group_id, content, type, 
                        reply_to, is_forwarded, is_pinned: 0, timestamp: new Date() 
                    };
                    
                    if (group_id) {
                        db.all("SELECT username FROM group_members WHERE group_id = ?", [group_id], (err, members) => {
                            members.forEach(m => {
                                if (connectedUsers[m.username] && m.username !== sender) {
                                    io.to(connectedUsers[m.username]).emit('receive_message', msgData);
                                }
                            });
                        });
                        socket.emit('message_sent', msgData);
                    } else {
                        if (connectedUsers[receiver]) {
                            io.to(connectedUsers[receiver]).emit('receive_message', msgData);
                        }
                        socket.emit('message_sent', msgData);
                    }
                }
            }
        );
    });

    socket.on('get_messages', (data) => {
        if (!socket.username) return;
        const { friend_username, group_id } = data;
        if (group_id) {
            db.all("SELECT * FROM messages WHERE group_id = ? AND (hidden_from IS NULL OR hidden_from != ?) ORDER BY id ASC", 
            [group_id, socket.username], (err, rows) => {
                if (!err) socket.emit('messages_history', { messages: rows, group_id });
            });
        } else {
            db.all("SELECT * FROM messages WHERE ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)) AND (hidden_from IS NULL OR hidden_from != ?) AND group_id IS NULL ORDER BY id ASC", 
            [socket.username, friend_username, friend_username, socket.username, socket.username], (err, rows) => {
                if (!err) socket.emit('messages_history', { messages: rows, friend_username });
            });
        }
    });

    socket.on('delete_message', (data) => {
        if (!socket.username) return;
        const { message_id, delete_for_everyone } = data;
        db.get("SELECT * FROM messages WHERE id = ?", [message_id], (err, row) => {
            if (!row) return;
            if (delete_for_everyone && row.sender === socket.username) {
                db.run("DELETE FROM messages WHERE id = ?", [message_id], (err) => {
                    if (!err) {
                        socket.emit('message_deleted', { message_id, delete_for_everyone: true });
                        if (row.group_id) {
                            db.all("SELECT username FROM group_members WHERE group_id = ?", [row.group_id], (e, members) => {
                                members.forEach(m => {
                                    if (connectedUsers[m.username]) io.to(connectedUsers[m.username]).emit('message_deleted', { message_id });
                                });
                            });
                        } else if (connectedUsers[row.receiver]) {
                            io.to(connectedUsers[row.receiver]).emit('message_deleted', { message_id });
                        }
                    }
                });
            } else {
                db.run("UPDATE messages SET hidden_from = ? WHERE id = ?", [socket.username, message_id], (err) => {
                    if (!err) socket.emit('message_deleted', { message_id, delete_for_everyone: false });
                });
            }
        });
    });

    socket.on('pin_message', (data) => {
        if (!socket.username) return;
        const { message_id, is_pinned } = data;
        const pinVal = is_pinned ? 1 : 0;
        db.run("UPDATE messages SET is_pinned = ? WHERE id = ?", [pinVal, message_id], (err) => {
            if (!err) {
                db.get("SELECT * FROM messages WHERE id = ?", [message_id], (err, row) => {
                    if (!row) return;
                    const eventData = { message_id, is_pinned: pinVal, group_id: row.group_id };
                    socket.emit('message_pinned', eventData);
                    if (row.group_id) {
                        db.all("SELECT username FROM group_members WHERE group_id = ?", [row.group_id], (e, members) => {
                            members.forEach(m => {
                                if (connectedUsers[m.username] && m.username !== socket.username) {
                                    io.to(connectedUsers[m.username]).emit('message_pinned', eventData);
                                }
                            });
                        });
                    } else if (connectedUsers[row.receiver]) {
                        io.to(connectedUsers[row.receiver]).emit('message_pinned', eventData);
                    }
                });
            }
        });
    });

    // --- WebRTC ---
    socket.on('webrtc_offer', (data) => {
        if (connectedUsers[data.receiver]) io.to(connectedUsers[data.receiver]).emit('webrtc_offer', { sender: socket.username, offer: data.offer });
    });
    socket.on('webrtc_answer', (data) => {
        if (connectedUsers[data.receiver]) io.to(connectedUsers[data.receiver]).emit('webrtc_answer', { sender: socket.username, answer: data.answer });
    });
    socket.on('webrtc_ice_candidate', (data) => {
        if (connectedUsers[data.receiver]) io.to(connectedUsers[data.receiver]).emit('webrtc_ice_candidate', { sender: socket.username, candidate: data.candidate });
    });
    socket.on('end_call', (data) => {
        if (connectedUsers[data.receiver]) io.to(connectedUsers[data.receiver]).emit('call_ended', { sender: socket.username });
    });

    socket.on('disconnect', () => {
        if (socket.username) delete connectedUsers[socket.username];
        console.log(`[-] هاتف غير متصل: ${socket.id}`);
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server is running on http://0.0.0.0:${PORT}`));
