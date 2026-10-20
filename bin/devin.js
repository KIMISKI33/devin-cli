#!/usr/bin/env node
require("../dist/agent.js").main().catch((error) => {
  console.error(error);
  process.exit(1);
});
