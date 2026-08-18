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
        console.error('Target admin.html page not found in Chrome. Current tabs:', targets.map(t => ({ title: t.title, url: t.url })));
        return;
    }

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    ws.addEventListener('open', () => {
        const expr = `
            (async () => {
                async function measure(name, promiseFn) {
                    const t0 = performance.now();
                    const res = await promiseFn();
                    const t1 = performance.now();
                    return { name, durationMs: Math.round(t1 - t0), rows: res.data ? res.data.length : 0 };
                }

                const results = [];
                results.push(await measure("facilities", () => supabase.from('facilities').select('*')));
                results.push(await measure("inventory (all with JOIN)", () => supabase.from('inventory').select('*, users!uid(name, email, onboarding_status)')));
                results.push(await measure("inventory (active only with JOIN)", () => supabase.from('inventory').select('*, users!uid(name, email, onboarding_status)').in('status', ['stored', 'pending-stage', 'staged', 'pending-dispatch', 'out-for-delivery', 'with-customer', 'missing-tote'])));
                results.push(await measure("inventory (active only NO JOIN)", () => supabase.from('inventory').select('*').in('status', ['stored', 'pending-stage', 'staged', 'pending-dispatch', 'out-for-delivery', 'with-customer', 'missing-tote'])));
                results.push(await measure("access_requests with JOIN", () => supabase.from('access_requests').select('*, users!uid(name, active_zone)')));
                results.push(await measure("access_requests NO JOIN", () => supabase.from('access_requests').select('*')));
                return results;
            })()
        `;

        ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
                expression: expr,
                awaitPromise: true,
                returnByValue: true
            }
        }));
    });

    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === 1) {
            console.log('=== REALTIME BROWSER QUERY LATENCY ===');
            console.log(JSON.stringify(msg.result?.result?.value, null, 2));
            ws.close();
            process.exit(0);
        }
    });
}

main().catch(console.error);
