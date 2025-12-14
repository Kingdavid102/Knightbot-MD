/**
 * Multi-Session WhatsApp Bot with Web Interface
 * Based on Knight Bot by Professor
 * Modified for multi-user support
 */

// ============================================
// TEMP FOLDER FIX
// ============================================
const fs = require('fs');
const path = require('path');
const customTemp = path.join(process.cwd(), 'temp');
if (!fs.existsSync(customTemp)) fs.mkdirSync(customTemp, { recursive: true });
process.env.TMPDIR = customTemp;
process.env.TEMP = customTemp;
process.env.TMP = customTemp;

// Auto-clean temp folder every 3 hours
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

// ============================================
// CORE IMPORTS
// ============================================
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
const PhoneNumber = require('awesome-phonenumber');

// ============================================
// LOCAL IMPORTS
// ============================================
const settings = require('./settings');
require('./config.js');
const store = require('./lib/lightweight_store');

// ============================================
// GLOBAL SETTINGS
// ============================================
global.botname = settings.botName || "KNIGHT BOT";
global.themeemoji = "•";
global.packname = settings.packname;
global.author = settings.author;
global.channelLink = "https://whatsapp.com/channel/0029Va90zAnIHphOuO8Msp3A";
global.ytch = "Mr Unique Hacker";

// ============================================
// SESSION MANAGEMENT
// ============================================
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

// Initialize store
if (store && typeof store.readFromFile === 'function') {
    try {
        store.readFromFile();
        if (typeof store.writeToFile === 'function') {
            setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000);
        }
    } catch (error) {
        console.error('Error initializing store:', error);
    }
}

// ============================================
// SESSION HANDLING FUNCTIONS
// ============================================

/**
 * Start bot session for a user
 */
