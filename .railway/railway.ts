import { defineRailway, project, service } from 'railway/iac';

export default defineRailway(() => {
  const web = service('modu2-web', {
    build: 'npm ci --include=dev && npm run build && npm prune --omit=dev',
    start: 'npm start',
    healthcheck: '/api/health',
    healthcheckTimeout: 100,
  });

  return project('MODU2', { resources: [web] });
});
