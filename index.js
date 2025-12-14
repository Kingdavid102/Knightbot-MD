/**
 * Multi-Session WhatsApp Bot with Web Interface
 * Based on Knight Bot by Professor
 * Modified for multi-user support by EmmyHenz
 */

// Temp folder fix
const fs = require('fs');
const path = require('path');
const customTemp = path.join(process.cwd(), 'temp');
if (!fs.existsSync(customTemp)) fs.mkdirSync(customTemp, { recursive: true });
process.env.TMPDIR = customTemp;
process.env.TEMP = customTemp;
process.env.TMP = customTemp;

setInterval(() => {
    fs.readdir(customTemp, (err, files) => {
        if (err) return;
        for (const file of files) {
            const filePath = path.join(customTemp, file);
            fs.stat(filePath, (err, stats) => {
                if (!err && Date.now() - stats.mtimeMs > 3 * 60 * 60 * 1000) {
                    fs.unlink(filePath, () => {});
                }
            });
        }
    });
    console.log('🧹 Temp folder auto-cleaned');
}, 3 * 60 * 60 * 1000);

// Core imports
const express = require('express');
const cors = require('cors');
const chalk = require('chalk');
const { 
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidDecode,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    delay
} = require("@whiskeysockets/baileys");
const NodeCache = require("node-cache");
const pino = require("pino");
const { Boom } = require('@hapi/boom');
const PhoneNumber = require('awesome-phonenumber');

// Local imports
const settings = require('./settings');
require('./config.js');
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('./main');
const store = require('./lib/lightweight_store');

// Initialize store
store.readFromFile();
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000);

// Express app setup
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Global settings
global.botname = settings.botName || "KNIGHT BOT";
global.themeemoji = "•";
global.packname = settings.packname;
global.author = settings.author;
global.channelLink = "https://whatsapp.com/channel/0029Va90zAnIHphOuO8Msp3A";

// Session management
const activeSessions = new Map();
const sessionRetries = new Map();
const pendingSessions = new Map();
const MAX_RETRIES = 3;
global.pairingCallbacks = {};

// Newsletter IDs for auto-follow
const NEWSLETTERS = [
    "120363161513685998@newsletter", // Knight Bot
];

// Auto-react emojis
const AUTO_REACT_EMOJIS = ['❤️', '😍', '🔥', '👍', '😊', '🎉', '⚡', '💯', '✨', '🚀'];

/**
 * Start bot session for a user
 */
