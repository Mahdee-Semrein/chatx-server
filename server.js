const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const initDB = require('./db');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const admin = require('firebase-admin');
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        serviceAccount = require('./serviceAccountKey.json');
    }
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin Initialized Successfully.");
} catch (error) {
    console.warn("Firebase Admin Initialization Failed: Please provide serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT env var. Push notifications will not work.");
}

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

function broadcastStatus(username, is_online) {
    db.all(`
        SELECT friend_username FROM friends 
        WHERE user_id = (SELECT id FROM users WHERE username = ?) AND status = 'accepted'
    `, [username], (err, rows) => {
        if (!err) {
            rows.forEach(r => {
                if (connectedUsers[r.friend_username]) {
                    io.to(connectedUsers[r.friend_username]).emit('friend_status_updated', {
                        username: username,
                        is_online: is_online
                    });
                }
            });
        }
    });
}

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
                broadcastStatus(username, true);
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
                        broadcastStatus(username, true);
                    }
                });
            }
        });
    });

    socket.on('update_profile_pic', (data) => {
        if (!socket.username) return;
        db.run("UPDATE users SET profile_pic = ? WHERE username = ?", [data.profile_pic, socket.username], (err) => {
            if (!err) {
                socket.emit('profile_updated', { profile_pic: data.profile_pic });
                // Broadcast to all connected users (simple approach) or just friends
                io.emit('friend_profile_updated', { username: socket.username, profile_pic: data.profile_pic });
            }
        });
    });

    socket.on('update_fcm_token', (data) => {
        if (!socket.username) return;
        db.run("UPDATE users SET fcm_token = ? WHERE username = ?", [data.fcm_token, socket.username], (err) => {
            if (err) console.error("Error updating FCM token:", err);
        });
    });

    // --- Friends ---
    socket.on('get_friends', () => {
        if (!socket.userId) return;
        db.all(`
            SELECT f.friend_username, u.profile_pic 
            FROM friends f
            JOIN users u ON f.friend_username = u.username
            WHERE f.user_id = ? AND f.status = 'accepted'
        `, [socket.userId], (err, rows) => {
            if (!err) {
                const friendsData = rows.map(r => ({
                    username: r.friend_username,
                    profile_pic: r.profile_pic,
                    is_online: !!connectedUsers[r.friend_username]
                }));
                socket.emit('friends_list', { friends_data: friendsData });
                socket.emit('friends_list_old', { friends: rows.map(r => r.friend_username) });
            }
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
                                sendPushNotification(friend_username, "Friend Request", `${socket.username} sent you a friend request.`, { type: 'friend_request', sender: socket.username });
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
                const allMembers = [...new Set([socket.username, ...members])];
                allMembers.forEach(member => {
                    const role = (member === socket.username) ? 'creator' : 'member';
                    db.run("INSERT INTO group_members (group_id, username, role) VALUES (?, ?, ?)", [groupId, member, role]);
                    if (connectedUsers[member]) {
                        io.to(connectedUsers[member]).emit('group_created', { id: groupId, name, group_pic, created_by: socket.username, is_locked: 0 });
                    }
                });
            }
        });
    });

    socket.on('leave_group', (data) => {
        const { group_id } = data;
        if (!socket.username || !group_id) return;
        
        db.run('DELETE FROM group_members WHERE group_id = ? AND username = ?', [group_id, socket.username], function(err) {
            if (err) {
                console.error(err);
                return;
            }
            socket.emit('left_group_success', { group_id });
        });
    });
    socket.on('get_groups', () => {
        if (!socket.username) return;
        db.all("SELECT g.*, ifnull(g.is_locked, 0) as is_locked, gm.role, (SELECT GROUP_CONCAT(ifnull(nickname, username)) FROM group_members WHERE group_id = g.id AND username != ?) as members_list FROM chat_groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.username = ?", [socket.username, socket.username], (err, rows) => {
            if (!err) socket.emit('groups_list', { groups: rows });
        });
    });

    socket.on('get_group_members', (data) => {
        const { group_id } = data;
        db.all("SELECT gm.username, gm.role, gm.nickname, u.profile_pic FROM group_members gm JOIN users u ON gm.username = u.username WHERE gm.group_id = ?", [group_id], (err, rows) => {
            if (!err) {
                // backward compatibility + new data
                const members = rows.map(r => r.username);
                socket.emit('group_members_list', { group_id, members, members_data: rows });
            }
        });
    });
    // --- Group Admin Endpoints ---
    socket.on('update_group_pic', (data) => {
        const { group_id, group_pic } = data;
        if (!socket.username || !group_id) return;
        
        db.get("SELECT created_by FROM chat_groups WHERE id = ?", [group_id], (err, row) => {
            if (row) { // Any member can update? Or just admin? The prompt says "???? ?????? ... ????" but group pic "????? ??? ???? ???????", usually any member can change group pic, but let's allow it for anyone in the group.
                db.run("UPDATE chat_groups SET group_pic = ? WHERE id = ?", [group_pic, group_id], (err) => {
                    if (!err) {
                        db.all("SELECT username FROM group_members WHERE group_id = ?", [group_id], (e, members) => {
                            if (!e) {
                                members.forEach(m => {
                                    if (connectedUsers[m.username]) {
                                        io.to(connectedUsers[m.username]).emit('group_pic_updated', { group_id, group_pic });
                                    }
                                });
                            }
                        });
                    }
                });
            }
        });
    });

    socket.on('remove_group_member', (data) => {
        const { group_id, member_username } = data;
        if (!socket.username || !group_id) return;
        
        db.get("SELECT role FROM group_members WHERE group_id = ? AND username = ?", [group_id, socket.username], (err, row) => {
            if (row && (row.role === 'admin' || row.role === 'creator')) {
                // Prevent kicking creators
                db.get("SELECT role FROM group_members WHERE group_id = ? AND username = ?", [group_id, member_username], (err, targetRow) => {
                    if (targetRow && targetRow.role !== 'creator') {
                        db.run("DELETE FROM group_members WHERE group_id = ? AND username = ?", [group_id, member_username], (err) => {
                            if (!err) {
                                if (connectedUsers[member_username]) {
                                    io.to(connectedUsers[member_username]).emit('kicked_from_group', { group_id });
                                }
                                db.all("SELECT username FROM group_members WHERE group_id = ?", [group_id], (e, members) => {
                                    if (!e) {
                                        members.forEach(m => {
                                            if (connectedUsers[m.username]) {
                                                io.to(connectedUsers[m.username]).emit('member_removed', { group_id, member_username });
                                            }
                                        });
                                    }
                                });
                            }
                        });
                    }
                });
            }
        });
    });

    socket.on('toggle_group_lock', (data) => {
        const { group_id, is_locked } = data;
        if (!socket.username || !group_id) return;

        db.get("SELECT role FROM group_members WHERE group_id = ? AND username = ?", [group_id, socket.username], (err, row) => {
            if (row && (row.role === 'admin' || row.role === 'creator')) {
                db.run("UPDATE chat_groups SET is_locked = ? WHERE id = ?", [is_locked, group_id], (err) => {
                    if (!err) {
                        db.all("SELECT username FROM group_members WHERE group_id = ?", [group_id], (e, members) => {
                            if (!e) {
                                members.forEach(m => {
                                    if (connectedUsers[m.username]) {
                                        io.to(connectedUsers[m.username]).emit('group_lock_updated', { group_id, is_locked });
                                    }
                                });
                            }
                        });
                    }
                });
            }
        });
    });

    socket.on('set_group_role', (data) => {
        const { group_id, member_username, role } = data; // role = 'admin' or 'member'
        if (!socket.username || !group_id) return;

        db.get("SELECT role FROM group_members WHERE group_id = ? AND username = ?", [group_id, socket.username], (err, row) => {
            if (row && row.role === 'creator') { // only creator can promote/demote admins for simplicity, or admin can? let's allow creator only
                db.run("UPDATE group_members SET role = ? WHERE group_id = ? AND username = ? AND role != 'creator'", [role, group_id, member_username], (err) => {
                    if (!err) {
                        db.all("SELECT username FROM group_members WHERE group_id = ?", [group_id], (e, members) => {
                            if (!e) {
                                members.forEach(m => {
                                    if (connectedUsers[m.username]) {
                                        io.to(connectedUsers[m.username]).emit('group_role_updated', { group_id, member_username, role });
                                    }
                                });
                            }
                        });
                    }
                });
            }
        });
    });

    socket.on('set_group_nickname', (data) => {
        const { group_id, member_username, nickname } = data;
        if (!socket.username || !group_id) return;

        db.get("SELECT role FROM group_members WHERE group_id = ? AND username = ?", [group_id, socket.username], (err, row) => {
            if (row && (row.role === 'admin' || row.role === 'creator')) {
                db.run("UPDATE group_members SET nickname = ? WHERE group_id = ? AND username = ?", [nickname, group_id, member_username], (err) => {
                    if (!err) {
                        db.all("SELECT username FROM group_members WHERE group_id = ?", [group_id], (e, members) => {
                            if (!e) {
                                members.forEach(m => {
                                    if (connectedUsers[m.username]) {
                                        io.to(connectedUsers[m.username]).emit('group_nickname_updated', { group_id, member_username, nickname });
                                    }
                                });
                            }
                        });
                    }
                });
            }
        });
    });



