import { buildControlPlaneServer } from './server.js';

const { app, config } = await buildControlPlaneServer();

try {
  await app.listen({
    host: config.CONTROL_PLANE_HOST,
    port: config.CONTROL_PLANE_PORT,
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
