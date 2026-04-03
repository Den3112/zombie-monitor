const express = require('express');
const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 3333;

app.use(express.json());
app.use(express.static('public'));

// Request Logger
app.use((req, res, next) => {
    if (req.url !== '/api/status' && !req.url.startsWith('/public')) {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} from ${req.ip}`);
    }
    next();
});

// Load configuration
const configPath = path.join(__dirname, 'config.json');
let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

fs.watchFile(configPath, () => {
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        appendLog({ type: 'EVENT', message: 'Config reloaded' });
    } catch (e) {}
});

const logFile = path.join(__dirname, config.logging.file);
const processHistory = new Map();
const pendingSIGTERM = new Map();
const killLog = []; // In-memory cache for recent kills

// Metrics tracking
const metrics = {
    reapsTotal: 0,
    sigtermsSent: 0,
    sigkillsSent: 0,
    anomaliesDetected: 0,
    startTime: Date.now(),
    autoKill: true,
    currentAnomalies: []
};

function appendLog(entry) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, ...entry };
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
    if (entry.type === 'KILLED' || entry.type === 'EVENT') {
        killLog.unshift(`${timestamp.split('T')[1].split('.')[0]} [${entry.type}] ${entry.message || (entry.comm + ' ' + entry.action + ': ' + entry.reason)}`);
        if (killLog.length > 50) killLog.pop();
    }
}

async function getProcesses() {
    return new Promise((resolve) => {
        exec('ps -eo pid,ppid,pmem,pcpu,stat,comm,args --no-headers', (err, stdout) => {
            if (err) return resolve([]);
            const lines = stdout.split('\n');
            const procs = lines.map(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 6) return null;
                return {
                    pid: parseInt(parts[0]),
                    ppid: parseInt(parts[1]),
                    mem: parseFloat(parts[2]),
                    cpu: parseFloat(parts[3]),
                    stat: parts[4],
                    comm: parts[5],
                    args: parts.slice(6).join(' ')
                };
            }).filter(p => p !== null);
            resolve(procs);
        });
    });
}

function shouldTerminate(p, history) {
    if (!metrics.autoKill) return false;
    const myPid = process.pid;
    if (p.pid === myPid || p.pid === process.ppid) return false;
    if (config.protected.some(c => p.comm.includes(c))) return false;

    const isTarget = config.targets.some(t => p.comm.includes(t) || p.args.includes(t));
    if (!isTarget) return false;

    if (!history || history.samples.length < 2) return false;
    const lastSample = history.samples[history.samples.length - 1];

    if (history.samples.slice(-2).every(s => s.stat.startsWith('Z') || s.stat.startsWith('D'))) 
        return { reason: `Stuck in state ${lastSample.stat}` };

    if (lastSample.ppid === 1) return { reason: "Orphaned process (PPID=1)" };

    if (history.samples.length >= config.monitoring.cpuHangingSamples) {
        if (history.samples.slice(-config.monitoring.cpuHangingSamples).every(s => s.cpu > config.monitoring.cpuHangingThreshold))
            return { reason: `High CPU (> ${config.monitoring.cpuHangingThreshold}%)` };
    }
    return false;
}

async function checkAndClean() {
    const procs = await getProcesses();
    const currentPids = new Set();
    metrics.anomaliesDetected = 0;
    metrics.currentAnomalies = [];

    procs.forEach(p => {
        currentPids.add(p.pid);
        let history = processHistory.get(p.pid) || { samples: [], firstSeen: Date.now() };
        history.samples.push({ cpu: p.cpu, mem: p.mem, stat: p.stat, ppid: p.ppid });
        if (history.samples.length > config.monitoring.maxHistorySamples) history.samples.shift();
        processHistory.set(p.pid, history);

        const term = shouldTerminate(p, history);
        if (term) {
            metrics.anomaliesDetected++;
            metrics.currentAnomalies.push({
                pid: p.pid,
                name: p.comm,
                cpu: p.cpu,
                memMB: ((p.mem * os.totalmem() / 100) / (1024 * 1024)).toFixed(0),
                reason: term.reason,
                stat: p.stat
            });
            handleTermination(p, term.reason);
        }
    });

    for (const pid of processHistory.keys()) {
        if (!currentPids.has(pid)) { processHistory.delete(pid); pendingSIGTERM.delete(pid); }
    }
}

function handleTermination(p, reason) {
    const now = Date.now();
    const sigtermTime = pendingSIGTERM.get(p.pid);
    
    // Если процесс уже в состоянии зомби, убивать его бесполезно.
    // Нам нужно либо убить его родителя, либо подождать, пока PID 1 его заберет.
    if (p.stat.startsWith('Z')) {
        if (!pendingSIGTERM.has(p.pid)) {
            appendLog({ type: 'KILLED', action: 'ZOMBIE_DETECTED', pid: p.pid, comm: p.comm, reason: 'Zombie process needs reaping' });
            pendingSIGTERM.set(p.pid, now);
        }
        return;
    }

    if (!sigtermTime) {
        appendLog({ type: 'KILLED', action: 'SIGTERM', pid: p.pid, comm: p.comm, reason });
        exec(`kill -15 ${p.pid}`, (err) => {
            if (err) appendLog({ type: 'ERROR', message: `Failed to SIGTERM ${p.pid}: ${err.message}` });
        });
        pendingSIGTERM.set(p.pid, now);
        metrics.sigtermsSent++;
    } else if (now - sigtermTime > config.termination.sigtermWaitSeconds * 1000) {
        appendLog({ type: 'KILLED', action: 'SIGKILL', pid: p.pid, comm: p.comm, reason });
        exec(`kill -9 ${p.pid}`, (err) => {
            if (err) appendLog({ type: 'ERROR', message: `Failed to SIGKILL ${p.pid}: ${err.message}` });
        });
        metrics.sigkillsSent++;
        metrics.reapsTotal++;
    }
}

// Stats Helpers
function formatBytes(bytes) { return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'; }

// --- DASHBOARD API ---
app.get('/api/status', async (req, res) => {
    const procs = await getProcesses();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    // Sort for Top Procs
    const topProcs = procs
        .sort((a, b) => (b.mem * totalMem / 100) - (a.mem * totalMem / 100))
        .slice(0, 50)
        .map(p => ({
            pid: p.pid,
            name: p.comm,
            cpu: p.cpu.toFixed(1),
            memMB: ((p.mem * totalMem / 100) / (1024 * 1024)).toFixed(0),
            args: p.args,
            stat: p.stat
        }));

    res.json({
        metrics,
        config,
        cpuLoad: os.loadavg()[0].toFixed(2),
        mem: {
            used: formatBytes(usedMem),
            total: formatBytes(totalMem),
            percent: ((usedMem / totalMem) * 100).toFixed(1)
        },
        disk: { percent: "N/A", used: "N/A", size: "N/A" }, // Simplified
        sysInfo: { hostname: os.hostname(), uptime: (os.uptime() / 3600).toFixed(1) + ' hrs' },
        topProcs,
        recentLogs: killLog,
        autoKill: metrics.autoKill,
        candidates: Array.from(processHistory.keys()).filter(pid => {
            const h = processHistory.get(pid);
            return h && h.samples.slice(-1)[0].ppid === 1;
        })
    });
});

app.post('/api/kill/:pid', (req, res) => {
    const pid = req.params.pid;
    appendLog({ type: 'EVENT', message: `Manual kill requested for PID ${pid}` });
    exec(`kill -9 ${pid}`);
    res.json({ success: true });
});

app.post('/api/toggle-autokill', (req, res) => {
    metrics.autoKill = !metrics.autoKill;
    appendLog({ type: 'EVENT', message: `AutoKill toggled to ${metrics.autoKill}` });
    res.json({ autoKill: metrics.autoKill });
});

// --- FILE SYSTEM API ---
app.get('/api/fs/list', (req, res) => {
    const targetPath = req.query.path || '/home/creator';
    try {
        const items = fs.readdirSync(targetPath, { withFileTypes: true }).map(dirent => {
            const fullPath = path.join(targetPath, dirent.name);
            let stats = { size: 0, mtime: new Date() };
            try { stats = fs.statSync(fullPath); } catch (e) {}
            return {
                name: dirent.name,
                path: fullPath,
                isDir: dirent.isDirectory(),
                size: dirent.isDirectory() ? '--' : (stats.size / 1024).toFixed(1) + ' KB',
                rawSize: stats.size,
                mtime: stats.mtime
            };
        });
        res.json({ currentPath: targetPath, items });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/fs/delete', (req, res) => {
    const { path: target } = req.body;
    if (!target) return res.status(400).send("Path is required");
    
    const resolvedPath = path.resolve(target);
    const homeBase = '/home/creator';
    
    if (!resolvedPath.startsWith(homeBase)) {
        appendLog({ type: 'SECURITY', message: `Blocked deletion attempt outside home: ${target}` });
        return res.status(403).send("Outside home directory access denied");
    }

    try {
        if (!fs.existsSync(resolvedPath)) return res.status(404).send("File not found");
        
        if (fs.statSync(resolvedPath).isDirectory()) {
            fs.rmSync(resolvedPath, { recursive: true });
        } else {
            fs.unlinkSync(resolvedPath);
        }
        appendLog({ type: 'EVENT', message: `Deleted FS: ${resolvedPath}` });
        res.json({ success: true });
    } catch (e) { 
        appendLog({ type: 'ERROR', message: `FS Delete error: ${e.message}` });
        res.status(500).send(e.message); 
    }
});

// Prometheus Endpoint
app.get('/metrics', (req, res) => {
    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
    const promMetrics = [
        `zombie_reaps_total ${metrics.reapsTotal}`,
        `zombie_sigterms_sent_total ${metrics.sigtermsSent}`,
        `zombie_uptime_seconds ${uptime}`
    ];
    res.set('Content-Type', 'text/plain').send(promMetrics.join('\n'));
});

setInterval(checkAndClean, config.monitoring.intervalMs);

app.listen(PORT, '0.0.0.0', () => {
    appendLog({ type: 'EVENT', message: 'Senior Status Monitor V3.0 Started (0.0.0.0)', port: PORT });
    console.log(`Senior Status Monitor V3.0 on port ${PORT}`);
});
