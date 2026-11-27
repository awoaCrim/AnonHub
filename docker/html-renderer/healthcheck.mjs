import http from "node:http";

const request = http.get({ socketPath: process.env.RENDERER_SOCKET || "/run/renderer/http.sock", path: "/health", timeout: 3000 }, (response) => {
  response.resume();
  process.exitCode = response.statusCode === 200 ? 0 : 1;
});
request.on("timeout", () => request.destroy(new Error("timeout")));
request.on("error", () => {
  process.exitCode = 1;
});
