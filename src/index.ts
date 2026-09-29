const fiveMinutesMs = 5 * 60 * 1000;

function logHelloWorld(): void {
  console.log("Hello, world!");
}

logHelloWorld();
setInterval(logHelloWorld, fiveMinutesMs);
