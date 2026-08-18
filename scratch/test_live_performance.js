const http = require('http');

async function main() {
    const targets = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json', (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(JSON.parse(body)));
        }).on('error', reject);
    });

    const pageTarget = targets.find(t => t.url && t.url.includes('cloudvault-35a9b-6b3db.web.app/admin.html') && t.type === 'page');
    if (!pageTarget) {
        console.error('Target page not found');
        return;
    }

    console.log('Reloading page to test Master Batch Ingestion performance...');
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    ws.addEventListener('open', () => {
        // Send Page.reload
        ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: true } }));
    });

    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === 1) {
            // Wait 2.5 seconds after reload and evaluate performance
            setTimeout(() => {
                const expr = `
                    (() => {
                        const entries = performance.getEntriesByType('resource');
                        const supabaseCalls = entries.filter(s => s.name.includes('supabase.co')).map(e => ({
                            name: e.name.split('?')[0].split('/').pop(),
                            durationMs: Math.round(e.duration),
                            startTimeMs: Math.round(e.startTime)
                        }));
                        const nav = performance.getEntriesByType('navigation')[0];
                        return {
                            domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : 0,
                            loadCompleteMs: nav ? Math.round(nav.loadEventEnd) : 0,
                            totalSupabaseRequests: supabaseCalls.length,
                            supabaseCalls
                        };
                    })()
                `;
                ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
            }, 2500);
        }
        if (msg.id === 2) {
            console.log('=== TEST RESULT AFTER MASTER BATCH INGESTION ===');
            console.log(JSON.stringify(msg.result?.result?.value, null, 2));
            ws.close();
            process.exit(0);
        }
    });
}

main().catch(console.error);
