import { createApplication } from './lib/app.mjs';

const port = Number(process.env.PORT || 4378);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number.');
const host = process.env.HOST || '127.0.0.1';
const server = createApplication();
server.requestTimeout = 95_000;
server.headersTimeout = 10_000;
server.listen(port, host, () => console.log(`Realove Connection Lab listening on http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
