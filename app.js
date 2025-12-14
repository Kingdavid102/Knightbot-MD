const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const chalk = require('chalk');
require('dotenv').config();

// Import bot functionality
const { startBotSession, getAllSessions, closeSession, activeSessions } = require('./index');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SESSIONS = 50;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Create necessary directories on startup
function setupDirectories() {
    const dirs = ['sessions', 'temp', 'public', 'data'];
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(chalk.green(`✓ Created directory: ${dir}`));
        }
    });
    
    // Create basic HTML file if doesn't exist
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (!fs.existsSync(htmlPath)) {
        const basicHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Multi-Session Bot</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        }
        
        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            padding: 40px;
            width: 100%;
            max-width: 500px;
        }
        
        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 28px;
            text-align: center;
        }
        
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 16px;
            text-align: center;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        label {
            display: block;
            margin-bottom: 8px;
            color: #333;
            font-weight: 500;
        }
        
        input {
            width: 100%;
            padding: 12px 15px;
            border: 2px solid #e1e1e1;
            border-radius: 10px;
            font-size: 16px;
            transition: border-color 0.3s;
        }
        
        input:focus {
            outline: none;
            border-color: #667eea;
        }
        
        button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 15px 30px;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            width: 100%;
            transition: transform 0.3s, box-shadow 0.3s;
            margin-top: 10px;
        }
        
        button:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
        }
        
        button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        
        .result {
            margin-top: 20px;
            padding: 15px;
            border-radius: 10px;
            display: none;
        }
        
        .success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }
        
        .error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }
        
        .code-display {
            font-family: 'Courier New', monospace;
            font-size: 24px;
            font-weight: bold;
            letter-spacing: 5px;
            text-align: center;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 8px;
            margin: 10px 0;
            border: 2px dashed #667eea;
        }
        
        .instructions {
            background: #e3f2fd;
            padding: 15px;
            border-radius: 10px;
            margin-top: 20px;
            font-size: 14px;
            color: #1565c0;
        }
        
        .loader {
            display: none;
            text-align: center;
            margin: 20px 0;
        }
        
        .spinner {
            border: 4px solid #f3f3f3;
            border-top: 4px solid #667eea;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 10px;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .session-info {
            background: #f5f5f5;
            padding: 15px;
            border-radius: 10px;
            margin-top: 20px;
            font-size: 14px;
        }
        
        .refresh-btn {
            background: #4CAF50;
            padding: 8px 15px;
            font-size: 14px;
            width: auto;
            margin: 5px;
        }
        
        .code-container {
            text-align: center;
            margin: 20px 0;
        }
        
        .copy-btn {
            background: #2196F3;
            padding: 10px 20px;
            font-size: 14px;
            width: auto;
            margin-top: 10px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📱 WhatsApp Bot</h1>
        <p class="subtitle">Connect your WhatsApp account to use the bot</p>
        
        <form id="pairingForm">
            <div class="form-group">
                <label for="phoneNumber">WhatsApp Number (with country code)</label>
                <input 
                    type="tel" 
                    id="phoneNumber" 
                    placeholder="Example: 919876543210" 
                    required
                    pattern="[0-9]{10,15}"
                >
                <small style="color: #666; display: block; margin-top: 5px;">
                    Enter your WhatsApp number without + sign. Example: 919876543210
                </small>
            </div>
            
            <div class="loader" id="loader">
                <div class="spinner"></div>
                <p>Generating pairing code...</p>
            </div>
            
            <button type="submit" id="submitBtn">Generate Pairing Code</button>
        </form>
        
        <div class="result" id="result"></div>
        
        <div class="instructions" id="instructions" style="display: none;">
            <h3>📱 How to pair:</h3>
            <ol style="margin-top: 10px; margin-left: 20px;">
                <li>Open WhatsApp on your phone</li>
                <li>Go to <strong>Settings → Linked Devices → Link a Device</strong></li>
                <li>Enter the code shown below</li>
                <li>Wait for connection confirmation</li>
            </ol>
            
            <div class="code-container" id="codeContainer" style="display: none;">
                <h4>Your Pairing Code:</h4>
                <div class="code-display" id="pairingCodeDisplay"></div>
                <button type="button" class="copy-btn" onclick="copyCode()">📋 Copy Code</button>
                <button type="button" class="refresh-btn" onclick="checkCodeStatus()">🔄 Refresh Status</button>
            </div>
        </div>
        
        <div class="session-info">
            <h4>ℹ️ Session Info</h4>
            <p id="sessionCount">Active sessions: 0</p>
            <p id="sessionLimit">Max sessions: ${MAX_SESSIONS}</p>
            <button type="button" class="refresh-btn" onclick="loadSessionInfo()">🔄 Refresh Sessions</button>
        </div>
    </div>
    
    <script>
        const form = document.getElementById('pairingForm');
        const resultDiv = document.getElementById('result');
        const loader = document.getElementById('loader');
        const submitBtn = document.getElementById('submitBtn');
        const instructions = document.getElementById('instructions');
        const codeContainer = document.getElementById('codeContainer');
        const pairingCodeDisplay = document.getElementById('pairingCodeDisplay');
        const sessionCount = document.getElementById('sessionCount');
        const sessionLimit = document.getElementById('sessionLimit');
        
        let currentSessionId = null;
        let checkInterval = null;
        
        // Load session info on page load
        async function loadSessionInfo() {
            try {
                const response = await fetch('/api/sessions');
                const data = await response.json();
                
                if (data.success) {
                    sessionCount.textContent = \`Active sessions: \${data.sessions.length}\`;
                    sessionLimit.textContent = \`Max sessions: \${MAX_SESSIONS}\`;
                }
            } catch (error) {
                console.error('Error loading session info:', error);
            }
        }
        
        // Load session info when page loads
        loadSessionInfo();
        
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const phoneNumber = document.getElementById('phoneNumber').value.trim();
            
            if (!phoneNumber.match(/^[0-9]{10,15}$/)) {
                showResult('Please enter a valid phone number (10-15 digits)', false);
                return;
            }
            
            // Show loader
            loader.style.display = 'block';
            submitBtn.disabled = true;
            resultDiv.style.display = 'none';
            instructions.style.display = 'none';
            codeContainer.style.display = 'none';
            
            try {
                const response = await fetch('/api/pair', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ phoneNumber })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    currentSessionId = data.sessionId;
                    
                    showResult(\`
                        <h3>✅ Pairing Request Successful!</h3>
                        <p>Your session has been created. Waiting for pairing code...</p>
                        <p><strong>Session ID:</strong> \${data.sessionId}</p>
                    \`, true);
                    
                    // Show instructions and start checking for code
                    instructions.style.display = 'block';
                    codeContainer.style.display = 'block';
                    
                    // Start checking for pairing code
                    checkCodeStatus();
                    
                    // Update session info
                    loadSessionInfo();
                } else {
                    showResult(\`❌ Error: \${data.error}\`, false);
                }
            } catch (error) {
                showResult(\`❌ Network error: \${error.message}\`, false);
            } finally {
                // Hide loader
                loader.style.display = 'none';
                submitBtn.disabled = false;
            }
        });
        
        // Check for pairing code status
        async function checkCodeStatus() {
            if (!currentSessionId) return;
            
            try {
                const response = await fetch(\`/api/session/\${currentSessionId}\`);
                const data = await response.json();
                
                if (data.success) {
                    if (data.code) {
                        // Show the pairing code!
                        pairingCodeDisplay.textContent = data.code;
                        
                        // Stop checking if we have the code
                        if (checkInterval) {
                            clearInterval(checkInterval);
                            checkInterval = null;
                        }
                        
                        // Update result message
                        resultDiv.innerHTML = \`
                            <h3>✅ Pairing Code Generated!</h3>
                            <p>Your WhatsApp should show a notification. Enter the code below:</p>
                        \`;
                    } else if (data.status === 'error') {
                        showResult(\`❌ Error generating code: \${data.error}\`, false);
                        if (checkInterval) clearInterval(checkInterval);
                    } else {
                        // Still waiting, check again in 2 seconds
                        if (!checkInterval) {
                            checkInterval = setInterval(checkCodeStatus, 2000);
                        }
                    }
                } else {
                    showResult(\`❌ Session error: \${data.error}\`, false);
                    if (checkInterval) clearInterval(checkInterval);
                }
            } catch (error) {
                console.error('Error checking code status:', error);
            }
        }
        
        // Copy code to clipboard
        function copyCode() {
            const code = pairingCodeDisplay.textContent;
            if (!code) return;
            
            navigator.clipboard.writeText(code.replace(/-/g, ''))
                .then(() => {
                    alert('Code copied to clipboard!');
                })
                .catch(err => {
                    console.error('Failed to copy code:', err);
                    alert('Failed to copy code. Please copy manually.');
                });
        }
        
        function showResult(message, isSuccess) {
            resultDiv.innerHTML = message;
            resultDiv.className = \`result \${isSuccess ? 'success' : 'error'}\`;
            resultDiv.style.display = 'block';
            
            if (isSuccess) {
                instructions.style.display = 'block';
            } else {
                instructions.style.display = 'none';
                codeContainer.style.display = 'none';
            }
            
            // Scroll to result
            resultDiv.scrollIntoView({ behavior: 'smooth' });
        }
        
        // Clean up interval when page is closed
        window.addEventListener('beforeunload', () => {
            if (checkInterval) {
                clearInterval(checkInterval);
            }
        });
    </script>
</body>
</html>`;
        
        fs.writeFileSync(htmlPath, basicHTML);
        console.log(chalk.green('✓ Created default index.html'));
    }
}

// ============================================
// API ROUTES
// ============================================

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint to request pairing code
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
        
        if (cleanPhone.length < 10) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid phone number format (minimum 10 digits)' 
            });
        }

        // Check session limit
        if (activeSessions.size >= MAX_SESSIONS) {
            return res.status(429).json({
                success: false,
                error: `Session limit reached. Maximum ${MAX_SESSIONS} sessions allowed.`,
                limit: MAX_SESSIONS,
                current: activeSessions.size
            });
        }

        const sessionId = `session_${cleanPhone}_${Date.now()}`;
        
        console.log(chalk.blue(`📱 New pairing request for ${cleanPhone} - Session: ${sessionId}`));

        // Set up callback for pairing code
        global.pairingCallbacks[sessionId] = (code, error) => {
            if (error) {
                console.error(chalk.red(`[${sessionId}] Pairing callback error: ${error}`));
            } else {
                console.log(chalk.green(`[${sessionId}] Pairing code generated: ${code}`));
            }
        };

        try {
            // Start bot session (this will generate pairing code)
            const sock = await startBotSession(cleanPhone, sessionId);
            
            // Return success immediately - code will come via polling
            res.json({
                success: true,
                sessionId,
                phoneNumber: cleanPhone,
                message: 'Session created. Pairing code will be generated in 3-5 seconds.'
            });

        } catch (error) {
            console.error(chalk.red(`Error starting session: ${error.message}`));
            
            // Clean up callback
            delete global.pairingCallbacks[sessionId];
            
            res.status(500).json({
                success: false,
                error: 'Failed to start session: ' + error.message
            });
        }

    } catch (error) {
        console.error(chalk.red('Error in /api/pair:', error));
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// Get session status and pairing code
app.get('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    
    // Check if session exists in memory
    const sessionData = activeSessions.get(sessionId);
    
    // Check for pairing.json file
    const pairingFile = path.join(sessionPath, 'pairing.json');
    const errorFile = path.join(sessionPath, 'error.json');
    
    if (fs.existsSync(pairingFile)) {
        try {
            const pairingData = JSON.parse(fs.readFileSync(pairingFile, 'utf8'));
            
            res.json({
                success: true,
                sessionId,
                phoneNumber: pairingData.phoneNumber,
                code: pairingData.code,
                status: pairingData.status,
                timestamp: pairingData.timestamp,
                connectedAt: pairingData.connectedAt
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: 'Error reading pairing data'
            });
        }
    } else if (fs.existsSync(errorFile)) {
        try {
            const errorData = JSON.parse(fs.readFileSync(errorFile, 'utf8'));
            
            res.json({
                success: false,
                sessionId,
                error: errorData.error,
                status: 'error',
                timestamp: errorData.timestamp
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: 'Error reading error data'
            });
        }
    } else if (sessionData) {
        // Session exists but no pairing code yet
        res.json({
            success: true,
            sessionId,
            phoneNumber: sessionData.phoneNumber,
            status: sessionData.status || 'pending',
            message: 'Waiting for pairing code...'
        });
    } else {
        res.status(404).json({
            success: false,
            error: 'Session not found'
        });
    }
});

