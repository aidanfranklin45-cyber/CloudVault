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
    if (!pageTarget) return;

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    ws.addEventListener('open', () => {
        // Evaluate window status and errors
        const expr = `
            (() => {
                return {
                    facilitySelected: window.currentSelectedFacilityId,
                    activeRole: activeRole,
                    actualUserRole: actualUserRole,
                    actualUserName: actualUserName,
                    masterDataLoaded: !!window._masterAdminData,
                    totalInventoryItems: window._masterAdminData ? window._masterAdminData.inventory.length : 0,
                    totalAccessRequests: window._masterAdminData ? window._masterAdminData.accessRequests.length : 0,
                    totalStaff: window._masterAdminData ? window._masterAdminData.staffUsers.length : 0
                };
            })()
        `;
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    });

    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === 1) {
            console.log('=== LIVE BROWSER STATE REPORT ===');
            console.log(JSON.stringify(msg.result?.result?.value, null, 2));
            ws.close();
            process.exit(0);
        }
    });
}

main().catch(console.error);