async function startBotSession(phoneNumber, sessionId) {
    try {
        console.log(chalk.blue(`🚀 Starting bot session for ${phoneNumber} (${sessionId})`));
        
        // Check if session already exists
        if (activeSessions.has(sessionId)) {
            console.log(chalk.yellow(`⚠️ Session ${sessionId} already active`));
            return activeSessions.get(sessionId).session;
        }

        // Create session directory
        const sessionPath = `./sessions/${sessionId}`;
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        // Get latest Baileys version
        let { version } = await fetchLatestBaileysVersion();
        
        // Use multi-file auth state
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const msgRetryCounterCache = new NodeCache();

        // Create WhatsApp socket
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

        // Store session metadata
        sock.sessionId = sessionId;
        sock.phoneNumber = phoneNumber;
        sock.sessionPath = sessionPath;

        // Save credentials
        sock.ev.on('creds.update', saveCreds);
        
        // Bind store if available
        if (store && typeof store.bind === 'function') {
            store.bind(sock.ev);
        }

        // Helper functions
        sock.decodeJid = (jid) => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                let decode = jidDecode(jid) || {};
                return decode.user && decode.server && decode.user + '@' + decode.server || jid;
            } else return jid;
        };

        sock.public = true;

        // Handle pairing code if not registered
        if (!state.creds.registered) {
            let cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
            
            const pn = PhoneNumber('+' + cleanPhone);
            if (!pn.isValid()) {
                console.log(chalk.red(`[${sessionId}] Invalid phone number`));
                throw new Error('Invalid phone number');
            }

            // Request pairing code after a delay
            setTimeout(async () => {
                try {
                    let code = await sock.requestPairingCode(cleanPhone);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    
                    console.log(chalk.bgGreen(chalk.black(`[${sessionId}] Pairing Code: `)), chalk.white(code));
                    
                    // Store pairing info
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
                    
                    // Call callback if exists
                    if (global.pairingCallbacks[sessionId]) {
                        global.pairingCallbacks[sessionId](code);
                    }
                    
                } catch (error) {
                    console.error(`[${sessionId}] Error requesting pairing code:`, error);
                    
                    // Store error info
                    const errorData = {
                        sessionId,
                        phoneNumber: cleanPhone,
                        error: error.message,
                        timestamp: Date.now(),
                        status: 'error'
                    };
                    
                    fs.writeFileSync(
                        path.join(sessionPath, 'error.json'),
                        JSON.stringify(errorData, null, 2)
                    );
                }
            }, 3000);
        }

        // ============================================
        // EVENT HANDLERS
        // ============================================

        // Connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'connecting') {
                console.log(chalk.yellow(`[${sessionId}] 🔄 Connecting...`));
            }

            if (connection === 'open') {
                console.log(chalk.green(`[${sessionId}] ✅ Connected Successfully!`));
                
                // Clear retries and mark as active
                sessionRetries.delete(sessionId);
                activeSessions.set(sessionId, {
                    session: sock,
                    phoneNumber,
                    status: 'connected',
                    connectedAt: new Date()
                });
                
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
                
                // Send success message to user
                try {
                    const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    await sock.sendMessage(botNumber, {
                        text: `🤖 *Bot Connected Successfully!*\n\n` +
                              `⏰ Time: ${new Date().toLocaleString()}\n` +
                              `✅ Status: Online and Ready!\n\n` +
                              `📢 Channel: ${global.channelLink}\n` +
                              `🔧 Your Session ID: ${sessionId}`
                    });
                } catch (error) {
                    console.error(`[${sessionId}] Error sending connection message:`, error.message);
                }
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                console.log(chalk.red(`[${sessionId}] Connection closed. Code: ${statusCode}`));
                
                // Remove from active sessions
                activeSessions.delete(sessionId);

                // Handle logged out sessions
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

                // Handle reconnection
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
                    startBotSession(phoneNumber, sessionId).catch(err => {
                        console.error(`[${sessionId}] Failed to reconnect:`, err);
                    });
                }
            }
        });

        // Message handling - defer to main.js
        sock.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                // Import main handler dynamically
                const { handleMessages } = require('./main');
                await handleMessages(sock, chatUpdate, true);
            } catch (error) {
                console.error(`[${sessionId}] Error in message handler:`, error);
            }
        });

        // Group participant updates
        sock.ev.on('group-participants.update', async (update) => {
            try {
                const { handleGroupParticipantUpdate } = require('./main');
                await handleGroupParticipantUpdate(sock, update);
            } catch (error) {
                console.error(`[${sessionId}] Error in group participant update:`, error);
            }
        });

        // Status updates
        sock.ev.on('status.update', async (status) => {
            try {
                const { handleStatus } = require('./main');
                await handleStatus(sock, status);
            } catch (error) {
                console.error(`[${sessionId}] Error in status update:`, error);
            }
        });

        // Handle call events (for anticall feature)
        sock.ev.on('call', async (call) => {
            try {
                const { readAnticallState } = require('./commands/anticall');
                const anticallState = readAnticallState();
                
                if (anticallState.enabled && call.status === 'offer') {
                    console.log(chalk.yellow(`[${sessionId}] 📞 Call received from ${call.from} - Auto rejecting`));
                    
                    // Send auto-reject message if configured
                    if (anticallState.message) {
                        await sock.sendMessage(call.from, { text: anticallState.message });
                    }
                    
                    // Reject the call
                    await sock.rejectCall(call.id, call.from);
                }
            } catch (error) {
                console.error(`[${sessionId}] Error handling call:`, error);
            }
        });

        console.log(chalk.green(`[${sessionId}] ✅ Bot session initialized`));
        return sock;

    } catch (error) {
        console.error(`[${sessionId}] ❌ Error in startBotSession:`, error);
        
        // Store error info
        const errorData = {
            sessionId,
            phoneNumber,
            error: error.message,
            stack: error.stack,
            timestamp: Date.now(),
            status: 'failed'
        };
        
        const sessionPath = `./sessions/${sessionId}`;
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }
        
        fs.writeFileSync(
            path.join(sessionPath, 'startup-error.json'),
            JSON.stringify(errorData, null, 2)
        );
        
        throw error;
    }
}

/**
 * Get active session by ID
 */
function getSession(sessionId) {
    return activeSessions.get(sessionId);
}

/**
 * Get all active sessions
 */
function getAllSessions() {
    const sessions = [];
    for (const [sessionId, data] of activeSessions) {
        sessions.push({
            sessionId,
            phoneNumber: data.phoneNumber,
            status: data.status,
            connectedAt: data.connectedAt,
            uptime: data.connectedAt ? Date.now() - data.connectedAt.getTime() : 0
        });
    }
    return sessions;
}

