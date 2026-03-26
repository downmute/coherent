import { buildWorkerServer } from './server.js';

const { app, config } = await buildWorkerServer();

try {
  await app.listen({
    host: config.WORKER_HOST,
    port: config.WORKER_PORT,
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
