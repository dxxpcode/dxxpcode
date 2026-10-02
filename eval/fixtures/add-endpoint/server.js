const http = require("http");
const { version } = require("./package.json");

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.listen(3000);
