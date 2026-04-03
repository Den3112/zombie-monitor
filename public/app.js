let currentPath = '/home/creator';
let cachedProcs = [];
let procSort = { key: 'memMB', dir: -1 };

async function updateStatus() {
    try {
        const response = await fetch('/api/status');
        const data = await response.json();
        cachedProcs = data.topProcs || [];

        // Dashboard Updates
        document.getElementById('cpu-load').textContent = data.cpuLoad;
        document.getElementById('cpu-fill').style.width = Math.min(parseFloat(data.cpuLoad) * 10, 100) + '%';

        document.getElementById('mem-used').textContent = data.mem.used;
        document.getElementById('mem-total').textContent = `of ${data.mem.total}`;
        document.getElementById('mem-fill').style.width = data.mem.percent + '%';

        document.getElementById('anomaly-count').textContent = data.metrics.anomaliesDetected;
        document.getElementById('reap-count').textContent = data.metrics.reapsTotal;
        document.getElementById('uptime').textContent = data.sysInfo.uptime;
        document.getElementById('hostname').textContent = data.sysInfo.hostname;

        // Alerts Display
        const alertContainer = document.getElementById('alerts-container');
        const anomalyList = document.getElementById('anomaly-list');
        if (data.metrics.currentAnomalies.length > 0) {
            alertContainer.style.display = 'block';
            anomalyList.innerHTML = data.metrics.currentAnomalies.map(a => `
                <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:12px 20px; border-radius:12px; border:1px solid rgba(218, 54, 51, 0.2);">
                    <div>
                        <div style="font-weight:700; color:#fff;">${a.name} <span style="font-weight:400; color:var(--text-dim); font-size:0.8rem">PID:${a.pid}</span></div>
                        <div style="font-size:0.8rem; color:var(--danger); margin-top:4px;">Warning: ${a.reason}</div>
                        <div style="font-size:0.75rem; color:var(--text-dim); margin-top:2px;">CPU: ${a.cpu}% | RAM: ${a.memMB}MB | State: ${a.stat}</div>
                    </div>
                    <button class="danger" style="padding:6px 12px; font-size:0.8rem;" onclick="killProcess(${a.pid})">Terminate Now</button>
                </div>
            `).join('');
        } else {
            alertContainer.style.display = 'none';
        }

        // Top Procs list (Dashboard)
        const topList = document.getElementById('top-procs-list');
        topList.innerHTML = cachedProcs.slice(0, 8).map(p => `
            <div style="display:flex; justify-content:space-between; padding: 14px 0; border-bottom:1px solid var(--border)">
                <span style="font-weight:600; color:var(--accent-secondary)">${p.name} <span style="font-weight:400; color:var(--text-dim); font-size:0.8rem">PID:${p.pid}</span></span>
                <span style="color:var(--accent); font-family:'Fira Code', monospace">${p.memMB} MB</span>
            </div>
        `).join('');

        // Logs
        document.getElementById('mini-logs').innerHTML = data.recentLogs.slice(0, 10).map(l => `<div>> ${l}</div>`).join('');
        document.getElementById('full-logs').innerHTML = data.recentLogs.map(l => `<div>[AUDIT] ${l}</div>`).join('');

        renderProcs();
        document.getElementById('autokill-check').checked = data.autoKill;

    } catch (e) {
        console.error("Dashboard link failed", e);
    }
}

function renderProcs() {
    const list = [...cachedProcs].sort((a, b) => {
        let valA = a[procSort.key], valB = b[procSort.key];
        if (['pid', 'cpu', 'memMB'].includes(procSort.key)) {
            valA = parseFloat(valA); valB = parseFloat(valB);
        } else {
            valA = (valA || '').toLowerCase(); valB = (valB || '').toLowerCase();
        }
        return valA > valB ? -procSort.dir : procSort.dir;
    });

    const procTable = document.getElementById('full-proc-table');
    procTable.innerHTML = list.map(p => `
        <tr>
            <td style="color:var(--text-dim); font-family:'Fira Code'">${p.pid}</td>
            <td style="font-weight:700;">${p.name}</td>
            <td><span class="badge" style="background:rgba(0,242,255,0.1); color:var(--accent)">${p.cpu}%</span></td>
            <td><span style="font-weight:700">${p.memMB} MB</span></td>
            <td><span class="badge" style="background:rgba(112,0,255,0.1); color:var(--accent-secondary)">${p.stat}</span></td>
            <td><button class="danger" onclick="killProcess(${p.pid})">Kill</button></td>
        </tr>
    `).join('');
}

