const { handleReq } = require("./helpers");

const res = handleReq({ path: "/" });
console.log(res.status);
