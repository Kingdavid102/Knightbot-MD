/**
 * Express Server for Multi-Session WhatsApp Bot
 * Handles pairing requests from web interface
 */

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

const { 
    startBotSession, 
    getSession, 
    getAllSessions,
    deleteSession,
    isSessionActive,
    getSessionInfo 
} = require('./multi_session_pair');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Serve static files (HTML, CSS, JS)

// Store pairing callbacks
global.pairingCallbacks = {};

// Store pending sessions
const pendingSessions = new Map();

/**
 * Homepage - Pairing Interface
 */
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * Request pairing code
 * POST /api/pair
 * Body: { phoneNumber: "234XXXXXXXXXX" }
 */
app.post('/api/pair', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({ 
                success: false, 
                error: 'Phone number is required' 
            });
        }

        // Clean phone number
        const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
        
        // Validate phone number
        if (cleanPhone.length < 10) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid phone number format' 
            });
        }

        // Generate unique session ID
        const sessionId = `session_${cleanPhone}_${Date.now()}`;
        
        console.log(chalk.blue(`📱 New pairing request for ${cleanPhone} - Session: ${sessionId}`));

        // Store session as pending
        pendingSessions.set(sessionId, {
            phoneNumber: cleanPhone,
            status: 'generating_code',
            timestamp: Date.now()
        });

        // Setup callback to capture pairing code
        let pairingCode = null;
        let codePromise = new Promise((resolve, reject) => {
            global.pairingCallbacks[sessionId] = (code) => {
                pairingCode = code;
                resolve(code);
            };
            
            // Timeout after 15 seconds
            setTimeout(() => {
                if (!pairingCode) {
                    reject(new Error('Pairing code generation timeout'));
                }
            }, 15000);
        });

        // Start bot session (this will generate the pairing code)
        startBotSession(cleanPhone, sessionId).catch(err => {
            console.error(`Error starting session ${sessionId}:`, err);
            pendingSessions.delete(sessionId);
        });

        // Wait for pairing code
        try {
            const code = await codePromise;
            
            // Update pending session
            pendingSessions.set(sessionId, {
                phoneNumber: cleanPhone,
                status: 'awaiting_link',
                code,
                timestamp: Date.now()
            });

            // Clean up callback
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

/**
 * Check session status
 * GET /api/session/:sessionId
 */
app.get('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    // Check if session is active
    if (isSessionActive(sessionId)) {
        const info = getSessionInfo(sessionId);
        return res.json({
            success: true,
            status: 'connected',
            sessionId,
            ...info
        });
    }
    
    // Check if session is pending
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

/**
 * Get all active sessions
 * GET /api/sessions
 */
app.get('/api/sessions', (req, res) => {
    const sessions = getAllSessions();
    const sessionData = sessions.map(sessionId => ({
        sessionId,
        active: isSessionActive(sessionId),
        ...getSessionInfo(sessionId)
    }));
    
    res.json({
        success: true,
        count: sessions.length,
        sessions: sessionData
    });
});

/**
 * Delete a session
 * DELETE /api/session/:sessionId
 */
app.delete('/api/session/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        await deleteSession(sessionId);
        pendingSessions.delete(sessionId);
        
        res.json({
            success: true,
            message: 'Session deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting session:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Health check
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'online',
        uptime: process.uptime(),
        activeSessions: getAllSessions().length,
        memory: process.memoryUsage()
    });
});

// Cleanup old pending sessions (every 5 minutes)
setInterval(() => {
    const now = Date.now();
    const timeout = 10 * 60 * 1000; // 10 minutes
    
    for (const [sessionId, data] of pendingSessions) {
        if (now - data.timestamp > timeout) {
            console.log(chalk.yellow(`⏰ Cleaning up expired pending session: ${sessionId}`));
            pendingSessions.delete(sessionId);
            
            // Delete session if it exists but not connected
            if (!isSessionActive(sessionId)) {
                deleteSession(sessionId).catch(console.error);
            }
        }
    }
}, 5 * 60 * 1000);

// Start server
app.listen(PORT, () => {
    console.log(chalk.green(`\n✅ Server running on port ${PORT}`));
    console.log(chalk.cyan(`🌐 Access at: http://localhost:${PORT}`));
    console.log(chalk.yellow(`📱 Ready to accept pairing requests\n`));
});

// Handle process termination
process.on('SIGINT', () => {
    console.log(chalk.yellow('\n⚠️ Shutting down server...'));
    process.exit(0);
});

module.exports = app;