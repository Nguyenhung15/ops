const app = require('./app');
const env = require('./config/env');
const { connectDB, disconnectDB } = require('./config/db');
const paymentMaintenanceJob = require('./jobs/paymentMaintenance.job');

const start = async () => {
  try {
    await connectDB();

    if (env.paymentJobEnabled && env.nodeEnv !== 'test') {
      paymentMaintenanceJob.start();
    }

    const server = app.listen(env.port, () => {
      console.log(`Server running on port ${env.port} [${env.nodeEnv}]`);
    });

    const shutdown = (signal) => {
      console.log(`${signal} received, shutting down...`);
      paymentMaintenanceJob.stop();
      server.close(async () => {
        await disconnectDB();
        process.exit(0);
      });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
};

start();