/**
 * Close a session
 */
async function closeSession(sessionId) {
    const sessionData = activeSessions.get(sessionId);
    if (!sessionData) {
        return { success: false, error: 'Session not found' };
    }

    try {
        const sock = sessionData.session;
        
        // Close WebSocket connection
        if (sock && sock.ws) {
            sock.ws.close();
        }
        
        // Remove from active sessions
        activeSessions.delete(sessionId);
        sessionRetries.delete(sessionId);
        
        console.log(chalk.yellow(`[${sessionId}] Session closed`));
        
        return { success: true, message: 'Session closed successfully' };
    } catch (error) {
        console.error(`[${sessionId}] Error closing session:`, error);
        return { success: false, error: error.message };
    }
}

/**
 * Cleanup old sessions
 */
function cleanupOldSessions(maxAgeHours = 24) {
    const now = Date.now();
    const maxAge = maxAgeHours * 60 * 60 * 1000;
    
    // Clean session folders
    const sessionsDir = './sessions';
    if (fs.existsSync(sessionsDir)) {
        const folders = fs.readdirSync(sessionsDir);
        
        for (const folder of folders) {
            const folderPath = path.join(sessionsDir, folder);
            const stats = fs.statSync(folderPath);
            
            if (now - stats.mtimeMs > maxAge) {
                try {
                    fs.rmSync(folderPath, { recursive: true, force: true });
                    console.log(chalk.gray(`🧹 Cleaned old session folder: ${folder}`));
                } catch (error) {
                    console.error(`Error cleaning folder ${folder}:`, error);
                }
            }
        }
    }
    
    // Clean pending sessions
    const pendingToDelete = [];
    for (const [sessionId, data] of pendingSessions) {
        if (now - data.timestamp > 10 * 60 * 1000) { // 10 minutes
            pendingToDelete.push(sessionId);
        }
    }
    
    pendingToDelete.forEach(sessionId => {
        pendingSessions.delete(sessionId);
        console.log(chalk.gray(`🧹 Cleaned expired pending session: ${sessionId}`));
    });
}

// ============================================
// AUTO-CLEANUP SETUP
// ============================================

// Run cleanup every hour
setInterval(() => {
    cleanupOldSessions();
}, 60 * 60 * 1000);

// Run initial cleanup
setTimeout(() => {
    cleanupOldSessions();
}, 10000);

// ============================================
// MEMORY MONITORING
// ============================================
setInterval(() => {
    const memUsage = process.memoryUsage();
    const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    
    if (memMB > 400) {
        console.log(chalk.yellow(`⚠️ High memory usage: ${memMB}MB`));
        
        // Try to run garbage collection if available
        if (global.gc) {
            try {
                global.gc();
                console.log(chalk.gray('🧹 Manual garbage collection triggered'));
            } catch (e) {
                console.error('Error running GC:', e);
            }
        }
    }
}, 30 * 60 * 1000);

// ============================================
// PROCESS HANDLERS
// ============================================
process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n⚠️ Shutting down all sessions...'));
    
    // Close all active sessions
    const closePromises = [];
    for (const [sessionId, sessionData] of activeSessions) {
        closePromises.push(closeSession(sessionId));
    }
    
    await Promise.allSettled(closePromises);
    console.log(chalk.green('✅ All sessions closed'));
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log(chalk.yellow('\n⚠️ Terminating all sessions...'));
    
    // Close all active sessions
    for (const [sessionId, sessionData] of activeSessions) {
        try {
            if (sessionData.session && sessionData.session.ws) {
                sessionData.session.ws.close();
            }
        } catch (e) {
            console.error(`Error closing session ${sessionId}:`, e);
        }
    }
    
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Rejection:', err);
});

// ============================================
// EXPORTS
// ============================================
module.exports = {
    startBotSession,
    getSession,
    getAllSessions,
    closeSession,
    cleanupOldSessions,
    activeSessions,
    pendingSessions
};

// ============================================
// INITIALIZATION LOG
// ============================================
console.log(chalk.cyan(`
╔══════════════════════════════════════════╗
║     WhatsApp Multi-Session Bot v1.0      ║
║      Ready to accept connections         ║
╚══════════════════════════════════════════╝
`));