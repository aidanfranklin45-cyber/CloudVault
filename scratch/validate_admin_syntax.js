const fs = require('fs');

const html = fs.readFileSync('admin.html', 'utf8');
const scriptMatches = html.matchAll(/<script[\s\S]*?>([\s\S]*?)<\/script>/gi);

let scriptIndex = 0;
let errors = 0;

for (const match of scriptMatches) {
    scriptIndex++;
    const code = match[1];
    if (!code.trim()) continue;

    try {
        new Function(code);
        console.log(`✓ Script block ${scriptIndex} syntax OK`);
    } catch (e) {
        console.error(`❌ Syntax error in script block ${scriptIndex}:`, e.message);
        errors++;
    }
}

if (errors === 0) {
    console.log('\n🎉 ALL SCRIPT BLOCKS IN admin.html PARSED WITH ZERO SYNTAX ERRORS!');
} else {
    process.exit(1);
}