function sortProcs(key) {
    if (procSort.key === key) procSort.dir *= -1;
    else { procSort.key = key; procSort.dir = -1; }
    renderProcs();
}

async function loadFiles(path = currentPath) {
    try {
        const response = await fetch(`/api/fs/list?path=${encodeURIComponent(path)}`);
        const data = await response.json();
        currentPath = data.currentPath;
        updateBreadcrumbs(currentPath);
        
        const listContainer = document.getElementById('file-list');
        listContainer.innerHTML = '';

        if (currentPath !== '/home/creator' && currentPath !== '/') {
            const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
            listContainer.innerHTML += `
                <div class="file-row" style="opacity: 0.6; cursor: pointer;" onclick="loadFiles('${parent}')">
                    <div class="file-name"><span>🔙</span> .. (Up)</div>
                    <div></div><div></div><div></div>
                </div>
            `;
        }

        data.items.forEach(item => {
            const row = document.createElement('div');
            row.className = 'file-row';
            row.innerHTML = `
                <div class="file-name" onclick="${item.isDir ? `loadFiles('${item.path}')` : ''}" style="${item.isDir ? 'cursor:pointer' : ''}">
                    <span>${item.isDir ? '📂' : '📄'}</span> ${item.name}
                </div>
                <div style="font-family:'Fira Code'; font-size:0.8rem">${item.size}</div>
                <div style="color:var(--text-dim); font-size:0.8rem">${new Date(item.mtime).toLocaleDateString()}</div>
                <div><button class="danger" style="padding:4px 8px; font-size:0.75rem" onclick="deleteFile('${item.path}')">Del</button></div>
            `;
            listContainer.appendChild(row);
        });
    } catch (e) { console.error("FS error", e); }
}

async function deleteFile(path) {
    if (!confirm(`Delete ${path}?`)) return;
    await fetch('/api/fs/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
    });
    loadFiles(currentPath);
}

async function killProcess(pid) {
    if (!confirm(`Kill PID ${pid}?`)) return;
    await fetch(`/api/kill/${pid}`, { method: 'POST' });
    updateStatus();
}

async function killAllOrphans() {
    if (!confirm("Kill all orphaned candidates (PPID=1)?")) return;
    const res = await fetch('/api/status');
    const data = await res.json();
    for (const pid of data.candidates) {
        await fetch(`/api/kill/${pid}`, { method: 'POST' });
    }
    updateStatus();
}

document.getElementById('autokill-check').onchange = async () => {
    await fetch('/api/toggle-autokill', { method: 'POST' });
};

function showTab(tabId, event) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    event.currentTarget.classList.add('active');
    if (tabId === 'files') loadFiles();
}

function updateBreadcrumbs(path) {
    const container = document.getElementById('breadcrumbs');
    const parts = path.split('/').filter(p => p);
    let currentFull = '';
    
    let html = `<div style="background: rgba(0,242,255,0.05); cursor:pointer; padding:6px 12px; border-radius:8px; border:1px solid var(--border); color:var(--accent); font-size:0.8rem" onclick="loadFiles('/')">/</div>`;
    
    parts.forEach((p, index) => {
        currentFull += '/' + p;
        html += `<span style="color:var(--text-dim)">/</span>`;
        if (index === parts.length - 1) {
            html += `<div style="background: rgba(0,242,255,0.1); padding:6px 12px; border-radius:8px; border:1px solid var(--accent); color:var(--accent); font-size:0.8rem; font-weight:700">${p}</div>`;
        } else {
            const thisPath = currentFull;
            html += `<div style="background: rgba(255,255,255,0.05); cursor:pointer; padding:6px 12px; border-radius:8px; border:1px solid var(--border); color:var(--text); font-size:0.8rem" onclick="loadFiles('${thisPath}')">${p}</div>`;
        }
    });
    
    container.innerHTML = html;
}

setInterval(updateStatus, 5000);
updateStatus();
loadFiles();
