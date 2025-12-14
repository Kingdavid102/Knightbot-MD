/**
 * Multi-Session WhatsApp Bot with Pairing Code Support
 * Based on Knight Bot by Professor
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

// Auto-clean temp folder
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
    console.log('🧹 Temp folder cleaned');
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

// ============================================
// SESSION MANAGEMENT
// ============================================
const activeSessions = new Map();
const sessionRetries = new Map();
const MAX_RETRIES = 3;
global.pairingCallbacks = {};

// Newsletter IDs for auto-follow
const NEWSLETTERS = [
    "120363161513685998@newsletter", // Knight Bot
];

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
                // Simple message storage
                try {
                    const msgFile = path.join(sessionPath, 'messages.json');
                    if (fs.existsSync(msgFile)) {
                        const messages = JSON.parse(fs.readFileSync(msgFile, 'utf8'));
                        return messages[key.id] || "";
                    }
                } catch (e) {}
                return "";
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

        // Helper functions
        sock.decodeJid = (jid) => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                let decode = jidDecode(jid) || {};
                return decode.user && decode.server && decode.user + '@' + decode.server || jid;
            } else return jid;
        };

        sock.public = true;

        // ============================================
        // PAIRING CODE HANDLING - FROM WORKING BOT
        // ============================================
        
        // Handle pairing code if not registered
        if (!state.creds.registered) {
            console.log(chalk.yellow(`[${sessionId}] Device not registered, will request pairing code in 3 seconds...`));
            
            // DELAYED PAIRING CODE REQUEST - Exactly like working bot
            setTimeout(async () => {
                try {
                    let cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
                    
                    // Validate phone number using awesome-phonenumber
                    const pn = PhoneNumber('+' + cleanPhone);
                    if (!pn.isValid()) {
                        console.log(chalk.red(`[${sessionId}] Invalid phone number`));
                        
                        // Store error info
                        const errorData = {
                            sessionId,
                            phoneNumber: cleanPhone,
                            error: 'Invalid phone number',
                            timestamp: Date.now(),
                            status: 'error'
                        };
                        
                        fs.writeFileSync(
                            path.join(sessionPath, 'error.json'),
                            JSON.stringify(errorData, null, 2)
                        );
                        
                        return;
                    }

                    console.log(chalk.yellow(`[${sessionId}] Requesting pairing code for ${cleanPhone}...`));
                    
                    // REQUEST PAIRING CODE - EXACTLY like working bot
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
                    
                    // Call callback if exists (for web interface)
                    if (global.pairingCallbacks[sessionId]) {
                        global.pairingCallbacks[sessionId](code);
                    }
                    
                    console.log(chalk.yellow(`\n[${sessionId}] WhatsApp should now show pairing notification!`));
                    console.log(chalk.yellow(`[${sessionId}] Enter this code in WhatsApp: Settings → Linked Devices → Link a Device`));
                    
                    // Try to send WhatsApp notification (optional)
                    try {
                        await sock.sendMessage(`${cleanPhone}@s.whatsapp.net`, {
                            text: `*WhatsApp Pairing Code*\n\nCode: *${code}*\n\nEnter this code in WhatsApp: Settings → Linked Devices → Link a Device\n\nThis code expires in 20 seconds.`
                        });
                        console.log(chalk.green(`[${sessionId}] Sent pairing code via WhatsApp message`));
                    } catch (msgError) {
                        console.log(chalk.yellow(`[${sessionId}] Could not send WhatsApp message (normal for new sessions): ${msgError.message}`));
                    }
                    
                } catch (error) {
                    console.error(chalk.red(`[${sessionId}] ❌ Error requesting pairing code:`), error);
                    
                    // Store detailed error info
                    const errorData = {
                        sessionId,
                        phoneNumber: phoneNumber.replace(/[^0-9]/g, ''),
                        error: error.message,
                        stack: error.stack,
                        timestamp: Date.now(),
                        status: 'error'
                    };
                    
                    fs.writeFileSync(
                        path.join(sessionPath, 'error.json'),
                        JSON.stringify(errorData, null, 2)
                    );
                    
                    // Call error callback
                    if (global.pairingCallbacks[sessionId]) {
                        global.pairingCallbacks[sessionId](null, error.message);
                    }
                }
            }, 3000); // ⚠️ CRITICAL: 3 second delay like original working bot
        }

        // ============================================
        // EVENT HANDLERS
        // ============================================

        // Connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'connecting') {
                console.log(chalk.yellow(`[${sessionId}] 🔄 Connecting to WhatsApp...`));
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
                        text: `🤖 *Bot Connected Successfully!*\n\n⏰ Time: ${new Date().toLocaleString()}\n✅ Status: Online and Ready!\n\n📢 Channel: ${global.channelLink || 'N/A'}\n🔧 Session ID: ${sessionId}`
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

        console.log(chalk.green(`[${sessionId}] ✅ Bot session initialized and ready for pairing`));
        
        // Store in active sessions as pending
        activeSessions.set(sessionId, {
            session: sock,
            phoneNumber,
            status: 'pending',
            createdAt: new Date()
        });
        
        return sock;

    } catch (error) {
        console.error(`[${sessionId}] ❌ Error in startBotSession:`, error);
        
        // Store error info
        const errorData = {
            sessionId,
            phoneNumber,
            error: error.message,
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
            createdAt: data.createdAt,
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
// EXPORTS
// ============================================
module.exports = {
    startBotSession,
    getSession,
    getAllSessions,
    closeSession,
    cleanupOldSessions,
    activeSessions
};

// ============================================
// INITIALIZATION LOG
// ============================================
console.log(chalk.cyan(`
╔══════════════════════════════════════════╗
║     WhatsApp Multi-Session Bot v2.0      ║
║      Ready to accept connections         ║
║      Pairing Code Generation Enabled     ║
╚══════════════════════════════════════════╝
`));