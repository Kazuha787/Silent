const axios = require('axios');
const fs = require('fs/promises');
const TelegramBot = require('node-telegram-bot-api');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Constants
const ENDPOINTS = {
    POSITION: 'https://ceremony-backend.silentprotocol.org/ceremony/position',
    PING: 'https://ceremony-backend.silentprotocol.org/ceremony/ping'
};

const FILES = {
    TOKENS: 'tokens.json',
    CONFIG: 'config.json',
    PROXIES: 'proxies.txt'
};

const UPDATE_INTERVALS = {
    POSITION: 10000,  // 10 seconds
    NOTIFICATION: 60000  // 1 minutes
};

// Console styling
const ConsoleStyle = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    colors: {
        info: '\x1b[36m',     // Cyan
        success: '\x1b[32m',  // Green
        warning: '\x1b[33m',  // Yellow
        error: '\x1b[31m',    // Red
        status: '\x1b[35m'    // Magenta
    },
    icons: {
        info: 'ℹ️',
        success: '✅',
        warning: '⚠️',
        error: '❌',
        status: '🔄'
    }
};

class ProxyManager {
    constructor() {
        this.proxies = [];
        this.currentIndex = 0;
    }

    async loadProxies() {
        try {
            const data = await fs.readFile(FILES.PROXIES, 'utf8');
            this.proxies = data.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'))
                .map(this.parseProxyString);
            
            console.log(formatLog(`Loaded ${this.proxies.length} proxies`, 'success'));
        } catch (error) {
            console.error(formatLog(`Failed to load proxies: ${error.message}`, 'error'));
            this.proxies = [];
        }
    }

    parseProxyString(proxyStr) {
        const [protocol, rest] = proxyStr.split('://');
        const [auth, hostPort] = rest.split('@').reverse();
        const [host, port] = hostPort.split(':');
        const [username, password] = (auth && auth.includes(':')) ? auth.split(':') : [];

        return {
            protocol,
            host,
            port: parseInt(port),
            username,
            password,
            url: proxyStr
        };
    }

    getProxyAgent(proxy) {
        const proxyUrl = proxy.url;
        switch (proxy.protocol) {
            case 'socks4':
            case 'socks5':
                return new SocksProxyAgent(proxyUrl);
            case 'http':
            case 'https':
                return new HttpsProxyAgent(proxyUrl);
            default:
                throw new Error(`Unsupported proxy protocol: ${proxy.protocol}`);
        }
    }

    getNextProxy() {
        if (this.proxies.length === 0) return null;
        const proxy = this.proxies[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
        return proxy;
    }
}

class WalletMonitor {
    constructor(token, proxyManager) {
        this.token = token;
        this.proxyManager = proxyManager;
        this.data = {
            position: null,
            lastPing: null,
            lastUpdate: null,
            proxy: null
        };
    }

