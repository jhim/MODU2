import express from 'express';
import configuredApp from '../server/src/index.js';

const app = express();
app.use(configuredApp);

export default app;