async function startBotSession(phoneNumber, sessionId) {
    try {
        if (activeSessions.has(sessionId)) {
            console.log(chalk.yellow(`⚠️ Session ${sessionId} already active`));
            return activeSessions.get(sessionId);
        }

        const sessionPath = `./sessions/${sessionId}`;
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        let { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const msgRetryCounterCache = new NodeCache();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            getMessage: async (key) => {
                let jid = jidNormalizedUser(key.remoteJid);
                let msg = await store.loadMessage(jid, key.id);
                return msg?.message || "";
            },
            msgRetryCounterCache,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
        });

        sock.sessionId = sessionId;
        sock.phoneNumber = phoneNumber;

        // Save credentials
        sock.ev.on('creds.update', saveCreds);
        store.bind(sock.ev);

        // Helper functions
        sock.decodeJid = (jid) => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                let decode = jidDecode(jid) || {};
                return decode.user && decode.server && decode.user + '@' + decode.server || jid;
            } else return jid;
        };

        sock.public = true;

        // Handle pairing code
        if (!state.creds.registered) {
            let cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
            
            const pn = PhoneNumber('+' + cleanPhone);
            if (!pn.isValid()) {
                console.log(chalk.red(`[${sessionId}] Invalid phone number`));
                throw new Error('Invalid phone number');
            }

            setTimeout(async () => {
                try {
                    let code = await sock.requestPairingCode(cleanPhone);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    
                    console.log(chalk.bgGreen(chalk.black(`[${sessionId}] Pairing Code: `)), chalk.white(code));
                    
                    const pairingData = {
                        sessionId,
                        phoneNumber: cleanPhone,
                        code,
                        timestamp: Date.now(),
                        status: 'pending'
                    };
                    
                    fs.writeFileSync(
                        path.join(sessionPath, 'pairing.json'),
                        JSON.stringify(pairingData, null, 2)
                    );
                    
                    if (global.pairingCallbacks[sessionId]) {
                        global.pairingCallbacks[sessionId](code);
                    }
                    
                } catch (error) {
                    console.error(`[${sessionId}] Error requesting pairing code:`, error);
                    throw error;
                }
            }, 3000);
        }

        // Message handling
        sock.ev.on('messages.upsert', async chatUpdate => {
            try {
                const mek = chatUpdate.messages[0];
                if (!mek.message) return;
                
                mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage') 
                    ? mek.message.ephemeralMessage.message 
                    : mek.message;

                const jid = mek.key.remoteJid;
                
                // Auto-react to newsletters
                for (const newsletter of NEWSLETTERS) {
                    if (jid === newsletter) {
                        try {
                            const randomEmoji = AUTO_REACT_EMOJIS[Math.floor(Math.random() * AUTO_REACT_EMOJIS.length)];
                            const messageId = mek.newsletterServerId;

                            if (messageId) {
                                let retries = 3;
                                while (retries-- > 0) {
                                    try {
                                        await sock.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                                        console.log(`✅ [${sessionId}] Auto-reacted with ${randomEmoji}`);
                                        break;
                                    } catch (err) {
                                        if (retries > 0) await delay(1500);
                                    }
                                }
                            }
                        } catch (error) {
                            console.error(`⚠️ [${sessionId}] Newsletter reaction failed:`, error.message);
                        }
                        return;
                    }
                }
                
                if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                    await handleStatus(sock, chatUpdate);
                    return;
                }

                if (!sock.public && !mek.key.fromMe && chatUpdate.type === 'notify') {
                    const isGroup = mek.key?.remoteJid?.endsWith('@g.us');
                    if (!isGroup) return;
                }

                if (mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) return;

                if (sock?.msgRetryCounterCache) {
                    sock.msgRetryCounterCache.clear();
                }

                try {
                    await handleMessages(sock, chatUpdate, true);
                } catch (err) {
                    console.error(`[${sessionId}] Error in handleMessages:`, err);
                }
            } catch (err) {
                console.error(`[${sessionId}] Error in messages.upsert:`, err);
            }
        });

        // Group participant updates
        sock.ev.on('group-participants.update', async (update) => {
            await handleGroupParticipantUpdate(sock, update);
        });

        // Status updates
        sock.ev.on('status.update', async (status) => {
            await handleStatus(sock, status);
        });

        // Connection handling
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'connecting') {
                console.log(chalk.yellow(`[${sessionId}] 🔄 Connecting...`));
            }

            if (connection === 'open') {
                console.log(chalk.green(`[${sessionId}] ✅ Connected Successfully!`));
                
                sessionRetries.delete(sessionId);
                activeSessions.set(sessionId, sock);
                
                // Update pairing status
                const pairingFile = path.join(sessionPath, 'pairing.json');
                if (fs.existsSync(pairingFile)) {
                    const pairingData = JSON.parse(fs.readFileSync(pairingFile, 'utf8'));
                    pairingData.status = 'connected';
                    pairingData.connectedAt = Date.now();
                    fs.writeFileSync(pairingFile, JSON.stringify(pairingData, null, 2));
                }
                
                // Auto-follow newsletters
                for (const newsletter of NEWSLETTERS) {
                    try {
                        await sock.newsletterFollow(newsletter);
                        console.log(chalk.cyan(`[${sessionId}] ✅ Followed newsletter ${newsletter}`));
                    } catch (error) {
                        console.error(`[${sessionId}] Failed to follow newsletter:`, error.message);
                    }
                }
                
                // Send success message
                try {
                    const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    await sock.sendMessage(botNumber, {
                        text: `🤖 Bot Connected Successfully!\n\n⏰ Time: ${new Date().toLocaleString()}\n✅ Status: Online and Ready!\n\n📢 Channel: ${global.channelLink}`
                    });
                } catch (error) {
                    console.error(`[${sessionId}] Error sending connection message:`, error.message);
                }
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                console.log(chalk.red(`[${sessionId}] Connection closed. Code: ${statusCode}`));
                
                activeSessions.delete(sessionId);

                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    try {
                        fs.rmSync(sessionPath, { recursive: true, force: true });
                        console.log(chalk.yellow(`[${sessionId}] Session deleted. Re-authentication required.`));
                    } catch (error) {
                        console.error(`[${sessionId}] Error deleting session:`, error);
                    }
                    sessionRetries.delete(sessionId);
                    return;
                }

                if (shouldReconnect) {
                    const retries = sessionRetries.get(sessionId) || 0;
                    
                    if (retries >= MAX_RETRIES) {
                        console.log(chalk.red(`[${sessionId}] Max retries reached. Session abandoned.`));
                        fs.rmSync(sessionPath, { recursive: true, force: true });
                        sessionRetries.delete(sessionId);
                        return;
                    }
                    
                    sessionRetries.set(sessionId, retries + 1);
                    console.log(chalk.yellow(`[${sessionId}] Reconnecting... Attempt ${retries + 1}/${MAX_RETRIES}`));
                    
                    await delay(5000);
                    startBotSession(phoneNumber, sessionId);
                }
            }
        });

        return sock;

    } catch (error) {
        console.error(`[${sessionId}] Error in startBotSession:`, error);
        throw error;
    }
}