// Helper function for push notifications
async function sendPushNotification(username, title, body, payload) {
    if (admin.apps.length === 0) return; // Do not send if Firebase is not initialized
    db.get("SELECT fcm_token FROM users WHERE username = ?", [username], (err, row) => {
        if (row && row.fcm_token) {
            const message = {
                notification: { title: title, body: body },
                data: payload || {},
                token: row.fcm_token
            };
            admin.messaging().send(message)
                .then(response => console.log('Successfully sent push notification:', response))
                .catch(error => console.error('Error sending push notification:', error));
        }
    });
}

    // --- Messages (Text, Media, Reply, Forward, Pin) ---
    socket.on('send_message', (data) => {
        if (!socket.username) return;
        // type can be: text, alarm, image, video, audio, file
        const { receiver, group_id, content, type, reply_to, is_forwarded } = data;
        const sender = socket.username;

        const performSend = () => {
            db.run(
                "INSERT INTO messages (sender, receiver, group_id, content, type, reply_to, is_forwarded) VALUES (?, ?, ?, ?, ?, ?, ?)", 
                [sender, receiver, group_id, content, type, reply_to, is_forwarded ? 1 : 0], 
                function(err) {
                    if (!err) {
                        const msgData = { 
                            id: this.lastID, sender, receiver, group_id, content, type, 
                            reply_to, is_forwarded, is_pinned: 0, timestamp: new Date() 
                        };
                        
                        const notificationTitle = group_id ? `New message in group` : `Message from ${sender}`;
                        const notificationBody = type === 'text' ? content : `Sent a ${type}`;

                        if (group_id) {
                            db.all("SELECT username FROM group_members WHERE group_id = ?", [group_id], (err, members) => {
                                members.forEach(m => {
                                    if (m.username !== sender) {
                                        if (connectedUsers[m.username]) {
                                            io.to(connectedUsers[m.username]).emit('receive_message', msgData);
                                        }
                                        sendPushNotification(m.username, notificationTitle, notificationBody, { type: 'chat', group_id: group_id.toString() });
                                    }
                                });
                            });
                            socket.emit('message_sent', msgData);
                        } else {
                            if (connectedUsers[receiver]) {
                                io.to(connectedUsers[receiver]).emit('receive_message', msgData);
                            }
                            sendPushNotification(receiver, notificationTitle, notificationBody, { type: 'chat', sender: sender });
                            socket.emit('message_sent', msgData);
                        }
                    }
                }
            );
        };

        if (group_id) {
            db.get("SELECT g.is_locked, gm.role FROM chat_groups g JOIN group_members gm ON g.id = gm.group_id WHERE g.id = ? AND gm.username = ?", [group_id, sender], (err, row) => {
                if (row && row.is_locked && row.role === 'member') {
                    socket.emit('error_msg', { message: 'Only admins can send messages in this group.' });
                    return;
                }
                performSend();
            });
        } else {
            performSend();
        }
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
        if (connectedUsers[data.receiver]) {
            io.to(connectedUsers[data.receiver]).emit('webrtc_offer', { sender: socket.username, offer: data.offer });
        }
        sendPushNotification(data.receiver, "Incoming Call", `Incoming call from ${socket.username}`, { type: 'call', sender: socket.username });
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
        if (socket.username) {
            delete connectedUsers[socket.username];
            broadcastStatus(socket.username, false);
        }
        console.log(`[-] هاتف غير متصل: ${socket.id}`);
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server is running on http://0.0.0.0:${PORT}`));



