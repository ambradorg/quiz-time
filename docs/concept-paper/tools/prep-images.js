const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const IMG = path.join(require("os").tmpdir(), "quiztime-docs-img");
// Strip each diagram's own header (duplicates the slide title) for slide use.
const jobs = [
  ["ipo", 168], ["pipeline", 168], ["offline", 168], ["architecture", 168],
  ["curve", 160], ["timeline", 162],
];
(async () => {
  for (const [name, top] of jobs) {
    const src = path.join(IMG, `${name}.png`);
    const meta = await sharp(src).metadata();
    const h = meta.height - top;
    const out = path.join(IMG, `${name}-body.png`);
    await sharp(src).extract({ left: 0, top, width: meta.width, height: h }).toFile(out);
    console.log(name, `${meta.width}x${meta.height}`, "->", `${meta.width}x${h}`, "ar", (meta.width / h).toFixed(3));
  }
})();
