function handleReq(req) {
  return { status: 200, path: req.path, ts: Date.now() };
}

module.exports = { handleReq };
