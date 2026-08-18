const http = require('http');

async function main() {
    // 1. Get targets
    const targets = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json', (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(JSON.parse(body)));
        }).on('error', reject);
    });

    const pageTarget = targets.find(t => t.url && t.url.includes('cloudvault-35a9b-6b3db.web.app/admin.html') && t.type === 'page');
    if (!pageTarget) {
        console.error('Target page not found among:', targets.map(t => ({ title: t.title, url: t.url, type: t.type })));
        return;
    }

    console.log('Connecting to page:', pageTarget.title);
    console.log('WS Debugger URL:', pageTarget.webSocketDebuggerUrl);

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    ws.addEventListener('open', () => {
        const expr = `
            (() => {
                const entries = performance.getEntriesByType('resource');
                const sorted = entries.map(e => ({
                    name: e.name.split('/').pop().split('?')[0] || e.name,
                    fullName: e.name,
                    initiatorType: e.initiatorType,
                    durationMs: Math.round(e.duration),
                    startTimeMs: Math.round(e.startTime),
                    transferSizeBytes: e.transferSize
                })).sort((a, b) => b.durationMs - a.durationMs);

                const nav = performance.getEntriesByType('navigation')[0];

                return {
                    url: window.location.href,
                    totalResources: entries.length,
                    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : 0,
                    loadCompleteMs: nav ? Math.round(nav.loadEventEnd) : 0,
                    slowest15Resources: sorted.slice(0, 15),
                    supabaseCalls: sorted.filter(s => s.fullName.includes('supabase.co'))
                };
            })()
        `;

        ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
                expression: expr,
                returnByValue: true
            }
        }));
    });

    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === 1) {
            console.log('=== LIVE BROWSER PERFORMANCE REPORT ===');
            console.log(JSON.stringify(msg.result?.result?.value, null, 2));
            ws.close();
        }
    });

    ws.addEventListener('error', err => {
        console.error('WebSocket Error:', err);
    });
}

main().catch(console.error);
