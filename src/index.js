import express from 'express';
import serverApp from '../dist-server/server/src/index.js';

const app = express();
app.set('trust proxy', 1);
app.use(serverApp);

export default app;