    getHeaders() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Accept': '*/*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };
    }

    async makeRequest(url, retries = 3) {
        let lastError;
        
        for (let i = 0; i < retries; i++) {
            try {
                const proxy = this.proxyManager.getNextProxy();
                const config = {
                    headers: this.getHeaders(),
                    ...(proxy && { httpsAgent: this.proxyManager.getProxyAgent(proxy) })
                };

                this.data.proxy = proxy?.url || 'direct';
                const response = await axios.get(url, config);
                return response.data;
            } catch (error) {
                lastError = error;
                console.error(formatLog(`Request failed, attempt ${i + 1}/${retries}`, 'warning'));
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        throw lastError;
    }

    async updatePosition() {
        try {
            const data = await this.makeRequest(ENDPOINTS.POSITION);
            this.data.position = data;
            this.data.lastUpdate = new Date();
            
            console.log(formatLog(
                `[${this.token.slice(0, 6)}...] Position: ${data.behind} behind, ETA: ${data.timeRemaining}`,
                'status'
            ));
        } catch (error) {
            console.error(formatLog(
                `[${this.token.slice(0, 6)}...] Position update failed: ${error.message}`,
                'error'
            ));
        }
    }

    async ping() {
        try {
            await this.makeRequest(ENDPOINTS.PING);
            this.data.lastPing = new Date();
            console.log(formatLog(`[${this.token.slice(0, 6)}...] Ping successful`, 'success'));
        } catch (error) {
            console.error(formatLog(`[${this.token.slice(0, 6)}...] Ping failed: ${error.message}`, 'error'));
        }
    }

    getStatusReport() {
        const { position, lastPing, lastUpdate, proxy } = this.data;
        if (!position) return null;

        return {
            token: this.token.slice(0, 6),
            position: position.behind,
            timeRemaining: position.timeRemaining,
            lastPing: lastPing?.toLocaleTimeString() || 'Never',
            lastUpdate: lastUpdate?.toLocaleTimeString() || 'Never',
            proxy: proxy || 'direct'
        };
    }
}

class CeremonyMonitor {
    constructor() {
        this.wallets = new Map();
        this.proxyManager = new ProxyManager();
        this.telegramBot = null;
        this.chatId = null;
    }

    async initialize() {
        console.log(formatLog('Initializing Silent Protocol Ceremony Monitor...', 'info'));
        
        await this.proxyManager.loadProxies();
        await this.initializeTelegram();
        await this.loadWallets();
        
        this.setupPeriodicTasks();
        await this.sendTelegramNotification('🚀 <b>Monitor Started</b>\n\nMonitoring began for ' +
            `${this.wallets.size} wallets.\nUpdates every 1 minutes.`);
    }

    async initializeTelegram() {
        const config = await this.loadConfig();
        if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
            this.telegramBot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: false });
            this.chatId = config.TELEGRAM_CHAT_ID;
            console.log(formatLog('Telegram bot initialized', 'success'));
        }
    }

    async loadConfig() {
        try {
            const data = await fs.readFile(FILES.CONFIG, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error(formatLog('Config loading failed: ' + error.message, 'error'));
            process.exit(1);
        }
    }

    async loadWallets() {
        try {
            const data = await fs.readFile(FILES.TOKENS, 'utf8');
            const tokens = JSON.parse(data);
            
            tokens.forEach(token => {
                this.wallets.set(token, new WalletMonitor(token, this.proxyManager));
            });
            
            console.log(formatLog(`Loaded ${this.wallets.size} wallets`, 'success'));
        } catch (error) {
            console.error(formatLog('Failed to load wallets: ' + error.message, 'error'));
            process.exit(1);
        }
    }

    setupPeriodicTasks() {
        // Update positions and ping for each wallet
        for (const wallet of this.wallets.values()) {
            setInterval(() => wallet.updatePosition(), UPDATE_INTERVALS.POSITION);
            setInterval(() => wallet.ping(), UPDATE_INTERVALS.POSITION);
        }

        // Send periodic status updates
        setInterval(() => this.sendStatusUpdate(), UPDATE_INTERVALS.NOTIFICATION);
    }

    async sendStatusUpdate() {
        const reports = Array.from(this.wallets.values())
            .map(wallet => wallet.getStatusReport())
            .filter(report => report !== null);

        if (reports.length === 0) return;

        let message = '🔄 <b>Status Update</b>\n\n';
        
        reports.forEach(report => {
            message += `<b>Wallet ${report.token}...</b>\n`;
            message += `├ Position: ${report.position} behind\n`;
            message += `├ ETA: ${report.timeRemaining}\n`;
            message += `├ Last Ping: ${report.lastPing}\n`;
            message += `├ Last Update: ${report.lastUpdate}\n`;
            message += `└ Proxy: ${report.proxy}\n\n`;
        });

        await this.sendTelegramNotification(message);
    }

    async sendTelegramNotification(message) {
        if (!this.telegramBot || !this.chatId) return;
        
        try {
            await this.telegramBot.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error(formatLog('Telegram notification failed: ' + error.message, 'error'));
        }
    }
}

function formatLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const { colors, icons } = ConsoleStyle;
    return `${ConsoleStyle.bright}[${timestamp}]${ConsoleStyle.reset} ${colors[type]}${icons[type]} ${message}${ConsoleStyle.reset}`;
}

// Error handling
process.on('unhandledRejection', async (error) => {
    console.error(formatLog('Unhandled rejection: ' + error.message, 'error'));
    const monitor = new CeremonyMonitor();
    await monitor.sendTelegramNotification('⚠️ <b>Critical Error</b>\n\n' + error.message);
});

process.on('SIGINT', async () => {
    console.log(formatLog('\nGracefully shutting down...', 'warning'));
    const monitor = new CeremonyMonitor();
    await monitor.sendTelegramNotification('🛑 <b>Monitor Stopped</b>\n\nService has been terminated.');
    process.exit(0);
});

// Start the application
new CeremonyMonitor().initialize().catch(console.error);