// Get all sessions
app.get('/api/sessions', (req, res) => {
    const sessions = getAllSessions();
    
    res.json({
        success: true,
        count: sessions.length,
        limit: MAX_SESSIONS,
        sessions: sessions.map(session => ({
            sessionId: session.sessionId,
            phoneNumber: session.phoneNumber,
            status: session.status,
            createdAt: session.createdAt,
            connectedAt: session.connectedAt,
            uptime: session.uptime
        }))
    });
});

// Remove a session
app.delete('/api/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    
    try {
        const result = await closeSession(sessionId);
        
        if (result.success) {
            // Clean up callback
            delete global.pairingCallbacks[sessionId];
            
            // Remove session folder
            const sessionPath = path.join(__dirname, 'sessions', sessionId);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
            
            res.json({
                success: true,
                message: 'Session removed successfully'
            });
        } else {
            res.status(404).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error(chalk.red(`Error removing session ${sessionId}:`, error));
        res.status(500).json({
            success: false,
            error: 'Failed to remove session'
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    const sessions = getAllSessions();
    
    res.json({
        success: true,
        status: 'online',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        server: {
            node: process.version,
            platform: process.platform,
            memory: {
                heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
                heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
            }
        },
        sessions: {
            active: sessions.length,
            limit: MAX_SESSIONS,
            pending: sessions.filter(s => s.status === 'pending').length,
            connected: sessions.filter(s => s.status === 'connected').length
        }
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error(chalk.red('Server error:'), err);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    setupDirectories();
    console.log(chalk.green(`
╔════════════════════════════════════════════════════════╗
║    WhatsApp Multi-Session Bot v2.0                     ║
║    Server running on port ${PORT}                       ║
║    Web Interface: http://localhost:${PORT}              ║
║                                                        ║
║    🔥 Features:                                        ║
║    • Pairing Code Generation                           ║
║    • Multi-Session Support                             ║
║    • Web Interface                                     ║
║    • Auto Session Cleanup                              ║
║                                                        ║
║    📱 Visit the web interface to connect your WhatsApp ║
╚════════════════════════════════════════════════════════╝
    `));
    
    console.log(chalk.cyan(`\n📊 Initial session check: ${activeSessions.size} active sessions`));
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n⚠️  Shutting down server...'));
    
    // Close all active sessions
    const sessions = getAllSessions();
    console.log(chalk.yellow(`Closing ${sessions.length} active sessions...`));
    
    for (const session of sessions) {
        await closeSession(session.sessionId);
    }
    
    console.log(chalk.green('✅ Server shutdown complete'));
    process.exit(0);
});