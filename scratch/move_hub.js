const fs = require('fs');
let content = fs.readFileSync('admin.html', 'utf8');

const sMarker = 'id=" executive-creator-promo-hub\';
const eMarker = 'id=\webhook-payload-modal\';

let sIdx = content.indexOf(sMarker);
sIdx = content.lastIndexOf('<!--', sIdx);

let eIdx = content.indexOf(eMarker);
eIdx = content.lastIndexOf('<!-- Modal: Webhook Payload Viewer -->', eIdx);

console.log('sIdx:', sIdx, 'eIdx:', eIdx);
const block = content.substring(sIdx, eIdx);

content = content.substring(0, sIdx) + content.substring(eIdx);

const view2Idx = content.indexOf('<!-- VIEW 2: WAREHOUSE MANAGER ROLE -->');
const insertIdx = content.lastIndexOf('</div>', view2Idx);

content = content.substring(0, insertIdx) + '\n\n ' + block.trim() + '\n ' + content.substring(insertIdx);

fs.writeFileSync('admin.html', content, 'utf8');
console.log('Successfully relocated block into view-executive!');