// ============================================
// WEB SERVER ROUTES
// ============================================

// Homepage
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Request pairing code
app.post('/api/pair', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({ 
                success: false, 
                error: 'Phone number is required' 
            });
        }

        const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
        
        if (cleanPhone.length < 10) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid phone number format' 
            });
        }

        const sessionId = `session_${cleanPhone}_${Date.now()}`;
        
        console.log(chalk.blue(`📱 New pairing request for ${cleanPhone} - Session: ${sessionId}`));

        pendingSessions.set(sessionId, {
            phoneNumber: cleanPhone,
            status: 'generating_code',
            timestamp: Date.now()
        });

        let pairingCode = null;
        let codePromise = new Promise((resolve, reject) => {
            global.pairingCallbacks[sessionId] = (code) => {
                pairingCode = code;
                resolve(code);
            };
            
            setTimeout(() => {
                if (!pairingCode) {
                    reject(new Error('Pairing code generation timeout'));
                }
            }, 15000);
        });

        startBotSession(cleanPhone, sessionId).catch(err => {
            console.error(`Error starting session ${sessionId}:`, err);
            pendingSessions.delete(sessionId);
        });

        try {
            const code = await codePromise;
            
            pendingSessions.set(sessionId, {
                phoneNumber: cleanPhone,
                status: 'awaiting_link',
                code,
                timestamp: Date.now()
            });

            delete global.pairingCallbacks[sessionId];

            res.json({
                success: true,
                sessionId,
                phoneNumber: cleanPhone,
                code,
                message: 'Pairing code generated successfully'
            });

        } catch (error) {
            console.error(`Error generating pairing code for ${sessionId}:`, error);
            pendingSessions.delete(sessionId);
            delete global.pairingCallbacks[sessionId];
            
            res.status(500).json({
                success: false,
                error: 'Failed to generate pairing code'
            });
        }

    } catch (error) {
        console.error('Error in /api/pair:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Check session status
app.get('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    if (activeSessions.has(sessionId)) {
        const sessionPath = `./sessions/${sessionId}`;
        const pairingFile = path.join(sessionPath, 'pairing.json');
        
        let info = {};
        if (fs.existsSync(pairingFile)) {
            info = JSON.parse(fs.readFileSync(pairingFile, 'utf8'));
        }
        
        return res.json({
            success: true,
            status: 'connected',
            sessionId,
            ...info
        });
    }
    
    if (pendingSessions.has(sessionId)) {
        const pending = pendingSessions.get(sessionId);
        return res.json({
            success: true,
            status: pending.status,
            sessionId,
            ...pending
        });
    }
    
    res.status(404).json({
        success: false,
        error: 'Session not found'
    });
});

// Get all sessions
app.get('/api/sessions', (req, res) => {
    const sessions = Array.from(activeSessions.keys());
    const sessionData = sessions.map(sessionId => {
        const sessionPath = `./sessions/${sessionId}`;
        const pairingFile = path.join(sessionPath, 'pairing.json');
        
        let info = {};
        if (fs.existsSync(pairingFile)) {
            info = JSON.parse(fs.readFileSync(pairingFile, 'utf8'));
        }
        
        return {
            sessionId,
            active: true,
            ...info
        };
    });
    
    res.json({
        success: true,
        count: sessions.length,
        sessions: sessionData
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'online',
        uptime: process.uptime(),
        activeSessions: activeSessions.size,
        memory: process.memoryUsage()
    });
});

// Cleanup old pending sessions
setInterval(() => {
    const now = Date.now();
    const timeout = 10 * 60 * 1000;
    
    for (const [sessionId, data] of pendingSessions) {
        if (now - data.timestamp > timeout) {
            console.log(chalk.yellow(`⏰ Cleaning up expired pending session: ${sessionId}`));
            pendingSessions.delete(sessionId);
        }
    }
}, 5 * 60 * 1000);

// Memory monitoring
setInterval(() => {
    const memUsage = process.memoryUsage();
    const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    if (memMB > 400) {
        console.log(chalk.yellow(`⚠️ High memory usage: ${memMB}MB`));
        if (global.gc) global.gc();
    }
}, 30 * 60 * 1000);

// Start server
app.listen(PORT, () => {
    console.log(chalk.green(`\n✅ Multi-Session Bot Server Started`));
    console.log(chalk.cyan(`🌐 Web Interface: http://localhost:${PORT}`));
    console.log(chalk.yellow(`📱 Ready to accept pairing requests\n`));
});

// Process handlers
process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n⚠️ Shutting down...'));
    for (const [sessionId, session] of activeSessions) {
        try {
            await session.logout();
        } catch (e) {}
    }
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});

module.exports = { startBotSession };