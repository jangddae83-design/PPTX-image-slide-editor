const fs = require('fs');
const content = fs.readFileSync('components/EditorCanvas.tsx', 'utf-8');

const mouseMoveBody = content.match(/const handleMouseMoveRaw[^\{]+\{([\s\S]*?)^\s{2}\};/m);
if (!mouseMoveBody) {
  console.error("Could not parse handleMouseMoveRaw");
  process.exit(1);
}

if (mouseMoveBody[1].includes('onUpdateOverlays')) {
  console.log("❌ TEST FAILED: onUpdateOverlays is called synchronously inside handleMouseMoveRaw.");
  console.log("This causes global React re-renders of the ENTIRE APP at 120Hz during drag.");
  process.exit(1);
} else {
  console.log("✅ TEST PASSED: Global re-render during drag is mitigated.");
  process.exit(0);
}
